import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSameOriginRequestForHeaders, publicUrlFor } from '@/lib/auth-security';

const SERVER_TO_SERVER_ENDPOINTS = new Set([
  '/api/sms/process-queue',
  '/api/najiki/webhook',
  '/api/webhooks/najiki',
  // Usher sessions are JWTs in their own cookie, not Supabase sessions. This
  // endpoint performs its own origin check, so it must not fail closed just
  // because Supabase auth cannot be reached — otherwise ushers cannot log out.
  '/api/auth/usher-logout',
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
    if (!isSameOriginRequestForHeaders(origin, request.headers, request.url) || fetchSite === 'cross-site') {
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
      return NextResponse.redirect(publicUrlFor('/?error=Session%20Expired', request.headers, request.url));
    }
  } catch (error) {
    // Only log as error for protected routes/mutations — public pages like
    // /signup, /manifest, /sw.js naturally have no session and are expected
    // to hit AuthSessionMissingError. Demoted to warn to keep Vercel logs clean.
    const isPublicNoise = !isAdminRoute && !isApiMutation;
    if (isPublicNoise) {
      console.warn('Proxy auth skipped (public route, no session):', url.pathname);
    } else {
      console.error('Proxy auth verification failed:', error);
    }
    // Fail closed for protected pages and cookie-authenticated mutations when
    // Supabase cannot validate the session. Public reads may still render.
    if (isAdminRoute) {
      return NextResponse.redirect(publicUrlFor('/?error=Session%20Expired', request.headers, request.url));
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
