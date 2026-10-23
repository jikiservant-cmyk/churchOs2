import { createAdminClient } from '@/lib/supabase/server';
import { normalizeUgPhone } from '@/lib/utils';

export type EnqueueSmsInput = {
  tenantId: string;
  phoneNumber: string;
  message: string;
  senderId?: string | null;
  recipientId?: string | null;
  broadcastId?: string | null;
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
  const message = input.message.trim();
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';

  if (!input.tenantId || !phone || !message) {
    throw new Error('A tenant, valid Ugandan phone number, and message are required.');
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
    throw new Error('The SMS idempotency key must be between 8 and 255 characters.');
  }

  const admin = await createAdminClient();
  const row = {
    tenant_id: input.tenantId,
    broadcast_id: input.broadcastId ?? null,
    recipient_id: input.recipientId ?? null,
    recipient_phone: phone,
    message,
    sender_id: input.senderId?.trim() || null,
    idempotency_key: idempotencyKey,
    status: 'PENDING',
    scheduled_at: new Date().toISOString(),
  };

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
      .select('id, tenant_id, recipient_phone, message, sender_id, idempotency_key, status')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (lookupError || !existing) {
      throw new Error(`Could not load the existing SMS queue item: ${lookupError?.message ?? 'not found'}`);
    }
    if (
      existing.tenant_id !== input.tenantId ||
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

/**
 * Calls the deployed Edge Function with only the durable queue ID as payload.
 * If the HTTP call times out, callers must retry this ID, never enqueue another row.
 */
export async function dispatchSmsQueueItem(smsId: string, timeoutMs = 12_000): Promise<Record<string, unknown>> {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const dispatchSecret = process.env.SMS_DISPATCH_SECRET;

  if (!projectUrl || !publishableKey || !dispatchSecret) {
    throw new Error('SMS Edge dispatch is not configured. Set Supabase URL/key and SMS_DISPATCH_SECRET.');
  }

  const response = await fetch(`${projectUrl}/functions/v1/church-najiki-dispatch`, {
    method: 'POST',
    headers: {
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

export async function dispatchSmsQueueWorker(timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const dispatchSecret = process.env.SMS_DISPATCH_SECRET;
  if (!projectUrl || !publishableKey || !dispatchSecret) {
    throw new Error('SMS Edge worker is not configured. Set Supabase URL/key and SMS_DISPATCH_SECRET.');
  }

  const response = await fetch(`${projectUrl}/functions/v1/church-najiki-queue-worker`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'content-type': 'application/json',
      'x-dispatch-secret': dispatchSecret,
    },
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`SMS Edge queue worker returned ${response.status}: ${String((result as any)?.error ?? 'request failed')}`);
  }
  return result as Record<string, unknown>;
}

export async function dispatchSmsQueueItems(ids: string[], concurrency = 10) {
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), ids.length) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        await dispatchSmsQueueItem(id);
        results.push({ id, ok: true });
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
  if (queued.status === 'FAILED') {
    throw new Error('This SMS idempotency key is already attached to a FAILED queue item. Use a new key for a deliberate resend.');
  }

  let dispatched: Record<string, unknown> | null = null;
  let dispatchPending = false;
  try {
    dispatched = await dispatchSmsQueueItem(queued.id);
  } catch (error) {
    // Do not discard or recreate the row after an invocation timeout/error.
    dispatchPending = true;
    console.warn('[SMS] Edge invocation deferred; queue recovery will retry the same ID:', error instanceof Error ? error.message : error);
  }

  if (dispatched?.status === 'failed') {
    throw new Error('Na’jiki permanently rejected the SMS; the queue item was marked FAILED.');
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
