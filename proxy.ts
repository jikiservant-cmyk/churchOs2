import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSameOriginRequest } from '@/lib/auth-security';

const SERVER_TO_SERVER_ENDPOINTS = new Set([
  '/api/sms/process-queue',
  '/api/najiki/webhook',
  '/api/webhooks/najiki',
]);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const url = new URL(request.url);
  const isApiMutation = url.pathname.startsWith('/api/') && MUTATING_METHODS.has(request.method);
  const isTrustedServerEndpoint = SERVER_TO_SERVER_ENDPOINTS.has(url.pathname);

  // Cookie-authenticated API mutations must prove they came from this exact
  // origin. Missing Origin and Origin: null are rejected, not treated as safe.
  // The exempt endpoints have their own server-secret/signature verification.
  if (isApiMutation && !isTrustedServerEndpoint) {
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    if (!isSameOriginRequest(request.url, origin) || fetchSite === 'cross-site') {
      return NextResponse.json({ error: 'Cross-origin request blocked' }, { status: 403 });
    }
  }

  // Server-to-server endpoints authenticate their own shared secret/signature
  // and must not depend on a browser Supabase session refresh.
  if (isTrustedServerEndpoint) return supabaseResponse;

  // Skip Supabase auth check if env vars are missing (for local dev without Supabase).
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return supabaseResponse;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, { ...options, sameSite: 'none', secure: true })
          );
        },
      },
    },
  );

  const isAdminRoute = url.pathname.split('/').includes('admin') && !url.pathname.includes('/admin/login');

  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;

    if (isAdminRoute && !user) {
      return NextResponse.redirect(new URL('/?error=Session%20Expired', request.url));
    }
  } catch (error) {
    console.error('Proxy auth verification failed:', error);
    // Fail closed for protected pages and cookie-authenticated mutations when
    // Supabase cannot validate the session. Public reads may still render.
    if (isAdminRoute) {
      return NextResponse.redirect(new URL('/?error=Session%20Expired', request.url));
    }
    if (isApiMutation) {
      return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 503 });
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
