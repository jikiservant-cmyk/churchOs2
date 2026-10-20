import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { startActivationPayment, SUPPORTED_ACTIVATION_PROVIDERS } from '@/lib/activation';
import { isChurchAdminRole } from '@/lib/roles';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Determine caller's church from server-side trusted admin profile
    const { data: profile, error: profileError } = await supabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile?.tenant_id) {
      return NextResponse.json({ error: 'No church workspace linked to this user' }, { status: 400 });
    }

    // Activation is a church-admin operation: paying for (or re-paying for) a
    // workspace must not be possible for non-admin role holders.
    if (!isChurchAdminRole(String(profile.role || '').toLowerCase())) {
      return NextResponse.json({ error: 'Forbidden: you do not have permission to manage this workspace' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const phoneNumber = String(body.phoneNumber || body.phone || '').trim();
    const provider = String(body.provider || 'najiki').trim().toLowerCase();

    if (!SUPPORTED_ACTIVATION_PROVIDERS.includes(provider as (typeof SUPPORTED_ACTIVATION_PROVIDERS)[number])) {
      return NextResponse.json(
        { error: `Unsupported payment provider: ${provider}. Supported: ${SUPPORTED_ACTIVATION_PROVIDERS.join(', ')}` },
        { status: 400 }
      );
    }

    if (!phoneNumber) {
      return NextResponse.json({ error: 'Phone number is required for mobile money payment' }, { status: 400 });
    }

    const result = await startActivationPayment({
      churchId: profile.tenant_id,
      userId: user.id,
      phoneNumber,
      provider
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to start payment' }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[API Start Activation] Unhandled error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
