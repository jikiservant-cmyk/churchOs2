import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getChurchActivationStatus } from '@/lib/activation';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
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
      return NextResponse.json({ error: 'No church workspace linked' }, { status: 400 });
    }

    const status = await getChurchActivationStatus(profile.tenant_id);

    if (!status) {
      return NextResponse.json({ error: 'Failed to retrieve activation status' }, { status: 404 });
    }

    return NextResponse.json(status);
  } catch (err: any) {
    console.error('[API Activation Status] Error:', err);
    return NextResponse.json({ error: err?.message || 'Internal Server Error' }, { status: 500 });
  }
}
