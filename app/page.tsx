import { createClient, createAdminClient } from '@/lib/supabase/server';
import LoginForm from '@/components/LoginForm';
import { getChurchBySlug } from '@/lib/db';
import { resolveLoginDestination } from '@/lib/auth-destination';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

export const dynamic = 'force-dynamic';

export default async function RootLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; slug?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams || {};
  const supabase = await createClient();
  
  // Normalize params to strings
  let targetSlug = Array.isArray(resolvedSearchParams.slug) ? resolvedSearchParams.slug[0] : resolvedSearchParams.slug;
  let loginError = Array.isArray(resolvedSearchParams.error) ? resolvedSearchParams.error[0] : resolvedSearchParams.error;

  let redirectTo: string | null = null;

  // A logged-in visitor is routed by their session, never parked on this form
  // because a `?error=` query string is present. That guard used to be
  // `if (!loginError)`, so anyone the middleware or the admin layout bounced
  // here with `?error=Session Expired` — including a pastor whose session was
  // actually still valid, and any pastor of an unpaid church — had to sign in
  // again before reaching the one screen they are allowed on. The error still
  // shows whenever there is genuinely no session to route with.
  try {
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      const adminSupabase = await createAdminClient();
      const destination = await resolveLoginDestination({
        userClient: supabase,
        adminClient: adminSupabase,
        userId: user.id,
        surface: 'RootPage',
        allowProvisioningRedirect: true,
      });

      if (destination.href) {
        redirectTo = destination.href;
      } else if (destination.accessDenied) {
        loginError = 'Access Denied: You do not have admin permissions';
      }
    }
  } catch (err: any) {
    console.error('[RootPage] Auth check error:', err);
  }

  // Perform redirect if needed, outside of try/catch
  if (redirectTo) {
    redirect(redirectTo);
  }

  // 2. Resolve Branding Slug
  if (!targetSlug) {
    try {
      const { data: firstChurch } = await supabase
        .schema('church')
        .from('churches')
        .select('slug')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
        
      targetSlug = firstChurch?.slug || undefined;
    } catch (e) {
      console.warn('[RootPage] Fallback slug resolution failed');
    }
  }

  // 3. Resolve Church Object for Branding
  const finalSlug = targetSlug || 'admin';
  const churchData = targetSlug ? await getChurchBySlug(targetSlug) : null;

  const displayChurch = churchData || {
    id: 'placeholder',
    name: 'Church Management',
    slug: finalSlug,
    themeColor: 'bg-slate-900',
    logoUrl: `https://picsum.photos/seed/church-admin/200/200`
  };

  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F5E6CE] animate-pulse" />}>
      <LoginForm 
        church={displayChurch} 
        churchSlug={finalSlug} 
        error={loginError} 
      />
    </Suspense>
  );
}
