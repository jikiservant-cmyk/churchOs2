import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { startActivationPayment } from '@/lib/activation';

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const phoneNumber = typeof body.phoneNumber === 'string'
      ? body.phoneNumber.trim()
      : typeof body.phone === 'string' ? body.phone.trim() : '';
    const plan = typeof body.plan === 'string' ? body.plan.trim() || undefined : undefined;
    const churchIdParam = typeof body.churchId === 'string' ? body.churchId.trim() : '';

    // The request body is not proof of church ownership. Only the authenticated
    // user's existing admin profile may select the activation ledger tenant.
    const adminSupabase = await createAdminClient();
    const { data: profile, error: profileError } = await adminSupabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json({ error: 'Unable to verify church administrator access' }, { status: 500 });
    }
    if (!profile?.tenant_id || !['pastor', 'admin'].includes(profile.role)) {
      return NextResponse.json({ error: 'A linked pastor or administrator account is required' }, { status: 403 });
    }
    if (churchIdParam && churchIdParam !== profile.tenant_id) {
      return NextResponse.json({ error: 'Access denied for this church workspace' }, { status: 403 });
    }
    const targetTenantId = profile.tenant_id;

    if (!phoneNumber) {
      return NextResponse.json({ error: 'Phone number is required for mobile money payment' }, { status: 400 });
    }

    const result = await startActivationPayment({
      churchId: targetTenantId,
      userId: user.id,
      phoneNumber,
      plan
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to start payment' }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[API Start Activation] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal Server Error' }, { status: 500 });
  }
}
