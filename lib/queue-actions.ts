import { randomUUID } from 'node:crypto';
import { normalizeUgPhone } from '@/lib/utils';
import { tenantScopedAdmin } from '@/lib/supabase/tenant-scoped';
import { isSmsWithinSegmentLimit } from '@/supabase/functions/_shared/sms-length';
import { hasSmsQueueStatus, SMS_QUEUE_STATUS } from '@/lib/sms-queue-status';

export interface EnqueueBroadcastParams {
  tenantId: string;
  message: string;
  audience?: string;
  senderId: string;
  recipients: Array<{ id: string; full_name: string; phone_number: string }>;
  createdBy?: string;
}

export interface EnqueueResult {
  /** API-compatible name; this is a queue batch ID, not a church.broadcasts row. */
  broadcastId: string;
  enqueued: number;
  skipped: number;
  queueIds: string[];
}

export interface BroadcastStatus {
  broadcastId: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  total: number;
  sent: number;
  failed: number;
  pending: number;
  percentComplete: number;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Persist one lowercase-pending queue row per recipient. The batch UUID is
 * embedded in each row's idempotency key, avoiding any assumed batch column
 * or dependency on church.broadcasts/church.broadcast_sessions.
 */
export async function enqueueBroadcast(params: EnqueueBroadcastParams): Promise<EnqueueResult> {
  if (!params.tenantId || typeof params.message !== 'string' || !params.message.trim() || Array.from(params.message).length > 500 || !isSmsWithinSegmentLimit(params.message)) {
    throw new Error('A church ID and SMS message of at most 500 characters are required.');
  }
  if (!Array.isArray(params.recipients) || params.recipients.length < 1 || params.recipients.length > 250) {
    throw new Error('Broadcasts must contain between 1 and 250 recipients.');
  }
  const scopedDb = await tenantScopedAdmin(params.tenantId);
  const batchId = randomUUID();
  const rows: Array<Record<string, unknown>> = [];
  let skipped = 0;

  for (let i = 0; i < params.recipients.length; i++) {
    const recipient = params.recipients[i];
    const phone = normalizeUgPhone(recipient.phone_number);
    if (!phone) {
      skipped++;
      continue;
    }

    const name = recipient.full_name?.trim() || 'Member';
    const message = params.message
      .replace(/{name}/gi, name)
      .replace(/{first_name}/gi, name.split(/\s+/)[0] || 'Member');
    if (Array.from(message).length > 500 || !isSmsWithinSegmentLimit(message)) {
      throw new Error('A personalized SMS exceeds the 500-character or 4-segment limit.');
    }

    rows.push({
      tenant_id: params.tenantId,
      recipient_id: recipient.id,
      recipient_phone: phone,
      message,
      sender_id: params.senderId?.trim() || null,
      status: SMS_QUEUE_STATUS.pending,
      scheduled_at: new Date().toISOString(),
      idempotency_key: `bcast_${batchId}_${recipient.id}_${i}`,
    });
  }

  // Insert the whole bounded batch in one PostgreSQL statement. Splitting it
  // into multiple requests could leave a partially queued broadcast if a later
  // chunk failed; the queue worker might then send an incomplete batch while
  // the client sees an error and retries.
  const { data, error } = await scopedDb
    .church('sms_queue')
    .insert(rows)
    .select('id');
  if (error) throw new Error(`Queue insert failed: ${error.message}`);
  const queueIds = (data ?? []).map((row: { id: string }) => row.id);

  return { broadcastId: batchId, enqueued: queueIds.length, skipped, queueIds };
}

/** Progress is computed from the live queue only; no church.broadcasts schema is assumed. */
export async function getBroadcastStatus(
  batchId: string,
  tenantId: string,
): Promise<BroadcastStatus | null> {
  const scopedDb = await tenantScopedAdmin(tenantId);
  const { data: rows, error } = await scopedDb
    .church('sms_queue')
    .select('status, created_at, processed_at')
    .like('idempotency_key', `bcast_${batchId}_%`);

  if (error) throw new Error(`Could not read queue batch status: ${error.message}`);
  if (!rows?.length) return null;

  const sent = rows.filter((row: { status: string }) => hasSmsQueueStatus(row.status, SMS_QUEUE_STATUS.sent)).length;
  const failed = rows.filter((row: { status: string }) =>
    hasSmsQueueStatus(row.status, SMS_QUEUE_STATUS.failed) || hasSmsQueueStatus(row.status, SMS_QUEUE_STATUS.cancelled),
  ).length;
  const pending = rows.length - sent - failed;
  const status: BroadcastStatus['status'] = pending > 0
    ? sent + failed === 0 ? 'QUEUED' : 'PROCESSING'
    : failed === 0 ? 'COMPLETED' : sent === 0 ? 'FAILED' : 'PARTIAL';
  const createdAt = rows.map((row: { created_at: string }) => row.created_at).sort()[0];
  const completedAt = pending === 0
    ? rows.map((row: { processed_at: string | null }) => row.processed_at).filter(Boolean).sort().at(-1) ?? null
    : null;

  return {
    broadcastId: batchId,
    status,
    total: rows.length,
    sent,
    failed,
    pending,
    percentComplete: Math.round(((sent + failed) / rows.length) * 100),
    createdAt,
    completedAt,
  };
}
