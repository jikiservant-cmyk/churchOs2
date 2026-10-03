'use server';

import { createClient } from './supabase/server';
import { revalidatePath } from 'next/cache';

export interface OverseerChurchItem {
  church_id: string;
  name: string;
  slug: string;
  pastor_name?: string | null;
  pastor_email?: string | null;
  member_count?: number;
  recent_attendance?: number;
  total_giving?: number;
  joined_at?: string;
  status?: string;
}

export interface OverseerTotals {
  total_churches: number;
  total_members: number;
  total_giving: number;
  active_pastors: number;
  denomination_name?: string;
  denomination_slug?: string;
}

export interface OverseerInvite {
  id?: string;
  code: string;
  max_uses?: number | null;
  uses_count?: number;
  expires_at?: string | null;
  created_at?: string;
  revoked?: boolean;
}

/**
 * Fetch denomination aggregates and church summaries for authenticated overseer.
 */
export async function getOverseerDashboardData() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Authentication required' };
  }

  try {
    // 1. Fetch totals
    const { data: totalsData, error: totalsError } = await supabase.rpc('overseer_denomination_totals');
    if (totalsError) {
      console.warn('[Overseer] totals RPC notice:', totalsError.message);
    }

    // 2. Fetch churches
    const { data: churchesData, error: churchesError } = await supabase.rpc('overseer_church_summary');
    if (churchesError) {
      console.warn('[Overseer] churches RPC notice:', churchesError.message);
    }

    // 3. Fetch invites
    const { data: invitesData, error: invitesError } = await supabase.rpc('overseer_list_invites');
    if (invitesError) {
      console.warn('[Overseer] invites RPC notice:', invitesError.message);
    }

    const totals: OverseerTotals = totalsData?.[0] || {
      total_churches: Array.isArray(churchesData) ? churchesData.length : 0,
      total_members: 0,
      total_giving: 0,
      active_pastors: 0,
    };

    const churches: OverseerChurchItem[] = (churchesData as OverseerChurchItem[]) || [];
    const invites: OverseerInvite[] = (invitesData as OverseerInvite[]) || [];

    return {
      success: true,
      totals,
      churches,
      invites,
    };
  } catch (err: any) {
    console.error('[Overseer] getOverseerDashboardData error:', err);
    return { error: err?.message || 'Failed to load overseer data' };
  }
}

/**
 * Creates a new pastor invite code for the overseer's denomination.
 */
export async function createOverseerInvite(formData: FormData) {
  const code = (formData.get('code') as string || '').trim().toUpperCase();
  const maxUsesStr = formData.get('max_uses') as string;
  const expiresAt = (formData.get('expires_at') as string || '').trim();

  const maxUses = maxUsesStr ? parseInt(maxUsesStr, 10) : null;

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Authentication required' };
  }

  try {
    const params: Record<string, any> = {};
    if (code) params.p_code = code;
    if (maxUses && !isNaN(maxUses)) params.p_max_uses = maxUses;
    if (expiresAt) params.p_expires_at = expiresAt;

    const { data, error } = await supabase.rpc('overseer_create_invite', params);

    if (error) {
      return { error: error.message };
    }

    revalidatePath('/overseer');
    return { success: true, invite: data };
  } catch (err: any) {
    return { error: err?.message || 'Failed to create invite' };
  }
}

/**
 * Revokes an existing invite code.
 */
export async function revokeOverseerInvite(inviteIdentifier: string) {
  if (!inviteIdentifier) {
    return { error: 'Invite identifier required' };
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Authentication required' };
  }

  try {
    // Attempt with invite identifier (could be id or code)
    const { error } = await supabase.rpc('overseer_revoke_invite', {
      p_invite_id: inviteIdentifier,
    });

    if (error) {
      // Fallback try with p_code if signature expects code
      const { error: codeErr } = await supabase.rpc('overseer_revoke_invite', {
        p_code: inviteIdentifier,
      });
      if (codeErr) {
        return { error: error.message };
      }
    }

    revalidatePath('/overseer');
    return { success: true };
  } catch (err: any) {
    return { error: err?.message || 'Failed to revoke invite' };
  }
}

/**
 * Detaches a church from the overseer's denomination.
 */
export async function detachOverseerChurch(churchId: string) {
  if (!churchId) {
    return { error: 'Church ID required' };
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Authentication required' };
  }

  try {
    const { error } = await supabase.rpc('overseer_detach_church', {
      p_church_id: churchId,
    });

    if (error) {
      return { error: error.message };
    }

    revalidatePath('/overseer');
    return { success: true };
  } catch (err: any) {
    return { error: err?.message || 'Failed to detach church' };
  }
}
