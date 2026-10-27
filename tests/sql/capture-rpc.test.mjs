// Tests scripts/capture-rpc.mjs end to end. The security requirement is
// narrow and absolute: a credential embedded in a captured function definition
// must never be printed, and must block the write.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/capture-rpc.mjs');

const GOOD = `CREATE OR REPLACE FUNCTION public.provision_church_v3(
  p_user_id uuid,
  p_name text,
  p_slug text,
  p_role text,
  p_invite_code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, church, auth
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO church.churches (name, slug, passkey, passkey_version)
  VALUES (p_name, p_slug, upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)), 1)
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;
`;

// Same function, but the fifth parameter is the v2 one — the exact drift.
const WRONG_SIGNATURE = GOOD.replace('p_invite_code text DEFAULT NULL', 'p_ip text DEFAULT NULL');

// Same function with a credential baked into the body. The string is synthetic
// and is asserted absent from all output.
// Built by concatenation so this file does not itself contain a string that
// repository secret scanners would flag. The assembled value is synthetic.
const FAKE_SECRET = ['sk', 'live', 'THISisASyntheticTestValue99'].join('_');
const WITH_SECRET = GOOD.replace('  v_id uuid;', `  v_id uuid;\n  v_key text := '${FAKE_SECRET}';`);

// No passkey assignment at all — blocks passkey NOT NULL later.
const NO_PASSKEY = `CREATE OR REPLACE FUNCTION public.provision_church_v3(
  p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text DEFAULT NULL
)
RETURNS uuid LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT gen_random_uuid() $function$;
`;

