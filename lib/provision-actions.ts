'use server';

import { createAdminClient, createClient } from '@/lib/supabase/server';
import { headers } from 'next/headers';
import { canProvisionChurch } from '@/lib/provisioning-security';
import { checkRateLimit, getRateLimitIp } from '@/lib/security/rate-limit';

export type ProvisionState = {
  error?: string;
  success?: boolean;
  tenantId?: string;
  slug?: string;
  appType?: 'church';
};

export async function provisionTenant(prevState: ProvisionState, formData: FormData): Promise<ProvisionState> {
  const nameValue = formData.get('name');
  const slugValue = formData.get('slug');
  const inviteValue = formData.get('invite_code') ?? formData.get('inviteCode');
  if (typeof nameValue !== 'string' || typeof slugValue !== 'string' ||
      (inviteValue !== null && typeof inviteValue !== 'string')) {
    return { error: 'Invalid church setup details.' };
  }

  const name = nameValue.normalize('NFKC').trim();
  const rawSlug = slugValue.normalize('NFKC').toLowerCase().trim();
  const inviteCode = typeof inviteValue === 'string' ? inviteValue.trim() : '';
  const appType = 'church';

  // Bound invite input before using the Supabase RPC.
  if (inviteCode.length > 512) return { error: 'Invalid invitation code.' };

  // IP detection for scam prevention
  const headerList = await headers();
  const ip = getRateLimitIp(headerList);

  // 0. Robust Input Validation
  if (!name || name.length < 3 || name.length > 50) {
    return { error: 'Church name must be between 3 and 50 characters' };
  }

  // Regex for slug: lowercase letters, numbers, and single hyphens, no start/end hyphen
  const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!rawSlug || !slugRegex.test(rawSlug) || rawSlug.length < 3 || rawSlug.length > 30) {
    return { error: 'Invalid workspace URL. Use lowercase letters, numbers and hyphens (e.g. grace-church)' };
  }

  // Simple Blacklist for slugs
  const blacklist = ['admin', 'portal', 'api', 'auth', 'signup', 'login', 'pastoros', 'root'];
  if (blacklist.includes(rawSlug)) {
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
  const { data: existingProfile, error: profileLookupError } = await adminSupabase
    .from('admin_profiles')
    .select('tenant_id, role, app_type')
    .eq('id', user.id)
    .maybeSingle();

  if (profileLookupError) {
    console.error('[Provisioning] Could not verify existing profile:', profileLookupError);
    return { error: 'Unable to verify your church account. Please try again.' };
  }

  if (existingProfile?.tenant_id) {
    // If they already have a church workspace, redirect them — even if legacy role is 'member'
    // from shared table before upgrade. Only hard-block truly foreign roles.
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
    // They have a tenant_id but no matching church row (e.g. saccos tenant) —
    // don't let them silently create a second church that overwrites it.
    // Let canProvisionChurch handle it (will block because tenant_id != null).
  }

  // Enforce account limit always; IP limit only when IP is known. Never hard-fail
  // provisioning just because headers were missing — that caused 100% outage.
  const accountLimit = await checkRateLimit({ namespace: 'church-provision-account', subject: user.id, limit: 3, windowSeconds: 24 * 60 * 60 });
  const ipLimit =
    ip === 'unknown'
      ? { allowed: true, retryAfterSeconds: 0 }
      : await checkRateLimit({ namespace: 'church-provision-ip', subject: ip, limit: 3, windowSeconds: 24 * 60 * 60 });
  if (ip === 'unknown' && process.env.NODE_ENV === 'production') {
    console.warn('[Provisioning] Registration IP unavailable - enforcing account limit only');
  }
  const deniedLimit = !accountLimit.allowed ? accountLimit : ipLimit;
  if (!accountLimit.allowed || !ipLimit.allowed) {
    return { error: deniedLimit.unavailable ? 'Registration protection is temporarily unavailable.' : 'Too many registration attempts. Please try again later.' };
  }

  // 1.2 Additional database check: block repeat registrations from a saved IP
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
    const sanitizedName = name;
    const sanitizedSlug = rawSlug;

    currentStep = 'provisioning-church';
    if (!canProvisionChurch(existingProfile)) {
      return { error: 'This account already belongs to a church or is not eligible to create one.' };
    }

    // Keep all identity, invite, and tenant writes inside the verified atomic
    // RPC. Never fall back to service-role table inserts if the RPC fails.
    const { data: tenantId, error: provisionError } = await supabase.rpc('provision_church_v3', {
      p_user_id: user.id,
      p_name: sanitizedName,
      p_slug: sanitizedSlug,
      p_role: 'pastor',
      p_invite_code: inviteCode || null,
    });

    if (provisionError || !tenantId) {
      console.error('[Provisioning] Atomic church provisioning failed:', provisionError);
      return { error: 'Church setup could not be completed. Check the invite code or try again.' };
    }

    console.log('[Provisioning] Success!', { tenantId, slug: sanitizedSlug });
    
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
