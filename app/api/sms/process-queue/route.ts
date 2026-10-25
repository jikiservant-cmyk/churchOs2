import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { dispatchSmsQueueItems } from '@/lib/sms-dispatch';

const QUEUE_SECRET = process.env.QUEUE_PROCESSOR_SECRET;
const HAS_STRONG_QUEUE_SECRET = Boolean(QUEUE_SECRET && Buffer.byteLength(QUEUE_SECRET) >= 32 && !QUEUE_SECRET.includes('REPLACE_ME'));

function isAuthorized(request: Request): boolean {
  if (!QUEUE_SECRET || !HAS_STRONG_QUEUE_SECRET) return false;
  const provided = request.headers.get('x-queue-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(QUEUE_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function run(request: Request) {
  if (!QUEUE_SECRET || !HAS_STRONG_QUEUE_SECRET) {
    return NextResponse.json({ error: 'A strong queue processor secret is not configured.' }, { status: 503 });
  }
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const admin = await createAdminClient();
    const now = new Date().toISOString();
    const [pendingResult, expiredResult] = await Promise.all([
      admin.schema('church').from('sms_queue').select('id')
        .eq('status', 'pending')
        .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
        .order('scheduled_at', { ascending: true })
        .limit(20),
      admin.schema('church').from('sms_queue').select('id')
        .eq('status', 'processing')
        .or(`locked_until.is.null,locked_until.lte.${now}`)
        .order('locked_until', { ascending: true })
        .limit(20),
    ]);

    if (pendingResult.error) throw new Error(`Pending queue lookup failed: ${pendingResult.error.message}`);
    if (expiredResult.error) throw new Error(`Expired lease lookup failed: ${expiredResult.error.message}`);

    const ids = [...new Set([
      ...(pendingResult.data ?? []).map((row) => row.id),
      ...(expiredResult.data ?? []).map((row) => row.id),
    ])];
    const outcomes = await dispatchSmsQueueItems(ids, 5);
    return NextResponse.json({
      success: true,
      candidates: ids.length,
      sent: outcomes.filter((result) => result.status === 'sent').length,
      pending: outcomes.filter((result) => result.status === 'pending' || !result.ok).length,
      failed: outcomes.filter((result) => result.status === 'failed').length,
      skipped: outcomes.filter((result) => result.status === 'not_due_or_already_claimed').length,
    });
  } catch (error) {
    console.error('[ProcessQueue] Queue dispatch failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Queue dispatch failed.' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  return run(request);
}

export async function GET(request: Request) {
  return run(request);
}
