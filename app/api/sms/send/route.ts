import { NextResponse } from 'next/server';
import { createClient as createSupabaseServerClient } from '@/lib/supabase/server';
import { normalizeUgPhone } from '@/lib/utils';
import { sendSingleSMS } from '@/lib/sms-actions';
import { readBoundedJson } from '@/lib/http/read-json';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isSameOriginRequestForHeaders } from '@/lib/auth-security';
import { isSmsWithinSegmentLimit } from '@/supabase/functions/_shared/sms-length';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_SMS_CHARACTERS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  try {
    if (!isSameOriginRequestForHeaders(req.headers.get('origin'), req.headers, req.url)) {
      return NextResponse.json({ error: 'Cross-origin request denied.' }, { status: 403 });
    }
    const parsed = await readBoundedJson<unknown>(req, MAX_REQUEST_BYTES);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    if (!parsed.value || Array.isArray(parsed.value) || typeof parsed.value !== 'object') {
      return NextResponse.json({ error: 'JSON body must be an object.' }, { status: 400 });
    }

    const body = parsed.value as Record<string, unknown>;
    const churchId = typeof body.churchId === 'string' ? body.churchId.trim() : '';
    const recipientId = typeof body.recipientId === 'string' ? body.recipientId.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const idempotencyKey = typeof body.idempotencyKey === 'string'
      ? body.idempotencyKey.trim()
      : req.headers.get('idempotency-key')?.trim() ?? '';

    if (!UUID_RE.test(churchId) || !UUID_RE.test(recipientId)) {
      return NextResponse.json({ error: 'A valid church and recipient ID are required.' }, { status: 400 });
    }
    if (!message || Array.from(message).length > MAX_SMS_CHARACTERS || !isSmsWithinSegmentLimit(message)) {
      return NextResponse.json({ error: 'Message must be at most 500 characters and 4 SMS segments.' }, { status: 400 });
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      return NextResponse.json({ error: 'Provide a stable idempotency key between 8 and 255 characters.' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: adminProfile } = await supabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .eq('tenant_id', churchId)
      .maybeSingle();
    if (!adminProfile || !['pastor', 'admin'].includes(adminProfile.role)) {
      return NextResponse.json({ error: 'Access denied: a pastor or administrator for this church is required.' }, { status: 403 });
    }

    const accountLimit = await checkRateLimit({ namespace: 'sms-single-account', subject: user.id, limit: 30, windowSeconds: 10 * 60 });
    const tenantLimit = await checkRateLimit({ namespace: 'sms-single-tenant', subject: churchId, limit: 200, windowSeconds: 60 * 60 });
    const deniedLimit = !accountLimit.allowed ? accountLimit : tenantLimit;
    if (!accountLimit.allowed || !tenantLimit.allowed) {
      const unavailable = Boolean(deniedLimit.unavailable);
      return NextResponse.json(
        { error: unavailable ? 'SMS protection is temporarily unavailable.' : 'SMS sending limit reached. Please try again later.' },
        { status: unavailable ? 503 : 429, headers: unavailable ? undefined : { 'Retry-After': String(deniedLimit.retryAfterSeconds) } },
      );
    }

    const [memberResult, convertResult, churchResult] = await Promise.all([
      supabase.schema('church').from('members').select('id, phone_number').eq('id', recipientId).eq('church_id', churchId).maybeSingle(),
      supabase.schema('church').from('new_converts').select('id, contact').eq('id', recipientId).eq('church_id', churchId).maybeSingle(),
      supabase.schema('church').from('churches').select('id, sender_id').eq('id', churchId).maybeSingle(),
    ]);
    if (memberResult.error || convertResult.error || churchResult.error) {
      return NextResponse.json({ error: 'Could not verify the selected recipient.' }, { status: 503 });
    }
    if (!churchResult.data) return NextResponse.json({ error: 'Church configuration not found.' }, { status: 404 });

    const member = memberResult.data;
    const convert = convertResult.data;
    const church = churchResult.data;
    const storedPhone = member ? member.phone_number : convert?.contact ?? null;
    if (!storedPhone) return NextResponse.json({ error: 'Recipient does not belong to this church or has no phone number.' }, { status: 403 });
    const recipientPhone = normalizeUgPhone(storedPhone);
    if (!recipientPhone) return NextResponse.json({ error: 'Recipient has no valid Ugandan phone number.' }, { status: 400 });

    // If a legacy caller supplies a phone, reject mismatches; the queued number
    // always comes from the tenant-verified database record.
    if (typeof body.phoneNumber === 'string' && normalizeUgPhone(body.phoneNumber) !== recipientPhone) {
      return NextResponse.json({ error: 'Phone number does not match the selected church recipient.' }, { status: 400 });
    }

    const result = await sendSingleSMS({
      supabase,
      phoneNumber: recipientPhone,
      message,
      churchId,
      idempotencyKey,
      senderId: church.sender_id?.trim() || '',
      recipientId,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[SMS API] Request failed:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'SMS request could not be completed.' }, { status: 502 });
  }
}
