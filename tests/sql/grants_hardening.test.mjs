// Proof for migrations/021_close_excess_grants.sql, against a real PostgreSQL with
// RLS enforced and the privilege surface as it was actually found on the live project:
// church.churches had a strict tenant SELECT policy, no tenant write policies at all,
// and UPDATE/DELETE/TRUNCATE granted to both anon and authenticated.
//
// The point of this file is the distinction between the two controls. Policies filter
// rows; grants decide whether the statement is allowed to run at all — and TRUNCATE is
// not filtered by policies. Every assertion below is about a privilege, so none of it
// can be shown by the policy tests in rls_church_row_guard.test.mjs.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const MIGRATION_021 = readFileSync(
  new URL('../../migrations/021_close_excess_grants.sql', import.meta.url), 'utf8');

const EKERO = '11111111-1111-1111-1111-111111111111';
const BUKOTO = '22222222-2222-2222-2222-222222222222';
const PASTOR_EKERO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function buildDb({ tenantWritePolicy = false, noToClause = false } = {}) {
  const db = new PGlite();
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
      activation_status text,
      passkey text,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE church.members (
      id uuid PRIMARY KEY,
      church_id uuid REFERENCES church.churches(id) ON DELETE CASCADE,
      full_name text
    );
    CREATE TABLE public.admin_profiles (
      id uuid PRIMARY KEY,
      tenant_id uuid,
      app_type text
    );
    CREATE FUNCTION church.my_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $f$
      SELECT tenant_id::uuid FROM public.admin_profiles WHERE id = auth.uid() LIMIT 1 $f$;

    -- The payment ledger, RLS enabled with a service-role policy, and SELECT left to
    -- the browser role: the shape found live, and the one 019's deferred revoke is about.
    CREATE TABLE church.activation_payments (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      church_id uuid,
      provider text,
      status text,
      amount integer
    );
    ALTER TABLE church.activation_payments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "activation_payments service role" ON church.activation_payments
      FOR ALL TO service_role USING (true) WITH CHECK (true);

    INSERT INTO church.churches (id, name, slug, activation_status, passkey) VALUES
      ('${EKERO}', 'Ekero Temple', 'ekero', 'pending_payment', 'AAA111'),
      ('${BUKOTO}', 'Bukoto Grace', 'bukoto', 'pending_payment', 'BBB222');
    INSERT INTO church.members (id, church_id, full_name)
      VALUES ('99999999-9999-9999-9999-999999999999', '${EKERO}', 'Sister Sarah');
    INSERT INTO public.admin_profiles (id, tenant_id, app_type)
      VALUES ('${PASTOR_EKERO}', '${EKERO}', 'church');

    ALTER TABLE church.churches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE church.members ENABLE ROW LEVEL SECURITY;

    -- Production's read policy: tenant-scoped AND app_type-scoped. Stricter than the
    -- predicate this repository's schema file uses, which is why 020 must not simply
    -- add another one.
    CREATE POLICY "churches_strict_select" ON church.churches
      FOR SELECT TO authenticated
      USING (id = church.my_tenant_id() AND app_type = 'church');
    CREATE POLICY "churchos_service_role" ON church.churches
      FOR ALL TO service_role USING (true) WITH CHECK (true);

    -- The excess privileges the audit found. Not invented: UPDATE, DELETE and TRUNCATE
    -- for both browser roles, on a table RLS was supposedly protecting.
    GRANT USAGE ON SCHEMA church, auth TO anon, authenticated, service_role;
    GRANT SELECT ON public.admin_profiles TO anon, authenticated;
    GRANT SELECT, UPDATE, DELETE, TRUNCATE ON church.churches TO anon, authenticated;
    GRANT SELECT, TRUNCATE ON church.members TO authenticated;
    GRANT SELECT ON church.activation_payments TO anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA church TO service_role;

    -- security_invoker means anon reads church.churches as itself, so this view is the
    -- reason SELECT on the base table must survive the revoke.
    CREATE VIEW public.churches_public WITH (security_invoker = true) AS
      SELECT id, name, slug, app_type, theme_color, created_at FROM church.churches;
    GRANT SELECT ON public.churches_public TO anon, authenticated;
  `);

  if (tenantWritePolicy) {
    // Two shapes of the same privilege, because both are out there: 020/016 name the
    // role explicitly, while supabase-schema.sql's own churches policy is created
    // WITHOUT a TO clause and so applies to PUBLIC — which pg_policy stores as
    // polroles = {0}, casting to '{-}' and dodging any role-name LIKE.
    await db.exec(noToClause
      ? `CREATE POLICY "legacy_tenant_write" ON church.churches
           FOR ALL USING (id = church.my_tenant_id())
           WITH CHECK (id = church.my_tenant_id())`
      : `CREATE POLICY "legacy_tenant_write" ON church.churches
           FOR ALL TO authenticated
           USING (id = church.my_tenant_id()) WITH CHECK (id = church.my_tenant_id())`);
  }
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
    return { ok: true, rows: result.rows ?? [], affected: result.rowCount ?? 0 };
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
  } finally { /* role and GUC are LOCAL to the transaction */ }
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

const rowsLeft = (db) => asService(db, 'SELECT count(*)::int AS n FROM church.churches');

test('a TRUNCATE privilege is not held back by RLS - the hole 021 closes is real', async () => {
  const db = await buildDb();

  // A member cannot even UPDATE the other church's row: RLS filters it to zero.
  const update = await runAs(db, PASTOR_EKERO,
    `UPDATE church.churches SET activation_status = 'active' WHERE id = '${BUKOTO}'`);
  assert.equal(update.ok, true);
  assert.equal(update.affected, 0, 'the tenant read policy must already filter writes to 0 rows');

  // Same role, same table, one statement: TRUNCATE is not a DML command, so there is
  // no policy to consult. Every church in the database loses its row, not one tenant's.
  // CASCADE because church.members has an FK to churches — the privilege does not
  // just empty one table, it takes the tenants' own member rows with it.
  const truncate = await runAs(db, PASTOR_EKERO, 'TRUNCATE church.churches CASCADE');
  assert.equal(truncate.ok, true, `expected TRUNCATE to succeed pre-hardening: ${truncate.error}`);
  assert.equal((await rowsLeft(db)).rows[0].n, 0, 'TRUNCATE must have emptied the table');

  await db.close();
});

test('021 removes the privilege while leaving the rows and the reads alone', async () => {
  const db = await buildDb();
  await db.exec(MIGRATION_021);

  const truncate = await runAs(db, PASTOR_EKERO, 'TRUNCATE church.churches CASCADE');
  assert.equal(truncate.ok, false, 'TRUNCATE must stop being possible for a browser role');
  assert.match(truncate.error, /permission denied for table churches/i);

  // Data intact, and the church row still readable by its own member — 021 changes
  // privileges, never rows.
  assert.equal((await rowsLeft(db)).rows[0].n, 2);
  const read = await runAs(db, PASTOR_EKERO, 'SELECT name FROM church.churches');
  assert.deepEqual(read.rows.map((r) => r.name), ['Ekero Temple']);

  const membersTruncate = await runAs(db, PASTOR_EKERO, 'TRUNCATE church.members');
  assert.equal(membersTruncate.ok, false, 'the sweep covers every church table, not only churches');
  // Counted as the admin client, because RLS on church.members has no tenant policy in
  // this fixture — the point here is that no ROW was destroyed by the revoke.
  const membersLeft = await db.query('SELECT count(*)::int AS n FROM church.members');
  assert.equal(membersLeft.rows[0].n, 1, 'and it takes no rows with it');

  await db.close();
});

test('021 does not blank the public pages: security_invoker reads still work', async () => {
  const db = await buildDb();
  await db.exec(MIGRATION_021);

  // public.churches_public is declared WITH (security_invoker = true), so a visitor
  // reads church.churches as themselves: the SELECT privilege on the base table is what
  // makes that view executable at all. 021 keeps it deliberately.
  const anon = await runAsAnon(db, 'SELECT name, slug FROM public.churches_public ORDER BY name');
  assert.equal(anon.ok, true, `anon must still be able to execute the public view: ${anon.error}`);
  // And the honest part: today it returns no rows, because supabase-schema.sql dropped
  // "Churches are viewable by everyone" and left anon no policy — the landing page
  // renders its static content either way. That is why the privilege stays and no
  // anon-facing policy is invented here: if a read policy for anon is ever restored,
  // the grant has to already be underneath it, or the page breaks at the wrong layer.
  assert.equal(anon.rows.length, 0, 'no anon read policy means no rows — 021 is about privileges, not visibility');
  const priv = await asService(db,
    `SELECT has_table_privilege('anon', 'church.churches', 'SELECT') AS can_read`);
  assert.equal(priv.rows[0].can_read, true);
  await db.close();
});

test('021 refuses to revoke DML while a tenant write policy is still live', async () => {
  // Ordering matters. On a database where 020 has not run, `authenticated` write
  // policies exist and the grant underneath them is load-bearing; revoking it would be
  // a behaviour change disguised as cleanup. The migration must abort instead.
  const db = await buildDb({ tenantWritePolicy: true });
  const before = await runAs(db, PASTOR_EKERO,
    `UPDATE church.churches SET theme_color = '#123456' WHERE id = '${EKERO}'`);
  assert.equal(before.ok, true);
  assert.equal(before.affected, 1, 'the tenant write policy must work before 021 runs');

  let failed = '';
  try {
    await db.exec(MIGRATION_021);
  } catch (error) {
    // The guard aborts the migration's BEGIN...COMMIT, so the session is sitting in an
    // aborted transaction. Real operators get the same state in psql and must ROLLBACK
    // before touching the database again.
    await db.exec('ROLLBACK');
    // PGlite wraps a failing statement inside a script in an AggregateError whose own
    // message is EMPTY; the real Postgres text lives one level down. Reading only
    // .message is how you conclude a guard did not fire when it did.
    failed = [error?.message, error?.cause?.message, error?.cause?.aggError?.message,
              error?.cause?.aggError,
              ...(Array.isArray(error?.cause?.aggError?.results) ? error.cause.aggError.results : [])]
      .flat()
      .map((v) => (typeof v === 'string' ? v : (v?.message ?? v?.error?.message ?? '')))
      .join(' | ');
  }
  assert.match(failed ?? '', /tenant write polic/i);

  // Refusing means nothing half-applied: the TRUNCATE sweep in step 2 must not have
  // committed alongside the aborted churches step.
  const still = await runAs(db, PASTOR_EKERO,
    `UPDATE church.churches SET theme_color = '#654321' WHERE id = '${EKERO}'`);
  assert.equal(still.affected, 1, 'a rejected run must leave the write path exactly as it was');
  await db.close();
});

test('the same guard fires for a PUBLIC write policy, which pg_policy hides', async () => {
  // FOR ALL with no TO clause is stored as polroles = {0} and polcmd = '*'. A check
  // written against pg_policy sees neither: '{0}' is not '{}' and regrole renders it
  // '{-}'. That is how 021's first draft would have revoked a live grant and reported
  // success, so the no-TO shape is asserted here, not left to reasoning.
  const db = await buildDb({ tenantWritePolicy: true, noToClause: true });
  const writes = await db.query(
    `SELECT polcmd, polroles::text AS oids, polroles::regrole[]::text AS cast
       FROM pg_policy WHERE polname = 'legacy_tenant_write'`);
  assert.equal(writes.rows[0].cast, '{-}', 'sanity: the raw catalog really is invisible to a role-name LIKE');
  assert.equal(writes.rows[0].polcmd, '*', 'sanity: FOR ALL is not a or i');

  let failed = '';
  try {
    await db.exec(MIGRATION_021);
  } catch (error) {
    await db.exec('ROLLBACK');
    failed = String(error?.message ?? error);
  }
  assert.match(failed, /tenant write polic/i);
  await db.close();
});

test('021 is idempotent and leaves the service-role write path working', async () => {
  const db = await buildDb();
  await db.exec(MIGRATION_021);
  await db.exec(MIGRATION_021);

  // Every privileged write in the app goes through service_role: self-activation from
  // the webhook, passkey rotation, the ledger insert. None of them may break.
  const activate = await asService(db,
    `UPDATE church.churches SET activation_status = 'active', passkey = 'NEWCODE9' WHERE id = '${EKERO}'`);
  assert.equal(activate.ok, true, `admin path must still work: ${activate.error}`);
  assert.equal(activate.affected, 1);
  const ledger = await asService(db,
    `INSERT INTO church.activation_payments (church_id, provider, status, amount)
     VALUES ('${EKERO}', 'mollom', 'captured', 1000)`);
  assert.equal(ledger.ok, true, `ledger write must still work: ${ledger.error}`);
  await db.close();
});
