import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

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

export async function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
        getAll: () => [],
        setAll: () => {},
      },
    }
  );
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
