/**
 * POST /api/sms/enqueue
 *
 * Validates the authenticated church admin, persists one `pending` row per
 * recipient, then invokes church-najiki-dispatch once per queue ID after commit.
 */

import { after, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { enqueueBroadcast } from '@/lib/queue-actions';
import { dispatchSmsQueueItems } from '@/lib/sms-dispatch';
import { normalizeUgPhone } from '@/lib/utils';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { message, churchId, recipients, audience } = body;

    // ── Input validation ────────────────────────────────────────────────────
    if (!message || !churchId || !Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields: message, churchId, or recipients' },
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
    const { data: adminProfile } = await supabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .eq('tenant_id', churchId)
      .maybeSingle();

    if (!adminProfile || !['pastor', 'admin'].includes(adminProfile.role)) {
      return NextResponse.json(
        { error: 'Access denied: only pastors or administrators can enqueue broadcasts.' },
        { status: 403 },
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
    const requestedIds = Array.isArray(recipients) ? recipients.map((r: any) => r.id).filter(Boolean) : [];
    if (requestedIds.length === 0) {
      return NextResponse.json(
        { error: 'Recipients must be selected from this church (ids are required).' },
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

    // The existing Edge debit RPC performs the authoritative wallet check; no
    // preflight balance read is used to decide whether to enqueue.

    // ── Sender ID ───────────────────────────────────────────────────────────
    const senderId = church.sender_id?.trim() || '';

    // ── Enqueue ─────────────────────────────────────────────────────────────
    const { broadcastId, enqueued, skipped, queueIds } = await enqueueBroadcast({
      tenantId:   churchId,
      message,
      audience:   audience ?? 'all',
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
