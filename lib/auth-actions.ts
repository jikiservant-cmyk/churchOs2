'use server';

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { checkRateLimit, getRateLimitIp } from '@/lib/security/rate-limit';
import { validateSignupCredentials } from '@/lib/signup-security';

export type AuthState = {
  error?: string;
  message?: string;
  success?: boolean;
  redirectTo?: string;
};

export async function login(prevState: AuthState, formData: FormData): Promise<AuthState> {
  const email = (formData.get('email') as string || '').trim();
  const password = formData.get('password') as string;
  const churchSlug = formData.get('churchSlug') as string;

  if (!email || !password) {
    return { error: 'Email and password are required' };
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { error: 'Supabase not configured' };
  }

  try {
    const supabase = await createClient();
    
    // 1. Sign in with Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      return { error: authError?.message || 'Login failed' };
    }

    // Invite redemption is a safe, narrowly-scoped post-login destination. Do
    // not accept arbitrary return URLs from the browser.
    const returnTo = String(formData.get('returnTo') || '').trim();
    if (/^\/overseer\/invite\/[A-Za-z0-9_-]{1,128}$/.test(returnTo)) {
      return { success: true, redirectTo: returnTo };
    }

    // The global platform role takes precedence over denomination/church context.
    const adminSupabase = await createAdminClient();
    const { data: signedInProfile } = await adminSupabase
      .from('admin_profiles')
      .select('role, tenant_id')
      .eq('id', authData.user.id)
      .maybeSingle();
    if (signedInProfile?.role === 'super_admin') {
      return { success: true, redirectTo: '/super-admin/overseers' };
    }

    // If an existing pastor/admin also has a denomination-admin link, preserve
    // their church dashboard as the default login destination. They can still
    // open /overseer directly because access is checked against denomination_admins.
    if (['pastor', 'admin'].includes(signedInProfile?.role || '') && signedInProfile?.tenant_id) {
      const { data: church } = await adminSupabase
        .schema('church')
        .from('churches')
        .select('slug')
        .eq('id', signedInProfile.tenant_id)
        .maybeSingle();
      if (church?.slug) {
        return { success: true, redirectTo: `/${church.slug}/admin` };
      }
    }

    // 2. Call my_login_context RPC and route based on its result
    try {
      const { data: contextData, error: contextError } = await supabase.rpc('my_login_context');
      if (!contextError && Array.isArray(contextData) && contextData.length > 0) {
        const context = contextData[0];

        if (context?.account_type === 'overseer') {
          const overseerUrl = context.denomination_slug ? `/d/${context.denomination_slug}/overseer` : '/overseer';
          return { success: true, redirectTo: overseerUrl };
        } else if (context?.account_type === 'pastor') {
          const { data: profile } = await adminSupabase
            .from('admin_profiles')
            .select('tenant_id')
            .eq('id', authData.user.id)
            .maybeSingle();

          if (profile?.tenant_id) {
            const { data: church } = await adminSupabase
              .schema('church')
              .from('churches')
              .select('slug')
              .eq('id', profile.tenant_id)
              .maybeSingle();

            if (church?.slug) {
              return { success: true, redirectTo: `/${church.slug}/admin` };
            }
          }

          if (churchSlug && churchSlug !== 'admin') {
            return { success: true, redirectTo: `/${churchSlug}/admin` };
          }

          return { success: true, redirectTo: '/signup/provision' };
        }
      }
    } catch (contextErr) {
      console.warn('[Auth] my_login_context RPC not available, using fallback:', contextErr);
    }

    // 3. Fallback: Verify Role and find Church Slug in admin_profiles
    // Reuse the server-side admin client to bypass RLS restrictions on admin_profiles.
    let profile = null;
    let profileError = null;

    // Attempt 1: Fetch by ID
    const { data: idData, error: idError } = await adminSupabase
      .from('admin_profiles')
      .select('role, tenant_id, email, app_type')
      .eq('id', authData.user.id)
      .maybeSingle();
    
    if (idData) {
      profile = idData;
    } else {
      profileError = idError;
    }

    // Attempt 2: Fallback to Email
    if (!profile) {
      const { data: emailData, error: emailError } = await adminSupabase
        .from('admin_profiles')
        .select('role, tenant_id, email, app_type')
        .eq('email', email)
        .maybeSingle();
      
      if (emailData) {
        profile = emailData;
      } else {
        profileError = emailError;
      }
    }

    // The platform super-admin is a global role and does not need a church tenant.
    if (profile?.role === 'super_admin') {
      return { success: true, redirectTo: '/super-admin/overseers' };
    }

    // Overseer access is granted by the denomination membership relation, not
    // by admin_profiles.role. Check it before the church-provisioning fallback.
    const { data: overseerLink } = await adminSupabase
      .schema('church')
      .from('denomination_admins')
      .select('user_id')
      .eq('user_id', authData.user.id)
      .maybeSingle();
    if (overseerLink?.user_id === authData.user.id) {
      return { success: true, redirectTo: '/overseer' };
    }

    // If no profile or no tenant_id exists yet, the authenticated user has not provisioned their church workspace.
    // Send them to /signup/provision instead of kicking them out with Access Denied!
    if (!profile || !profile.tenant_id) {
      return { success: true, redirectTo: '/signup/provision' };
    }

    // Allow strictly pastor roles for church admin
    const authorizedRoles = ['pastor', 'admin'];
    if (!authorizedRoles.includes(profile.role.toLowerCase())) {
      await supabase.auth.signOut();
      return { error: `Access Denied: Role '${profile.role}' does not have admin access.` };
    }

    // 3. Get the correct slug from churches
    let targetSlug: string | null = null;
    const tenantId = profile.tenant_id;
    const appType = profile.app_type;
    
    if (tenantId) {
      if (appType === 'church' || (!appType && ['pastor', 'admin'].includes(profile.role))) {
        // Use Admin Client to query church schema, bypassing RLS!
        const adminSupabase = await createAdminClient();
        const { data: church } = await adminSupabase
          .schema('church')
          .from('churches')
          .select('slug')
          .eq('id', tenantId)
          .maybeSingle();
        
        if (church?.slug) {
          targetSlug = church.slug;
        }
      }
    }

    if (!targetSlug && churchSlug && churchSlug !== 'admin') {
      targetSlug = churchSlug;
    }

    if (!targetSlug) {
      return { success: true, redirectTo: '/signup/provision' };
    }

    return { success: true, redirectTo: `/${targetSlug}/admin` };
  } catch (err: any) {
    if (err?.message === 'NEXT_REDIRECT' || err?.__next_redirect || err?.digest?.startsWith?.('NEXT_REDIRECT')) throw err;
    console.error('[Auth] Login exception:', err);
    return { error: err?.message || 'An unexpected error occurred during login.' };
  }
}

