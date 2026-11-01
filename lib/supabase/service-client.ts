/**
 * The service-role connection used by server-side code that has to see past RLS.
 *
 * WHY THIS FILE EXISTS (SECURITY_REVIEW-2026-10-30.md, P0-2)
 * This file exists because the *shape* of that client was wrong, not because it was
 * measurably sending the wrong token: on `main` the admin client passes an EMPTY cookie
 * store (`getAll: () => []`), so there is no session to pick up and the service key goes
 * out — verified by `scripts/probe-admin-client-identity.mjs`, and recorded as a
 * retraction in SECURITY_REVIEW-2026-10-30.md's P0-2. What an ssr-backed construction
 * does allow is far more dangerous than that correction: supabase-js chooses the bearer
 * token per request as
 *
 *     data.session?.access_token ?? this.supabaseKey
 *
 * so a client that CAN see a user's session sends **that user's JWT** and the service
 * key only as `apikey`. PostgREST takes the role from the JWT. Any future version that
 * wires the request's cookie store into `createAdminClient()` — an edit that looks like
 * simplification — would silently move every privileged read and write onto the caller's
 * policies, and a read of a table the caller has no policy on would come back as
 * "0 rows, no error". Two incidents in this repo already had that shape (from the
 * missing-key path below), which is why the identity is pinned by
 * `tests/admin-client-identity.test.ts` rather than trusted.
 *
 * WHAT THIS DOES
 * Builds a sessionless client whose Authorization header is the service key, always,
 * and hands back the headers it used so a test can assert exactly that. No cookie
 * store is involved, because a service connection has no business reading a user's
 * session — and a client that cannot be silently downgraded is the one precondition
 * that makes narrowing those policies safe.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SERVICE_ROLE_ENV = 'SUPABASE_SERVICE_ROLE_KEY';
export const PROJECT_URL_ENV = 'NEXT_PUBLIC_SUPABASE_URL';

export interface ServiceClientConfig {
  url: string | undefined | null;
  serviceRoleKey: string | undefined | null;
}

export type ServiceClientOutcome =
  | { configured: true; url: string; serviceRoleKey: string }
  | { configured: false; reason: 'missing-url' | 'missing-key' | 'missing-both' };

/**
 * Pure so the failure modes are testable without importing next/headers: this is the
 * decision the app's logs and the deploy checklist both depend on.
 */
export function resolveServiceClient(config: ServiceClientConfig): ServiceClientOutcome {
  const url = typeof config.url === 'string' && config.url.trim() !== '' ? config.url.trim() : null;
  const key = typeof config.serviceRoleKey === 'string' && config.serviceRoleKey.trim() !== ''
    ? config.serviceRoleKey.trim()
    : null;
  if (url && key) return { configured: true, url, serviceRoleKey: key };
  return { configured: false, reason: url ? 'missing-key' : key ? 'missing-url' : 'missing-both' };
}

/**
 * The headers a service-role request must carry. Exported separately because the
 * property that matters — `Authorization` being the service key and not a user's
 * access token — is a value a test can read without a network.
 */
export function serviceClientHeaders(serviceRoleKey: string): Record<string, string> {
  const key = serviceRoleKey.trim();
  return { apikey: key, Authorization: `Bearer ${key}` };
}

export interface BuiltServiceClient {
  client: SupabaseClient;
  /** True only when this client really is the service role. */
  privileged: boolean;
}

/**
 * Build the privileged client. Returns `null` when the environment cannot provide it:
 * the caller then decides whether to degrade (page reads, with a loud log line) or to
 * fail closed (money paths, which must not pretend a missing key is a zero).
 */
export function createServiceClient(config: ServiceClientConfig): BuiltServiceClient | null {
  const resolved = resolveServiceClient(config);
  if (!resolved.configured) return null;
  return {
    client: createClient(resolved.url, resolved.serviceRoleKey, {
      global: { headers: serviceClientHeaders(resolved.serviceRoleKey) },
      // No session, no refresh, no storage: nothing here may pick up a user's token.
      auth: { autoRefreshToken: false, persistSession: false, storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      } },
    }),
    privileged: true,
  };
}

/** What to print once per process when the service key is missing. */
export function serviceClientFallbackNotice(reason: string): string {
  return `[Supabase] ${SERVICE_ROLE_ENV} or ${PROJECT_URL_ENV} is unusable (${reason}): `
    + 'createAdminClient() is falling back to a request-scoped client, which runs under the '
    + 'CALLER\'S row-level-security policies, not the service role. Reads of tables that church '
    + 'members have no policy on will come back empty, and writes to protected columns '
    + '(activation_status, activation_paid_at, passkey*) will be refused by the database with '
    + 'SQLSTATE 42501. Set the service-role key in Vercel to restore them.';
}
