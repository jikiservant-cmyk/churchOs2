import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { confirmActivationPayment, ACTIVATION_FEE_UGX, isSimulationEnabled } from '@/lib/activation';

export const dynamic = 'force-dynamic';

/**
 * ⚠️ TESTING-ONLY ENDPOINT.
 *
 * This confirms an activation payment WITHOUT any real provider money moving.
 * It exists so QA can exercise the full activation flow in a sandbox.
 *
 * Historically this was reachable by ANY signed-in church user (and a button
 * that called it was rendered in the production activation UI), which let a
 * pastor activate their church for free — a direct payment bypass.
 *
 * It is now disabled unless the deployment explicitly opts in by setting
 * `ACTIVATION_SIMULATION=true` (never set in production). Even when enabled,
 * it is scoped to the caller's OWN church, mirrors the real webhook's
 * amount/currency checks, and is logged.
 */
export async function POST(req: NextRequest) {
  if (!isSimulationEnabled()) {
    // Return 404 (not 403) so the endpoint's existence is not advertised.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    console.warn('[API Activate Simulation] SIMULATION ENABLED — confirming payment without a real provider transaction');

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile?.tenant_id) {
      return NextResponse.json({ error: 'No church found' }, { status: 400 });
    }

    if (!['pastor', 'admin'].includes(String(profile.role || '').toLowerCase())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const merchantReference = body.merchantReference;

    if (!merchantReference) {
      return NextResponse.json({ error: 'Missing merchantReference' }, { status: 400 });
    }

    const outcome = await confirmActivationPayment({
      merchantReference,
      providerTransactionId: `SIM-${Date.now()}`,
      paidAmount: ACTIVATION_FEE_UGX,
      currency: 'UGX',
      status: 'SUCCESS'
    });

    if (!outcome.success) {
      return NextResponse.json({ error: outcome.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: 'Simulation confirmed! Church activated.' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
