import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      const supabase = await createClient();
      await supabase.auth.signOut();
    }
  } catch (err) {
    console.error('[Logout Route] Error signing out:', err);
  }

  const url = new URL(req.url);
  return NextResponse.redirect(new URL('/', url.origin), 303);
}

export async function GET(req: Request) {
  try {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      const supabase = await createClient();
      await supabase.auth.signOut();
    }
  } catch (err) {
    console.error('[Logout Route] Error signing out:', err);
  }

  const url = new URL(req.url);
  return NextResponse.redirect(new URL('/', url.origin), 303);
}
