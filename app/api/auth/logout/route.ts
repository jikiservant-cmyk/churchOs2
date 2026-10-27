import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { isSameOriginRequestForHeaders, publicUrlFor } from '@/lib/auth-security';

export async function POST(req: Request) {
  if (!isSameOriginRequestForHeaders(req.headers.get('origin'), req.headers, req.url)) {
    return NextResponse.json({ error: 'Cross-origin request denied.' }, { status: 403 });
  }
  try {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      const supabase = await createClient();
      await supabase.auth.signOut();
    }
  } catch (err) {
    console.error('[Logout Route] Error signing out:', err);
  }

  return NextResponse.redirect(publicUrlFor('/', req.headers, req.url), 303);
}

export async function GET() {
  return NextResponse.json(
    { error: 'Logout requires POST.' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
