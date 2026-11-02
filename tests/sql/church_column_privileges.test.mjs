// Proof for migrations/022_hide_church_credential_columns.sql: RLS filters rows, so a
// tenant-scoped SELECT policy on church.churches still hands every signed-in account of
// that church the usher `passkey` — a credential, in the clear, because the attendance
// screen has to read it out loud to a volunteer. These tests assert that the column is
// unreadable to the browser roles while every read the application actually makes keeps
// working, and they are written against a real PostgreSQL so the privilege layer, not my
// reading of it, decides the outcome.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const MIGRATION_022 = readFileSync(
  new URL('../../migrations/022_hide_church_credential_columns.sql', import.meta.url), 'utf8');
const SCHEMA = readFileSync(new URL('../../supabase-schema.sql', import.meta.url), 'utf8');

const EKERO = '11111111-1111-1111-1111-111111111111';
const BUKOTO = '22222222-2222-2222-2222-222222222222';
const PASTOR_EKERO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_EKERO = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const SECRET = ['passkey', 'passkey_hash', 'passkey_version', 'passkey_updated_at'];

/**
 * `shape: 'partial'` models a database where 011 has not run, so only `passkey` exists.
 * 020 nearly shipped a bug of this class (it assumed a column name that was not there),
 * so 022 is tested against both shapes rather than only the tidy one.
 */
