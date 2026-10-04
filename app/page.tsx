import { createClient } from '@/lib/supabase/server';
import LoginForm from '@/components/LoginForm';
import { getChurchBySlug } from '@/lib/db';
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

  // 1. Check if user is already logged in
  // ONLY redirect if there's no error in the URL (to avoid redirect loops)
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
          // Attempt to find their church via their profile
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
               // Dangling tenant: profile links to a church row that no
               // longer exists — send them back to provisioning.
               redirectTo = '/signup/provision';
             }
          } else if (profile && profile.role !== 'pastor' && profile.role !== 'overseer') {
             loginError = 'Access Denied: You do not have admin permissions';
          }
        }
      }
    } catch (err: any) {
      console.error('[RootPage] Auth check error:', err);
    }
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
