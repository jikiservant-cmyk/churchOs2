import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverseerDashboardSnapshot } from '../lib/overseer-dashboard-data.ts';

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
