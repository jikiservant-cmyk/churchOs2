'use server';

import { createAdminClient, createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

export type ProvisionState = {
  error?: string;
  success?: boolean;
  tenantId?: string;
  slug?: string;
  appType?: 'church';
};

export async function provisionTenant(prevState: ProvisionState, formData: FormData): Promise<ProvisionState> {
  const name = (formData.get('name') as string || '').trim();
  const rawSlug = (formData.get('slug') as string || '').toLowerCase().trim();
  const inviteCode = (formData.get('invite_code') as string || formData.get('inviteCode') as string || '').trim();
  const appType = 'church';

  // IP detection for scam prevention
  const headerList = await headers();
  const ip = headerList.get('x-forwarded-for')?.split(',')[0] || 
             headerList.get('x-real-ip') || 
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
  const { data: existingProfile } = await adminSupabase
    .from('admin_profiles')
    .select('tenant_id, role')
    .eq('id', user.id)
    .maybeSingle();

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

  // 1.2 IP Rate Limiting: Check if IP has already registered a church
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

    currentStep = 'provisioning-church';
    let tenantId: string | null = null;
    let rpcError: any = null;

    // Check slug uniqueness
    const { data: slugCheck } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('id')
      .ilike('slug', sanitizedSlug)
      .maybeSingle();

    if (slugCheck) {
      return { error: 'Workspace URL (slug) is already taken. Please choose another.' };
    }

    // Resolve denomination invite if provided
    let denomId: string | null = null;
    if (inviteCode) {
      const { data: invite } = await adminSupabase
        .schema('church')
        .from('denomination_invites')
        .select('denomination_id')
        .ilike('code', inviteCode)
        .maybeSingle();
      if (invite?.denomination_id) {
        denomId = invite.denomination_id;
      }
    }

    // If an admin profile already exists for this auth user (e.g. created on auth signup with null tenant_id),
    // provision the church directly and link the profile to avoid redundant constraint violations
    if (existingProfile) {
      const newTenantId = crypto.randomUUID();

      const { error: churchInsertError } = await adminSupabase
        .schema('church')
        .from('churches')
        .insert({
          id: newTenantId,
          name: sanitizedName,
          slug: sanitizedSlug,
          app_type: 'church',
          denomination_id: denomId,
          activation_status: 'pending_payment'
        });

      if (churchInsertError) {
        console.error('[Provisioning] Church insert error:', churchInsertError);
        return { error: churchInsertError.message || 'Failed to create church workspace' };
      }

      const { error: profileError } = await adminSupabase
        .from('admin_profiles')
        .upsert({
          id: user.id,
          email: user.email,
          tenant_id: newTenantId,
          role: 'pastor',
          full_name: sanitizedName,
          app_type: 'church'
        }, { onConflict: 'id' });

      if (profileError) {
        console.error('[Provisioning] Profile upsert error:', profileError);
      }

      tenantId = newTenantId;
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
          });

        if (v3Response.error) {
          rpcError = v3Response.error;
        } else {
          tenantId = v3Response.data;
        }
      } catch (v3CallErr: any) {
        rpcError = v3CallErr;
      }

      // Direct fallback if RPC fails
      if (rpcError) {
        const newTenantId = crypto.randomUUID();

        const { error: churchInsertError } = await adminSupabase
          .schema('church')
          .from('churches')
          .insert({
            id: newTenantId,
            name: sanitizedName,
            slug: sanitizedSlug,
            app_type: 'church',
            denomination_id: denomId,
            activation_status: 'pending_payment'
          });

        if (churchInsertError) {
          console.error('[Provisioning] Direct church insert error:', churchInsertError);
          return { error: churchInsertError.message || 'Failed to create church workspace' };
        }

        const { error: profileError } = await adminSupabase
          .from('admin_profiles')
          .upsert({
            id: user.id,
            email: user.email,
            tenant_id: newTenantId,
            role: 'pastor',
            full_name: sanitizedName,
            app_type: 'church'
          }, { onConflict: 'id' });

        if (profileError) {
          console.error('[Provisioning] Direct profile upsert error:', profileError);
        }

        tenantId = newTenantId;
        rpcError = null;
      }
    }

    if (!tenantId) {
      throw new Error('Provisioning failed: No tenant ID returned');
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
