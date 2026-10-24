'use server';

import { createClient } from './supabase/server';
import { revalidatePath } from 'next/cache';

async function isAuthorizedOverseer(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data: profile, error } = await supabase
    .from('admin_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  return !error && profile?.role === 'overseer';
}

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
  label?: string;
  code?: string;
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
  if (!await isAuthorizedOverseer(supabase, user.id)) {
    return { error: 'Forbidden: overseer access required' };
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

    const rawTotal = totalsData?.[0] || {};
    const totals: OverseerTotals = {
      total_churches: Number(rawTotal.church_count ?? rawTotal.total_churches ?? (Array.isArray(churchesData) ? churchesData.length : 0)),
      total_members: Number(rawTotal.member_total ?? rawTotal.total_members ?? 0),
      total_giving: Number(rawTotal.giving_total ?? rawTotal.total_giving ?? 0),
      active_pastors: Number(rawTotal.active_churches_30d ?? rawTotal.active_pastors ?? (Array.isArray(churchesData) ? churchesData.length : 0)),
      denomination_name: rawTotal.denomination_name,
      denomination_slug: rawTotal.denomination_slug,
    };

    const churches: OverseerChurchItem[] = Array.isArray(churchesData)
      ? churchesData.map((c: any) => ({
          church_id: c.church_id || c.id,
          name: c.church_name || c.name || 'Unnamed Parish',
          slug: c.slug || '',
          pastor_name: c.pastor_name || c.pastor_email?.split('@')[0] || 'Pastor',
          pastor_email: c.pastor_email || null,
          member_count: Number(c.member_count || 0),
          recent_attendance: Number(c.attendance_30d ?? c.recent_attendance ?? 0),
          total_giving: Number(c.total_giving || 0),
          joined_at: c.joined_at || c.created_at || new Date().toISOString(),
          status: c.status || 'active',
        }))
      : [];
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
  const label = (formData.get('label') as string || '').trim();
  const maxUsesRaw = (formData.get('max_uses') as string || '').trim();
  const expiresInDaysRaw = (formData.get('expires_in_days') as string || '14').trim();
  const maxUses = maxUsesRaw ? Number(maxUsesRaw) : null;
  const expiresInDays = Number(expiresInDaysRaw);

  if (!label || label.length > 100) {
    return { error: 'Invite label must be between 1 and 100 characters.' };
  }
  if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1)) {
    return { error: 'Maximum uses must be a positive whole number or left blank for unlimited uses.' };
  }
  if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1) {
    return { error: 'Expiration must be a positive number of days.' };
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Authentication required' };
  }
  if (!await isAuthorizedOverseer(supabase, user.id)) {
    return { error: 'Forbidden: overseer access required' };
  }

  try {
    const { data, error } = await supabase.rpc('overseer_create_invite', {
      p_label: label,
      p_max_uses: maxUses,
      p_expires_in_days: expiresInDays,
    });

    if (error) {
      return { error: error.message };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.code !== 'string' || !row.code.trim()) {
      console.error('[Overseer] Invite RPC returned no generated code.');
      return { error: 'The invite was created, but no code was returned. Please contact support before creating another.' };
    }

    const invite: OverseerInvite = {
      id: row.invite_id ? String(row.invite_id) : undefined,
      label,
      code: row.code,
      max_uses: maxUses,
      uses_count: 0,
      expires_at: row.expires_at ?? null,
      created_at: new Date().toISOString(),
    };

    revalidatePath('/overseer');
    return { success: true, invite };
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
  if (!await isAuthorizedOverseer(supabase, user.id)) {
    return { error: 'Forbidden: overseer access required' };
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
  if (!await isAuthorizedOverseer(supabase, user.id)) {
    return { error: 'Forbidden: overseer access required' };
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
