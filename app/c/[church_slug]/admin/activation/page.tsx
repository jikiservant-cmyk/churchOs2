import { getChurchBySlug } from '@/lib/db';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import ActivationClient from '@/components/activation/ActivationClient';

export const dynamic = 'force-dynamic';

export default async function ChurchActivationPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const { church_slug } = await params;
  const church = await getChurchBySlug(church_slug);

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect(`/?error=Session Expired`);
  }

  // Profile check
  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !profile.tenant_id) {
    redirect('/?error=Access Denied');
  }

  // If already active, redirect straight to dashboard
  if (church && church.activation_status === 'active') {
    redirect(`/${church_slug}/admin`);
  }

  return (
    <ActivationClient 
      churchName={church?.name || church_slug} 
      churchSlug={church_slug}
      churchId={profile.tenant_id}
      userEmail={user.email || ''}
    />
  );
}
