import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  describeAccessFailure,
  verifyChurchAdminAccess,
} from '@/lib/supabase/church-access';

/**
 * The RLS failure mode, exercised without a database.
 *
 * Context: `church.churches`, `public.wallets` and friends have
 * `ENABLE ROW LEVEL SECURITY`, and `supabase-schema.sql` created 33 policies with
 * no `DROP POLICY IF EXISTS` guard. A re-run therefore aborted at the first of
 * them, so on the live project RLS is on while the policies are partly missing —
 * and Postgres answers that with zero rows and NO error. Every read below models
 * exactly that shape so the fallback behaviour is pinned, not hoped for.
 *
 * Run through `tsx` (see the `test` script) because it resolves `@/`.
 */

const PASTOR = '99999999-9999-4999-8999-999999999999';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PASTOR_ROW = { tenant_id: TENANT_A, role: 'pastor' };

type Outcome = { data?: unknown; error?: { code?: string; message?: string } | null };

/** Minimal stand-in for a Supabase client: only the three chained reads are used. */
function fakeDb(
  handler: (columns: string, call: number) => Outcome,
  calls: string[],
) {
  let columns = '';
  let count = 0;
  const chain: Record<string, unknown> = {
    select(next: string) {
      columns = next;
      return chain;
    },
    eq() { return chain; },
    or() { return chain; },
    limit() {
      calls.push(`limit(${columns})`);
      return Promise.resolve(handler(columns, ++count));
    },
    maybeSingle() {
      calls.push(`maybeSingle(${columns})`);
      return Promise.resolve(handler(columns, ++count));
    },
  };
  return { from: () => chain } as never;
}

const EMPTY = (): Outcome => ({ data: null, error: null });
const ROW = (row: unknown): Outcome => ({ data: row, error: null });

const ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    process.env[key] = key.includes('URL') ? 'https://project.supabase.co' : 'service-role-key';
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('church admin access under a broken RLS policy', () => {
  it('grants from the service-role read and never tries the fallback', async () => {
    const adminCalls: string[] = [];
    const userCalls: string[] = [];
    const verified = await verifyChurchAdminAccess({
      adminClient: fakeDb(() => ROW(PASTOR_ROW), adminCalls),
      userClient: fakeDb(() => ROW(PASTOR_ROW), userCalls),
      userId: PASTOR,
      churchId: TENANT_A,
    });
    assert.equal(verified.outcome.kind, 'granted');
    assert.equal(verified.outcome.kind === 'granted' && verified.outcome.via, 'service-role');
    assert.equal(userCalls.length, 0, 'the privileged read answered, so nothing else should run');
  });

  it('still grants when RLS silently empties the service-role read', async () => {
    // This is the incident: service_role has no policy, so its read returns
    // nothing at all, while the caller's own policy (`id = auth.uid()`) works.
    const verified = await verifyChurchAdminAccess({
      adminClient: fakeDb(EMPTY, []),
      userClient: fakeDb((columns) => (columns === 'tenant_id, role' ? ROW(PASTOR_ROW) : ROW({ id: PASTOR })), []),
      userId: PASTOR,
      churchId: TENANT_A,
    });
    assert.equal(verified.outcome.kind, 'granted');
    assert.equal(verified.degradedVerification, true);
    assert.equal(verified.profile?.role, 'pastor');
  });

  it('does NOT widen access through the fallback', async () => {
    const crossTenant = await verifyChurchAdminAccess({
      adminClient: fakeDb(EMPTY, []),
      userClient: fakeDb(() => ROW({ tenant_id: TENANT_A, role: 'pastor' }), []),
      userId: PASTOR,
      // The caller is trying to act on another church's workspace.
      churchId: TENANT_B,
    });
    assert.equal(crossTenant.outcome.kind, 'denied');
    assert.equal(crossTenant.outcome.kind === 'denied' && crossTenant.outcome.reason, 'tenant-mismatch');

    const wrongRole = await verifyChurchAdminAccess({
      adminClient: fakeDb(EMPTY, []),
      userClient: fakeDb(() => ROW({ tenant_id: TENANT_A, role: 'usher' }), []),
      userId: PASTOR,
      churchId: TENANT_A,
      allowedRoles: ['pastor', 'admin'],
    });
    assert.equal(wrongRole.outcome.kind, 'denied');
    assert.equal(wrongRole.outcome.kind === 'denied' && wrongRole.outcome.reason, 'role');
  });

  it('calls a wholly unreadable table a policy gap, not a denial', async () => {
    const calls: string[] = [];
    const verified = await verifyChurchAdminAccess({
      adminClient: fakeDb((columns) => {
        // The unfiltered probe also comes back empty: nobody can read this table.
        if (columns === 'id') return { data: [], error: null };
        return EMPTY();
      }, calls),
      userClient: fakeDb(EMPTY, calls),
      userId: PASTOR,
      churchId: TENANT_A,
    });
    assert.equal(verified.outcome.kind, 'policy-gap');
    assert.equal(verified.outcome.kind === 'policy-gap' && verified.outcome.status, 503);
    assert.match(verified.outcome.kind === 'policy-gap' ? verified.outcome.error : '', /migrations\/016_rls_policy_repair\.sql/);
  });

  it('keeps a genuine "no profile" a 403 when the table is otherwise readable', async () => {
    const verified = await verifyChurchAdminAccess({
      adminClient: fakeDb((columns) => (columns === 'id' ? ROW([{ id: 'someone-else' }]) : EMPTY()), []),
      userClient: fakeDb(EMPTY, []),
      userId: PASTOR,
      churchId: TENANT_A,
    });
    assert.equal(verified.outcome.kind, 'denied');
    assert.equal(verified.outcome.kind === 'denied' && verified.outcome.reason, 'no-profile');
  });

  it('reports a query error as 503 and skips the fallback probe', async () => {
    // The missing-column case (42703) must not be relabelled as a policy gap or a
    // denial: the read itself failed, so no verdict about the user exists.
    const userCalls: string[] = [];
    const verified = await verifyChurchAdminAccess({
      adminClient: fakeDb(() => ({ data: null, error: { code: '42703', message: 'column admin_profiles.app_type does not exist' } }), []),
      userClient: fakeDb(() => ROW(PASTOR_ROW), userCalls),
      userId: PASTOR,
      churchId: TENANT_A,
    });
    assert.equal(verified.outcome.kind, 'lookup-failed');
    assert.equal(userCalls.length, 0);
  });

  it('refuses to decide anything without a service-role key', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const adminCalls: string[] = [];
    const userCalls: string[] = [];
    const verified = await verifyChurchAdminAccess({
      adminClient: fakeDb(() => ROW(PASTOR_ROW), adminCalls),
      userClient: fakeDb(EMPTY, userCalls),
      userId: PASTOR,
      churchId: TENANT_A,
    });
    assert.equal(verified.outcome.kind, 'unconfigured');
    assert.equal(verified.serviceRoleConfigured, false);
    assert.equal(adminCalls.length, 0, 'the placeholder client must not even be queried');
    assert.equal(userCalls.length, 0, 'the verdict is already known; no fallback round-trips');
  });

  it('logs the degraded grant loudly enough to be found in Vercel', async () => {
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      const verified = await verifyChurchAdminAccess({
        adminClient: fakeDb(EMPTY, []),
        userClient: fakeDb((columns) => (columns === 'tenant_id, role' ? ROW(PASTOR_ROW) : ROW({ id: PASTOR })), []),
        userId: PASTOR,
        churchId: TENANT_A,
      });
      describeAccessFailure('Enqueue', PASTOR, TENANT_A, verified);
    } finally {
      console.error = original;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /RLS policy|service_role policy/);
    assert.match(lines[0], /016_rls_policy_repair/);
  });
});
