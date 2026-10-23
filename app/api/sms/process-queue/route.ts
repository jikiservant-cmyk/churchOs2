import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { dispatchSmsQueueWorker } from '@/lib/sms-dispatch';

const QUEUE_SECRET = process.env.QUEUE_PROCESSOR_SECRET;

function isAuthorized(request: Request): boolean {
  if (!QUEUE_SECRET) return false;
  const provided = request.headers.get('x-queue-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(QUEUE_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function run(request: Request) {
  if (!QUEUE_SECRET) {
    return NextResponse.json({ error: 'Queue processor secret not configured.' }, { status: 503 });
  }
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // This route only wakes the Edge worker. The worker scans due PENDING rows
    // and expired PROCESSING leases, then calls the single-row dispatcher by ID.
    const result = await dispatchSmsQueueWorker();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[ProcessQueue] Edge worker invocation failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Queue dispatch failed.' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  return run(request);
}

export async function GET(request: Request) {
  return run(request);
}
