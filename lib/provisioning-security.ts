export interface ProvisioningProfile {
  tenant_id: string | null;
  role: string;
  app_type?: string | null;
}

/**
 * A new church may be created by a fresh account (no profile) OR any
 * unlinked account (tenant_id === null) with a compatible role.
 * Shared table note: SACCOS app uses role='member' as default on same
 * public.admin_profiles table. We must not block church provisioning just
 * because role is 'member' — the RPC will safely upgrade to pastor and set
 * tenant_id/app_type='church'. Only block if they already own a workspace.
 */
export function canProvisionChurch(profile: ProvisioningProfile | null): boolean {
  if (!profile) return true;
  // Allow pastor (church default) and member (saccos shared-table default) when unlinked.
  // Keep other roles blocked to preserve original security intent.
  if (profile.tenant_id === null && (profile.role === 'pastor' || profile.role === 'member')) return true;
  return false;
}
