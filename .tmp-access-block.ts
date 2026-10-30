export type ChurchProfileRow = { tenant_id?: string | null; role?: string | null } | null;

export type ChurchAccessInput = {
  /** Whether the service-role client is real, or a placeholder that cannot query. */
  serviceRoleConfigured: boolean;
  /** The `admin_profiles` row for the caller, if the service-role read returned one. */
  profile: ChurchProfileRow;
  /** The lookup itself errored (network, permissions, schema drift). */
  profileLookupFailed: boolean;
  /**
   * The same row read back through the caller's OWN RLS policy
   * (`USING (id = auth.uid())`). If it appears here but not above, the row exists
   * and the privileged read is the thing that is broken.
   */
  selfScopedProfile?: ChurchProfileRow;
  /** The RLS read errored — usually a missing EXECUTE grant on my_tenant_id(). */
  selfScopedLookupFailed?: boolean;
  /**
   * False when an unfiltered service-role read of `admin_profiles` is empty too.
   * RLS without a policy returns zero rows *and no error*, so "this user has no
   * profile" and "nobody can read this table" are otherwise indistinguishable —
   * and only one of them should ever be called a denial.
   */
  serviceRoleCanReadTable?: boolean;
  /** Tenant the caller is acting on; compared against the profile's tenant. */
  expectedTenantId?: string | null;
  allowedRoles?: readonly string[];
};

export type ChurchAccessOutcome =
  /** Verified: correct tenant, allowed role. */
  | { kind: 'granted'; via: 'service-role' | 'self-scoped' }
  /** Cannot verify anything — configuration gap, never an authorization verdict. */
  | { kind: 'unconfigured'; status: 503; error: string }
  /** Verified attempt failed on the database side — retryable, not a denial. */
  | { kind: 'lookup-failed'; status: 503; error: string }
  /**
   * Every read path came up empty on a table that must be readable for anyone at
   * all — the signature of RLS enabled without a policy for `service_role`.
   */
  | { kind: 'policy-gap'; status: 503; error: string }
  /** Verified denial. `reason` is for logs, never returned to the client. */
  | { kind: 'denied'; status: 403; error: string; reason: 'no-profile' | 'tenant-mismatch' | 'role' };

const NO_PROFILE = 'Access denied: this account has no admin profile for that church workspace.';
const TENANT_MISMATCH = 'Access denied: your account is linked to a different church workspace.';

/** Tenant and role checks, applied to whichever read produced the row. */
function accessVerdict(
  profile: ChurchProfileRow,
  expectedTenantId: string | null | undefined,
  allowedRoles: readonly string[],
): ChurchAccessOutcome | null {
  if (!profile) {
    return { kind: 'denied', status: 403, error: NO_PROFILE, reason: 'no-profile' };
  }
  if (expectedTenantId && profile.tenant_id !== expectedTenantId) {
    return { kind: 'denied', status: 403, error: TENANT_MISMATCH, reason: 'tenant-mismatch' };
  }
  if (!hasAllowedRole(profile.role, allowedRoles)) {
    return {
      kind: 'denied',
      status: 403,
      error: `Access denied: requires one of ${allowedRoles.join(', ')}.`,
      reason: 'role',
    };
  }
  return null;
}

/**
 * Classify a service-role admin-profile check into a decision the client can act on.
 *
 * Exists because collapsing "the query returned nothing" into "you are not allowed"
 * turns infrastructure faults into messages that blame the user. Three separate
 * failures all arrive as an empty result:
 *
 *   1. `SUPABASE_SERVICE_ROLE_KEY` missing, so the client is a placeholder;
 *   2. a projection over a column the deployed table does not have (42703);
 *   3. RLS enabled on `public.admin_profiles` with no policy for `service_role`,
 *      which Postgres answers with zero rows and NO error whatsoever.
 *
 * (3) is the one that hides longest, because nothing in the response looks like a
 * failure. Fail-closed is preserved: only `granted` authorises, and the self-scoped
 * fallback can only ever return the caller's own row.
 */
export function resolveChurchAdminAccess(input: ChurchAccessInput): ChurchAccessOutcome {
  const allowedRoles = input.allowedRoles ?? CHURCH_ADMIN_ROLES;

  if (!input.serviceRoleConfigured) {
    return {
      kind: 'unconfigured',
      status: 503,
      error: 'Access verification is unavailable on this deployment: SUPABASE_SERVICE_ROLE_KEY is not set. Add it in the host’s environment variables and redeploy.',
    };
  }
  if (input.profileLookupFailed) {
    return {
      kind: 'lookup-failed',
      status: 503,
      error: 'Access verification is temporarily unavailable. Please retry — if it persists, check that public.admin_profiles is readable and its columns match the app.',
    };
  }

  if (input.profile) {
    const denial = accessVerdict(input.profile, input.expectedTenantId, allowedRoles);
    return denial ?? { kind: 'granted', via: 'service-role' };
  }

  // The privileged read came up empty. Ask the caller's own RLS policy before
  // concluding anything: it is scoped to `id = auth.uid()`, so a match proves the
  // row exists and that it is the service-role read that is broken, not the user.
  if (input.selfScopedLookupFailed) {
    return {
      kind: 'lookup-failed',
      status: 503,
      error: 'Access verification is temporarily unavailable: the workspace membership check itself failed. If this persists, check EXECUTE on church.my_tenant_id() for authenticated.',
    };
  }
  if (input.selfScopedProfile) {
    // Same verdict either way: a denial on the caller's own row is a real answer,
    // and the policy gap explains only why the privileged read was empty.
    const denial = accessVerdict(input.selfScopedProfile, input.expectedTenantId, allowedRoles);
    return denial ?? { kind: 'granted', via: 'self-scoped' };
  }
  if (input.serviceRoleCanReadTable === false) {
    return {
      kind: 'policy-gap',
      status: 503,
      error: 'The server cannot read public.admin_profiles: it returns no rows for every account, which is row-level security enabled without a policy for service_role. Re-apply migrations/016_rls_policy_repair.sql.',
    };
  }
  return { kind: 'denied', status: 403, error: NO_PROFILE, reason: 'no-profile' };
}

