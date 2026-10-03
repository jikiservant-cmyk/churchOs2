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

  // 1.1 Secure Rate Limiting: Check if user already has a tenant
  const { data: existingProfile } = await adminSupabase
    .from('admin_profiles')
    .select('tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (existingProfile?.tenant_id) {
    return { error: 'Your account is already associated with a ministry workspace.' };
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

    currentStep = 'calling-rpc';
    
    // Switch to public.provision_church_v3 using the authenticated user's access token.
    // v3 takes five parameters (p_user_id, p_name, p_slug, p_role, p_invite_code) and no p_ip.
    let tenantId: string | null = null;
    let rpcError: any = null;

    // 1. Check if user already has an active church
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
        console.log('[Provisioning] User already has a church, routing to:', existingChurch.slug);
        return {
          success: true,
          tenantId: existingProfile.tenant_id,
          slug: existingChurch.slug,
          appType
        };
      }
    }

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

    // Direct self-healing provisioning if RPC fails due to profile conflicts
    if (rpcError && (
      rpcError.message?.includes('already has an admin profile') || 
      rpcError.message?.includes('provision_church') ||
      rpcError.code === 'P0001' ||
      rpcError.code === '42883'
    )) {
      console.warn('[Provisioning] RPC failed with known constraint, executing direct provisioning fallback:', rpcError.message);
      
      const newTenantId = crypto.randomUUID();
      let denomId: string | null = null;

      // Handle invite code if provided
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

      // Insert Church
      const { error: churchInsertError } = await adminSupabase
        .schema('church')
        .from('churches')
        .insert({
          id: newTenantId,
          name: sanitizedName,
          slug: sanitizedSlug,
          app_type: 'church',
          denomination_id: denomId
        });

      if (churchInsertError) {
        console.error('[Provisioning] Direct church insert error:', churchInsertError);
        return { error: churchInsertError.message || 'Failed to create church workspace' };
      }

      // Upsert admin profile
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

    if (rpcError) {
      const errorStr = JSON.stringify(rpcError, null, 2);
      console.error('[Provisioning] RPC error details:', errorStr);
      return { error: rpcError.message || `Provisioning failed: ${errorStr}` };
    }

    if (!tenantId) {
      throw new Error('Provisioning failed: No tenant ID returned');
    }

    console.log('[Provisioning] Success!', { tenantId, slug: sanitizedSlug });
    
    // We navigate on the client side to avoid some Next.js 15 action state issues with redirect
    return { 
      success: true, 
      tenantId, 
      slug: sanitizedSlug,
      appType 
    };

  } catch (err: any) {
    if (err.message === 'NEXT_REDIRECT' || err.__next_redirect) throw err;
    console.error(`[Provisioning] Error at step ${currentStep}:`, err);
    let errorMessage = 'An unknown error occurred';
    
    if (typeof err === 'string') {
      errorMessage = err;
    } else if (err instanceof Error) {
      errorMessage = err.message;
    } else if (err && typeof err === 'object') {
      // Handle Supabase PostgREST error objects
      errorMessage = err.message || err.details || err.hint || JSON.stringify(err);
    }
    
    return { error: `Provisioning failed: ${errorMessage}` };
  }
}
