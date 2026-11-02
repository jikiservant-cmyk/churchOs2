import { createClient, createAdminClient } from '@/lib/supabase/server';
import LoginForm from '@/components/LoginForm';
import { getChurchBySlug } from '@/lib/db';
import { redirect } from 'next/navigation';
import { resolveLoginDestination } from '@/lib/auth-destination';
import { Suspense } from 'react';

export const dynamic = 'force-dynamic';

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; slug?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams || {};
  const supabase = await createClient();
  
  let targetSlug = Array.isArray(resolvedSearchParams.slug) ? resolvedSearchParams.slug[0] : resolvedSearchParams.slug;
  let loginError = Array.isArray(resolvedSearchParams.error) ? resolvedSearchParams.error[0] : resolvedSearchParams.error;

  let redirectTo: string | null = null;

  // Same resolver as `/` — see lib/auth-destination.ts. This page used to read
  // admin_profiles through the caller's RLS-scoped client and accept only the
  // `pastor` role, so an `admin` (or any account on a policy-gapped database)
  // could not be routed at all and saw the form forever.
  try {
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      const adminSupabase = await createAdminClient();
      const destination = await resolveLoginDestination({
        userClient: supabase,
        adminClient: adminSupabase,
        userId: user.id,
        surface: 'AdminLoginPage',
      });

      if (destination.href) {
        redirectTo = destination.href;
      } else if (destination.accessDenied) {
        loginError = 'Access Denied: You do not have admin permissions';
      }
    }
  } catch (err: any) {
    console.error('[AdminLoginPage] Auth check error:', err);
  }

  if (redirectTo) {
    redirect(redirectTo);
  }

  // 2. Resolve Branding
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
      console.warn('[AdminLoginPage] Fallback slug resolution failed');
    }
  }

  const finalSlug = targetSlug || 'admin';
  const churchData = targetSlug ? await getChurchBySlug(targetSlug) : null;

  const displayChurch = churchData || {
    id: 'placeholder',
    name: 'pastorOs Admin',
    slug: finalSlug,
    themeColor: '#B5622A',
    logoUrl: 'https://images.unsplash.com/photo-1438232992991-995b7058bbb3?q=80&w=300&auto=format&fit=crop'
  };

  return (
    <Suspense fallback={<div className="min-h-screen bg-[#2B1A0E] animate-pulse" />}>
      <LoginForm 
        church={displayChurch} 
        churchSlug={finalSlug} 
        error={loginError} 
      />
    </Suspense>
  );
}
