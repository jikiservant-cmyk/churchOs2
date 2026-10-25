'use server';

import { revalidatePath } from 'next/cache';
import { createAdminClient, createClient } from '@/lib/supabase/server';

export interface SuperAdminDenominationOption {
  id: string;
  name: string;
  slug: string;
}

/** Always verify the caller's global role on the server before using service-role access. */
async function requireSuperAdmin() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { user: null, admin: null, supabase: null };

  const admin = await createAdminClient();
  const { data: profile, error } = await admin
    .from('admin_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (error || profile?.role !== 'super_admin') {
    return { user: null, admin: null, supabase: null };
  }

  return { user, admin, supabase };
}

export async function getSuperAdminOverseerRegistrationData(): Promise<{
  authorized: boolean;
  denominations: SuperAdminDenominationOption[];
}> {
  const { admin } = await requireSuperAdmin();
  if (!admin) return { authorized: false, denominations: [] };

  const { data, error } = await admin
    .schema('church')
    .from('denominations')
    .select('id, name, slug')
    .order('name', { ascending: true });

  if (error) {
    console.error('[SuperAdmin] Failed to load denominations:', error.message);
    return { authorized: true, denominations: [] };
  }

  return {
    authorized: true,
    denominations: (data || []).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
    })),
  };
}

export interface CreateDenominationActionState {
  error?: string;
  success?: boolean;
  name?: string;
  slug?: string;
}

function isHttpsUrl(value: string): boolean {
  if (!value) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function createDenomination(
  _previousState: CreateDenominationActionState | null,
  formData: FormData,
): Promise<CreateDenominationActionState> {
  const name = String(formData.get('name') || '').trim();
  const slug = String(formData.get('slug') || '').trim().toLowerCase();
  const primaryColor = String(formData.get('primary_color') || '#2563eb').trim();
  const logoUrl = String(formData.get('logo_url') || '').trim();
  const backgroundUrl = String(formData.get('background_url') || '').trim();
  const loginTitle = String(formData.get('login_title') || '').trim();
  const loginTagline = String(formData.get('login_tagline') || '').trim();
  const loginLayout = String(formData.get('login_layout') || 'centered');
  const isListed = formData.get('is_listed') === 'on';

  if (name.length < 2 || name.length > 120) return { error: 'Name must be between 2 and 120 characters.' };
  if (slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { error: 'Use a lowercase slug with letters, numbers, and single hyphens only.' };
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(primaryColor)) return { error: 'Primary color must be a six-digit hex color.' };
  if (!isHttpsUrl(logoUrl) || !isHttpsUrl(backgroundUrl)) {
    return { error: 'Logo and background links must use HTTPS.' };
  }
  if (loginTitle.length > 120 || loginTagline.length > 240) {
    return { error: 'Login title or tagline is too long.' };
  }
  if (!['centered', 'split', 'fullbleed'].includes(loginLayout)) {
    return { error: 'Choose a valid login layout.' };
  }

  const { admin } = await requireSuperAdmin();
  if (!admin) return { error: 'Forbidden: super-admin access required.' };

  const { data, error } = await admin
    .schema('church')
    .from('denominations')
    .insert({
      name,
      slug,
      logo_url: logoUrl || null,
      primary_color: primaryColor,
      background_url: backgroundUrl || null,
      login_title: loginTitle || null,
      login_tagline: loginTagline || null,
      login_layout: loginLayout,
      is_listed: isListed,
    })
    .select('name, slug')
    .single();

  if (error || !data) {
    console.error('[SuperAdmin] Failed to create denomination:', error?.message);
    if (error?.code === '23505') return { error: 'That denomination slug is already in use.' };
    return { error: 'Could not create the denomination. Please try again.' };
  }

  revalidatePath('/super-admin/overseers');
  revalidatePath('/denominations');
  return { success: true, name: data.name, slug: data.slug };
}

export interface CreateInviteActionState {
  error?: string;
  success?: boolean;
  code?: string;
  expiresAt?: string;
  maxUses?: number;
}

export async function createDenominationOverseerInvite(
  _previousState: CreateInviteActionState | null,
  formData: FormData,
): Promise<CreateInviteActionState> {
  const denominationId = String(formData.get('denomination_id') || '').trim();
  const label = String(formData.get('label') || '').trim();
  const expiresInDays = Number(formData.get('expires_in_days') || 14);
  const maxUses = Number(formData.get('max_uses') || 1);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(denominationId)) {
    return { error: 'Choose a valid denomination.' };
  }
  if (label.length > 120) return { error: 'The invite label must be 120 characters or fewer.' };
  if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    return { error: 'Expiry must be between 1 and 90 days.' };
  }
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    return { error: 'Allowed uses must be between 1 and 1,000.' };
  }

  const { user, admin, supabase } = await requireSuperAdmin();
  if (!user || !admin || !supabase) return { error: 'Forbidden: super-admin access required.' };

  // Verify the selected denomination with the service client; issue the invite
  // through the session client so the database RPC receives auth.uid().
  const { data: denomination, error: denominationError } = await admin
    .schema('church')
    .from('denominations')
    .select('id')
    .eq('id', denominationId)
    .maybeSingle();

  if (denominationError || !denomination) return { error: 'That denomination could not be found.' };

  const { data, error } = await supabase.rpc('create_denomination_overseer_invite', {
    p_denomination_id: denominationId,
    p_label: label || null,
    p_max_uses: maxUses,
    p_expires_in_days: expiresInDays,
  });

  if (error) {
    console.error('[SuperAdmin] Invite RPC failed:', error.message);
    return { error: 'Could not create the invitation. Please try again.' };
  }

  const result = Array.isArray(data) ? data[0] : data;
  const rawCode = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
      ? [result.code, result.raw_code, result.invite_code, result.p_code].find((value) => typeof value === 'string')
      : undefined;

  if (typeof rawCode !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(rawCode)) {
    console.error('[SuperAdmin] Invite RPC returned no usable raw code.');
    return { error: 'The invite was created, but its link could not be returned. Contact support before creating another.' };
  }

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  revalidatePath('/super-admin/overseers');
  return { success: true, code: rawCode, expiresAt, maxUses };
}

export async function redeemDenominationOverseerInvite(rawCode: string) {
  const code = (rawCode || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
    return { error: 'This invitation is invalid or has expired.' };
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { error: 'Please sign in before accepting this invitation.' };

  const { data, error } = await supabase.rpc('redeem_denomination_overseer_invite', {
    p_code: code,
  });

  if (error || !data) {
    return { error: 'This invitation cannot be accepted. It may be invalid, expired, fully redeemed, or your account may already be linked to a denomination.' };
  }

  revalidatePath('/overseer');
  revalidatePath('/super-admin/overseers');
  return { success: true, denominationId: String(data) };
}
