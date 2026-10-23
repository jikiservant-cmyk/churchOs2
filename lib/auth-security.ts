export const CHURCH_ADMIN_ROLES = ['pastor', 'admin'] as const;
export type ChurchAdminRole = (typeof CHURCH_ADMIN_ROLES)[number];

export function hasAllowedRole(role: unknown, allowedRoles: readonly string[]): boolean {
  return typeof role === 'string' && allowedRoles.includes(role);
}

/** Exact origin comparison for cookie-authenticated browser mutations. */
export function isSameOriginRequest(requestUrl: string, originHeader: string | null): boolean {
  if (!originHeader) return false;

  try {
    const requestOrigin = new URL(requestUrl).origin;
    const suppliedUrl = new URL(originHeader);
    // Browsers send Origin as a serialized origin (no path or credentials).
    // Requiring that canonical form prevents URL parsing from ignoring suffixes.
    return suppliedUrl.origin === requestOrigin && originHeader === suppliedUrl.origin;
  } catch {
    return false;
  }
}
