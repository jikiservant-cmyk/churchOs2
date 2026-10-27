import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isSameOriginRequestForHeaders, publicUrlFor } from '@/lib/auth-security';

/**
 * POST /api/auth/usher-logout?church=<slug>
 *
 * Clears the usher session cookie for one church. Ushers share a single tablet
 * between services, so "log out" has to actually revoke the 24h session — a
 * link back to the entry page leaves the next person signed in.
 *
 * A route handler (rather than a Server Action) keeps this working as a plain
 * HTML form post, so it functions with JavaScript disabled or before hydration.
 */
export async function POST(req: Request) {
  if (!isSameOriginRequestForHeaders(req.headers.get('origin'), req.headers, req.url)) {
    return NextResponse.json({ error: 'Cross-origin request denied.' }, { status: 403 });
  }

  const requested = new URL(req.url).searchParams.get('church') ?? '';
  // Canonicalise exactly like getUsherSession(), or we delete a name never set.
  const canonicalSlug = requested.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  if (!canonicalSlug) {
    return NextResponse.json({ error: 'A valid church slug is required.' }, { status: 400 });
  }

  const cookieStore = await cookies();
  cookieStore.delete(`usher_session_${canonicalSlug}`);

  return NextResponse.redirect(publicUrlFor(`/${canonicalSlug}/usher`, req.headers, req.url), 303);
}

export async function GET() {
  return NextResponse.json(
    { error: 'Usher logout requires POST.' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
