export const CHURCH_ADMIN_ROLES = ['pastor', 'admin'] as const;
export type ChurchAdminRole = (typeof CHURCH_ADMIN_ROLES)[number];

export function hasAllowedRole(role: unknown, allowedRoles: readonly string[]): boolean {
  return typeof role === 'string' && allowedRoles.includes(role);
}

/**
 * Canonical church workspace slug: lowercase alphanumerics joined by single
 * hyphens, no leading/trailing hyphen.
 *
 * Slugs are interpolated into redirect targets (`/${slug}/admin`). Without this
 * check a value like `/evil.example.com` produces `//evil.example.com/admin`,
 * which browsers treat as a protocol-relative URL — an open redirect after
 * login. Anything that becomes part of a redirect path must pass this first.
 */
export const CHURCH_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True only for a canonical slug safe to interpolate into an internal path. */
export function isSafeChurchSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && slug.length <= 63 && CHURCH_SLUG_PATTERN.test(slug);
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
