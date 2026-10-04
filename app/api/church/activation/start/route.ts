import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { startActivationPayment } from '@/lib/activation';

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

    const body = await req.json().catch(() => ({}));
    const phoneNumber = (body.phoneNumber || body.phone || '').trim();
    const provider = (body.provider || 'najiki').trim();

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
    return NextResponse.json({ error: err?.message || 'Internal Server Error' }, { status: 500 });
  }
}
