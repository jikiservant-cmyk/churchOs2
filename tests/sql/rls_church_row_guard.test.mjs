// Hardening proof for migrations/020 + 019, run against a real PostgreSQL
// (PGlite / PG16) with Row Level Security ENFORCED and the JWT claims PostgREST
// sets for a browser session.
//
// Where tests/sql/rls_activation_bypass_poc.test.mjs reproduces the legacy FOR ALL
// policy and reports the exploit as OPEN, this file applies the fix for real and
// asserts it holds. It is the test that fails if the hardening is reverted, and it
// is the evidence that the Phase B paste can be run on a live project.
//
// Each scenario builds its own database, because one PGlite instance bleeding into
// the next is how a security test ends up asserting nothing.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const MIGRATION_019 = readFileSync(
  new URL('../../migrations/019_activation_ledger_rls.sql', import.meta.url), 'utf8');
const MIGRATION_020 = readFileSync(
  new URL('../../migrations/020_close_church_row_writes.sql', import.meta.url), 'utf8');
const SCHEMA = readFileSync(new URL('../../supabase-schema.sql', import.meta.url), 'utf8');

const EKERO = '11111111-1111-1111-1111-111111111111';
const BUKOTO = '22222222-2222-2222-2222-222222222222';
const PASTOR_EKERO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF_EKERO = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MEMBER_EKERO = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/**
 * The vulnerable baseline: the FOR ALL policy exactly as supabase-schema.sql shipped
 * it, the tenancy helper, and a churches table whose column set can be narrowed by
 * the caller to model a database where 011/017 have not been applied yet.
 */
