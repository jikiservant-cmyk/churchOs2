// Guards the provisioning drift that let 18 churches run on a function the
// repository never defined.
//
// The application calls RPCs by name. If no migration or schema file creates
// that function, a database rebuilt from this repository is missing it, and
// nothing in CI notices — tests/provisioning-security.test.ts only asserts the
// *call* exists, which is exactly the half that was never in doubt.
//
// This test compares the two sides. Known gaps are listed explicitly so the
// ratchet cannot silently widen: adding a new unsourced RPC fails, and so does
// fixing one without removing it from the list.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// RPCs the app calls for which this repository defines no function anywhere
// (checked: every .sql file, plus supabase-schema.sql).
//
// This list is a baseline, not an endorsement. It exists so the gap cannot grow
// silently, and the test fails the moment an entry is fixed without being
// removed, so it cannot rot either.
//
// Being on this list means: a database built from this repository is missing
// the function, and nothing in CI would have noticed before this test existed.
const NOT_IN_REPO = new Set([
  // Login path — a rebuilt database cannot authenticate anyone.
  'my_login_context',
  // Provisioning. Actively being captured; see migrations/013 and
  // scripts/capture-rpc.mjs.
  'provision_church_v3',
  // Denomination / overseer surface.
  'create_denomination_overseer_invite',
  'get_denomination_branding',
  'join_denomination_with_invite',
  'redeem_denomination_overseer_invite',
  'overseer_church_summary',
  'overseer_create_invite',
  'overseer_denomination_totals',
  'overseer_detach_church',
  'overseer_list_invites',
  'overseer_revoke_invite',
]);

const KNOWN_UNSOURCED = NOT_IN_REPO;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function calledRpcs() {
  const names = new Set();
  for (const file of [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))]) {
    if (!['.ts', '.tsx'].includes(extname(file))) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.rpc\(\s*['"]([a-z0-9_]+)['"]/gi)) names.add(m[1]);
  }
  return names;
}

function definedRpcs() {
  const files = [
    join(ROOT, 'supabase-schema.sql'),
    ...readdirSync(join(ROOT, 'migrations'))
      .filter(f => f.endsWith('.sql'))
      .map(f => join(ROOT, 'migrations', f)),
  ];
  const names = new Set();
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    // Functions live in more than one schema (public, church, auth), so the
    // schema prefix is any identifier, not just `public.`.
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:[a-z_][a-z0-9_]*\.)?([a-z0-9_]+)\s*\(/gi)) {
      names.add(m[1].toLowerCase());
    }
  }
  return names;
}

describe('app RPC calls are backed by definitions in the repository', () => {
  it('finds the call sites at all (sanity)', () => {
    const calls = calledRpcs();
    assert.ok(calls.size > 0, 'expected to discover RPC calls in app/ and lib/');
    assert.ok(calls.has('provision_church_v3'), 'provision_church_v3 call site should be discovered');
  });

  it('has no unsourced RPCs beyond the documented gaps', () => {
    const unsourced = [...calledRpcs()].filter(n => !definedRpcs().has(n)).sort();
    assert.deepEqual(
      unsourced,
      [...KNOWN_UNSOURCED].sort(),
      'An RPC called by the app has no CREATE FUNCTION in the repo, or a known gap was fixed.\n' +
      `Unsourced: ${unsourced.join(', ') || '(none)'}\n` +
      `Known:      ${[...KNOWN_UNSOURCED].join(', ') || '(none)'}\n` +
      'Capture it with: node scripts/capture-rpc.mjs <dump.sql> --out migrations/013_provision_church_v3.sql'
    );
  });

  it('documents the v3/v2 signature drift rather than hiding it', () => {
    const schema = readFileSync(join(ROOT, 'supabase-schema.sql'), 'utf8');
    const caller = readFileSync(join(ROOT, 'lib/provision-actions.ts'), 'utf8');
    // The repo's v2 replaces the app's p_invite_code with p_ip. They are not
    // interchangeable, which is why v2 cannot stand in for the deployed v3.
    assert.match(schema, /FUNCTION public\.provision_church_v2\([\s\S]{0,200}p_ip text/);
    assert.match(caller, /p_invite_code:\s*inviteCode/);
    assert.doesNotMatch(caller, /p_ip:/);
  });
});
