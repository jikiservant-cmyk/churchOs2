import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { confirmActivationPayment, ACTIVATION_FEE_UGX } from '@/lib/activation';

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('admin_profiles')
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile?.tenant_id) {
      return NextResponse.json({ error: 'No church found' }, { status: 400 });
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
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}
