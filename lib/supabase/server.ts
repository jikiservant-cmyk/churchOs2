import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import {
  createServiceClient,
  resolveServiceClient,
  serviceClientFallbackNotice,
} from './service-client';

export async function createClient() {
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // Return a dummy client that will fail on actual requests but won't crash the server during boot/SSR
    return createServerClient(
      'https://placeholder.supabase.co',
      'placeholder-key',
      { cookies: { getAll: () => [], setAll: () => {} } }
    );
  }

  return createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              // Force SameSite=None and Secure for iframe support
              cookieStore.set(name, value, { ...options, sameSite: 'none', secure: true })
            });
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  );
}

/**
 * The server-side privileged client.
 *
 * This used to be `createServerClient(url, SERVICE_ROLE_KEY, { cookies })`. Because
 * supabase-js chooses the bearer per request as `session?.access_token ?? key`, that
 * client sent the *user's* JWT inside a logged-in request and ran every "admin" query
 * under the caller's own row-level-security policies — so a table the caller has no
 * policy on read back as "0 rows, no error", and any tightening of the authenticated
 * policies would have broken the application's own writes. See P0-2 in
 * SECURITY_REVIEW-2026-10-30.md and lib/supabase/service-client.ts for the why.
 */
let fallbackWarned = false;

export async function createAdminClient() {
  const config = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const service = createServiceClient(config);
  if (service) return service.client;

  // The environment cannot provide a service connection. Degrade to the caller's own
  // permissions — the historical behaviour, and what keeps a misconfigured preview
  // readable — but say so once, loudly, because with the church-row guard trigger in
  // place a fallback here turns protected writes into SQLSTATE 42501 rather than
  // silent success.
  if (!fallbackWarned) {
    fallbackWarned = true;
    const resolution = resolveServiceClient(config);
    console.error(serviceClientFallbackNotice(
      resolution.configured ? 'unexpected-state' : resolution.reason,
    ));
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anonKey) {
    const cookieStore = await cookies();
    return createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll: () => {},
      },
    });
  }

  // No project URL at all: a dummy client that fails on real requests without
  // crashing boot/SSR.
  return createServerClient('https://placeholder.supabase.co', 'placeholder-key', {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}

/**
 * True when `createAdminClient()` returns a client that can actually reach the
 * project. Without this the dummy client above makes every service-role read
 * come back as "no rows", which callers historically render as a `0` balance or
 * as an access denial — a silent lie about the real failure. Guard the
 * fail-closed paths with it so the distinction survives to the log and the UI.
 */
export function isServiceRoleConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