export async function signup(prevState: AuthState, formData: FormData): Promise<AuthState> {
  const credentials = validateSignupCredentials(formData.get('email'), formData.get('password'));
  if (!credentials.ok) {
    return {
      error: credentials.reason === 'email'
        ? 'Enter a valid email address.'
        : 'Password must be at least 8 characters and no more than 72 UTF-8 bytes.',
    };
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { error: 'Auth service not configured properly.' };
  }

  const requestHeaders = await headers();
  const clientIp = getRateLimitIp(requestHeaders);
  if (clientIp === 'unknown' && process.env.NODE_ENV === 'production') {
    return { error: 'Signup protection is temporarily unavailable. Please try again later.' };
  }

  const emailLimit = await checkRateLimit({
    namespace: 'signup-email', subject: credentials.email, limit: 3, windowSeconds: 60 * 60,
  });
  const ipLimit = await checkRateLimit({
    namespace: 'signup-ip', subject: clientIp, limit: 10, windowSeconds: 60 * 60,
  });
  const deniedLimit = !emailLimit.allowed ? emailLimit : ipLimit;
  if (!emailLimit.allowed || !ipLimit.allowed) {
    return {
      error: deniedLimit.unavailable
        ? 'Signup protection is temporarily unavailable. Please try again later.'
        : 'Too many signup attempts. Please wait before trying again.',
    };
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({
      email: credentials.email,
      password: credentials.password,
    });

    // Use the same response for an existing email and a newly registered
    // account awaiting confirmation, avoiding a signup email-enumeration oracle.
    if (error) {
      if (/already registered|already exists|user exists/i.test(error.message)) {
        return {
          success: true,
          message: 'If an account can be created for that email, confirmation instructions will be sent.',
        };
      }
      console.warn('[Auth] Signup provider rejected request:', error.status ?? 'unknown status');
      return { error: 'Could not create the account. Check the details or try again later.' };
    }

    if (!data.user) {
      return {
        success: true,
        message: 'If an account can be created for that email, confirmation instructions will be sent.',
      };
    }

    // Supabase may require email confirmation, in which case signUp returns no
    // session. Do not send unauthenticated users to church provisioning.
    if (!data.session) {
      return {
        success: true,
        message: 'Check your email for confirmation instructions. After confirming, sign in to finish setup.',
      };
    }

    return { success: true, redirectTo: '/signup/provision' };
  } catch (err: any) {
    if (err?.message === 'NEXT_REDIRECT' || err?.__next_redirect || err?.digest?.startsWith?.('NEXT_REDIRECT')) throw err;
    console.error('[Auth] Signup exception:', err instanceof Error ? err.name : 'unknown error');
    return { error: 'Could not create the account. Please try again later.' };
  }
}

export async function logout(formData: FormData) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  
  redirect(`/`);
}
