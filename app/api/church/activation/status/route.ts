import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { getChurchActivationStatus } from '@/lib/activation';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
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

    let targetTenantId = profile?.tenant_id;

    // Check query params if tenant_id was not yet attached to profile
    const churchSlugParam = req.nextUrl.searchParams.get('church_slug') || req.nextUrl.searchParams.get('slug');
    const churchIdParam = req.nextUrl.searchParams.get('church_id');

    if (!targetTenantId && churchIdParam) {
      targetTenantId = churchIdParam;
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
      }
    }

    if (!targetTenantId) {
      return NextResponse.json({ error: 'No church workspace linked' }, { status: 400 });
    }

    const status = await getChurchActivationStatus(targetTenantId);

    if (!status) {
      return NextResponse.json({ error: 'Failed to retrieve activation status' }, { status: 404 });
    }

    return NextResponse.json(status);
  } catch (err: any) {
    console.error('[API Activation Status] Error:', err);
    return NextResponse.json({ error: err?.message || 'Internal Server Error' }, { status: 500 });
  }
}
