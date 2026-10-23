'use server';

import { createClient } from './supabase/server';
import { revalidatePath } from 'next/cache';

export async function joinDenominationWithInvite(inviteCode: string, churchSlug?: string) {
  const code = (inviteCode || '').trim();

  if (!code) {
    return { error: 'Please enter a valid denomination invite code' };
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Authentication required. Please sign in.' };
  }

  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('tenant_id, role')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile?.tenant_id || !['pastor', 'admin'].includes(profile.role)) {
    return { error: 'Forbidden: only church pastors or administrators can change denomination membership.' };
  }

  if (churchSlug) {
    const canonicalSlug = churchSlug.toLowerCase().trim();
    const { data: church } = await supabase
      .schema('church')
      .from('churches')
      .select('id')
      .eq('slug', canonicalSlug)
      .maybeSingle();
    if (!church || church.id !== profile.tenant_id) {
      return { error: 'Access denied for this church workspace.' };
    }
  }

  try {
    const { data: denominationId, error } = await supabase.rpc(
      'join_denomination_with_invite',
      { p_invite_code: code }
    );

    if (error) {
      console.error('[joinDenominationWithInvite] RPC error:', error);
      return { error: error.message || 'Failed to join denomination with this code' };
    }

    if (churchSlug) {
      revalidatePath(`/${churchSlug}/admin/settings`);
      revalidatePath(`/${churchSlug}/admin`);
    }

    return { 
      success: true, 
      denominationId,
      message: 'Successfully joined denomination network!'
    };
  } catch (err: any) {
    console.error('[joinDenominationWithInvite] Exception:', err);
    return { error: err?.message || 'An unexpected error occurred while joining denomination.' };
  }
}
