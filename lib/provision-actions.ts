'use server';

import { createAdminClient, createClient } from '@/lib/supabase/server';
import { normalizeInviteCode } from '@/lib/denomination';
import { headers } from 'next/headers';

export type ProvisionState = {
  error?: string;
  success?: boolean;
  tenantId?: string;
  slug?: string;
  appType?: 'church';
};

// Simple Blacklist for slugs (routes that would otherwise be shadowed)
const SLUG_BLACKLIST = ['admin', 'portal', 'api', 'auth', 'signup', 'login', 'pastoros', 'root', 'd', 'denominations', 'overseer'];

const isUniqueViolation = (err: any) => err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');

/**
 * Validate a denomination invite code against `church.denomination_invites`.
 *
 * The old lookup only checked that *a* row with that code existed, so revoked,
 * expired and maxed-out codes still linked a church to a denomination. All
 * four conditions are now enforced, and an unreadable table is treated as a
 * hard error (we must never silently drop a code the pastor typed in).
 *
 * Returns { ok, denomId?, error? }.
 */
async function resolveDenominationInvite(
  adminSupabase: Awaited<ReturnType<typeof createAdminClient>>,
  inviteCode: string
): Promise<{ ok: true; denomId: string } | { ok: false; error: string }> {
  const code = normalizeInviteCode(inviteCode);

  const { data: invite, error } = await adminSupabase
    .schema('church')
    .from('denomination_invites')
    .select('id, denomination_id, code, revoked, max_uses, uses_count, expires_at')
    .ilike('code', code)
    .maybeSingle();

  if (error) {
    console.error('[Provisioning] Could not verify denomination invite code:', error);
    return { ok: false, error: 'Invite codes cannot be verified right now. Please try again or contact support.' };
  }

  if (!invite) {
    return { ok: false, error: 'That denomination invite code was not found. Please check it and try again.' };
  }
  if (invite.revoked) {
    return { ok: false, error: 'That denomination invite code has been revoked. Please ask your overseer for a new one.' };
  }
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'That denomination invite code has expired. Please ask your overseer for a new one.' };
  }
  if (typeof invite.max_uses === 'number' && invite.max_uses > 0 && Number(invite.uses_count ?? 0) >= invite.max_uses) {
    return { ok: false, error: 'That denomination invite code has reached its usage limit. Please ask your overseer for a new one.' };
  }

  return { ok: true, denomId: invite.denomination_id };
}

async function upsertPastorProfile(
  adminSupabase: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string,
  email: string | null | undefined,
  tenantId: string,
  existingRole?: string | null
) {
  // Preserve an existing role: provisioning must never demote (e.g. an
  // overseer account that is also setting up a church) or escalate anything.
  const role = existingRole || 'pastor';

  // Note: `full_name` is intentionally NOT written here — the church name is
  // not the pastor's name, and the previous code corrupted the profile with
  // it. The profile keeps whatever name was captured at signup.
  const row: Record<string, unknown> = {
    id: userId,
    tenant_id: tenantId,
    role,
    app_type: 'church',
  };
  if (email) row.email = email; // only touch email when we actually have it

  return adminSupabase
    .from('admin_profiles')
    .upsert(row, { onConflict: 'id' });
}

