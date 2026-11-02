import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { resolveLoginDestination } from '@/lib/auth-destination';

/**
 * Where a signed-in visitor is sent — decided against fake PostgREST clients,
 * in the shapes that actually happen in production.
 *
 * Two failure modes are pinned here, and both were live bugs:
 *
 *   1. A church that has not paid the activation fee must land on the payment
 *      screen from every login entry point. The gate used to be re-implemented
 *      per page (and `getChurchBySlug` reported a missing status as 'active'),
 *      so an unpaid workspace reached the dashboard, or was bounced between the
 *      dashboard and the login form.
 *   2. "Zero rows and no error" from `public.admin_profiles` is a policy gap,
 *      not a person without a church. The resolver must decline to route rather
 *      than hand that pastor a `/signup/provision` page with a create-church
 *      button on it.
 *
 * Run through `tsx` (see the `test` script) because it resolves `@/`.
 */

const PASTOR = '99999999-9999-4999-8999-999999999999';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SLUG = 'kasanga-hill';

type Row = Record<string, unknown> | null;
type Outcome = { data?: unknown; error?: { message?: string } | null };

type Scenario = {
  serviceRoleProfile?: Row;
  selfScopedProfile?: Row;
  serviceRoleProbe?: unknown[];
  churches?: Row;
  denominationAdmin?: Row;
  context?: { data: unknown; error: unknown };
};

function makeClient(name: 'service' | 'user', scenario: Scenario) {
  const resolve = (table: string, mode: 'maybeSingle' | 'limit'): Outcome => {
    if (table === 'admin_profiles') {
      if (mode === 'limit') {
        return { data: name === 'service' ? (scenario.serviceRoleProbe ?? []) : [], error: null };
      }
      return {
        data: name === 'service'
          ? (scenario.serviceRoleProfile ?? null)
          : (scenario.selfScopedProfile ?? null),
        error: null,
      };
    }
    if (table === 'churches') return { data: scenario.churches ?? null, error: null };
    if (table === 'denomination_admins') return { data: scenario.denominationAdmin ?? null, error: null };
    return { data: null, error: null };
  };

  const chain = (table: string) => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.ilike = () => builder;
    builder.order = () => builder;
    builder.maybeSingle = () => Promise.resolve(resolve(table, 'maybeSingle'));
    builder.limit = () => Promise.resolve(resolve(table, 'limit'));
    return builder;
  };

  return {
    from: (table: string) => chain(table),
    schema: () => ({ from: (table: string) => chain(table) }),
    rpc: () => Promise.resolve(scenario.context ?? { data: null, error: new Error('rpc missing') }),
  } as never;
}

function churchRow(extra: Record<string, unknown> = {}) {
  return { id: TENANT, slug: SLUG, name: 'Kasanga Hill Assembly', ...extra };
}

async function resolveFor(scenario: Scenario, allowProvisioningRedirect = true) {
  return resolveLoginDestination({
    userClient: makeClient('user', scenario),
    adminClient: makeClient('service', scenario),
    userId: PASTOR,
    surface: 'test',
    allowProvisioningRedirect,
  });
}

const ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ACTIVATION_GATE_LEGACY_NULL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (key === 'ACTIVATION_GATE_LEGACY_NULL') delete process.env[key];
    else process.env[key] = 'set-for-test';
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('Login destination — the activation screen owns an unpaid church', () => {
  it('sends a pastor whose church owes the fee straight to the payment screen', async () => {
    const destination = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'pastor' },
      serviceRoleProbe: [{ id: PASTOR }],
      churches: churchRow({ activation_status: 'pending_payment', activation_paid_at: null }),
    });
    assert.equal(destination.href, `/${SLUG}/admin/activation`);
    assert.equal(destination.needsProvisioning, false);
    assert.equal(destination.accessDenied, false);
  });

  it('sends the same pastor to the portal once the fee is settled', async () => {
    const destination = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'pastor' },
      serviceRoleProbe: [{ id: PASTOR }],
      churches: churchRow({ activation_status: 'active', activation_paid_at: '2026-05-05T00:00:00Z' }),
    });
    assert.equal(destination.href, `/${SLUG}/admin`);
  });

  it('sends an `admin` account, not only a `pastor`', async () => {
    const destination = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'admin' },
      serviceRoleProbe: [{ id: PASTOR }],
      churches: churchRow({ activation_status: 'pending_payment' }),
    });
    assert.equal(destination.href, `/${SLUG}/admin/activation`);
  });

  it('grandfathers a blank status by default, and bills it once the policy is tightened', async () => {
    const scenario: Scenario = {
      serviceRoleProfile: { tenant_id: TENANT, role: 'pastor' },
      serviceRoleProbe: [{ id: PASTOR }],
      churches: churchRow({ activation_status: null, activation_paid_at: null }),
    };
    assert.equal((await resolveFor(scenario)).href, `/${SLUG}/admin`);

    process.env.ACTIVATION_GATE_LEGACY_NULL = 'pay';
    assert.equal((await resolveFor(scenario)).href, `/${SLUG}/admin/activation`);
  });

  it('treats a paid timestamp as a receipt even under the tightened policy', async () => {
    process.env.ACTIVATION_GATE_LEGACY_NULL = 'pay';
    const destination = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'pastor' },
      serviceRoleProbe: [{ id: PASTOR }],
      churches: churchRow({ activation_status: '', activation_paid_at: '2024-01-01T00:00:00Z' }),
    });
    assert.equal(destination.href, `/${SLUG}/admin`);
  });

  it('does not bill a suspended church, so it reaches the suspension notice', async () => {
    const destination = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'pastor' },
      serviceRoleProbe: [{ id: PASTOR }],
      churches: churchRow({ activation_status: 'suspended' }),
    });
    assert.equal(destination.href, `/${SLUG}/admin`);
  });

  it('routes the church found through my_login_context, not just the profile one', async () => {
    const destination = await resolveFor({
      context: { data: [{ account_type: 'pastor', church_slug: SLUG }], error: null },
      serviceRoleProfile: { tenant_id: TENANT, role: 'pastor' },
      serviceRoleProbe: [{ id: PASTOR }],
      churches: churchRow({ activation_status: 'pending_payment' }),
    });
    assert.equal(destination.href, `/${SLUG}/admin/activation`);
  });

  it('leaves an overseer and a platform admin alone', async () => {
    const overseer = await resolveFor({
      context: { data: [{ account_type: 'overseer', denomination_slug: 'central' }], error: null },
    });
    assert.equal(overseer.href, '/d/central/overseer');

    const platform = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'super_admin' },
      serviceRoleProbe: [{ id: PASTOR }],
    });
    assert.equal(platform.href, '/super-admin/overseers');

    const denomination = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'overseer' },
      serviceRoleProbe: [{ id: PASTOR }],
      denominationAdmin: { user_id: PASTOR },
    });
    assert.equal(denomination.href, '/overseer');
  });
});

describe('Login destination — an unreadable table is never called a missing profile', () => {
  it('recovers through the caller’s own policy when the service-role read comes back empty', async () => {
    const destination = await resolveFor({
      serviceRoleProfile: null,
      selfScopedProfile: { tenant_id: TENANT, role: 'pastor' },
      serviceRoleProbe: [],
      churches: churchRow({ activation_status: 'pending_payment' }),
    });
    assert.equal(destination.href, `/${SLUG}/admin/activation`);
  });

  it('declines to route, and never offers provisioning, when nobody can read the table', async () => {
    for (const allowProvisioningRedirect of [true, false]) {
      const destination = await resolveFor({
        serviceRoleProfile: null,
        selfScopedProfile: null,
        serviceRoleProbe: [],
      }, allowProvisioningRedirect);
      assert.equal(destination.href, null, 'a policy gap must not become a redirect');
      assert.equal(destination.needsProvisioning, false);
      assert.match(destination.reason, /policy-gap|unconfigured|lookup-failed/);
    }
  });

  it('sends a genuinely profile-less account to provisioning from /, and to the form from a login screen', async () => {
    const root = await resolveFor({
      serviceRoleProfile: null,
      selfScopedProfile: null,
      serviceRoleProbe: [{ id: 'someone-else' }],
    }, true);
    assert.equal(root.href, '/signup/provision');
    assert.equal(root.needsProvisioning, true);

    const login = await resolveFor({
      serviceRoleProfile: null,
      selfScopedProfile: null,
      serviceRoleProbe: [{ id: 'someone-else' }],
    }, false);
    assert.equal(login.href, null);
    assert.equal(login.needsProvisioning, true);
  });

  it('reports a church that has no row as a provisioning gap, not as a payment screen', async () => {
    const destination = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'pastor' },
      serviceRoleProbe: [{ id: PASTOR }],
      churches: null,
    });
    assert.equal(destination.href, '/signup/provision');
    assert.equal(destination.needsProvisioning, true);
  });

  it('denies a member account without inventing a destination for it', async () => {
    const destination = await resolveFor({
      serviceRoleProfile: { tenant_id: TENANT, role: 'member' },
      serviceRoleProbe: [{ id: PASTOR }],
    });
    assert.equal(destination.href, null);
    assert.equal(destination.accessDenied, true);
    assert.equal(destination.reason, 'role-member');
  });
});
