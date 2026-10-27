// Tests scripts/capture-rpc.mjs end to end. The security requirement is
// narrow and absolute: a credential embedded in a captured function definition
// must never be printed, and must block the write.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

    // It must be the hash of the definition as pg_get_functiondef returns it,
    // because that is what 014 recomputes inside the database.
    const expected = createHash('sha256').update(GOOD.trim(), 'utf8').digest('hex');
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
    const live = createHash('sha256').update(GOOD.trim(), 'utf8').digest('hex');
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

  it('extracts only the target function from a multi-statement dump', () => {
    const dump = `SELECT 1;\n\n${GOOD}\n\nCREATE OR REPLACE FUNCTION public.other()\nRETURNS int LANGUAGE sql AS $f$ SELECT 2 $f$;\n`;
    const r = run({ dump });
    assert.equal(r.code, 0, r.combined);
    assert.ok(r.wrote);
  });
});
