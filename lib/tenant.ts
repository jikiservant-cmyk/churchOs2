import { getChurchBySlug } from '@/lib/db';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';

export async function requireTenant(
  churchSlug: string,
  allowedRoles: ('pastor' | 'admin' | 'staff')[] = ['pastor', 'admin']
) {
  const church = await getChurchBySlug(churchSlug);
  if (!church) {
    notFound();
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect(`/?error=Session Expired`);
  }

  const adminSupabase = await createAdminClient();
  const { data: profile } = await adminSupabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !profile.tenant_id) {
    redirect('/signup/provision');
  }

  if (!allowedRoles.includes(profile.role)) {
    redirect(`/?error=Access Denied`);
  }

  if (profile.tenant_id !== church.id) {
    const { data: correctChurch } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('slug')
      .eq('id', profile.tenant_id)
      .maybeSingle();

    if (correctChurch?.slug && correctChurch.slug !== churchSlug) {
      redirect(`/${correctChurch.slug}/admin`);
    } else {
      redirect(`/?error=Church Mismatch`);
    }
  }

  return { church, user, profile, supabase };
}

export async function assertChurchAdminAuth(
  churchSlug: string,
  allowedRoles: ('pastor' | 'admin' | 'staff')[] = ['pastor', 'admin']
) {
  const canonical = churchSlug.toLowerCase().trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonical)) {
    throw new Error('Invalid church identifier');
  }

  const church = await getChurchBySlug(canonical);
  if (!church) throw new Error('Church not found');

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthenticated');

  // Use admin client for profile lookup (bypass RLS / stale JWT) but still
  // verify the *caller* is the authenticated user — service role never trusts client.
  const adminSupabase = await createAdminClient();
  const { data: profile } = await adminSupabase
    .from('admin_profiles')
    .select('role, tenant_id, app_type')
    .eq('id', user.id)
    .maybeSingle();

  // Allow Saccos shared-table 'member' if tenant matches (same as wallet fix)
  const effectiveAllowed = [...allowedRoles, 'member' as const];
  if (!profile || profile.tenant_id !== church.id || !effectiveAllowed.includes(profile.role as any)) {
    throw new Error(`Unauthorized: Insufficient permissions for church ${canonical}`);
  }

  return { supabase, user, church, churchId: church.id, role: profile.role };
}

export async function assertTenantRole(
  churchSlugOrId: string,
  allowedRoles: ('pastor' | 'admin' | 'staff')[] = ['pastor', 'admin']
) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthenticated');

  const adminSupabase = await createAdminClient();
  const { data: profile } = await adminSupabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !profile.tenant_id) {
    throw new Error('No tenant profile found');
  }

  const effectiveAllowed = [...allowedRoles, 'member' as const];
  if (!effectiveAllowed.includes(profile.role as any)) {
    throw new Error(`Forbidden: Role '${profile.role}' is not permitted for this operation`);
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(churchSlugOrId);
  if (isUuid) {
    if (profile.tenant_id !== churchSlugOrId) {
      throw new Error('Tenant mismatch');
    }
  } else {
    const church = await getChurchBySlug(churchSlugOrId);
    if (!church || profile.tenant_id !== church.id) {
      throw new Error('Tenant mismatch');
    }
  }

  return { user, profile, tenantId: profile.tenant_id };
}