async function buildDb({ shape = 'full', policyOnPasskey = false, viewLeaksPasskey = false } = {}) {
  const db = new PGlite();
  const credentialColumns = shape === 'partial'
    ? `passkey text`
    : `passkey text, passkey_hash text, passkey_version integer NOT NULL DEFAULT 1,
       passkey_updated_at timestamptz`;

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA church;
    CREATE SCHEMA auth;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;

    CREATE TABLE church.churches (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      app_type text NOT NULL DEFAULT 'church',
      theme_color text,
      logo_url text,
      sender_id text,
      activation_status text,
      activation_paid_at timestamptz,
      ${credentialColumns},
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.admin_profiles (
      id uuid PRIMARY KEY,
      tenant_id uuid,
      app_type text
    );
    CREATE FUNCTION church.my_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $f$
      SELECT tenant_id::uuid FROM public.admin_profiles WHERE id = auth.uid() LIMIT 1 $f$;

    INSERT INTO church.churches (id, name, slug, sender_id, activation_status, passkey${shape === 'full' ? ', passkey_hash' : ''})
      VALUES ('${EKERO}', 'Ekero Temple', 'ekero', 'CHURCHOS', 'pending_payment', 'AAA111'${shape === 'full' ? ", 'deadbeef'" : ''}),
             ('${BUKOTO}', 'Bukoto Grace', 'bukoto', 'GRACE99', 'active', 'BBB222'${shape === 'full' ? ", 'cafef00d'" : ''});
    INSERT INTO public.admin_profiles (id, tenant_id, app_type) VALUES
      ('${PASTOR_EKERO}', '${EKERO}', 'church'),
      ('${MEMBER_EKERO}', '${EKERO}', 'church');

    ALTER TABLE church.churches ENABLE ROW LEVEL SECURITY;

    -- Production's shape: one strict, tenant-scoped READ policy and no tenant writes.
    CREATE POLICY "churches_strict_select" ON church.churches
      FOR SELECT TO authenticated
      USING (id = church.my_tenant_id() AND app_type = 'church');
    CREATE POLICY "churchos_service_role" ON church.churches
      FOR ALL TO service_role USING (true) WITH CHECK (true);

    GRANT USAGE ON SCHEMA church, auth, public TO anon, authenticated, service_role;
    -- The privilege that makes the finding: table-level read for the browser roles.
    GRANT SELECT ON church.churches TO anon, authenticated;
    GRANT SELECT ON public.admin_profiles TO authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA church TO service_role;

    ${policyOnPasskey ? `CREATE POLICY "usher_must_have_code" ON church.churches
         FOR SELECT TO authenticated
         USING (passkey IS NOT NULL);` : ''}

    CREATE VIEW public.churches_public WITH (security_invoker = true) AS
      SELECT id, name, slug, app_type, logo_url, theme_color, created_at
        FROM church.churches;
    GRANT SELECT ON public.churches_public TO anon, authenticated;

    ${viewLeaksPasskey ? `CREATE VIEW public.churches_debug WITH (security_invoker = true) AS
       SELECT id, name, passkey FROM church.churches;
     GRANT SELECT ON public.churches_debug TO anon, authenticated;` : ''}
  `);
  return db;
}

async function runAs(db, userId, statement) {
  await db.exec('BEGIN');
  await db.exec('SET LOCAL ROLE authenticated');
  await db.exec(`SET LOCAL request.jwt.claims = '{"sub":"${userId}","role":"authenticated"}'`);
  await db.exec(`SET LOCAL request.jwt.claim.sub = '${userId}'`);
  try {
    const result = await db.query(statement);
    await db.exec('COMMIT');
    return { ok: true, rows: result.rows ?? [] };
  } catch (error) {
    await db.exec('ROLLBACK');
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function runAsAnon(db, statement) {
  await db.exec('BEGIN');
  await db.exec('SET LOCAL ROLE anon');
  try {
    const result = await db.query(statement);
    await db.exec('COMMIT');
    return { ok: true, rows: result.rows ?? [] };
  } catch (error) {
    await db.exec('ROLLBACK');
    return { ok: false, error: String(error?.message ?? error) };
  } finally { /* role is LOCAL to this transaction */ }
}

async function asService(db, statement) {
  await db.exec('BEGIN');
  await db.exec('SET LOCAL ROLE service_role');
  try {
    const result = await db.query(statement);
    await db.exec('COMMIT');
    return { ok: true, rows: result.rows ?? [], affected: result.rowCount ?? 0 };
  } catch (error) {
    await db.exec('ROLLBACK');
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** Everything a failing script surfaces, because PGlite can wrap the real message. */
function describeError(error) {
  return [error?.message, error?.cause?.message, error?.cause?.aggError?.message,
          ...(Array.isArray(error?.cause?.aggError?.results) ? error.cause.aggError.results : [])]
    .flat()
    .map((v) => (typeof v === 'string' ? v : (v?.message ?? v?.error?.message ?? '')))
    .join(' | ');
}

test('the finding, demonstrated: a tenant-scoped read policy still exposes the passkey', async () => {
  const db = await buildDb();

  // The pastor's own row, the correct tenant predicate, a legal query — and the shared
  // usher code comes back. Nothing about the policy is wrong; the policy cannot see
  // columns. The member row is the point: same tenant, same rights, no admin screen.
  for (const who of [PASTOR_EKERO, MEMBER_EKERO]) {
    const leaked = await runAs(db, who,
      `SELECT passkey, sender_id FROM church.churches WHERE id = '${EKERO}'`);
    assert.equal(leaked.ok, true, `RLS should allow this row, so the column must be readable pre-022: ${leaked.error}`);
    assert.deepEqual(leaked.rows[0], { passkey: 'AAA111', sender_id: 'CHURCHOS' });
  }

  // Cross-tenant is still refused, which is what the policy IS good at.
  const other = await runAs(db, PASTOR_EKERO, `SELECT passkey FROM church.churches WHERE id = '${BUKOTO}'`);
  assert.deepEqual(other.rows, [], 'the policy must already filter another church row to nothing');
  await db.close();
});

test('022 hides the credential columns from both browser roles', async () => {
  const db = await buildDb();
  await db.exec(MIGRATION_022);

  for (const who of [PASTOR_EKERO, MEMBER_EKERO]) {
    const gone = await runAs(db, who, `SELECT passkey FROM church.churches WHERE id = '${EKERO}'`);
    assert.equal(gone.ok, false, 'the code must stop being readable through the REST-shaped query');
    assert.match(gone.error, /permission denied/i);
  }

  const hidden = await asService(db, `
    SELECT a.attname AS column_name
      FROM pg_attribute a
     WHERE a.attrelid = 'church.churches'::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND has_column_privilege('authenticated', 'church.churches', a.attname, 'SELECT')
     ORDER BY a.attnum`);
  assert.deepEqual(hidden.rows.map((r) => r.column_name).filter((c) => SECRET.includes(c)), [],
    `no credential column may remain readable, got ${JSON.stringify(hidden.rows)}`);

  // An over-fetch is now a hard error rather than a free gift, for both roles.
  const star = await runAs(db, PASTOR_EKERO, 'SELECT * FROM church.churches');
  assert.equal(star.ok, false, 'select=* must be refused once the table-level read is gone');
  const anonStar = await runAsAnon(db, 'SELECT * FROM church.churches');
  assert.equal(anonStar.ok, false);
  await db.close();
});

test('022 keeps every read the application makes as the caller', async () => {
  const db = await buildDb();
  await db.exec(MIGRATION_022);

  // The five fields messages/page.tsx names (the one session-client churches read in
  // the repository) — still readable, still tenant-filtered.
  const caller = await runAs(db, MEMBER_EKERO,
    'SELECT id, name, slug, theme_color, logo_url FROM church.churches');
  assert.equal(caller.ok, true, `caller-role read must survive: ${caller.error}`);
  assert.equal(caller.rows.length, 1, 'and RLS must still be doing the row filtering');
  assert.equal(caller.rows[0].name, 'Ekero Temple');

  // The gate and the login redirects read these; the activation screen too.
  const gate = await runAs(db, PASTOR_EKERO,
    'SELECT id, name, slug, activation_status, activation_paid_at, sender_id FROM church.churches');
  assert.equal(gate.ok, true, `billing/config reads must survive: ${gate.error}`);

  // Public pages run a security_invoker view AS THE VISITOR, so this is the read that
  // a careless revoke would have blanked.
  const view = await runAsAnon(db, 'SELECT name, slug FROM public.churches_public ORDER BY name');
  assert.equal(view.ok, true, `anon must still execute the public view: ${view.error}`);
  assert.equal(view.rows.length, 0, 'zero rows is correct here: anon has no policy, and 022 changes no policies');

  // And the app's own credential reads — attendance page, passkey issue/rotate — go
  // through the service role, which keeps the table-level privilege.
  const serviceRead = await asService(db, `SELECT passkey, passkey_version FROM church.churches WHERE id = '${EKERO}'`);
  assert.equal(serviceRead.ok, true, `the service-role read the app depends on broke: ${serviceRead.error}`);
  assert.equal(serviceRead.rows[0].passkey, 'AAA111');

  // The rotation path writes the columns it hides. 021 removed tenant DML, so only the
  // service role can do this either way, but the assertion documents who may.
  const rotate = await asService(db,
    `UPDATE church.churches SET passkey = 'ZZZ999', passkey_updated_at = now() WHERE id = '${EKERO}'`);
  assert.equal(rotate.affected, 1, `service-role rotation broke: ${rotate.error}`);
  await db.close();
});

test('022 refuses to run beside a policy that reads the hidden column', async () => {
  const db = await buildDb({ policyOnPasskey: true });

  let failed = '';
  try {
    await db.exec(MIGRATION_022);
  } catch (error) {
    await db.exec('ROLLBACK');
    failed = describeError(error);
  }
  assert.match(failed, /references passkey/i);

  // Refusing means refusing completely: the pre-flight abort must not leave the grants
  // half-moved, or every member's admin screen loses its church row for nothing.
  const stillReadable = await runAs(db, PASTOR_EKERO, 'SELECT passkey FROM church.churches');
  assert.equal(stillReadable.ok, true, `a rejected run must change nothing: ${stillReadable.error}`);
  await db.close();
});

test('022 refuses to run when a security_invoker view exposes the credential', async () => {
  // A view is the sneaky case: it looks like a safe projection, but with
  // security_invoker the visitor needs the underlying column, so hiding the column would
  // turn the public page into a 42501 rather than close anything.
  const db = await buildDb({ viewLeaksPasskey: true });

  let failed = '';
  try {
    await db.exec(MIGRATION_022);
  } catch (error) {
    await db.exec('ROLLBACK');
    failed = describeError(error);
  }
  assert.match(failed, /exposes the hidden column passkey to a browser role/i);
  assert.match(failed, /security_invoker: t/);
  await db.close();
});

test('022 tolerates a database where the later migrations have not run', async () => {
  const db = await buildDb({ shape: 'partial' });   // only `passkey` exists: no 011 yet
  await db.exec(MIGRATION_022);                    // would abort on a hard-coded column list

  const gone = await runAs(db, PASTOR_EKERO, 'SELECT passkey FROM church.churches');
  assert.equal(gone.ok, false, `the one column that exists must still be hidden: ${gone.error}`);
  const ok = await runAs(db, PASTOR_EKERO, 'SELECT id, name, slug FROM church.churches');
  assert.equal(ok.ok, true, `granted reads must work on the partial shape: ${ok.error}`);
  await db.close();
});

test('022 is idempotent', async () => {
  const db = await buildDb();
  await db.exec(MIGRATION_022);
  await db.exec(MIGRATION_022);

  const privs = await asService(db, `
    SELECT has_column_privilege('authenticated','church.churches','passkey','SELECT') AS passkey_visible,
           has_column_privilege('authenticated','church.churches','name','SELECT')    AS name_visible,
           has_table_privilege('anon','church.churches','SELECT')                     AS anon_table_select,
           has_table_privilege('service_role','church.churches','SELECT')             AS service_table_select`);
  assert.deepEqual(privs.rows[0], {
    passkey_visible: false, name_visible: true, anon_table_select: false, service_table_select: true,
  });
  await db.close();
});

test('the schema ships the same rule, so a fresh install is not born with the hole', async () => {
  const begin = '-- BEGIN 022-CONVERGED';
  const end = '-- END 022-CONVERGED';
  assert.equal(SCHEMA.includes(begin) && SCHEMA.includes(end), true,
    'supabase-schema.sql must contain the marked 022 block; a fresh project is otherwise '
    + 'born with a readable passkey column and no test would notice');

  const block = SCHEMA.slice(SCHEMA.indexOf(begin), SCHEMA.indexOf(end));
  const migration = MIGRATION_022;

  // Same protected set, same two statements, in the same order of operations.
  for (const needle of [
    "ARRAY['passkey', 'passkey_hash', 'passkey_version', 'passkey_updated_at']",
    'REVOKE SELECT ON church.churches FROM anon, authenticated',
    "GRANT SELECT (%s) ON church.churches TO anon, authenticated",
  ]) {
    assert.ok(block.includes(needle), `schema block drifted from the migration: missing ${needle}`);
    assert.ok(migration.includes(needle), `migration lost ${needle}`);
  }

  // Then prove the schema copy behaves, not just reads: run the extracted block against
  // a database that still has the hole.
  const db = await buildDb();
  const before = await runAs(db, PASTOR_EKERO, 'SELECT passkey FROM church.churches');
  assert.equal(before.ok, true);

  const executable = block.replace(/^-- BEGIN 022-CONVERGED[\s\S]*?-- RLS hides rows/, '-- RLS hides rows');
  await db.exec(executable.slice(executable.indexOf('DO $$')));

  const after = await runAs(db, PASTOR_EKERO, 'SELECT passkey FROM church.churches');
  assert.equal(after.ok, false, 'the schema twin must close the hole on a fresh install, not merely mention it');
  const stillOk = await runAs(db, PASTOR_EKERO, 'SELECT id, name, slug FROM church.churches');
  assert.equal(stillOk.ok, true, `and must not over-revoke: ${stillOk.error}`);
  await db.close();
});
