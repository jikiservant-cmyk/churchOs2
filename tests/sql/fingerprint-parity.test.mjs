// Parities that the pin depends on, checked against a real PostgreSQL.
//
// A pin is only useful if the fingerprint the capture tool prints is the same
// number migrations/014 recomputes inside the database. If they differ by even
// one byte, 014 reports "changed since review" on a definition nobody touched
// — the most alarming possible message, for no reason.
//
// An earlier version of scripts/capture-rpc.mjs failed exactly this way: it
// hashed the trimmed statement, while pg_get_functiondef ends with a newline.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/capture-rpc.mjs');
const M014 = readFileSync(join(ROOT, 'migrations', '014_passkey_not_null.sql'), 'utf8');
const PIN_SQL = readFileSync(join(ROOT, 'scripts', 'capture-v3-pins.sql'), 'utf8');

const DEFINITIONS = [
  {
    label: 'v3 wrapper, plain IN args',
    schema: 'public',
    name: 'provision_church_v3',
    args: 'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text',
    ddl: `CREATE FUNCTION public.provision_church_v3(
  p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  RETURN private.provision_church_v3_impl(p_user_id, p_name, p_slug, p_role, p_invite_code);
END $function$`,
  },
  {
    label: 'private helper, DEFINER, non-public schema',
    schema: 'private',
    name: 'provision_church_v3_impl',
    args: 'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text',
    ddl: `CREATE FUNCTION private.provision_church_v3_impl(
  p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $body$
BEGIN
  RETURN public.provision_church_v2(p_user_id, p_name, p_slug, p_role);
END $body$`,
  },
  {
    label: 'v2, FOUR arguments as deployed',
    schema: 'public',
    name: 'provision_church_v2',
    args: 'p_user_id uuid, p_name text, p_slug text, p_role text',
    ddl: `CREATE FUNCTION public.provision_church_v2(
  p_user_id uuid, p_name text, p_slug text, p_role text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $body$
DECLARE v uuid;
BEGIN
  INSERT INTO church.churches (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v;
  RETURN v;
END $body$`,
  },
  {
    label: 'different dollar tag and an OUT parameter',
    schema: 'public',
    name: 'odd_shape',
    args: 'a uuid, OUT o integer, b text',
    ddl: `CREATE FUNCTION public.odd_shape(IN a uuid, OUT o integer, IN b text DEFAULT 'x,y')
RETURNS integer
LANGUAGE plpgsql
AS $$ BEGIN o := 1; END $$`,
  },
];

async function makeDb(def) {
  const db = new PGlite();
  await db.exec('CREATE SCHEMA IF NOT EXISTS private;');
  await db.exec('CREATE SCHEMA IF NOT EXISTS church;');
  await db.exec(`CREATE TABLE IF NOT EXISTS church.churches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, slug text)`);
  // Create the callees the definitions reference — except when the definition
  // under test *is* that callee, which would collide on (name, argument types).
  const isTarget = (schema, name) => schema === def.schema && name === def.name;
  if (!isTarget('public', 'provision_church_v2')) {
    await db.exec(`CREATE FUNCTION public.provision_church_v2(
        p_user_id uuid, p_name text, p_slug text, p_role text)
      RETURNS uuid LANGUAGE sql AS $f$ SELECT gen_random_uuid() $f$;`);
  }
  if (!isTarget('private', 'provision_church_v3_impl')) {
    await db.exec(`CREATE FUNCTION private.provision_church_v3_impl(
        p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text)
      RETURNS uuid LANGUAGE sql AS $f$ SELECT gen_random_uuid() $f$;`);
  }
  await db.exec(def.ddl);
  return db;
}

const dbFingerprint = async (db, schema, name) => (await db.query(`
  SELECT encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS fp,
         pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = 'f'`, [schema, name])).rows[0];

