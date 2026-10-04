import { createClient } from '@/lib/supabase/server';
import { getMyLoginContext } from '@/lib/denomination';

export interface OverseerGateResult {
  allowed: boolean;
  reason?: 'unauthenticated' | 'not_overseer';
}

/**
 * Server-side gate for the denomination/overseer portal.
 *
 * The old /overseer page only checked "is there a signed-in user at all", so
 * when the my_login_context RPC was unavailable (or for any account that
 * simply did not match), a regular pastor — or any signed-up user — landed on
 * the overseer dashboard and triggered the overseer_* data RPCs. The
 * denomination portal must fail closed: you need an account that the
 * database actually identifies as an overseer.
 */
export async function requireOverseer(): Promise<OverseerGateResult> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { allowed: false, reason: 'unauthenticated' };
  }

  // Primary signal: the my_login_context RPC (single trusted query).
  const context = await getMyLoginContext();
  if (context && context.account_type === 'overseer') {
    return { allowed: true };
  }

  // Secondary signal: the profile row (RLS-scoped to auth.uid()).
  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profile && String(profile.role || '').toLowerCase() === 'overseer') {
    return { allowed: true };
  }

  return { allowed: false, reason: 'not_overseer' };
}
