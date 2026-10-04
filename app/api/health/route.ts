import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — uptime/monitoring endpoint (public, no auth).
 *
 * Point any uptime monitor (UptimeRobot, Better Stack, Netlify functions
 * health checks, a cron curl, …) at `/api/health` and it will catch the
 * two production failure modes that matter most for this app:
 *
 *   200 { status: 'ok',        db: 'ok' }             — app + Postgres reachable
 *   503 { status: 'degraded',  db: 'not_configured' } — service-role key missing
 *   503 { status: 'degraded',  db: 'error' }          — database unreachable
 *
 * It deliberately exposes no data, row counts or version info — just enough
 * signal to page someone.
 */
export async function GET() {
  const noStore = { 'cache-control': 'no-store' } as const;

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json(
      { status: 'degraded', db: 'not_configured', time: new Date().toISOString() },
      { status: 503, headers: noStore }
    );
  }

  try {
    const admin = await createAdminClient();
    // Cheapest possible existence probe against the tenant schema.
    const { error } = await admin
      .schema('church')
      .from('churches')
      .select('id')
      .limit(1);

    if (error) {
      throw error;
    }

    return NextResponse.json(
      { status: 'ok', db: 'ok', time: new Date().toISOString() },
      { headers: noStore }
    );
  } catch (err) {
    console.error('[Health] Database probe failed:', (err as Error)?.message ?? err);
    return NextResponse.json(
      { status: 'degraded', db: 'error', time: new Date().toISOString() },
      { status: 503, headers: noStore }
    );
  }
}
