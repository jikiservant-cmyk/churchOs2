import { getChurchBySlug } from '@/lib/db';
import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import ActivationClient from '@/components/activation/ActivationClient';
import { isSimulationEnabled } from '@/lib/activation';

export const dynamic = 'force-dynamic';

const ACTIVATION_ROLES = ['pastor', 'admin'];

export default async function ChurchActivationPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const { church_slug } = await params;
  const church = await getChurchBySlug(church_slug);

  if (!church) {
    notFound();
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect(`/?error=Session Expired`);
  }

  // Profile + role check. Activation is a church-admin operation: a non-admin
  // role holder (or a user with no workspace) must not reach the payment UI.
  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !profile.tenant_id) {
    redirect('/?error=Access Denied');
  }

  if (!ACTIVATION_ROLES.includes(String(profile.role || '').toLowerCase())) {
    redirect('/?error=Access Denied');
  }

  // The user must manage THIS church — not merely any church.
  if (profile.tenant_id !== church.id) {
    redirect(`/?error=Access Denied`);
  }

  // If already active, redirect straight to dashboard
  if (church.activation_status === 'active') {
    redirect(`/${church_slug}/admin`);
  }

  return (
    <ActivationClient
      churchName={church.name}
      churchSlug={church.slug}
      churchId={church.id}
      userEmail={user.email || ''}
      allowSimulation={isSimulationEnabled()}
    />
  );
}
