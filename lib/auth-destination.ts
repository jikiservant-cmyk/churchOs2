/**
 * Where a signed-in visitor belongs — one answer for every login entry point.
 *
 * There were three copies of this decision (`/`, `/login`, `/{slug}/admin/login`),
 * each slightly different: two read `admin_profiles` through the caller's own
 * RLS-scoped client (which returns zero rows and no error when the table has a
 * policy gap), one accepted only `pastor` and not `admin`, and none of them
 * consulted the activation gate. A pastor whose church had not paid could
 * therefore sit on a login form forever, or be bounced to `/signup/provision`,
 * where the next honest-looking click creates a duplicate church.
 *
 * `allowProvisioningRedirect` keeps the pages' differing behaviour intact: `/`
 * sends a profile-less account to provisioning, the login screens show the form
 * instead. Nothing else differs by surface.
 */
import { decideActivationGate, activationPathFor, churchAdminPathFor, resolveActivationGate } from './activation-gate';
import { describeAccessFailure, verifyChurchAdminAccess } from './supabase/church-access';

/** Structural, not `SupabaseClient`: PostgREST builders resist structural typing, and this boundary is deliberately thin. */
type Reader = {
  from: (table: string) => any;
  schema: (name: string) => { from: (table: string) => any };
  // PromiseLike, not Promise: `.rpc()` hands back a thenable builder, and a
  // structural Promise here would reject every real client.
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
};

export type LoginDestination = {
  /** Where to send the visitor. Null means "this page should render the form". */
  href: string | null;
  /** The account is authenticated but has no church workspace yet. */
  needsProvisioning: boolean;
  /** The account is authenticated but has no admin portal it may enter. */
  accessDenied: boolean;
  /** Machine-readable reason, for logs only. */
  reason: string;
};

const PROVISIONING_PATH = '/signup/provision';
const CHURCH_ADMIN_ROLES_AT_LOGIN = ['pastor', 'admin'];

/**
 * Roles this helper is willing to identify, so that a `staff` or `member`
 * account is reported as "no portal for you" instead of "you have no profile".
 * Privilege is decided by the caller from `profile.role`, exactly as the pages
 * did before this was extracted.
 */
const IDENTIFIABLE_ROLES = ['pastor', 'admin', 'staff', 'member', 'overseer', 'super_admin'];

export async function resolveLoginDestination(options: {
  userClient: Reader;
  adminClient: Reader;
  userId: string;
  surface: string;
  allowProvisioningRedirect?: boolean;
}): Promise<LoginDestination> {
  const { userClient, adminClient, userId, surface } = options;
  const none = (reason: string, extra: Partial<LoginDestination> = {}): LoginDestination => ({
    href: null,
    needsProvisioning: false,
    accessDenied: false,
    reason,
    ...extra,
  });

  // 1. The security-definer context RPC first: it knows about accounts this app
  //    cannot otherwise see (overseers, multi-church staff). Unavailable here is
  //    normal — some databases never received it — so a failure is not a denial.
  try {
    const { data: contextData, error: contextError } = await userClient.rpc('my_login_context');
    if (!contextError && Array.isArray(contextData) && contextData.length > 0) {
      const ctx = contextData[0];
      if (ctx?.account_type === 'overseer') {
        return none('overseer-context', {
          href: ctx.denomination_slug ? `/d/${ctx.denomination_slug}/overseer` : '/overseer',
        });
      }
      if (ctx?.account_type === 'pastor' && typeof ctx.church_slug === 'string' && ctx.church_slug) {
        const { data: church } = await adminClient
          .schema('church')
          .from('churches')
          .select('slug, activation_status, activation_paid_at')
          .eq('slug', ctx.church_slug)
          .maybeSingle();
        return none('pastor-context', { href: entryHrefForChurch(ctx.church_slug, church) });
      }
    }
  } catch (contextError) {
    console.warn(`[${surface}] my_login_context unavailable, falling back to profile reads:`, describe(contextError));
  }

  // 2. Identity, through the same verifier the admin layout uses.
  //
  // A bare `admin_profiles` read cannot tell "this account has no profile" from
  // "public.admin_profiles has RLS enabled and no policy for service_role", which
  // Postgres answers with zero rows and NO error. Treating the second case as the
  // first used to send a working pastor to /signup/provision, where the next
  // honest-looking click creates a duplicate church. So an unverifiable read is
  // reported as "no destination", and the page keeps showing its form.
  const verified = await verifyChurchAdminAccess({
    adminClient,
    userClient,
    userId,
    allowedRoles: IDENTIFIABLE_ROLES,
  });
  const profile = verified.profile;

  if (verified.outcome.kind !== 'granted') {
    if (!(verified.outcome.kind === 'denied' && verified.outcome.reason === 'no-profile')) {
      describeAccessFailure(surface, userId, null, verified);
      return none(`access-${verified.outcome.kind}`);
    }
    // Genuinely no profile row: only `/` turns that into the provisioning step.
    return none('no-profile', {
      href: options.allowProvisioningRedirect ? PROVISIONING_PATH : null,
      needsProvisioning: true,
    });
  }

  const { data: overseerLink } = await adminClient
    .schema('church')
    .from('denomination_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (profile?.role === 'super_admin') {
    return none('super-admin', { href: '/super-admin/overseers' });
  }
  if (overseerLink?.user_id === userId) {
    return none('denomination-admin', { href: '/overseer' });
  }
  if (
    typeof profile?.role === 'string'
    && CHURCH_ADMIN_ROLES_AT_LOGIN.includes(profile.role)
    && profile.tenant_id
  ) {
    const { data: church, error: churchError } = await adminClient
      .schema('church')
      .from('churches')
      .select('id, slug, activation_status, activation_paid_at')
      .eq('id', profile.tenant_id)
      .maybeSingle();

    if (churchError) {
      console.error(`[${surface}] church lookup failed:`, describe(churchError));
    }
    if (church?.slug) {
      return none('church-admin', { href: entryHrefForChurch(church.slug, church) });
    }
    return none('no-church-row', {
      href: options.allowProvisioningRedirect ? PROVISIONING_PATH : null,
      needsProvisioning: true,
    });
  }
  if (!profile || !profile.tenant_id) {
    // A missing profile is only a provisioning case for `/`. The login screens
    // keep showing the form so a broken read never becomes a create-church CTA.
    return none('no-profile', {
      href: options.allowProvisioningRedirect ? PROVISIONING_PATH : null,
      needsProvisioning: true,
    });
  }
  return none(`role-${profile.role}`, { accessDenied: true });
}

/**
 * Unpaid churches go to the activation screen; everything else to the portal.
 * When the church row could not be read, hand the visitor to the layout rather
 * than inventing a destination — the layout applies the same rule with the same
 * row, so nobody can be bounced between the two.
 */
function entryHrefForChurch(slug: string, church: unknown): string {
  if (!church || typeof church !== 'object') return churchAdminPathFor(slug);
  const row = church as { activation_status?: string | null; activation_paid_at?: string | null };
  const gate = resolveActivationGate(row);
  return gate.decision === 'pay' ? activationPathFor(slug) : churchAdminPathFor(slug);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error?.toString?.() ?? error);
}

/** Exported for tests: the gate under the exact shape login uses. */
export const activationGateForLogin = decideActivationGate;
