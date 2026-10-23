export interface ProvisioningProfile {
  tenant_id: string | null;
  role: string;
}

/** A new church may be created only by a fresh account or an unlinked pastor. */
export function canProvisionChurch(profile: ProvisioningProfile | null): boolean {
  if (!profile) return true;
  return profile.tenant_id === null && profile.role === 'pastor';
}
