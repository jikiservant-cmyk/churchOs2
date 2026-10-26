'use server';

import { createClient } from './supabase/server';
import { revalidatePath } from 'next/cache';
import {
  buildOverseerDashboardSnapshot,
  type OverseerChurchItem,
  type OverseerInvite,
  type OverseerTotals,
} from './overseer-dashboard-data';
export type { OverseerChurchItem, OverseerInvite, OverseerTotals } from './overseer-dashboard-data';

async function isAuthorizedOverseer(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  // Overseer access comes from the denomination membership relation, not from
  // the global admin_profiles role (which may be super_admin independently).
  const { data, error } = await supabase
    .schema('church')
    .from('denomination_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  return !error && data?.user_id === userId;
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
    const [totals, churches, invites] = await Promise.all([
      supabase.rpc('overseer_denomination_totals'),
      supabase.rpc('overseer_church_summary'),
      supabase.rpc('overseer_list_invites'),
    ]);

    if (totals.error || churches.error || invites.error) {
      console.error('[Overseer] Dashboard RPC failed:', {
        totals: totals.error?.message,
        churches: churches.error?.message,
        invites: invites.error?.message,
      });
    }

    return buildOverseerDashboardSnapshot({ totals, churches, invites });
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
