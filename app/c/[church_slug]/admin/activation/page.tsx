import { getChurchBySlug } from '@/lib/db';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import ActivationClient from '@/components/activation/ActivationClient';

export const dynamic = 'force-dynamic';

export default async function ChurchActivationPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const { church_slug } = await params;
  let church = await getChurchBySlug(church_slug);

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect(`/?error=Session Expired`);
  }

  // Profile check using admin client to prevent RLS false negatives
  const adminSupabase = await createAdminClient();
  const { data: profile } = await adminSupabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !profile.tenant_id) {
    redirect('/signup/provision');
  }

  // If church was not found by slug, resolve from tenant_id
  if (!church) {
    const { data: pastorChurch } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('*')
      .eq('id', profile.tenant_id)
      .maybeSingle();

    if (pastorChurch) {
      church = pastorChurch;
    }
  }

  // If already active, redirect straight to dashboard
  if (church && church.activation_status === 'active') {
    redirect(`/${church.slug || church_slug}/admin`);
  }

  return (
    <ActivationClient 
      churchName={church?.name || church_slug} 
      churchSlug={church?.slug || church_slug}
      churchId={profile.tenant_id}
      userEmail={user.email || ''}
    />
  );
}
