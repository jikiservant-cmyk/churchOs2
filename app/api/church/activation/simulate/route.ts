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

    const adminSupabase = await createAdminClient();
    let { data: profile } = await adminSupabase
      .from('admin_profiles')
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile?.tenant_id && user.email) {
      const { data: emailProfile } = await adminSupabase
        .from('admin_profiles')
        .select('tenant_id')
        .eq('email', user.email)
        .maybeSingle();
      if (emailProfile?.tenant_id) {
        profile = emailProfile;
      }
    }

    const body = await req.json().catch(() => ({}));
    const merchantReference = body.merchantReference;

    if (!merchantReference) {
      return NextResponse.json({ error: 'Missing merchantReference' }, { status: 400 });
    }

    const { data: payment } = await supabase
      .schema('church')
      .from('activation_payments')
      .select('amount, currency')
      .eq('merchant_reference', merchantReference)
      .maybeSingle();

    const paidAmount = payment?.amount ? Number(payment.amount) : ACTIVATION_FEE_UGX;

    const outcome = await confirmActivationPayment({
      merchantReference,
      providerTransactionId: `SIM-${Date.now()}`,
      paidAmount,
      currency: payment?.currency || 'UGX',
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
