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

