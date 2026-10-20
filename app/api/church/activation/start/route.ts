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
    const phoneNumber = (body.phoneNumber || body.phone || '').trim();
    const provider = (body.provider || 'najiki').trim();
    const amount = Number(body.amount) || undefined;
    const plan = (body.plan || '').trim() || undefined;
    const churchIdParam = (body.churchId || '').trim();
    const churchSlugParam = (body.churchSlug || '').trim();

    // Use admin client to reliably bypass RLS restrictions
    const adminSupabase = await createAdminClient();

    let { data: profile } = await adminSupabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    // Fallback: check by email
    if (!profile?.tenant_id && user.email) {
      const { data: emailProfile } = await adminSupabase
        .from('admin_profiles')
        .select('tenant_id, role')
        .eq('email', user.email)
        .maybeSingle();

      if (emailProfile?.tenant_id) {
        profile = emailProfile;
      }
    }

    let targetTenantId = profile?.tenant_id;

    // If tenant_id was not yet in profile, resolve from churchId or churchSlug and link it
    if (!targetTenantId && churchIdParam) {
      const { data: church } = await adminSupabase
        .schema('church')
        .from('churches')
        .select('id')
        .eq('id', churchIdParam)
        .maybeSingle();

      if (church) {
        targetTenantId = church.id;
        await adminSupabase
          .from('admin_profiles')
          .upsert({
            id: user.id,
            email: user.email,
            tenant_id: church.id,
            role: 'pastor',
            app_type: 'church'
          }, { onConflict: 'id' });
      }
    }

    if (!targetTenantId && churchSlugParam) {
      const { data: church } = await adminSupabase
        .schema('church')
        .from('churches')
        .select('id')
        .eq('slug', churchSlugParam)
        .maybeSingle();

      if (church) {
        targetTenantId = church.id;
        await adminSupabase
          .from('admin_profiles')
          .upsert({
            id: user.id,
            email: user.email,
            tenant_id: church.id,
            role: 'pastor',
            app_type: 'church'
          }, { onConflict: 'id' });
      }
    }

    if (!targetTenantId) {
      return NextResponse.json({ error: 'No church workspace linked to this user' }, { status: 400 });
    }

    if (!phoneNumber) {
      return NextResponse.json({ error: 'Phone number is required for mobile money payment' }, { status: 400 });
    }

    const result = await startActivationPayment({
      churchId: targetTenantId,
      userId: user.id,
      phoneNumber,
      provider,
      amount,
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
