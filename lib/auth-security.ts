export const CHURCH_ADMIN_ROLES = ['pastor', 'admin'] as const;
export type ChurchAdminRole = (typeof CHURCH_ADMIN_ROLES)[number];

/** Roles allowed to spend a church's SMS wallet. Saccos shares the table and
 *  uses `member`, so the tenant check (not the role) is what bounds it. */
export const SMS_BROADCAST_ROLES = ['pastor', 'admin', 'staff', 'member'] as const;

export function hasAllowedRole(role: unknown, allowedRoles: readonly string[]): boolean {
  return typeof role === 'string' && allowedRoles.includes(role);
}

export type ChurchAccessInput = {
  /** Whether the service-role client is real, or a placeholder that cannot query. */
  serviceRoleConfigured: boolean;
  /** The `admin_profiles` row for the caller, if one was returned. */
  profile: { tenant_id?: string | null; role?: string | null } | null;
  /** The lookup itself errored (network, permissions, schema drift). */
  profileLookupFailed: boolean;
  /** Tenant the caller is acting on; compared against the profile's tenant. */
  expectedTenantId?: string | null;
  allowedRoles?: readonly string[];
};

export type ChurchAccessOutcome =
  /** Verified: correct tenant, allowed role. */
  | { kind: 'granted' }
  /** Cannot verify anything — configuration gap, never an authorization verdict. */
  | { kind: 'unconfigured'; status: 503; error: string }
  /** Verified attempt failed on the database side — retryable, not a denial. */
  | { kind: 'lookup-failed'; status: 503; error: string }
  /** Verified denial. `reason` is for logs, never returned to the client. */
  | { kind: 'denied'; status: 403; error: string; reason: 'no-profile' | 'tenant-mismatch' | 'role' };

/**
 * Classify a service-role admin-profile check into a decision the client can act on.
 *
 * Exists because collapsing "the query never ran" and "you are not allowed" into one
 * 403 turns a missing environment variable into a message that tells the pastor their
 * own account is not a pastor — which is false, unreproducible in the dashboard, and
 * sends everyone hunting through role tables. Fail-closed is preserved: only `granted`
 * authorises.
 */
export function resolveChurchAdminAccess(input: ChurchAccessInput): ChurchAccessOutcome {
  if (!input.serviceRoleConfigured) {
    return {
      kind: 'unconfigured',
      status: 503,
      error: 'Access verification is unavailable on this deployment: SUPABASE_SERVICE_ROLE_KEY is not set. Add it in the host’s environment variables and redeploy.',
    };
  }
  if (input.profileLookupFailed) {
    return {
      kind: 'lookup-failed',
      status: 503,
      error: 'Access verification is temporarily unavailable. Please retry — if it persists, check that public.admin_profiles is readable and its columns match the app.',
    };
  }
  if (!input.profile) {
    return {
      kind: 'denied',
      status: 403,
      error: 'Access denied: this account has no admin profile for that church workspace.',
      reason: 'no-profile',
    };
  }
  if (input.expectedTenantId && input.profile.tenant_id !== input.expectedTenantId) {
    return {
      kind: 'denied',
      status: 403,
      error: 'Access denied: your account is linked to a different church workspace.',
      reason: 'tenant-mismatch',
    };
  }
  const allowedRoles = input.allowedRoles ?? CHURCH_ADMIN_ROLES;
  if (!hasAllowedRole(input.profile.role, allowedRoles)) {
    return {
      kind: 'denied',
      status: 403,
      error: `Access denied: requires one of ${allowedRoles.join(', ')}.`,
      reason: 'role',
    };
  }
  return { kind: 'granted' };
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

function firstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first ? first : null;
}

/**
 * Hosts this request may legitimately have arrived on.
 *
 * `request.url` must NOT be used for same-origin checks: Next.js builds it from
 * the internal socket/bind address, so `next dev -H 0.0.0.0` yields
 * `http://0.0.0.0:3000/...` and a reverse-proxied deployment yields whatever
 * the upstream connection used. Neither ever equals the Origin a browser sends,
 * which made every cookie-authenticated mutation fail closed with 403.
 *
 * The browser sets `Host` itself and a cross-site attacker cannot override it,
 * so comparing the Origin's host against it is the standard CSRF check that
 * Next.js applies to Server Actions. `APP_URL` and `X-Forwarded-Host` are
 * server-controlled additions for proxied deployments.
 */
export function allowedRequestHosts(headers: Headers, requestUrl?: string): Set<string> {
  const add = (value: string | null, into: Set<string>) => {
    if (!value) return;
    let host = value;
    try {
      // Accept a full URL (APP_URL) as well as a bare host:port.
      host = value.includes('://') ? new URL(value).host : value;
    } catch {
      return;
    }
    const normalized = host.trim().toLowerCase();
    if (normalized) into.add(normalized);
  };

  // Hosts this request actually arrived on. `Host` is set by the browser and
  // cannot be forged cross-site; X-Forwarded-Host covers reverse proxies.
  const requestHosts = new Set<string>();
  add(firstHeaderValue(headers.get('x-forwarded-host')), requestHosts);
  add(firstHeaderValue(headers.get('host')), requestHosts);

  // A synthesized Request (tests, internal calls) may carry neither header. In
  // that case the URL is all we have, and it is not the bind address problem
  // described above.
  if (requestHosts.size === 0 && requestUrl) {
    try {
      add(new URL(requestUrl).host, requestHosts);
    } catch {
      // ignore
    }
  }

  // APP_URL is always acceptable, so a deployment behind a rewrites/proxy layer
  // keeps working even when Host is rewritten to the upstream socket.
  add(process.env.APP_URL ?? null, requestHosts);

  return requestHosts;
}

/**
 * Same-origin check for cookie-authenticated browser mutations, resolved from
 * headers instead of the internal request URL. Missing/`null` Origins and
 * non-canonical origin strings are rejected.
 */
export function isSameOriginRequestForHeaders(
  originHeader: string | null,
  headers: Headers,
  requestUrl?: string,
): boolean {
  if (!originHeader) return false;

  try {
    const supplied = new URL(originHeader);
    // Canonical serialized origin only: no path, query, credentials or suffix.
    if (supplied.origin !== originHeader) return false;
    return allowedRequestHosts(headers, requestUrl).has(supplied.host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Public absolute URL for a redirect target.
 *
 * `request.url` carries the internal bind address (for example
 * `http://0.0.0.0:3000` under `next dev -H 0.0.0.0`, or the upstream socket when
 * reverse-proxied), so redirecting with it sends browsers to an unreachable
 * host. Prefer the forwarded host/proto, then the Host header.
 */
export function publicUrlFor(pathname: string, headers: Headers, fallbackUrl: string): URL {
  const host = firstHeaderValue(headers.get('x-forwarded-host')) ?? firstHeaderValue(headers.get('host'));
  if (host) {
    const proto = firstHeaderValue(headers.get('x-forwarded-proto')) ?? 'https';
    try {
      return new URL(pathname, `${proto}://${host}`);
    } catch {
      // Fall through to the request URL below.
    }
  }
  return new URL(pathname, fallbackUrl);
}

