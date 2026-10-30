import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHURCH_ADMIN_ROLES,
  SMS_BROADCAST_ROLES,
  resolveChurchAdminAccess,
} from '../lib/auth-security.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * Regression guard for the incident where a pastor was told "only pastors or
 * administrators can enqueue broadcasts" while holding the pastor role, and the
 * SMS balance rendered as 0 while `public.wallets` had a real balance.
 *
 * Both were the same fault: the service-role client was a placeholder, so the
 * admin_profiles read returned *no rows*, and no-rows had exactly one meaning
 * in the code — "denied". Missing configuration must never be reported as an
 * authorization verdict.
 */
describe('church admin access classification', () => {
  it('grants a verified pastor of the matching tenant', () => {
    const outcome = resolveChurchAdminAccess({
      serviceRoleConfigured: true,
      profile: { tenant_id: TENANT, role: 'pastor' },
      profileLookupFailed: false,
      expectedTenantId: TENANT,
      allowedRoles: SMS_BROADCAST_ROLES,
    });
    assert.equal(outcome.kind, 'granted');
  });

  it('reports a missing service-role key as 503, never as 403', () => {
    const outcome = resolveChurchAdminAccess({
      serviceRoleConfigured: false,
      profile: null,
      profileLookupFailed: false,
      expectedTenantId: TENANT,
      allowedRoles: SMS_BROADCAST_ROLES,
    });
    assert.equal(outcome.kind, 'unconfigured');
    assert.equal(outcome.status, 503);
    assert.match((outcome as { error: string }).error, /SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('reports a failed lookup as 503, never as 403', () => {
    // Schema drift (a column the deployed DB does not have) failed the same way
    // as a real denial, which is why this branch is separated.
    const outcome = resolveChurchAdminAccess({
      serviceRoleConfigured: true,
      profile: null,
      profileLookupFailed: true,
      expectedTenantId: TENANT,
      allowedRoles: SMS_BROADCAST_ROLES,
    });
    assert.equal(outcome.kind, 'lookup-failed');
    assert.equal(outcome.status, 503);
  });

  it('fails closed: an unavailable verifier can never grant', () => {
    for (const serviceRoleConfigured of [false, true]) {
      for (const profileLookupFailed of [false, true]) {
        const outcome = resolveChurchAdminAccess({
          serviceRoleConfigured,
          profile: { tenant_id: TENANT, role: 'pastor' },
          profileLookupFailed,
          expectedTenantId: TENANT,
        });
        if (!serviceRoleConfigured || profileLookupFailed) {
          assert.notEqual(outcome.kind, 'granted');
          assert.equal((outcome as { status: number }).status, 503);
        }
      }
    }
  });

  it('distinguishes a missing profile from a tenant mismatch', () => {
    const missing = resolveChurchAdminAccess({
      serviceRoleConfigured: true,
      profile: null,
      profileLookupFailed: false,
      expectedTenantId: TENANT,
    });
    assert.equal(missing.kind, 'denied');
    assert.equal((missing as { reason: string }).reason, 'no-profile');

    const mismatch = resolveChurchAdminAccess({
      serviceRoleConfigured: true,
      profile: { tenant_id: OTHER, role: 'pastor' },
      profileLookupFailed: false,
      expectedTenantId: TENANT,
    });
    assert.equal(mismatch.kind, 'denied');
    assert.equal((mismatch as { reason: string }).reason, 'tenant-mismatch');
    assert.equal(mismatch.status, 403);
  });

  it('keeps the wallet endpoint stricter than the broadcast endpoint', () => {
    const staff = { tenant_id: TENANT, role: 'staff' };

    // Broadcasts: staff/member are allowed because the shared Saccos profiles
    // table uses `member`; the tenant check is what actually bounds it.
    assert.equal(
      resolveChurchAdminAccess({
        serviceRoleConfigured: true,
        profile: staff,
        profileLookupFailed: false,
        expectedTenantId: TENANT,
        allowedRoles: SMS_BROADCAST_ROLES,
      }).kind,
      'granted',
    );

    // Wallet top-up status: pastors and admins only.
    const denied = resolveChurchAdminAccess({
      serviceRoleConfigured: true,
      profile: staff,
      profileLookupFailed: false,
      expectedTenantId: TENANT,
      allowedRoles: CHURCH_ADMIN_ROLES,
    });
    assert.equal(denied.kind, 'denied');
    assert.equal((denied as { reason: string }).reason, 'role');
  });

  it('never lets a null profile through when no tenant is asserted', () => {
    const outcome = resolveChurchAdminAccess({
      serviceRoleConfigured: true,
      profile: null,
      profileLookupFailed: false,
    });
    assert.equal(outcome.kind, 'denied');
  });
});