function run(files) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-'));
  const input = join(dir, 'dump.sql');
  const out = join(dir, 'out.sql');
  writeFileSync(input, files.dump);
  let stdout = '', stderr = '', code = 0;
  try {
    stdout = execFileSync('node', [SCRIPT, input, '--out', out, ...(files.args ?? [])],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    stdout = e.stdout?.toString() ?? '';
    stderr = e.stderr?.toString() ?? '';
    code = e.status ?? 1;
  }
  const result = {
    dir, out, code, stdout, stderr,
    combined: `${stdout}\n${stderr}`,
    wrote: existsSync(out),
    content: existsSync(out) ? readFileSync(out, 'utf8') : '',
    redacted: existsSync(`${out}.redacted.sql`),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

// The pin is only usable if its `args` matches pg_get_function_identity_arguments
// byte for byte. Verified against a real PostgreSQL rather than by inspection,
// using the three signatures confirmed on the live database.
async function identityArgsMatches(createSql, argsName) {
  const db = new PGlite();
  await db.exec('CREATE SCHEMA IF NOT EXISTS private;');
  await db.exec(createSql);
  const { rows } = await db.query(
    'SELECT pg_get_function_identity_arguments(p.oid) AS a FROM pg_proc p WHERE p.proname = $1',
    [argsName]);
  await db.close();
  return rows[0].a;
}

function dumpFor({ schema = 'public', name, params }) {
  return `CREATE OR REPLACE FUNCTION ${schema}.${name}(${params})
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v uuid;
BEGIN
  INSERT INTO church.churches (name, slug, passkey) VALUES ('x','y','ABCDEF1234') RETURNING id INTO v;
  RETURN v;
END $function$;
`;
}

describe('capture-rpc.mjs', () => {
  it('accepts a definition that matches the call site and writes the migration', () => {
    const r = run({ dump: GOOD });
    assert.equal(r.code, 0, r.combined);
    assert.ok(r.wrote, 'expected the migration to be written');
    assert.match(r.stdout, /matches the call site/);
    assert.match(r.stdout, /Writes passkey\s+yes/);
  });

  it('rejects the v2 signature, because the app sends p_invite_code', () => {
    const r = run({ dump: WRONG_SIGNATURE });
    assert.notEqual(r.code, 0);
    assert.match(r.combined, /missing parameter p_invite_code/);
    assert.match(r.combined, /unexpected parameter p_ip/);
  });

  it('rejects a definition that never writes a passkey', () => {
    // passkey NOT NULL cannot be enforced, and new churches would repeat the
    // outage that locked 16 churches out.
    const r = run({ dump: NO_PASSKEY });
    assert.notEqual(r.code, 0, r.combined);
    assert.equal(r.wrote, false, 'must not write a definition without a passkey');
    assert.match(r.stdout, /Writes passkey\s+NO/);
    assert.match(r.combined, /body never assigns a passkey/);
  });

  it('refuses to write a definition containing a credential', () => {
    const r = run({ dump: WITH_SECRET });
    assert.notEqual(r.code, 0, 'expected a non-zero exit');
    assert.equal(r.wrote, false, 'must not write the migration');
    assert.ok(r.redacted, 'expected a redacted copy for inspection');
    assert.match(r.combined, /Refusing to write/);
  });

  it('never prints the credential value it detected', () => {
    const r = run({ dump: WITH_SECRET });
    assert.ok(!r.combined.includes(FAKE_SECRET), 'the secret leaked to stdout/stderr');
    // It still has to say *something* useful: the rule, the line, the length.
    assert.match(r.combined, /BLOCK\s+stripe-key\s+line \d+, \d+ chars/);
  });

  it('redacted copy replaces the value but keeps the shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-'));
    const input = join(dir, 'dump.sql');
    const out = join(dir, 'out.sql');
    writeFileSync(input, WITH_SECRET);
    try { execFileSync('node', [SCRIPT, input, '--out', out], { stdio: 'pipe' }); } catch { /* expected */ }
    const redacted = readFileSync(`${out}.redacted.sql`, 'utf8');
    assert.ok(!redacted.includes(FAKE_SECRET), 'redacted copy still contains the secret');
    assert.match(redacted, /\[REDACTED:stripe-key:\d+ch\]/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures a schema-qualified routine in a non-public schema', () => {
    const dump = GOOD
      .replace('public.provision_church_v3', 'private.provision_church_v3_impl');
    const r = run({ dump, args: ['--rpc', 'private.provision_church_v3_impl'] });
    assert.equal(r.code, 0, r.combined);
    assert.ok(r.wrote);
    assert.match(r.combined, /private\.provision_church_v3_impl/);
    // No contract exists for the helper, so contract checks must not fire.
    assert.doesNotMatch(r.combined, /missing parameter/);
  });

  it('will not capture the wrong schema silently', () => {
    // The dump holds public.provision_church_v3; asking for the private helper
    // must fail rather than capture whatever matches the name.
    const r = run({ dump: GOOD, args: ['--rpc', 'private.provision_church_v3_impl'] });
    assert.notEqual(r.code, 0);
    assert.equal(r.wrote, false);
    assert.match(r.combined, /No CREATE FUNCTION private\.provision_church_v3_impl/);
  });

  it('emits the fingerprint that migrations/014 pins', () => {
    const r = run({ dump: GOOD });
    assert.equal(r.code, 0, r.combined);
    const printed = r.combined.match(/sha256:([0-9a-f]{64})/);
    assert.ok(printed, 'no fingerprint printed');

    // It must be the hash of the definition exactly as pg_get_functiondef
    // returns it — which ends with a newline — because that is what 014
    // recomputes inside the database. Hashing the trimmed text produced
    // fingerprints that never matched; see tests/sql/fingerprint-parity.test.mjs.
    const expected = createHash('sha256').update(GOOD.trim() + '\n', 'utf8').digest('hex');
    assert.equal(printed[1], expected, 'fingerprint does not match the definition text');

    // …and it must be recorded in the file, so the pin survives a lost terminal.
    assert.ok(r.content.includes(printed[1]), 'written migration does not record the fingerprint');
    // The hint must be a ready v_pins entry for migrations/014, with args
    // normalised to pg_get_function_identity_arguments form.
    const entry = r.combined.match(/\{"schema":"[^"]+","name":"[^"]+","args":"[^"]*","fingerprint":"[0-9a-f]{64}"\}/);
    assert.ok(entry, 'no v_pins entry printed');
    const parsed = JSON.parse(entry[0]);
    assert.equal(parsed.schema, 'public');
    assert.equal(parsed.name, 'provision_church_v3');
    assert.equal(parsed.args, 'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text');
    assert.equal(parsed.fingerprint, expected);
  });

  it('--expect confirms the dump is the deployed function', () => {
    const live = createHash('sha256').update(GOOD.trim() + '\n', 'utf8').digest('hex');
    const r = run({ dump: GOOD, args: ['--expect', live] });
    assert.equal(r.code, 0, r.combined);
    assert.ok(r.wrote);
    assert.match(r.combined, /byte-identical to the deployed function/);
    assert.match(r.content, /matches the live database: yes/);
  });

  it('--expect refuses a dump that is not the deployed function', () => {
    // A different (e.g. older) capture of the same name and signature.
    const r = run({ dump: GOOD, args: ['--expect', 'a'.repeat(64)] });
    assert.notEqual(r.code, 0, 'expected a non-zero exit');
    assert.equal(r.wrote, false, 'must not write a definition it cannot vouch for');
    assert.match(r.combined, /not the deployed function/);
    assert.match(r.combined, /expected  sha256:aaaa/);
  });

  it('--expect rejects a malformed fingerprint instead of comparing nonsense', () => {
    const r = run({ dump: GOOD, args: ['--expect', 'not-a-hash'] });
    assert.notEqual(r.code, 0);
    assert.equal(r.wrote, false);
    assert.match(r.combined, /64 lowercase hex characters/);
  });

  it('reproduces pg_get_function_identity_arguments for each live signature', async () => {
    const cases = [
      {
        label: 'public.provision_church_v3',
        schema: 'public', name: 'provision_church_v3',
        params: 'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text DEFAULT NULL',
      },
      {
        label: 'private.provision_church_v3_impl',
        schema: 'private', name: 'provision_church_v3_impl',
        params: 'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text DEFAULT NULL',
      },
      {
        // FOUR arguments on the live database — not the five the repo's v2 declares.
        label: 'public.provision_church_v2 (live, 4 args)',
        schema: 'public', name: 'provision_church_v2',
        params: 'p_user_id uuid, p_name text, p_slug text, p_role text',
      },
    ];

    for (const c of cases) {
      const expected = await identityArgsMatches(
        `CREATE FUNCTION ${c.schema}.${c.name}(${c.params}) RETURNS uuid LANGUAGE sql AS $f$ SELECT gen_random_uuid() $f$;`,
        c.name);
      const r = run({ dump: dumpFor(c), args: ['--rpc', `${c.schema}.${c.name}`] });
      assert.equal(r.code, 0, `${c.label}: ${r.combined}`);
      const entry = r.combined.match(/\{"schema":"[^"]+","name":"[^"]+","args":"[^"]*","fingerprint":"[0-9a-f]{64}"\}/);
      assert.ok(entry, `${c.label}: no pin entry printed`);
      assert.equal(JSON.parse(entry[0]).args, expected, `${c.label}: args do not round-trip`);
      assert.equal(JSON.parse(entry[0]).schema, c.schema, `${c.label}: wrong schema in pin`);
    }
  });

  it('keeps OUT / INOUT / VARIADIC modes and drops IN, as PostgreSQL does', async () => {
    const cases = [
      { name: 'h_out', sql: 'IN a uuid, OUT o integer, IN c text DEFAULT $q$' + 'z' + '$q$'.replace(/\$q\$/g, "'") },
    ];
    // Simpler explicit cases, each compared against the database.
    const shapes = [
      ['h_inout',   'INOUT x int'],
      ['h_var',     'a uuid, VARIADIC b int[]'],
      ['h_mixed',   'OUT o1 int, IN i1 text'],
      ['h_comma',   "a uuid, b text DEFAULT 'x,y'"],
    ];
    for (const [name, params] of shapes) {
      const expected = await identityArgsMatches(
        `CREATE FUNCTION public.${name}(${params}) RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$;`, name);
      const r = run({ dump: dumpFor({ name, params }), args: ['--rpc', `public.${name}`] });
      assert.equal(r.code, 0, `${name}: ${r.combined}`);
      const entry = r.combined.match(/\{"schema":"[^"]+","name":"[^"]+","args":"[^"]*","fingerprint":"[0-9a-f]{64}"\}/);
      assert.equal(JSON.parse(entry[0]).args, expected, `${name}: expected ${JSON.stringify(expected)}`);
    }
  });

  it('distinguishes the live 4-argument v2 from the repo\'s 5-argument v2', async () => {
    // A stale pin taken from supabase-schema.sql must not silently match.
    const live = await identityArgsMatches(
      `CREATE FUNCTION public.provision_church_v2(p_user_id uuid, p_name text, p_slug text, p_role text) RETURNS uuid LANGUAGE sql AS $f$ SELECT gen_random_uuid() $f$;`,
      'provision_church_v2');
    const repo = await identityArgsMatches(
      `CREATE FUNCTION public.provision_church_v2b(p_user_id uuid, p_name text, p_slug text, p_role text, p_ip text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $f$ SELECT gen_random_uuid() $f$;`,
      'provision_church_v2b');
    assert.notEqual(live, repo);
    assert.equal(live.split(',').length, 4);
    assert.equal(repo.split(',').length, 5);
  });

  it('extracts only the target function from a multi-statement dump', () => {
    const dump = `SELECT 1;\n\n${GOOD}\n\nCREATE OR REPLACE FUNCTION public.other()\nRETURNS int LANGUAGE sql AS $f$ SELECT 2 $f$;\n`;
    const r = run({ dump });
    assert.equal(r.code, 0, r.combined);
    assert.ok(r.wrote);
  });
});
