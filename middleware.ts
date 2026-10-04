import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  // Skip Supabase auth check if env vars are missing (for local dev without Supabase)
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
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, { ...options, sameSite: 'none', secure: true })
          );
        },
      },
    }
  );

  // Refresh session if expired
  try {
    const url = new URL(request.url);

    // CSRF Protection for state-changing API mutations (F7 remediation)
    const PUBLIC_EXEMPT_ROUTES = new Set([
      '/api/auth/logout',
      '/api/billing/topup',
      '/api/sms/process-queue',
      '/api/najiki/webhook',
      '/api/webhooks/najiki',
      '/api/relworx/webhook'
    ]);

    if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
      const isPublicWebhook = PUBLIC_EXEMPT_ROUTES.has(url.pathname);
      const isAuthRoute = url.pathname.startsWith('/api/auth/');

      if (!isPublicWebhook && !isAuthRoute) {
        const secFetchSite = request.headers.get('sec-fetch-site');
        const origin = request.headers.get('origin');
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host');

        const isTrustedHost = (h: string) => {
          return (
            h === host ||
            h.endsWith('.run.app') ||
            h.endsWith('.google.com') ||
            h.endsWith('.googleusercontent.com') ||
            h.startsWith('localhost') ||
            h.startsWith('127.0.0.1')
          );
        };

        if (origin) {
          try {
            const originHost = new URL(origin).host;
            if (!isTrustedHost(originHost)) {
              if (secFetchSite === 'cross-site') {
                return NextResponse.json({ error: 'Cross-origin request blocked' }, { status: 403 });
              }
              return NextResponse.json({ error: 'Origin mismatch' }, { status: 403 });
            }
          } catch {
            return NextResponse.json({ error: 'Invalid origin header' }, { status: 403 });
          }
        }
      }
    }

    const { data: { user } } = await supabase.auth.getUser();

    // Protective Routing for Admin
    const pathParts = url.pathname.split('/');
    
    // Check if we are in an admin route: /c/[slug]/admin/... or /[slug]/admin/...
    const isAdminRoute = pathParts.includes('admin') && !url.pathname.includes('/admin/login');
    // The denomination/overseer portal is an authenticated surface too — the
    // pages themselves do the role check, but unauthenticated visitors get a
    // clean redirect here instead of a page render.
    const isOverseerRoute =
      url.pathname === '/overseer' ||
      (/^\/d\/[^/]+\/overseer\/?$/i.test(url.pathname));
    if (isAdminRoute || isOverseerRoute) {
      if (!user) {
        return NextResponse.redirect(new URL(`/?error=Session Expired`, request.url));
      }
      
      // We can't easily check the DB in middleware without a performance hit, 
      // but we can at least ensure the user exists.
      // The Layout will still do the fine-grained role/church check, 
      // but the middleware will catch the most common "unauthenticated" case.
    }
  } catch (e) {
    console.error("Middleware Auth Error:", e);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
