import { randomUUID } from 'node:crypto';
import { normalizeUgPhone } from '@/lib/utils';
import { tenantScopedAdmin } from '@/lib/supabase/tenant-scoped';

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

    rows.push({
      tenant_id: params.tenantId,
      recipient_id: recipient.id,
      recipient_phone: phone,
      message,
      sender_id: params.senderId?.trim() || null,
      status: 'pending',
      scheduled_at: new Date().toISOString(),
      idempotency_key: `bcast_${batchId}_${recipient.id}_${i}`,
    });
  }

  const queueIds: string[] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const { data, error } = await scopedDb
      .church('sms_queue')
      .insert(rows.slice(offset, offset + 100))
      .select('id');
    if (error) throw new Error(`Queue insert failed at offset ${offset}: ${error.message}`);
    queueIds.push(...(data ?? []).map((row: { id: string }) => row.id));
  }

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

  const sent = rows.filter((row: { status: string }) => row.status === 'sent').length;
  const failed = rows.filter((row: { status: string }) => row.status === 'failed' || row.status === 'cancelled').length;
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
