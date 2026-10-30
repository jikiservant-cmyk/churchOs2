import { isServiceRoleConfigured } from '@/lib/supabase/server';
import {
  resolveChurchAdminAccess,
  type ChurchAccessOutcome,
  type ChurchProfileRow,
} from '@/lib/auth-security';

/**
 * Both Supabase flavours this app passes around — the `@supabase/ssr` cookie
 * client and the service-role client — are accepted as "something with `from()`".
 *
 * The query builder is a deeply generic self-referential type: describing it
 * structurally here is fragile (any chain change breaks every caller) and
 * expensive enough to trip TS2589. The projections below are fixed and local to
 * this file, so the boundary is only as loose as it has to be, and no other table
 * is ever touched.
 */
type TableReader = { from: (table: string) => any };

type ProfileRead = { profile: ChurchProfileRow; failed: boolean };

async function readOwnProfile(client: TableReader, userId: string): Promise<ProfileRead> {
  try {
    const { data, error } = await client
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', userId)
      .maybeSingle();
    return { profile: (data ?? null) as ChurchProfileRow, failed: Boolean(error) };
  } catch {
    // A client pointed at an unreachable project throws instead of returning an
    // error object. Either way the read produced no evidence, which is not a
    // denial — see resolveChurchAdminAccess.
    return { profile: null, failed: true };
  }
}

/**
 * Can the privileged role read `admin_profiles` for ANYONE? A table with RLS
 * enabled and no policy for `service_role` answers every read with zero rows and
 * no error, so an empty result for one user carries no information until this is
 * checked.
 */
async function serviceRoleCanReadTable(client: TableReader): Promise<boolean> {
  try {
    const { data, error } = await client.from('admin_profiles').select('id').limit(1);
    if (error) return false;
    if (Array.isArray(data)) return data.length > 0;
    return data !== null && data !== undefined;
  } catch {
    return false;
  }
}

export type VerifiedChurchAccess = {
  outcome: ChurchAccessOutcome;
  /** The row the verdict was reached on, for the caller's own logging. */
  profile: ChurchProfileRow;
  serviceRoleConfigured: boolean;
  /** True when the caller's RLS policy decided it, not the service-role key. */
  degradedVerification: boolean;
};

/**
 * Verify that the signed-in user may administer `churchId`, and classify the
 * result honestly.
 *
 * Why a second read exists: with RLS enabled and no policy for `service_role` —
 * which is exactly what a half-applied `supabase-schema.sql` leaves behind, since
 * 33 `CREATE POLICY` statements had no `DROP POLICY IF EXISTS` guard and a re-run
 * aborted at the first of them — the privileged read returns zero rows and NO
 * error. Every caller used to translate that into "you are not a pastor". The same
 * table under the caller's own policy (`USING (id = auth.uid())`) still yields the
 * row, which both proves the profile exists and cannot leak another user's data.
 * Tenant and role are then checked identically, so the fallback never widens
 * access; it only changes which failure gets named.
 */
export async function verifyChurchAdminAccess(options: {
  adminClient: TableReader;
  userClient: TableReader;
  userId: string;
  churchId?: string | null;
  allowedRoles?: readonly string[];
}): Promise<VerifiedChurchAccess> {
  const serviceRoleConfigured = isServiceRoleConfigured();

  let profile: ChurchProfileRow = null;
  let profileLookupFailed = false;
  if (serviceRoleConfigured) {
    const read = await readOwnProfile(options.adminClient, options.userId);
    profile = read.profile;
    profileLookupFailed = read.failed;
  }

  let selfScopedProfile: ChurchProfileRow = null;
  let selfScopedLookupFailed = false;
  let canReadTable: boolean | undefined;

  // Nothing was learned from the privileged read, so ask the caller's own policy —
  // but only when there IS a privileged client to compare against, and only when
  // the read ran (an error means the row may exist and simply was not readable).
  if (serviceRoleConfigured && !profile && !profileLookupFailed) {
    const read = await readOwnProfile(options.userClient, options.userId);
    selfScopedProfile = read.profile;
    selfScopedLookupFailed = read.failed;
    if (!selfScopedProfile && !selfScopedLookupFailed) {
      canReadTable = await serviceRoleCanReadTable(options.adminClient);
    }
  }

  const outcome = resolveChurchAdminAccess({
    serviceRoleConfigured,
    profile,
    profileLookupFailed,
    selfScopedProfile,
    selfScopedLookupFailed,
    serviceRoleCanReadTable: canReadTable,
    expectedTenantId: options.churchId ?? null,
    allowedRoles: options.allowedRoles,
  });

  return {
    outcome,
    profile: outcome.kind === 'granted' && outcome.via === 'self-scoped' ? selfScopedProfile : profile,
    serviceRoleConfigured,
    degradedVerification: outcome.kind === 'granted' && outcome.via === 'self-scoped',
  };
}

/** Log which read path decided the request, and why a non-grant happened. */
export function describeAccessFailure(
  route: string,
  userId: string,
  churchId: string | null | undefined,
  verified: VerifiedChurchAccess,
): void {
  const { outcome, serviceRoleConfigured } = verified;

  if (outcome.kind === 'granted') {
    if (verified.degradedVerification) {
      console.error(
        `[${route}] service-role read of admin_profiles returned no rows while the caller's own RLS policy returned one `
        + `(user=${userId} serviceRoleConfigured=${serviceRoleConfigured}). The service_role policy on public.admin_profiles `
        + 'is missing — see migrations/016_rls_policy_repair.sql. Granted on the self-scoped row.',
      );
    }
    return;
  }

  const reason = outcome.kind === 'denied' ? ` (${outcome.reason})` : '';
  const detail = 'error' in outcome ? outcome.error : 'unavailable';
  const log = outcome.kind === 'denied' ? console.warn : console.error;
  log(`[${route}] access ${outcome.kind}${reason} user=${userId} church=${churchId ?? 'n/a'}: ${detail}`);
}