async function buildLegacyDb({ columns = 'full' } = {}) {
  const db = new PGlite();
  const churchColumns = columns === 'partial'
    // A live project mid-provisioning: passkey exists (011) but is_active and
    // activation_paid_at (017) do not. A trigger that names a missing column does
    // not fail at CREATE time — it fails every UPDATE at run time — so this shape is
    // a regression test for exactly that.
    ? `id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
       passkey text, passkey_version integer NOT NULL DEFAULT 1,
       activation_status text, created_at timestamptz DEFAULT now()`
    : `id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
       sender_id text, theme_color text, is_active boolean DEFAULT true,
       passkey text, passkey_hash text, passkey_version integer NOT NULL DEFAULT 1,
       passkey_updated_at timestamptz, activation_status text,
       activation_paid_at timestamptz, created_at timestamptz DEFAULT now()`;

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS church;
    CREATE SCHEMA IF NOT EXISTS auth;

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$ LANGUAGE sql STABLE;

    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;

    CREATE TABLE public.tenants (id uuid PRIMARY KEY, app_type text DEFAULT 'church', name text);
    CREATE TABLE public.admin_profiles (
      id uuid PRIMARY KEY, email text, full_name text, role text,
      tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
      app_type text DEFAULT 'church'
    );
    CREATE TABLE church.churches (${churchColumns});
    CREATE TABLE church.members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      church_id uuid NOT NULL REFERENCES church.churches(id) ON DELETE CASCADE,
      full_name text
    );

    CREATE OR REPLACE FUNCTION church.my_tenant_id()
    RETURNS uuid AS $$
    BEGIN
      RETURN (SELECT tenant_id::uuid FROM public.admin_profiles WHERE id = auth.uid() LIMIT 1);
    END;
    $$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, church;

    ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE church.churches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE church.members ENABLE ROW LEVEL SECURITY;

    CREATE POLICY "Users can view their own profile"
      ON public.admin_profiles FOR SELECT TO authenticated USING (id = auth.uid());
    CREATE POLICY "Service role full access on profiles"
      ON public.admin_profiles FOR ALL TO service_role USING (true);
    CREATE POLICY "Service role full access on tenants"
      ON public.tenants FOR ALL TO service_role USING (true);
    CREATE POLICY "Service role full access on members"
      ON church.members FOR ALL TO service_role USING (true);

    -- The legacy shape under test.
    CREATE POLICY "Admins can manage their associated church"
      ON church.churches FOR ALL TO authenticated
      USING (id = church.my_tenant_id())
      WITH CHECK (id = church.my_tenant_id());
    CREATE POLICY "Service role full access on churches"
      ON church.churches FOR ALL TO service_role USING (true);
    CREATE POLICY "members_rw_select" ON church.members FOR SELECT TO authenticated
      USING (church_id = church.my_tenant_id());

    GRANT USAGE ON SCHEMA public, church TO anon, authenticated, service_role;
    GRANT SELECT ON public.admin_profiles TO authenticated;
    -- Supabase grants the table-wide shape below by default in the public schema; a
    -- custom schema depends on project defaults. DELETE here on purpose: the report
    -- found that whether the FOR ALL policy also permits deleting the whole church
    -- row (cascading into members) depends on this grant, so the hardened test must
    -- cover it.
    GRANT SELECT, UPDATE, DELETE ON church.churches TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON church.members TO authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public, church TO service_role;

    INSERT INTO public.tenants (id, name) VALUES ('${EKERO}', 'Ekero Family Chapel'), ('${BUKOTO}', 'Bukoto Grace Assembly');
    INSERT INTO church.churches (id, name, slug, activation_status, passkey${columns === 'partial' ? '' : ', passkey_hash, is_active'})
      VALUES ('${EKERO}', 'Ekero Family Chapel', 'ekero', 'pending_payment', 'CODEAAA1'${columns === 'partial' ? '' : `, 'hash-a', true`}),
             ('${BUKOTO}', 'Bukoto Grace Assembly', 'bukoto', 'pending_payment', 'CODEBBB2'${columns === 'partial' ? '' : `, 'hash-b', true`});
    INSERT INTO church.members (church_id, full_name) VALUES
      ('${EKERO}', 'Nnakibuka Sarah'), ('${EKERO}', 'Mwesigwa Peter');
    INSERT INTO public.admin_profiles (id, email, role, tenant_id) VALUES
      ('${PASTOR_EKERO}', 'pastor@ekero.example', 'pastor', '${EKERO}'),
      ('${STAFF_EKERO}', 'staff@ekero.example', 'staff', '${EKERO}'),
      ('${MEMBER_EKERO}', 'member@ekero.example', 'member', '${EKERO}');
  `);
  return db;
}

/** Run one statement as a signed-in church account, exactly as PostgREST would. */
async function asUser(db, userId, statement) {
  await db.exec('BEGIN');
  await db.exec('SET LOCAL ROLE authenticated');
  await db.exec(`SET LOCAL request.jwt.claims = '{"sub":"${userId}","role":"authenticated","email":"x@y.z"}'`);
  await db.exec(`SET LOCAL request.jwt.claim.sub = '${userId}'`);
  try {
    const result = await db.query(statement);
    await db.exec('COMMIT');
    return { ok: true, rows: result.rows ?? [], affected: result.rowCount ?? 0 };
  } catch (error) {
    await db.exec('ROLLBACK');
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    // Nothing may outlive the transaction: the role and the claims GUC are LOCAL,
    // and a leaked SET ROLE would silently run the next assertion as the wrong user.
  }
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

const readStatus = (db) => asService(
  db,
  `SELECT activation_status, passkey FROM church.churches WHERE id = '${EKERO}'`,
);

test('020 applied: a church account can no longer activate itself', async () => {
  const db = await buildLegacyDb();
  await db.exec(MIGRATION_020);

  const selfActivate = await asUser(
    db, PASTOR_EKERO,
    `UPDATE church.churches SET activation_status = 'active', activation_paid_at = now() WHERE id = '${EKERO}'`,
  );
  const after = await readStatus(db);
  assert.ok(
    !(selfActivate.ok && selfActivate.affected === 1),
    `the UPDATE changed ${selfActivate.affected} row(s); it must change none (error: ${selfActivate.error ?? 'none'})`,
  );
  assert.equal(after.rows[0].activation_status, 'pending_payment', 'activation must not have moved');

  const staff = await asUser(db, STAFF_EKERO, `UPDATE church.churches SET activation_status = 'active' WHERE id = '${EKERO}'`);
  assert.notEqual(staff.affected, 1, 'staff is refused too — the old policy was role-blind');
  const member = await asUser(db, MEMBER_EKERO, `UPDATE church.churches SET activation_status = 'active' WHERE id = '${EKERO}'`);
  assert.notEqual(member.affected, 1, 'a plain member is refused too');
  await db.close();
});

test('020 applied: the usher passkey cannot be swapped, and the church row cannot be deleted', async () => {
  const db = await buildLegacyDb();
  await db.exec(MIGRATION_020);

  const passkeySwap = await asUser(db, PASTOR_EKERO, `UPDATE church.churches SET passkey = 'ATTACK01' WHERE id = '${EKERO}'`);
  const after = await readStatus(db);
  assert.notEqual(passkeySwap.affected, 1, 'the UPDATE that used to print "1 row" must affect none');
  assert.equal(after.rows[0].passkey, 'CODEAAA1', 'the usher code must be untouched');

  const del = await asUser(db, PASTOR_EKERO, `DELETE FROM church.churches WHERE id = '${EKERO}'`);
  assert.notEqual(del.affected, 1, `DELETE must be refused (deleted ${del.affected})`);
  const stillThere = await asService(db, `SELECT count(*)::int AS n FROM church.churches WHERE id = '${EKERO}'`);
  assert.equal(stillThere.rows[0].n, 1, 'the church row must still exist');
  const members = await asService(db, `SELECT count(*)::int AS n FROM church.members WHERE church_id = '${EKERO}'`);
  assert.equal(members.rows[0].n, 2, 'no cascade may have run');
  await db.close();
});

test('020 applied: reading your own church still works, reading a neighbour still does not', async () => {
  const db = await buildLegacyDb();
  await db.exec(MIGRATION_020);

  const own = await asUser(db, PASTOR_EKERO, `SELECT slug, activation_status FROM church.churches`);
  assert.ok(own.ok, `a member must still read their church row: ${own.error ?? ''}`);
  assert.equal(own.rows.length, 1, 'exactly one row, their own');
  assert.equal(own.rows[0].slug, 'ekero');
  assert.ok(own.rows[0].activation_status, 'including activation_status, which the gate screen renders');

  const anon = await (async () => {
    await db.exec('BEGIN');
    await db.exec('SET LOCAL ROLE anon');
    try {
      const r = await db.query('SELECT count(*)::int AS n FROM church.churches');
      await db.exec('COMMIT');
      return { ok: true, n: r.rows[0].n };
    } catch (error) {
      await db.exec('ROLLBACK');
      return { ok: false, error: String(error?.message ?? error) };
    }
  })();
  assert.ok(!anon.ok || anon.n === 0, `anon must not read churches: ${JSON.stringify(anon)}`);
  await db.close();
});

test('020 applied: the application service role keeps every write it needs', async () => {
  const db = await buildLegacyDb();
  await db.exec(MIGRATION_020);

  const activate = await asService(db, `UPDATE church.churches SET activation_status = 'active', activation_paid_at = now() WHERE id = '${EKERO}'`);
  assert.ok(activate.ok && activate.affected === 1, `settlement write must work: ${activate.error ?? ''}`);

  const rotate = await asService(db, `UPDATE church.churches SET passkey = 'NEWCODE9', passkey_version = passkey_version + 1 WHERE id = '${EKERO}'`);
  assert.ok(rotate.ok && rotate.affected === 1, `passkey rotation must work: ${rotate.error ?? ''}`);

  const settings = await asService(db, `UPDATE church.churches SET name = 'Bukoto Grace Assembly', slug = 'bukoto' WHERE id = '${BUKOTO}'`);
  assert.ok(settings.ok, `profile/settings save must work: ${settings.error ?? ''}`);
  const final = await asService(db, `SELECT activation_status, passkey FROM church.churches WHERE id = '${EKERO}'`);
  assert.equal(final.rows[0].activation_status, 'active');
  assert.equal(final.rows[0].passkey, 'NEWCODE9');
  await db.close();
});

test('020 applied to a half-provisioned database: benign saves still work', async () => {
  // No is_active, no activation_paid_at, no passkey_hash in this shape. If the guard
  // named those columns directly, every UPDATE to churches would raise
  // 'column NEW.is_active does not exist' — including a service-role settings save.
  const db = await buildLegacyDb({ columns: 'partial' });
  await db.exec(MIGRATION_020);

  const benign = await asService(db, `UPDATE church.churches SET name = 'Ekero Family Chapel Central' WHERE id = '${EKERO}'`);
  assert.ok(benign.ok && benign.affected === 1, `service-role save on a partial schema: ${benign.error ?? ''}`);

  const protectedWrite = await asService(db, `UPDATE church.churches SET activation_status = 'active' WHERE id = '${EKERO}'`);
  assert.ok(protectedWrite.ok, 'service role is exempt from the guard by design');

  const userPartialSave = await asUser(db, PASTOR_EKERO, `UPDATE church.churches SET name = 'hijacked' WHERE id = '${EKERO}'`);
  assert.notEqual(userPartialSave.affected, 1, 'an account still cannot rewrite its own church row at all');
  await db.close();
});

test('the guard trigger refuses protected columns even if a write policy comes back', async () => {
  // Defence in depth: the policy is the primary control, but a future migration that
  // re-adds a tenant UPDATE policy — the exact mistake this fixes — must still be
  // caught by the trigger before a pastor can self-activate.
  const db = await buildLegacyDb();
  await db.exec(MIGRATION_020);
  await db.exec(`
    CREATE POLICY "regression tenant update" ON church.churches
      FOR UPDATE TO authenticated USING (id = church.my_tenant_id()) WITH CHECK (id = church.my_tenant_id());
  `);

  const selfActivate = await asUser(db, PASTOR_EKERO, `UPDATE church.churches SET activation_status = 'active' WHERE id = '${EKERO}'`);
  assert.ok(!selfActivate.ok, 'the trigger must raise, not silently allow');
  assert.match(selfActivate.error ?? '', /billing and credential column/i);
  assert.match(selfActivate.error ?? '', /activation_status/);

  const swap = await asUser(db, PASTOR_EKERO, `UPDATE church.churches SET passkey = 'ATTACK01' WHERE id = '${EKERO}'`);
  assert.ok(!swap.ok && /passkey/.test(swap.error ?? ''), 'the passkey columns are guarded too');

  // An unprotected presentation column must still be writable under that policy, so
  // the guard cannot be accused of blocking legitimate edits.
  const theme = await asUser(db, PASTOR_EKERO, `UPDATE church.churches SET theme_color = '#123' WHERE id = '${EKERO}'`);
  assert.ok(theme.ok && theme.affected === 1, `non-protected column must pass: ${theme.error ?? ''}`);

  // Same for a write that changes nothing in the protected set: the guard compares,
  // it does not blanket-refuse.
  const rename = await asUser(db, PASTOR_EKERO, `UPDATE church.churches SET name = 'Ekero Family Chapel' WHERE id = '${EKERO}'`);
  assert.ok(rename.ok, `a name change must pass: ${rename.error ?? ''}`);
  await db.close();
});

test('020 also drops a repaired write policy installed under a different name', async () => {
  // The live project was patched by 016 and by hand under names other than the
  // shipped one. A paste that drops only the name in this repository would report
  // success on a database that is still open.
  const db = await buildLegacyDb();
  await db.exec(`
    DROP POLICY "Admins can manage their associated church" ON church.churches;
    CREATE POLICY "churchos_tenant_write_repair" ON church.churches
      FOR ALL TO authenticated
      USING (id = church.my_tenant_id()) WITH CHECK (id = church.my_tenant_id());
  `);
  await db.exec(MIGRATION_020);

  const attack = await asUser(db, PASTOR_EKERO, `UPDATE church.churches SET activation_status = 'active' WHERE id = '${EKERO}'`);
  assert.notEqual(attack.affected, 1, 'a hand-patched policy name must not survive the paste');
  const state = await readStatus(db);
  assert.equal(state.rows[0].activation_status, 'pending_payment');
  await db.close();
});

test('020 refuses to commit rather than narrowing a policy that also names service_role', async () => {
  // Dropping a mixed `TO authenticated, service_role` policy would take the
  // application's own access with it. So the file stops instead, and stops cleanly.
  const db = await buildLegacyDb();
  await db.exec(`
    DROP POLICY "Admins can manage their associated church" ON church.churches;
    CREATE POLICY "mixed_write" ON church.churches FOR ALL TO authenticated, service_role
      USING (id = church.my_tenant_id()) WITH CHECK (id = church.my_tenant_id());
  `);

  let error = null;
  try { await db.exec(MIGRATION_020); } catch (e) { error = String(e?.message ?? e); }
  assert.match(error ?? '', /PHASE B FAILED/);
  // The file's own BEGIN is left aborted by the raise — exactly what an operator has to
  // roll back in the dashboard before re-running anything in that session.
  await db.exec('ROLLBACK');

  const survived = await asService(db, `
    SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname = 'church' AND tablename = 'churches' AND policyname = 'mixed_write'
  `);
  assert.equal(survived.rows[0].n, 1, 'a refused migration must leave the database exactly as it was');
  const trigger = await asService(db, `
    SELECT count(*)::int AS n FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'church' AND c.relname = 'churches'
       AND t.tgname = 'guard_church_privileged_columns' AND NOT t.tgisinternal
  `);
  assert.equal(trigger.rows[0].n, 0, 'and must not have installed half of the hardening');
  await db.close();
});

test('020 is idempotent and self-verifying', async () => {
  const db = await buildLegacyDb();
  await db.exec(MIGRATION_020);
  await db.exec(MIGRATION_020); // second run: DROP IF EXISTS + OR REPLACE throughout
  const policies = await asService(db, `
    SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname = 'church' AND tablename = 'churches'
       AND cmd <> 'SELECT' AND roles::text NOT LIKE '%service_role%'
  `);
  assert.equal(policies.rows[0].n, 0, 'exactly one SELECT-only tenant policy must remain');
  await db.close();
});

test('019: the activation ledger becomes service-role-only', async () => {
  const db = await buildLegacyDb();
  await db.exec(`
    -- The live ledger shape from the report: created outside the migrations, no RLS.
    CREATE TABLE church.activation_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      church_id uuid NOT NULL,
      amount_ugx integer,
      status text,
      created_at timestamptz DEFAULT now()
    );
    INSERT INTO church.activation_payments (church_id, amount_ugx, status) VALUES
      ('${EKERO}', 1000, 'paid'), ('${BUKOTO}', 1000, 'paid');
    GRANT SELECT, INSERT, UPDATE ON church.activation_payments TO authenticated;
  `);

  const before = await asUser(db, PASTOR_EKERO, `SELECT count(*)::int AS n FROM church.activation_payments`);
  assert.ok(before.ok && before.rows[0]?.n === 2, `baseline: unsecured ledger readable by a tenant (${JSON.stringify(before)})`);

  await db.exec(MIGRATION_019);

  const after = await asUser(db, PASTOR_EKERO, `SELECT count(*)::int AS n FROM church.activation_payments`);
  // With RLS on and no policy for `authenticated`, PostgREST-style SELECTs are
  // filtered to nothing rather than erroring — which is why an empty result is the
  // invariant to assert, and why an error is also acceptable.
  assert.ok(!after.ok || after.rows[0].n === 0,
    `a church account must not read the ledger afterwards (got ${JSON.stringify(after.rows)})`);
  const otherTenant = await asUser(db, PASTOR_EKERO,
    `SELECT count(*)::int AS n FROM church.activation_payments WHERE church_id = '${BUKOTO}'`);
  assert.ok(!otherTenant.ok || otherTenant.rows[0].n === 0, 'no cross-tenant payment history either');

  const insert = await asUser(db, PASTOR_EKERO, `INSERT INTO church.activation_payments (church_id, amount_ugx, status) VALUES ('${EKERO}', 0, 'paid')`);
  assert.ok(!insert.ok, 'and must not be able to forge a settlement row');

  const serviceRead = await asService(db, `SELECT count(*)::int AS n FROM church.activation_payments`);
  assert.ok(serviceRead.ok && serviceRead.rows[0].n === 2, `the app must still read it: ${serviceRead.error ?? ''}`);
  const serviceWrite = await asService(db, `INSERT INTO church.activation_payments (church_id, amount_ugx, status) VALUES ('${BUKOTO}', 1000, 'pending')`);
  assert.ok(serviceWrite.ok && serviceWrite.affected === 1, `the app must still write it: ${serviceWrite.error ?? ''}`);
  await db.close();
});

test('019 is safe on a project without the ledger table', async () => {
  const db = await buildLegacyDb();
  await db.exec(MIGRATION_019); // must notice and skip, not abort a deployment
  const churches = await asService(db, `SELECT count(*)::int AS n FROM church.churches`);
  assert.equal(churches.rows[0].n, 2, 'the rest of the database is untouched');
  await db.close();
});

test('supabase-schema.sql and 020 install the same controls', async () => {
  // The schema is what a new project gets; 020 is what an existing one runs. If the
  // two ever disagree, a fresh church is born with different rules from everyone
  // else — the drift that produced half of the findings in this report.
  const schemaPolicy = /CREATE POLICY "Churches are readable by their own members"\s*ON church\.churches\s+FOR SELECT\s+TO authenticated\s+USING \(id = church\.my_tenant_id\(\)\)/.test(SCHEMA);
  const migrationPolicy = /CREATE POLICY "Churches are readable by their own members"\s*ON church\.churches\s+FOR SELECT\s+TO authenticated\s+USING \(id = church\.my_tenant_id\(\)\)/.test(MIGRATION_020);
  assert.ok(schemaPolicy, 'the shipped schema must contain the SELECT-only tenant policy');
  assert.ok(migrationPolicy, 'and 020 must install the same one');

  const columnsOf = (sql) => {
    const match = sql.match(/v_protected text\[\] := ARRAY\[\s*([\s\S]*?)\]\s*;/);
    assert.ok(match, 'the guard must declare its protected column list the same way in both files');
    return match[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')).filter(Boolean).sort().join(',');
  };
  assert.equal(columnsOf(SCHEMA), columnsOf(MIGRATION_020), 'the guarded column lists have drifted apart');
  assert.ok(columnsOf(SCHEMA).includes('activation_status'), 'activation_status must be guarded');
  assert.ok(columnsOf(SCHEMA).includes('passkey_hash'), 'passkey_hash must be guarded');

  assert.match(SCHEMA, /CREATE TRIGGER guard_church_privileged_columns\s+BEFORE UPDATE ON church\.churches/);
  assert.match(MIGRATION_020, /CREATE TRIGGER guard_church_privileged_columns\s+BEFORE UPDATE ON church\.churches/);
});
