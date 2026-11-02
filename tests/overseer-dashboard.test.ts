import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverseerDashboardSnapshot, pickRevokeTarget } from '../lib/overseer-dashboard-data.ts';

const emptyRpcResults = (): Parameters<typeof buildOverseerDashboardSnapshot>[0] => ({
  totals: {
    data: [{ church_count: 0, member_total: 0, giving_total: 0, active_churches_30d: 0 }],
    error: null,
  },
  churches: { data: [], error: null },
  invites: { data: [], error: null },
});

test('overseer data failure is reported instead of being disguised as zero totals', () => {
  const results = emptyRpcResults();
  results.totals = { data: null, error: { message: 'database unavailable' } };
  const response = buildOverseerDashboardSnapshot(results);
  assert.ok('error' in response);
  assert.match(response.error, /temporarily unavailable/i);
});

test('a successful empty database result preserves real zero totals and empty collections', () => {
  const response = buildOverseerDashboardSnapshot(emptyRpcResults());
  assert.ok('success' in response);
  assert.deepEqual(response.totals, {
    total_churches: 0,
    total_members: 0,
    total_giving: 0,
    active_pastors: 0,
    denomination_name: undefined,
    denomination_slug: undefined,
  });
  assert.deepEqual(response.churches, []);
  assert.deepEqual(response.invites, []);
});

test('incomplete totals are rejected instead of filling missing fields with zero', () => {
  const results = emptyRpcResults();
  results.totals = { data: [{ church_count: 3, member_total: 12 }], error: null };
  const response = buildOverseerDashboardSnapshot(results);
  assert.ok('error' in response);
  assert.match(response.error, /incomplete/i);
});

test('invalid church summary rows do not render fabricated placeholder churches', () => {
  const results = emptyRpcResults();
  results.churches = {
    data: [{ church_id: 'church-1', church_name: 'Grace Church', slug: 'grace-church' }],
    error: null,
  };
  const response = buildOverseerDashboardSnapshot(results);
  assert.ok('error' in response);
  assert.match(response.error, /church summary response was incomplete/i);
});

// Revoking is the only way to retire an outstanding pastor-invite code before it is
// redeemed, and the live function takes `p_invite_id uuid` and nothing else (measured on
// the production database 2026-11-02). These two properties are what keep that control
// reachable and honest.
test('an invite row keyed by invite_id still yields a usable id, and aliases are normalised', () => {
  const results = emptyRpcResults();
  results.invites = {
    data: [{
      invite_id: '3f2a1b9c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      raw_code: '  ABC123  ',
      label: 'Kampala parish',
      usage_count: '2',
      max_uses: 5,
      revoked_at: null,
    }],
    error: null,
  };
  const response = buildOverseerDashboardSnapshot(results);
  assert.ok('success' in response);
  assert.deepEqual(response.invites[0], {
    id: '3f2a1b9c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    label: 'Kampala parish',
    code: 'ABC123',
    max_uses: 5,
    uses_count: 2,
    expires_at: null,
    created_at: undefined,
    revoked: false,
  });
});

test('revoked_at set means revoked, and its absence is not reported as revoked', () => {
  const results = emptyRpcResults();
  results.invites = {
    data: [{ id: 'a1', revoked_at: '2026-10-01T00:00:00Z' }, { id: 'a2' }],
    error: null,
  };
  const response = buildOverseerDashboardSnapshot(results);
  assert.ok('success' in response);
  assert.equal(response.invites[0].revoked, true);
  assert.equal(response.invites[1].revoked, undefined);
  assert.equal(response.invites[1].code, undefined, 'no invented code for a row that has none');
});

test('unlimited max_uses stays null instead of becoming zero uses allowed', () => {
  const results = emptyRpcResults();
  results.invites = { data: [{ id: 'a1', max_uses: null, uses_count: 0 }], error: null };
  const response = buildOverseerDashboardSnapshot(results);
  assert.ok('success' in response);
  assert.equal(response.invites[0].max_uses, null);
  assert.equal(response.invites[0].uses_count, 0);
});

test('an invalid invite row is still an error, not an empty list', () => {
  const results = emptyRpcResults();
  results.invites = { data: ['just a string'], error: null };
  const response = buildOverseerDashboardSnapshot(results);
  assert.ok('error' in response);
  assert.match(response.error, /invite response was invalid/i);
});

test('revoke accepts a uuid and refuses anything else before making a request', () => {
  assert.deepEqual(
    pickRevokeTarget(' 3F2A1B9C-4D5E-4F60-8A7B-9C0D1E2F3A4B '),
    { ok: true, inviteId: '3f2a1b9c-4d5e-4f60-8a7b-9c0d1e2f3a4b' },
    'case is normalised because the database column is uuid, not text',
  );
  assert.deepEqual(pickRevokeTarget(''), { ok: false, error: 'No invite selected.' });
  for (const notAnId of ['ABC123', 'invite-7', '3f2a1b9c-4d5e-4f60-8a7b', 'kaka; DROP TABLE x']) {
    const verdict = pickRevokeTarget(notAnId);
    assert.equal(verdict.ok, false, `"${notAnId}" is not a uuid, so it cannot be sent as p_invite_id`);
    if (!verdict.ok) assert.match(verdict.error, /without an invite id/);
  }
});
