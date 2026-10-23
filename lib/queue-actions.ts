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

/** Persist a broadcast and its one-row-per-recipient queue. No SMS is sent here. */
export async function enqueueBroadcast(params: EnqueueBroadcastParams): Promise<EnqueueResult> {
  const scopedDb = await tenantScopedAdmin(params.tenantId);
  const { data: broadcast, error: broadcastError } = await scopedDb
    .church('broadcasts')
    .insert({
      message_template: params.message,
      audience: params.audience ?? 'all',
      total_recipients: 0,
      status: 'QUEUED',
      created_by: params.createdBy ?? null,
    })
    .select('id')
    .single();

  if (broadcastError || !broadcast) {
    throw new Error(`Failed to create broadcast: ${broadcastError?.message ?? 'unknown database error'}`);
  }

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
      broadcast_id: broadcast.id,
      recipient_id: recipient.id,
      recipient_phone: phone,
      message,
      sender_id: params.senderId?.trim() || null,
      status: 'PENDING',
      scheduled_at: new Date().toISOString(),
      idempotency_key: `bcast_${broadcast.id}_${recipient.id}_${i}`,
    });
  }

  const queueIds: string[] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const { data, error } = await scopedDb
      .church('sms_queue')
      .insert(rows.slice(offset, offset + 100))
      .select('id');
    if (error) {
      throw new Error(`Queue insert failed at offset ${offset}: ${error.message}`);
    }
    queueIds.push(...(data ?? []).map((row: { id: string }) => row.id));
  }

  const now = new Date().toISOString();
  await scopedDb
    .church('broadcasts')
    .update({
      total_recipients: queueIds.length,
      status: queueIds.length ? 'QUEUED' : 'COMPLETED',
      completed_at: queueIds.length ? null : now,
      updated_at: now,
    })
    .eq('id', broadcast.id);

  return { broadcastId: broadcast.id, enqueued: queueIds.length, skipped, queueIds };
}

/** Tenant-scoped live progress derived from the queue's authoritative states. */
export async function getBroadcastStatus(
  broadcastId: string,
  tenantId: string,
): Promise<BroadcastStatus | null> {
  const scopedDb = await tenantScopedAdmin(tenantId);
  const { data: broadcast } = await scopedDb
    .church('broadcasts')
    .select('id, created_at')
    .eq('id', broadcastId)
    .maybeSingle();
  if (!broadcast) return null;

  const { data: rows, error } = await scopedDb
    .church('sms_queue')
    .select('status, updated_at')
    .eq('broadcast_id', broadcastId);
  if (error || !rows) throw new Error(`Could not read broadcast queue status: ${error?.message ?? 'unknown error'}`);

  const sent = rows.filter((row: { status: string }) => row.status === 'SENT').length;
  const failed = rows.filter((row: { status: string }) => row.status === 'FAILED').length;
  const pending = rows.length - sent - failed;
  const status: BroadcastStatus['status'] = pending > 0
    ? sent + failed === 0 ? 'QUEUED' : 'PROCESSING'
    : failed === 0 ? 'COMPLETED' : sent === 0 ? 'FAILED' : 'PARTIAL';
  const complete = pending === 0;
  const completedAt = complete && rows.length
    ? rows.map((row: { updated_at: string }) => row.updated_at).sort().at(-1) ?? null
    : null;

  return {
    broadcastId,
    status,
    total: rows.length,
    sent,
    failed,
    pending,
    percentComplete: rows.length ? Math.round(((sent + failed) / rows.length) * 100) : 100,
    createdAt: broadcast.created_at,
    completedAt,
  };
}
