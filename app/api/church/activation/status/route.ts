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

    const churchIdParam = req.nextUrl.searchParams.get('church_id');
    if (churchIdParam && churchIdParam !== profile.tenant_id) {
      return NextResponse.json({ error: 'Access denied for this church workspace' }, { status: 403 });
    }
    const targetTenantId = profile.tenant_id;

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
