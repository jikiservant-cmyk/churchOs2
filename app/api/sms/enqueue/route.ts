/**
 * POST /api/sms/enqueue
 *
 * Validates the authenticated church admin, persists one `pending` row per
 * recipient, then invokes church-najiki-dispatch once per queue ID after commit.
 */

import { after, NextResponse } from 'next/server';
import { createClient as createServerClient, createAdminClient } from '@/lib/supabase/server';
import { enqueueBroadcast } from '@/lib/queue-actions';
import { dispatchSmsQueueItems } from '@/lib/sms-dispatch';
import { normalizeUgPhone } from '@/lib/utils';
import { readBoundedJson } from '@/lib/http/read-json';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isSameOriginRequestForHeaders } from '@/lib/auth-security';
import { isSmsWithinSegmentLimit, smsSegmentCount } from '@/supabase/functions/_shared/sms-length';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RECIPIENTS_PER_BROADCAST = 250;
const MAX_SMS_CHARACTERS = 500;

export async function POST(req: Request) {
  try {
    if (!isSameOriginRequestForHeaders(req.headers.get('origin'), req.headers, req.url)) {
      return NextResponse.json({ error: 'Cross-origin request denied.' }, { status: 403 });
    }
    const parsed = await readBoundedJson<unknown>(req, MAX_REQUEST_BYTES);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    }
    if (!parsed.value || Array.isArray(parsed.value) || typeof parsed.value !== 'object') {
      return NextResponse.json({ error: 'JSON body must be an object.' }, { status: 400 });
    }
    const body = parsed.value as Record<string, unknown>;
    const { message, churchId, recipients, audience } = body;

    // Bound broadcast size before any database query, then validate the actual
    // types rather than relying on client-side form constraints.
    if (typeof message !== 'string' || !message.trim() || Array.from(message).length > MAX_SMS_CHARACTERS || !isSmsWithinSegmentLimit(message) ||
        typeof churchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(churchId) ||
        !Array.isArray(recipients) || recipients.length === 0 || recipients.length > MAX_RECIPIENTS_PER_BROADCAST) {
      return NextResponse.json(
        { error: 'Provide a message of at most 500 characters and 4 SMS segments, a valid church ID, and 1–250 recipients.' },
        { status: 400 },
      );
    }

    // ── Auth ────────────────────────────────────────────────────────────────
    const supabase = await createServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── Multi-tenancy & Role guard (MT-04) ──────────────────────────────────
    // Use admin client to bypass stale JWT / RLS — still verify caller is the authed user
    // and tenant matches (service-role never trusts client). Allow Saccos 'member' when tenant matches.
    const adminSupabaseForAuth = await createAdminClient();
    const { data: adminProfile } = await adminSupabaseForAuth
      .from('admin_profiles')
      .select('tenant_id, role, app_type')
      .eq('id', user.id)
      .eq('tenant_id', churchId)
      .maybeSingle();

    const allowedRoles = ['pastor', 'admin', 'staff', 'member'] as const;
    if (!adminProfile || !allowedRoles.includes(adminProfile.role as any)) {
      return NextResponse.json(
        { error: 'Access denied: only pastors or administrators can enqueue broadcasts.' },
        { status: 403 },
      );
    }

    // Rate-limit by both account and tenant using shared storage in production.
    const accountLimit = await checkRateLimit({ namespace: 'sms-broadcast-account', subject: user.id, limit: 10, windowSeconds: 60 });
    const tenantLimit = await checkRateLimit({ namespace: 'sms-broadcast-tenant', subject: churchId, limit: 5, windowSeconds: 15 * 60 });
    const deniedLimit = !accountLimit.allowed ? accountLimit : tenantLimit;
    if (!accountLimit.allowed || !tenantLimit.allowed) {
      const unavailable = Boolean(deniedLimit.unavailable);
      return NextResponse.json(
        { error: unavailable ? 'SMS protection is temporarily unavailable.' : 'Broadcast limit reached. Please try again later.' },
        { status: unavailable ? 503 : 429, headers: unavailable ? undefined : { 'Retry-After': String(deniedLimit.retryAfterSeconds) } },
      );
    }

    // ── Church config ───────────────────────────────────────────────────────
    const { data: church, error: churchErr } = await supabase
      .schema('church')
      .from('churches')
      .select('id, sender_id')
      .eq('id', churchId)
      .maybeSingle();

    if (churchErr || !church) {
      return NextResponse.json({ error: 'Church configuration not found.' }, { status: 404 });
    }

    // ── Server-side Recipient Verification (MT-06 / F-02) ──────────────────────────
    const requestedIds = [...new Set((recipients as unknown[]).flatMap((recipient) => {
      if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) return [];
      const id = (recipient as Record<string, unknown>).id;
      return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        ? [id]
        : [];
    }))];
    if (requestedIds.length === 0 || requestedIds.length !== recipients.length) {
      return NextResponse.json(
        { error: 'Each recipient must be a unique, valid church member or convert ID.' },
        { status: 400 },
      );
    }

    let verifiedRecipients: Array<{ id: string; full_name: string; phone_number: string }> = [];

    const [membersRes, convertsRes] = await Promise.all([
      supabase
        .schema('church')
        .from('members')
        .select('id, full_name, phone_number')
        .eq('church_id', churchId)
        .in('id', requestedIds),
      supabase
        .schema('church')
        .from('new_converts')
        .select('id, full_name, phone_number')
        .eq('church_id', churchId)
        .in('id', requestedIds)
    ]);

    const memberRecipients = (membersRes.data || []).map(m => ({
      id: m.id,
      full_name: m.full_name,
      phone_number: normalizeUgPhone(m.phone_number)
    }));

    const convertRecipients = (convertsRes.data || []).map(c => ({
      id: c.id,
      full_name: c.full_name,
      phone_number: normalizeUgPhone(c.phone_number)
    }));

    verifiedRecipients = [...memberRecipients, ...convertRecipients].filter(
      (r): r is { id: string; full_name: string; phone_number: string } => !!r.phone_number
    );

    if (verifiedRecipients.length === 0) {
      return NextResponse.json({ error: 'No valid authorized recipients found for this church.' }, { status: 400 });
    }

    // Enforce billable SMS segments, not merely request or recipient count.
    // These quotas are shared with single sends through the same tenant key.
    const smsVolume = verifiedRecipients.length * smsSegmentCount(message);
    if (smsVolume > 500) {
      return NextResponse.json({ error: 'Hourly SMS volume limit reached.' }, { status: 429 });
    }
    const accountVolumeLimit = await checkRateLimit({
      namespace: 'sms-volume-account', subject: user.id, limit: 500, windowSeconds: 60 * 60,
      cost: smsVolume,
    });
    const tenantVolumeLimit = await checkRateLimit({
      namespace: 'sms-volume-tenant', subject: churchId, limit: 1_000, windowSeconds: 60 * 60,
      cost: smsVolume,
    });
    const deniedVolumeLimit = !accountVolumeLimit.allowed ? accountVolumeLimit : tenantVolumeLimit;
    if (!accountVolumeLimit.allowed || !tenantVolumeLimit.allowed) {
      const unavailable = Boolean(deniedVolumeLimit.unavailable);
      return NextResponse.json(
        { error: unavailable ? 'SMS protection is temporarily unavailable.' : 'Hourly SMS volume limit reached.' },
        { status: unavailable ? 503 : 429, headers: unavailable ? undefined : { 'Retry-After': String(deniedVolumeLimit.retryAfterSeconds) } },
      );
    }

    // The existing Edge debit RPC performs the authoritative wallet check; no
    // preflight balance read is used to decide whether to enqueue.

    // ── Sender ID ───────────────────────────────────────────────────────────
    const senderId = church.sender_id?.trim() || '';

    // ── Enqueue ─────────────────────────────────────────────────────────────
    const { broadcastId, enqueued, skipped, queueIds } = await enqueueBroadcast({
      tenantId:   churchId,
      message,
      audience:   typeof audience === 'string' ? audience.slice(0, 40) : 'all',
      senderId,
      recipients: verifiedRecipients,
      createdBy:  user.id,
    });

    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token ?? null;

    // Dispatch each durable queue row separately; the Edge request body is only its ID.
    after(async () => {
      const outcomes = await dispatchSmsQueueItems(queueIds, 5, accessToken);
      const deferred = outcomes.filter((outcome) => !outcome.ok || outcome.status === 'pending').length;
      if (deferred) console.warn(`[Enqueue] ${deferred} SMS rows remain queued for retry.`);
    });

    // ── Respond ─────────────────────────────────────────────────────────────
    return NextResponse.json({
      success:     true,
      broadcastId,
      enqueued,
      skipped,
      message:     `${enqueued} message${enqueued !== 1 ? 's' : ''} queued for delivery.`,
    });

  } catch (err: any) {
    console.error('[Enqueue] Unexpected error:', err);
    return NextResponse.json(
      { error: err.message ?? 'Internal server error' },
      { status: 500 },
    );
  }
}