export async function provisionTenant(prevState: ProvisionState, formData: FormData): Promise<ProvisionState> {
  const name = (formData.get('name') as string || '').trim();
  const rawSlug = (formData.get('slug') as string || '').toLowerCase().trim();
  const inviteCode = (formData.get('invite_code') as string || formData.get('inviteCode') as string || '').trim();
  const appType = 'church';

  // IP detection for scam prevention (first hop of a proxy chain)
  const headerList = await headers();
  const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ||
             headerList.get('x-real-ip')?.trim() ||
             'unknown';

  // 0. Robust Input Validation
  if (!name || name.length < 3 || name.length > 50) {
    return { error: 'Church name must be between 3 and 50 characters' };
  }

  // Regex for slug: lowercase letters, numbers, and single hyphens, no start/end hyphen
  const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!rawSlug || !slugRegex.test(rawSlug) || rawSlug.length < 3 || rawSlug.length > 30) {
    return { error: 'Invalid workspace URL. Use lowercase letters, numbers and hyphens (e.g. grace-church)' };
  }

  if (SLUG_BLACKLIST.includes(rawSlug)) {
    return { error: 'This workspace URL is reserved. Please choose another.' };
  }

  const supabase = await createClient();
  const adminSupabase = await createAdminClient();

  // 1. Get and Verify User
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError || !user) {
    return { error: 'You must be logged in to provision a church.' };
  }

  // 1.1 Check if user already has an active church
  const { data: existingProfile, error: existingProfileError } = await adminSupabase
    .from('admin_profiles')
    .select('tenant_id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (existingProfileError) {
    console.error('[Provisioning] Profile lookup error:', existingProfileError);
    return { error: 'Could not read your account profile. Please try again.' };
  }

  if (existingProfile?.tenant_id) {
    const { data: existingChurch } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('slug')
      .eq('id', existingProfile.tenant_id)
      .maybeSingle();

    if (existingChurch?.slug) {
      return {
        success: true,
        tenantId: existingProfile.tenant_id,
        slug: existingChurch.slug,
        appType
      };
    }
  }

  // 1.2 IP Rate Limiting: Check if IP has already registered a church.
  // The church row now records the originating IP (see below) so this check
  // actually has data to match on.
  if (ip !== 'unknown' && ip !== '127.0.0.1' && ip !== '::1') {
    const { data: ipChurch } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('id')
      .eq('ip_address', ip)
      .maybeSingle();

    if (ipChurch) {
      return { error: 'Only one church registration is allowed per network/location to prevent scams.' };
    }
  }

  let currentStep = 'initializing';
  try {
    // 0. Robust Input Sanitization (Unicode Normalization)
    const sanitizedName = name.normalize('NFKC');
    const sanitizedSlug = rawSlug.normalize('NFKC');

    // Check slug uniqueness
    const { data: slugCheck, error: slugCheckError } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('id')
      .ilike('slug', sanitizedSlug)
      .maybeSingle();

    if (slugCheckError) {
      console.error('[Provisioning] Slug uniqueness check failed:', slugCheckError);
      return { error: 'Could not check whether that workspace URL is available. Please try again.' };
    }
    if (slugCheck) {
      return { error: 'Workspace URL (slug) is already taken. Please choose another.' };
    }

    // Resolve denomination invite if provided (full validation — a bad code
    // is a hard error now, never silently ignored).
    let denomId: string | null = null;
    if (inviteCode) {
      const invite = await resolveDenominationInvite(adminSupabase, inviteCode);
      if (!invite.ok) {
        return { error: invite.error };
      }
      denomId = invite.denomId;
    }

    currentStep = 'provisioning-church';
    let tenantId: string | null = null;
    let rpcError: any = null;

    const churchRow = {
      id: null as unknown as string,
      name: sanitizedName,
      slug: sanitizedSlug,
      app_type: 'church' as const,
      denomination_id: denomId,
      activation_status: 'pending_payment' as const,
      ip_address: ip === 'unknown' ? null : ip,
    };

    const insertChurch = async (): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
      const newTenantId = crypto.randomUUID();
      const { data, error } = await adminSupabase
        .schema('church')
        .from('churches')
        .insert({ ...churchRow, id: newTenantId })
        .select('id')
        .maybeSingle();

      if (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, error: 'Workspace URL (slug) is already taken. Please choose another.' };
        }
        console.error('[Provisioning] Church insert error:', error);
        return { ok: false, error: error.message || 'Failed to create church workspace' };
      }
      if (!data) {
        return { ok: false, error: 'Failed to create church workspace' };
      }
      return { ok: true, id: data.id };
    };

    // If an admin profile already exists for this auth user (e.g. created on
    // auth signup with null tenant_id), provision the church directly and
    // link the profile to avoid redundant constraint violations.
    if (existingProfile) {
      const inserted = await insertChurch();
      if (!inserted.ok) return { error: inserted.error };
      tenantId = inserted.id;

      const { error: profileError } = await upsertPastorProfile(
        adminSupabase, user.id, user.email, tenantId, existingProfile.role
      );
      if (profileError) {
        console.error('[Provisioning] Profile link error:', profileError);
        return { error: 'Church was created but your account could not be linked to it. Please contact support.' };
      }
    } else {
      // If no admin profile exists yet, attempt the atomic provision_church_v3 RPC
      try {
        const v3Response = await supabase
          .rpc('provision_church_v3', {
            p_user_id: user.id,
            p_name: sanitizedName,
            p_slug: sanitizedSlug,
            p_role: 'pastor',
            p_invite_code: inviteCode || null,
            p_ip: ip === 'unknown' ? null : ip,
          });

        if (v3Response.error) {
          rpcError = v3Response.error;
        } else if (typeof v3Response.data === 'string' && v3Response.data) {
          tenantId = v3Response.data;
        } else {
          rpcError = new Error('provision_church_v3 returned no tenant id');
        }
      } catch (v3CallErr: any) {
        rpcError = v3CallErr;
      }

      // Direct fallback if RPC fails
      if (rpcError) {
        const inserted = await insertChurch();
        if (!inserted.ok) return { error: inserted.error };
        tenantId = inserted.id;

        const { error: profileError } = await upsertPastorProfile(
          adminSupabase, user.id, user.email, tenantId, null
        );
        if (profileError) {
          console.error('[Provisioning] Direct profile upsert error:', profileError);
          return { error: 'Church was created but your account could not be linked to it. Please contact support.' };
        }
        rpcError = null;
      }
    }

    if (!tenantId) {
      throw new Error('Provisioning failed: No tenant ID returned');
    }

    console.log('[Provisioning] Success!', { tenantId, slug: sanitizedSlug, denomId });

    // We navigate on the client side to avoid Next.js action redirect issues
    return {
      success: true,
      tenantId,
      slug: sanitizedSlug,
      appType
    };

  } catch (err: any) {
    console.error(`[Provisioning] Error at step ${currentStep}:`, err);
    return {
      error: err.message || 'Failed to setup church. Please try again or contact support.'
    };
  }
}
