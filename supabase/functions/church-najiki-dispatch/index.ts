import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  corsHeaders,
  exponentialBackoffMs,
  hasValidDispatchSecret,
  jsonResponse,
  requireSupabaseSecrets,
} from '../_shared/runtime.ts';
import { isSmsWithinSegmentLimit } from '../_shared/sms-length.ts';

type QueueItem = {
  id: string;
  tenant_id: string;
  recipient_id: string | null;
  recipient_phone: string;
  // Deployed church.sms_queue keeps the SMS text in `body`; older schema
  // snapshots name it `message`. Accept whichever column the claim returned.
  body?: string;
  message?: string;
  sender_id: string | null;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  lock_token: string;
};

/** Return the SMS text from a claimed queue row regardless of column name. */
function queueItemMessage(row: QueueItem): string {
  if (typeof row.body === 'string') return row.body;
  if (typeof row.message === 'string') return row.message;
  return '';
}

function client() {
  const { url, secretKey } = requireSupabaseSecrets();
  return createClient(url, secretKey, {
    db: { schema: 'church' },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function retryAt(delayMs: number) {
  return new Date(Date.now() + Math.max(1_000, delayMs)).toISOString();
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function messageFromBody(body: any): string {
  const candidate = body?.error ?? body?.message ?? body?.details ?? 'Na’jiki rejected the SMS request.';
  return String(candidate).slice(0, 900);
}

async function ensureSmsLog(db: ReturnType<typeof client>, row: QueueItem) {
  // sms_logs declares idempotency_key as its unique constraint (global). Use
  // that exact conflict target; tenant_id,idempotency_key has no matching
  // unique index in the deployed/base schema and causes every insert to fail.
  const { error: insertError } = await db.from('sms_logs').upsert({
    tenant_id: row.tenant_id,
    recipient_phone: row.recipient_phone,
    body: queueItemMessage(row),
    status: 'PENDING',
    idempotency_key: row.idempotency_key,
    sender_id: row.sender_id,
  }, { onConflict: 'idempotency_key', ignoreDuplicates: true });

  if (insertError) throw new Error(`SMS log insert failed: ${insertError.message}`);

  const { data, error } = await db.from('sms_logs')
    .select('tenant_id, recipient_phone, body, sender_id, status')
    .eq('tenant_id', row.tenant_id)
    .eq('idempotency_key', row.idempotency_key)
    .maybeSingle();
  if (error || !data) throw new Error(`SMS log lookup failed: ${error?.message ?? 'log not found'}`);
  if (
    data.tenant_id !== row.tenant_id ||
    data.recipient_phone !== row.recipient_phone ||
    data.body !== queueItemMessage(row) ||
    (data.sender_id ?? '') !== (row.sender_id ?? '')
  ) {
    throw new Error('SMS idempotency key is already associated with a different log payload.');
  }

  // A previous transient attempt may have left a failed log even though the
  // durable queue item is being retried. Never reset delivery callbacks.
  if (data.status === 'FAILED') {
    const { error: resetError } = await db.from('sms_logs')
      .update({ status: 'PENDING', error_message: null, updated_at: new Date().toISOString() })
      .eq('tenant_id', row.tenant_id)
      .eq('idempotency_key', row.idempotency_key)
      .eq('status', 'FAILED');
    if (resetError) throw new Error(`SMS log reset failed: ${resetError.message}`);
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!hasValidDispatchSecret(request)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const najikiApiKey = Deno.env.get('NAJIKI_API_KEY')?.trim();
  if (!najikiApiKey) return jsonResponse({ error: 'Na’jiki API key is not configured.' }, 503);

  const apiUrl = (Deno.env.get('NAJIKI_API_URL')?.trim() || 'https://najiki.netlify.app').replace(/\/+$/, '');
  try {
    if (new URL(apiUrl).protocol !== 'https:') {
      return jsonResponse({ error: 'NAJIKI_API_URL must use HTTPS.' }, 503);
    }
  } catch {
    return jsonResponse({ error: 'NAJIKI_API_URL is invalid.' }, 503);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Expected JSON with sms_id.' }, 400);
  }
  // The backend passes only this durable queue ID; message data never comes
  // from the caller and is always re-read from the database after the claim.
  const smsId = typeof body?.sms_id === 'string' ? body.sms_id : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(smsId)) {
    return jsonResponse({ error: 'A valid sms_id is required.' }, 400);
  }

  let db: ReturnType<typeof client>;
  try {
    db = client();
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Supabase is not configured.' }, 503);
  }

  const lockToken = crypto.randomUUID();
  const { data: claimed, error: claimError } = await db.rpc('claim_sms_queue_item', {
    p_sms_id: smsId,
    p_lock_token: lockToken,
    p_lease_seconds: 90,
  });
  if (claimError) {
    console.error('[church-najiki-dispatch] claim failed:', claimError.message);
    return jsonResponse({ error: 'Queue claim failed.' }, 500);
  }
  const row = (Array.isArray(claimed) ? claimed[0] : claimed) as QueueItem | null;
  if (!row) return jsonResponse({ ok: true, skipped: true, status: 'not_due_or_already_claimed' });

  try {
    const validPhone = typeof row.recipient_phone === 'string' && /^\+256\d{9}$/.test(row.recipient_phone);
    const messageText = queueItemMessage(row);
    const validMessage = messageText.trim().length > 0 && Array.from(messageText).length <= 500 && isSmsWithinSegmentLimit(messageText);
    const validIdempotencyKey = typeof row.idempotency_key === 'string' && row.idempotency_key.length >= 8 && row.idempotency_key.length <= 255;
    if (!validPhone || !validMessage || !validIdempotencyKey) {
      const { data: failed, error: failError } = await db.rpc('fail_sms_queue_item', {
        p_sms_id: row.id,
        p_lock_token: lockToken,
        p_error: 'Queue item failed server-side SMS validation.',
      });
      if (failError || failed?.result === 'not_claimed') {
        throw new Error(`Could not reject invalid SMS queue item: ${failError?.message ?? 'lease was lost'}`);
      }
      return jsonResponse({ ok: true, status: 'failed', reason: 'invalid_queue_payload', sms_id: row.id });
    }

    await ensureSmsLog(db, row);

    const { data: debit, error: debitError } = await db.rpc('reserve_sms_queue_debit', {
      p_sms_id: row.id,
      p_lock_token: lockToken,
    });
    if (debitError) throw new Error(`Wallet debit reservation failed: ${debitError.message}`);

    const debitResult = debit?.result;
    if (['insufficient_balance', 'wallet_missing'].includes(debitResult)) {
      const delay = debitResult === 'insufficient_balance' ? 5 * 60_000 : 10 * 60_000;
      const errorText = debitResult === 'insufficient_balance'
        ? 'Insufficient SMS wallet balance; waiting for a top-up.'
        : 'SMS wallet is missing for this tenant.';
      const { error } = await db.rpc('release_sms_queue_item', {
        p_sms_id: row.id,
        p_lock_token: lockToken,
        p_retry_at: retryAt(delay),
        p_error: errorText,
        p_restore_attempt: true,
      });
      if (error) throw new Error(`Could not release SMS queue lease: ${error.message}`);
      return jsonResponse({ ok: true, status: 'pending', reason: debitResult, sms_id: row.id });
    }
    if (!['debited', 'already_debited'].includes(debitResult)) {
      throw new Error(`Wallet debit could not be safely reserved (${String(debitResult)}).`);
    }

    const applicationCode = Deno.env.get('NAJIKI_APPLICATION_CODE')?.trim() || 'church';
    const payload: Record<string, unknown> = {
      to: row.recipient_phone,
      message: messageText,
      applicationCode,
    };
    if (row.sender_id?.trim()) payload.from = row.sender_id.trim();

    let response: Response;
    try {
      response = await fetch(`${apiUrl}/api/messaging/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${najikiApiKey}`,
          'content-type': 'application/json',
          'idempotency-key': row.idempotency_key,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25_000),
        cache: 'no-store',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const delay = exponentialBackoffMs(row.attempts);
      const { error: releaseError } = await db.rpc('release_sms_queue_item', {
        p_sms_id: row.id,
        p_lock_token: lockToken,
        p_retry_at: retryAt(delay),
        p_error: `Ambiguous Na’jiki network outcome; will retry with the same idempotency key. ${detail}`,
        p_restore_attempt: false,
      });
      if (releaseError) throw new Error(`Network timeout and lease release failed: ${releaseError.message}`);
      return jsonResponse({ ok: true, status: 'pending', reason: 'ambiguous_network', sms_id: row.id });
    }

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = messageFromBody(responseBody);
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        // Rate limits and server errors are transient/ambiguous. Retry forever
        // with this same key rather than risk a duplicate send or false refund.
        const delay = response.status === 429
          ? Math.max(60_000, parseRetryAfter(response.headers.get('retry-after')) ?? 60_000)
          : exponentialBackoffMs(row.attempts);
        const { error: releaseError } = await db.rpc('release_sms_queue_item', {
          p_sms_id: row.id,
          p_lock_token: lockToken,
          p_retry_at: retryAt(delay),
          p_error: `Na’jiki ${response.status}: ${detail}`,
          p_restore_attempt: response.status === 429,
        });
        if (releaseError) throw new Error(`Could not release retryable SMS: ${releaseError.message}`);
        return jsonResponse({ ok: true, status: 'pending', reason: 'retryable_gateway_response', sms_id: row.id });
      }

      // Other 4xx responses are definitive contract/configuration rejections.
      const { data: failed, error: failError } = await db.rpc('fail_sms_queue_item', {
        p_sms_id: row.id,
        p_lock_token: lockToken,
        p_error: `Na’jiki ${response.status}: ${detail}`,
      });
      if (failError || failed?.result === 'not_claimed') {
        throw new Error(`Could not finalize rejected SMS: ${failError?.message ?? 'lease was lost'}`);
      }
      return jsonResponse({ ok: true, status: 'failed', sms_id: row.id });
    }

    const gatewaySmsId = typeof responseBody?.smsId === 'string' ? responseBody.smsId : '';
    const gatewayReference = typeof responseBody?.reference === 'string' ? responseBody.reference : '';
    if (!gatewaySmsId || !gatewayReference || responseBody?.success === false) {
      // A successful HTTP status without the documented identifiers is still
      // ambiguous: retry the same key, allowing Na’jiki to return its original result.
      const { error: releaseError } = await db.rpc('release_sms_queue_item', {
        p_sms_id: row.id,
        p_lock_token: lockToken,
        p_retry_at: retryAt(exponentialBackoffMs(row.attempts)),
        p_error: 'Na’jiki response omitted smsId/reference; retrying idempotently.',
        p_restore_attempt: false,
      });
      if (releaseError) throw new Error(`Could not release ambiguous SMS response: ${releaseError.message}`);
      return jsonResponse({ ok: true, status: 'pending', reason: 'incomplete_gateway_response', sms_id: row.id });
    }

    const { data: completed, error: completeError } = await db.rpc('complete_sms_queue_item', {
      p_sms_id: row.id,
      p_lock_token: lockToken,
      p_najiki_sms_id: gatewaySmsId,
      p_najiki_reference: gatewayReference,
      p_gateway_status: typeof responseBody.status === 'string' ? responseBody.status : 'sent',
    });
    if (completeError || completed !== true) {
      // The accepted request is safe to retry because the exact same key and
      // queue ID are retained. The next invocation receives Na’jiki's dedupe result.
      throw new Error(`Na’jiki accepted the SMS but queue completion failed: ${completeError?.message ?? 'lease was lost'}`);
    }

    return jsonResponse({
      ok: true,
      status: 'sent',
      sms_id: row.id,
      smsId: gatewaySmsId,
      reference: gatewayReference,
      deduplicated: Boolean(responseBody.deduplicated),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[church-najiki-dispatch] queue item ${row.id} remains recoverable:`, detail);
    // Failure after claiming must release the lease. If this release also fails,
    // the locked_until lease is the fallback recovery mechanism.
    await db.rpc('release_sms_queue_item', {
      p_sms_id: row.id,
      p_lock_token: lockToken,
      p_retry_at: retryAt(exponentialBackoffMs(row.attempts)),
      p_error: detail,
      p_restore_attempt: false,
    });
    return jsonResponse({ error: 'SMS dispatch remains queued for a safe retry.', sms_id: row.id }, 503);
  }
});