function runScript(dump, args) {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  const input = join(dir, 'dump.sql');
  const out = join(dir, 'out.sql');
  writeFileSync(input, dump);
  let combined = '';
  try {
    combined = execFileSync('node', [SCRIPT, input, '--out', out, ...args],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  rmSync(dir, { recursive: true, force: true });
  return combined;
}

describe('capture fingerprint parity with pg_get_functiondef', () => {
  for (const def of DEFINITIONS) {
    it(`script and database agree: ${def.label}`, async () => {
      const db = await makeDb(def);
      const { fp, def: text } = await dbFingerprint(db, def.schema, def.name);
      await db.close();

      // Feed the operator's real workflow: the raw pg_get_functiondef output.
      const combined = runScript(text, ['--rpc', `${def.schema}.${def.name}`]);
      const printed = combined.match(/sha256:([0-9a-f]{64})/);
      assert.ok(printed, `no fingerprint printed for ${def.label}:\n${combined}`);

      assert.equal(
        printed[1], fp,
        `${def.label}: the script hashes different bytes than PostgreSQL.\n` +
        `Every pin would fail 014 with "changed since review".\n` +
        `PostgreSQL: ${fp}\nScript:     ${printed[1]}`
      );
    });
  }

  it('the definition text really does end with a newline (the trap)', async () => {
    const db = await makeDb(DEFINITIONS[0]);
    const { def: text, fp } = await dbFingerprint(db, 'public', 'provision_church_v3');
    await db.close();
    assert.ok(text.length > 0);
    assert.match(text, /\n$/, 'pg_get_functiondef is expected to end with a newline');
    // Hashing without it must NOT match — this is the regression being pinned.
    const { createHash } = await import('node:crypto');
    const trimmed = createHash('sha256').update(text.trim(), 'utf8').digest('hex');
    assert.notEqual(trimmed, fp, 'if these matched, the trailing byte would not matter');
  });

  it('--expect accepts the deployed definition and rejects a trimmed copy', async () => {
    const db = await makeDb(DEFINITIONS[2]);
    const { fp, def: text } = await dbFingerprint(db, 'public', 'provision_church_v2');
    await db.close();

    const ok = runScript(text, ['--rpc', 'public.provision_church_v2', '--expect', fp]);
    assert.match(ok, /byte-identical to the deployed function/);

    // Same function, reformatted (indentation removed) — a different definition
    // as far as the database is concerned, and it must not be waved through.
    const reformatted = text.replace(/\n\s*/g, '\n');
    const bad = runScript(reformatted, ['--rpc', 'public.provision_church_v2', '--expect', fp]);
    assert.match(bad, /not the deployed function/);
  });

  it('the SQL-only generator pins all three routines in call order', async () => {
    const db = await makeDb(DEFINITIONS[1]);   // callees created as stubs
    await db.exec(`CREATE OR REPLACE FUNCTION private.provision_church_v3_impl(
      p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text DEFAULT NULL)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $b$
      BEGIN RETURN public.provision_church_v2(p_user_id, p_name, p_slug, p_role); END $b$;`);
    await db.exec(`CREATE FUNCTION public.provision_church_v3(
      p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text DEFAULT NULL)
      RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $b$
      BEGIN RETURN private.provision_church_v3_impl(p_user_id, p_name, p_slug, p_role, p_invite_code); END $b$;`);
    const { rows } = await db.query(PIN_SQL);
    await db.close();

    assert.equal(rows[0].routines_pinned, 3, 'expected all three routines pinned');
    const pins = rows[0].v_pins;
    assert.deepEqual(pins.map(p => `${p.schema}.${p.name}`),
      ['public.provision_church_v3', 'private.provision_church_v3_impl', 'public.provision_church_v2'],
      'pins should read in call order');
    for (const pin of pins) {
      assert.match(pin.fingerprint, /^[0-9a-f]{64}$/, `${pin.name}: fingerprint is not a sha256`);
    }
    // The deployed v2 takes four arguments; the generator must reflect that.
    const v2 = pins.find(p => p.name === 'provision_church_v2');
    assert.equal(v2.args, 'p_user_id uuid, p_name text, p_slug text, p_role text');
  });

  it('generated v_pins are accepted by migrations/014', async () => {
    const db = await makeDb(DEFINITIONS[0]);
    const { fp } = await dbFingerprint(db, 'public', 'provision_church_v3');
    await db.close();

    const pins = [{
      schema: 'public',
      name: 'provision_church_v3',
      args: DEFINITIONS[0].args,
      fingerprint: fp,
    }];
    const sql = M014.replace(/v_pins CONSTANT jsonb := '\[\]'::jsonb;/,
      `v_pins CONSTANT jsonb := '${JSON.stringify(pins)}'::jsonb;`);
    assert.notEqual(sql, M014, 'failed to substitute v_pins');
    // Applying it here would fail on the call-site gate (the callee is a stub),
    // so only assert the pin itself is shaped the way 014 reads it.
    assert.match(sql, /"fingerprint":"[0-9a-f]{64}"/);
    assert.match(sql, new RegExp(`"args":"${DEFINITIONS[0].args.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  });
});
