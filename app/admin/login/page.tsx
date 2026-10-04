import { createClient } from '@/lib/supabase/server';
import LoginForm from '@/components/LoginForm';
import { getChurchBySlug } from '@/lib/db';
import { redirect } from 'next/navigation';
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

  // 1. Check if user is already logged in
  if (!loginError) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      
      if (user) {
        // Try my_login_context first
        try {
          const { data: contextData } = await supabase.rpc('my_login_context');
          if (Array.isArray(contextData) && contextData.length > 0) {
            const ctx = contextData[0];
            if (ctx?.account_type === 'overseer') {
              redirectTo = ctx.denomination_slug ? `/d/${ctx.denomination_slug}/overseer` : '/overseer';
            } else if (ctx?.account_type === 'pastor') {
              // Pastor context: go to the church, or to provisioning when no
              // church exists yet (account created, workspace not launched).
              redirectTo = ctx.church_slug ? `/${ctx.church_slug}/admin` : '/signup/provision';
            }
          }
        } catch {
          // Fallback to profile table
        }

        if (!redirectTo) {
          const { data: profile } = await supabase
            .from('admin_profiles')
            .select('role, tenant_id')
            .eq('id', user.id)
            .maybeSingle();

          if (profile?.role === 'overseer') {
            redirectTo = '/overseer';
          } else if (profile?.role === 'pastor' || profile?.role === 'admin') {
             const { data: church } = await supabase
               .schema('church')
               .from('churches')
               .select('slug')
               .eq('id', profile.tenant_id)
               .maybeSingle();

             if (church?.slug) {
               redirectTo = `/${church.slug}/admin`;
             } else if (profile?.tenant_id) {
               // Dangling tenant: send them back to provisioning.
               redirectTo = '/signup/provision';
             }
          }
        }
      }
    } catch (err: any) {
      console.error('[AdminLoginPage] Auth check error:', err);
    }
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
