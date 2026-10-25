import { createAdminClient } from '@/lib/supabase/server';
import { normalizeUgPhone } from '@/lib/utils';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isSmsWithinSegmentLimit, smsSegmentCount } from '@/supabase/functions/_shared/sms-length';

export type EnqueueSmsInput = {
  tenantId: string;
  phoneNumber: string;
  message: string;
  senderId?: string | null;
  recipientId?: string | null;
  idempotencyKey: string;
};

export type EnqueuedSms = {
  id: string;
  idempotencyKey: string;
  status: string;
  alreadyExisted: boolean;
};

/** Persist first, then invoke the single-row Edge Function using this same ID. */
export async function enqueueSmsDispatch(input: EnqueueSmsInput): Promise<EnqueuedSms> {
  const phone = normalizeUgPhone(input.phoneNumber);
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';

  if (!input.tenantId || !phone || !message) {
    throw new Error('A tenant, valid Ugandan phone number, and message are required.');
  }
  if (Array.from(message).length > 500 || !isSmsWithinSegmentLimit(message)) {
    throw new Error('SMS messages must contain 500 characters or fewer and no more than 4 SMS segments.');
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
    throw new Error('The SMS idempotency key must be between 8 and 255 characters.');
  }

  const admin = await createAdminClient();
  const row = {
    tenant_id: input.tenantId,
    recipient_id: input.recipientId ?? null,
    recipient_phone: phone,
    message,
    sender_id: input.senderId?.trim() || null,
    idempotency_key: idempotencyKey,
    status: 'pending',
    scheduled_at: new Date().toISOString(),
  };

  const { data: prior, error: priorError } = await admin
    .schema('church')
    .from('sms_queue')
    .select('id, tenant_id, recipient_id, recipient_phone, message, sender_id, idempotency_key, status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (priorError) throw new Error(`Could not check SMS idempotency: ${priorError.message}`);
  if (prior) {
    if (
      prior.tenant_id !== row.tenant_id || prior.recipient_id !== row.recipient_id ||
      prior.recipient_phone !== row.recipient_phone || prior.message !== row.message ||
      (prior.sender_id ?? '') !== (row.sender_id ?? '')
    ) {
      throw new Error('The SMS idempotency key is already bound to a different message.');
    }
    return { id: prior.id, idempotencyKey, status: prior.status, alreadyExisted: true };
  }

  const volumeLimit = await checkRateLimit({
    namespace: 'sms-volume-tenant',
    subject: input.tenantId,
    limit: 1_000,
    windowSeconds: 60 * 60,
    cost: smsSegmentCount(message),
  });
  if (!volumeLimit.allowed) {
    throw new Error(volumeLimit.unavailable
      ? 'SMS protection is temporarily unavailable.'
      : 'The church hourly SMS volume limit has been reached.');
  }

  const { data: inserted, error: insertError } = await admin
    .schema('church')
    .from('sms_queue')
    .insert(row)
    .select('id, idempotency_key, status')
    .single();

  if (inserted) {
    return { id: inserted.id, idempotencyKey: inserted.idempotency_key, status: inserted.status, alreadyExisted: false };
  }

  // A duplicate idempotency key means retry the same durable job, never create a second one.
  if (insertError?.code === '23505') {
    const { data: existing, error: lookupError } = await admin
      .schema('church')
      .from('sms_queue')
      .select('id, tenant_id, recipient_id, recipient_phone, message, sender_id, idempotency_key, status')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (lookupError || !existing) {
      throw new Error(`Could not load the existing SMS queue item: ${lookupError?.message ?? 'not found'}`);
    }
    if (
      existing.tenant_id !== input.tenantId ||
      existing.recipient_id !== row.recipient_id ||
      existing.recipient_phone !== phone ||
      existing.message !== message ||
      (existing.sender_id ?? '') !== (row.sender_id ?? '')
    ) {
      throw new Error('The SMS idempotency key is already bound to a different message.');
    }
    return { id: existing.id, idempotencyKey, status: existing.status, alreadyExisted: true };
  }

  throw new Error(`Failed to insert SMS queue item: ${insertError?.message ?? 'unknown database error'}`);
}

/** Return the initiating user's access token when the server-side client has one. */
async function getSupabaseAccessToken(supabase: unknown): Promise<string | null> {
  const auth = (supabase as { auth?: { getSession?: () => Promise<{ data?: { session?: { access_token?: string } | null } }> } } | undefined)?.auth;
  if (!auth?.getSession) return null;
  try {
    const { data } = await auth.getSession();
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Calls the deployed Edge Function with only the durable queue ID as payload.
 * If the HTTP call times out, callers must retry this ID, never enqueue another row.
 */
export async function dispatchSmsQueueItem(
  smsId: string,
  timeoutMs = 35_000,
  accessToken?: string | null,
): Promise<Record<string, unknown>> {
  const projectUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.replace(/\/$/, '');
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const dispatchSecret = process.env.CHURCH_DISPATCH_SECRET;
  const bearerToken = accessToken || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!projectUrl || !publishableKey || !dispatchSecret || !bearerToken) {
    throw new Error('SMS Edge dispatch requires Supabase URL, publishable key, server-side JWT, and CHURCH_DISPATCH_SECRET.');
  }

  const response = await fetch(`${projectUrl}/functions/v1/church-najiki-dispatch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      apikey: publishableKey,
      'content-type': 'application/json',
      'x-dispatch-secret': dispatchSecret,
    },
    body: JSON.stringify({ sms_id: smsId }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`SMS Edge dispatch returned ${response.status}: ${String((result as any)?.error ?? 'request failed')}`);
  }
  return result as Record<string, unknown>;
}

export async function dispatchSmsQueueItems(
  ids: string[],
  concurrency = 10,
  accessToken?: string | null,
) {
  const results: Array<{ id: string; ok: boolean; status?: string; error?: string }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), ids.length) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const result = await dispatchSmsQueueItem(id, 35_000, accessToken);
        const status = typeof result.status === 'string' ? result.status : undefined;
        results.push({ id, ok: status !== 'failed', status });
      } catch (error) {
        // The row is already durable; lease recovery will safely retry this same ID.
        results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Replace the old direct-send helper with a durable queue + Edge invocation.
 * `supabase` and `balance` are retained as optional compatibility inputs for callers
 * during migration; wallet debit is performed transactionally by the Edge Function.
 */
export async function sendSingleSMS({
  supabase,
  phoneNumber,
  message,
  churchId,
  idempotencyKey,
  senderId,
  recipientId,
}: {
  supabase?: unknown;
  phoneNumber: string;
  message: string;
  churchId: string;
  idempotencyKey: string;
  senderId?: string;
  recipientId?: string;
  balance?: unknown;
}) {
  const queued = await enqueueSmsDispatch({
    tenantId: churchId,
    phoneNumber,
    message,
    senderId,
    recipientId,
    idempotencyKey,
  });
  if (queued.status === 'failed' || queued.status === 'cancelled') {
    throw new Error('This SMS idempotency key is already attached to a failed queue item. Use a new key for a deliberate resend.');
  }

  let dispatched: Record<string, unknown> | null = null;
  let dispatchPending = false;
  try {
    const accessToken = await getSupabaseAccessToken(supabase);
    dispatched = await dispatchSmsQueueItem(queued.id, 35_000, accessToken);
  } catch (error) {
    // Do not discard or recreate the row after an invocation timeout/error.
    dispatchPending = true;
    console.warn('[SMS] Edge invocation deferred; queue recovery will retry the same ID:', error instanceof Error ? error.message : error);
  }

  if (dispatched?.status === 'failed') {
    throw new Error('Na’jiki permanently rejected the SMS; the queue item was marked failed.');
  }

  return {
    success: true,
    status: dispatched?.skipped ? queued.status : dispatched?.status ?? queued.status,
    messageId: dispatched?.smsId ?? null,
    queueId: queued.id,
    idempotencyKey: queued.idempotencyKey,
    deduplicated: queued.alreadyExisted || Boolean(dispatched?.deduplicated),
    dispatchPending,
  };
}
