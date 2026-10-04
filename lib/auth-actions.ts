'use server';

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { recordAuthAttempt, clientIpFromHeaders, isLoopbackIp } from '@/lib/auth-rate-limit';

export type AuthState = {
  error?: string;
  notice?: string;
  success?: boolean;
  redirectTo?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Minimal server-side credential policy. Supabase's own default is 6 chars;
 * we require 8 with at least one letter and one digit so a signup cannot
 * create a wallet/portal account with "123456".
 */
function passwordPolicyError(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number';
  }
  return null;
}

async function getClientIp(): Promise<string> {
  try {
    const headerList = await headers();
    return clientIpFromHeaders(headerList);
  } catch {
    return '';
  }
}

/**
 * Enforce the (action, email) and (action, ip) windows. Returns an error
 * string when the caller is over budget, or null when allowed.
 */
async function enforceAuthRateLimit(
  action: 'login' | 'signup',
  email: string
): Promise<string | null> {
  const ip = await getClientIp();

  const emailDecision = await recordAuthAttempt(action, 'email', email.toLowerCase());
  if (!emailDecision.allowed) {
    return 'Too many attempts for this email address. Please wait a few minutes and try again.';
  }

  if (!isLoopbackIp(ip)) {
    const ipDecision = await recordAuthAttempt(action, 'ip', ip);
    if (!ipDecision.allowed) {
      return 'Too many attempts from your network. Please wait a few minutes and try again.';
    }
  }

  return null;
}

/**
 * Resolve where a signed-in user should land, using ONLY server-derived data.
 *
 * The old implementation accepted the client-supplied `churchSlug` form field
 * as a redirect destination. That let any signed-in user be pointed at
 * `/<whatever-slug>/admin` after login; the layout checks only stop the data
 * leak, the URL was still attacker-chosen. Destinations here come exclusively
 * from `my_login_context` / `admin_profiles` / `church.churches`.
 */
async function resolveLoginDestination(
  supabase: Awaited<ReturnType<typeof createClient>>,
  adminSupabase: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string
): Promise<{ redirectTo: string } | { error: string }> {
  // 1. Preferred path: the my_login_context RPC (server-side, single query).
  try {
    const { data: contextData, error: contextError } = await supabase.rpc('my_login_context');
    if (!contextError && Array.isArray(contextData) && contextData.length > 0) {
      const context = contextData[0] as Record<string, any>;

      if (context?.account_type === 'overseer') {
        const overseerUrl = context.denomination_slug
          ? `/d/${context.denomination_slug}/overseer`
          : '/overseer';
        return { redirectTo: overseerUrl };
      }

      if (context?.account_type === 'pastor') {
        if (context.church_slug) {
          return { redirectTo: `/${context.church_slug}/admin` };
        }
        // Pastor without a provisioned church yet.
        return { redirectTo: '/signup/provision' };
      }
    }
  } catch (contextErr) {
    console.warn('[Auth] my_login_context RPC not available, using fallback:', contextErr);
  }

  // 2. Fallback: read the user's own profile (RLS-scoped to auth.uid()).
  const { data: profile, error: profileError } = await supabase
    .from('admin_profiles')
    .select('role, tenant_id, email')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) {
    console.warn('[Auth] Profile lookup failed during login:', profileError);
  }

  if (!profile) {
    // No profile row at all: the account was created but never provisioned.
    // Send them to provisioning instead of a dead-end error page.
    return { redirectTo: '/signup/provision' };
  }

  const role = String(profile.role ?? '').toLowerCase();

  if (role === 'overseer') {
    return { redirectTo: '/overseer' };
  }

  if (role !== 'pastor' && role !== 'admin') {
    return { error: `Access Denied: Role '${profile.role}' does not have admin access.` };
  }

  if (!profile.tenant_id) {
    return { redirectTo: '/signup/provision' };
  }

  // Derive the slug from the database — never from the request.
  const { data: church } = await adminSupabase
    .schema('church')
    .from('churches')
    .select('slug')
    .eq('id', profile.tenant_id)
    .maybeSingle();

  if (church?.slug) {
    return { redirectTo: `/${church.slug}/admin` };
  }

  // Dangling tenant (profile points at a church row that no longer exists).
  return { redirectTo: '/signup/provision' };
}

export async function login(prevState: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const password = String(formData.get('password') || '');

  if (!email || !password) {
    return { error: 'Email and password are required' };
  }
  if (!EMAIL_RE.test(email)) {
    return { error: 'Please enter a valid email address' };
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { error: 'Supabase not configured' };
  }

  // Throttle credential attempts BEFORE touching Supabase (per email + per IP).
  const limited = await enforceAuthRateLimit('login', email);
  if (limited) {
    return { error: limited };
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

    // 2. Server-derived routing only.
    const adminSupabase = await createAdminClient();
    const destination = await resolveLoginDestination(supabase, adminSupabase, authData.user.id);

    if ('error' in destination) {
      await supabase.auth.signOut();
      return { error: destination.error };
    }

    return { success: true, redirectTo: destination.redirectTo };
  } catch (err: any) {
    if (err?.message === 'NEXT_REDIRECT' || err?.__next_redirect || err?.digest?.startsWith?.('NEXT_REDIRECT')) throw err;
    console.error('[Auth] Login exception:', err);
    return { error: err?.message || 'An unexpected error occurred during login.' };
  }
}

export async function signup(prevState: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const password = String(formData.get('password') || '');

  if (!email || !password) {
    return { error: 'Email and password are required' };
  }
  if (!EMAIL_RE.test(email)) {
    return { error: 'Please enter a valid email address' };
  }
  if (email.length > 254) {
    return { error: 'Email address is too long' };
  }
  const policyError = passwordPolicyError(password);
  if (policyError) {
    return { error: policyError };
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { error: 'Auth service not configured properly' };
  }

  // Throttle signups (per email + per IP) before creating the account.
  const limited = await enforceAuthRateLimit('signup', email);
  if (limited) {
    return { error: limited };
  }

  try {
    const supabase = await createClient();
    console.log('[Auth] Attempting signup for:', email);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      console.error('[Auth] Signup error:', error.message);
      const lower = error.message.toLowerCase();
      if (lower.includes('already registered') || lower.includes('already been registered')) {
        return { error: 'This email is already registered. Please login instead.' };
      }
      return { error: error.message };
    }

    if (!data.user) {
      // Supabase reported success but did not return a user (usually: the
      // project requires email confirmation, so no session was issued).
      return {
        success: true,
        notice: 'Account created. Please check your inbox to confirm your email address, then sign in.',
      };
    }

    console.log('[Auth] Signup success for:', email);
    // No auto-redirect when confirmation is pending (data.session is null):
    // sending an unauthenticated user to /signup/provision would just bounce
    // them with "You must be logged in".
    if (!data.session) {
      return {
        success: true,
        notice: 'Account created. Please check your inbox to confirm your email address, then sign in.',
      };
    }

    return { success: true, redirectTo: '/signup/provision' };
  } catch (err: any) {
    if (err?.message === 'NEXT_REDIRECT' || err?.__next_redirect || err?.digest?.startsWith?.('NEXT_REDIRECT')) throw err;
    console.error('[Auth] Critical signup exception:', err);
    return { error: 'An unexpected error occurred. Please try again later.' };
  }
}

export async function logout(formData: FormData) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }

  redirect(`/`);
}
