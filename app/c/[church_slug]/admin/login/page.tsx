import { getChurchBySlug } from '@/lib/db';
import LoginForm from '@/components/LoginForm';
import { redirect } from 'next/navigation';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { resolveLoginDestination } from '@/lib/auth-destination';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ church_slug: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams || {};
  const church = await getChurchBySlug(resolvedParams.church_slug);

  // This form is exempt from the middleware's admin-session check (it is the way
  // back in), which also meant it never looked at the session at all: a signed-in
  // pastor of an unpaid church sat on it indefinitely. Route anyone who already
  // has a session to where their church actually is — the activation screen while
  // the fee is outstanding.
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const adminSupabase = await createAdminClient();
      const destination = await resolveLoginDestination({
        userClient: supabase,
        adminClient: adminSupabase,
        userId: user.id,
        surface: 'ChurchLoginPage',
      });
      if (destination.href) redirect(destination.href);
    }
  } catch (err) {
    // Never block the sign-in form because routing could not be resolved.
    console.warn('[ChurchLoginPage] Destination lookup unavailable:', err instanceof Error ? err.message : err);
  }
  
  // Normalize params
  const loginError = Array.isArray(resolvedSearchParams.error) ? resolvedSearchParams.error[0] : resolvedSearchParams.error;

  const displayChurch = church || {
    id: resolvedParams.church_slug,
    name: 'Church Admin',
    slug: resolvedParams.church_slug,
    themeColor: 'bg-blue-600',
    logoUrl: `https://picsum.photos/seed/${resolvedParams.church_slug}/200/200`
  };

  return (
    <LoginForm 
      church={displayChurch} 
      churchSlug={resolvedParams.church_slug} 
      error={loginError} 
    />
  );
}
