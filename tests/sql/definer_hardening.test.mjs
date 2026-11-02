// Proof for migrations/023_harden_definer_routines.sql, run against a real PostgreSQL so
// the catalog decides the outcome instead of my reading of it.
//
// Two properties, both learned from the 2026-11-02 live inventory rather than invented:
//
//   PART A — a SECURITY DEFINER function with no pinned search_path resolves its
//   unqualified names through the CALLER's path, and a caller can put its own temporary
//   table in front of every user schema. That is the hole the 63 already-pinned routines
//   closed and the three unpinned ones did not. 023 pins the ones whose bodies provably
//   do not care, and refuses the ones where pinning could change which object is found.
//
//   PART B — the browser roles must not be able to execute the passkey validators or the
//   tenant deleter. supabase-schema.sql already revokes those signatures; production had
//   drifted. 023 re-applies the revocation, but only after checking that no row-policy
//   predicate calls the function, because a policy is evaluated as the table's reader.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const MIGRATION = readFileSync(
  new URL('../../migrations/023_harden_definer_routines.sql', import.meta.url), 'utf8');
const MIGRATION_024 = readFileSync(
  new URL('../../migrations/024_usher_session_guard.sql', import.meta.url), 'utf8');

/** 024 is a report until an operator opts in; the tests need both modes. */
function withApply(text, apply) {
  const from = 'v_apply        constant boolean := false;';
  const to = `v_apply        constant boolean := ${apply};`;
  const out = text.replace(from, to);
  assert.notEqual(out, text, 'the switch this file is built around must exist to be flipped');
  return out;
}

async function buildDb({ policyCallsValidator = false } = {}) {
  const db = new PGlite();

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;

    CREATE SCHEMA church;
    CREATE SCHEMA private;
    CREATE SCHEMA business;

    CREATE TABLE church.things (id int);
    INSERT INTO church.things VALUES (1), (2);
    CREATE TABLE public.widgets (id int);
    INSERT INTO public.widgets VALUES (1), (2);

    -- definer, path-independent: every object it touches is schema-qualified
    CREATE FUNCTION church.safe_fn() RETURNS int
      LANGUAGE sql SECURITY DEFINER AS $$ SELECT count(*)::int FROM church.things $$;

    -- definer, path-DEPENDENT: reads "widgets" unqualified, which is the shape that can be
    -- shadowed by a caller's temporary table
    CREATE FUNCTION church.risky_fn() RETURNS int
      LANGUAGE sql SECURITY DEFINER AS $$ SELECT count(*)::int FROM widgets $$;

    -- already hardened, including a path this migration would never choose: leave alone
    CREATE FUNCTION church.already_fn() RETURNS int
      LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;

    -- not a definer: 023 has no business touching an invoker function's path
    CREATE FUNCTION church.plain_fn() RETURNS int
      LANGUAGE sql AS $$ SELECT count(*)::int FROM widgets $$;

    -- a definer that a browser role legitimately needs, so "did 023 over-reach?" is testable
    CREATE FUNCTION public.keepme_fn(slug text) RETURNS text
      LANGUAGE sql SECURITY DEFINER AS $$ SELECT slug $$;

    -- the three signatures whose live grants had drifted from supabase-schema.sql
    CREATE FUNCTION church.validate_usher_passkey(p_church_slug text, p_passkey text)
      RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = church, public AS $$
      SELECT EXISTS (SELECT 1 FROM church.things WHERE p_passkey = p_church_slug) $$;
    CREATE FUNCTION public.validate_usher_passkey(p_church_slug text, p_passkey text)
      RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = church, public AS $$
      SELECT church.validate_usher_passkey(p_church_slug, p_passkey) $$;
    CREATE FUNCTION church.delete_church_tenant_cascade(p_tenant_id uuid)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = church, public AS $$
      BEGIN DELETE FROM church.things WHERE 1 = 0; END $$;

    GRANT USAGE ON SCHEMA church, private, business TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION church.safe_fn(), church.risky_fn(), church.already_fn(),
      church.plain_fn(), public.keepme_fn(text) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION church.validate_usher_passkey(text, text),
      public.validate_usher_passkey(text, text),
      church.delete_church_tenant_cascade(uuid) TO anon, authenticated, service_role;
  `);

  // A definer function in "private", unpinned: 023 must be able to pin it (the schema is
  // in scope) but must not touch its EXECUTE grants — only the named list is revoked.
  await db.exec(`
    CREATE FUNCTION private.branding_impl(p_slug text) RETURNS text
      LANGUAGE sql SECURITY DEFINER AS $$ SELECT p_slug $$;
    GRANT EXECUTE ON FUNCTION private.branding_impl(text) TO anon, authenticated;
  `);

  if (policyCallsValidator) {
    await db.exec(`
      CREATE TABLE church.churches (id uuid PRIMARY KEY, slug text NOT NULL);
      ALTER TABLE church.churches ENABLE ROW LEVEL SECURITY;
      CREATE POLICY member_read ON church.churches FOR SELECT TO authenticated
        USING (church.validate_usher_passkey(slug, 'x'));
      GRANT SELECT ON church.churches TO authenticated;
    `);
  }

  return db;
}

/** The settings a function actually carries, read back from the catalog. */
const settings = async (db, fn) => (await db.query(
  `select coalesce(array_to_string(p.proconfig, ','), '') as settings
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname || '.' || p.proname = $1`, [fn])).rows[0]?.settings ?? null;

const canExecute = async (db, role, fn) => (await db.query(
  `select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok`, [role, fn])).rows[0].ok;

test('PART A: the hole is real — an unpinned definer reads the caller’s temp table', async () => {
  const db = await buildDb();
  try {
    // Same session, hostile path first: this is what "no pinned search_path" means for a
    // SECURITY DEFINER function running as the owner.
    await db.exec(`
      BEGIN;
      CREATE TEMP TABLE widgets (id int);
      INSERT INTO widgets VALUES (999), (999), (999);
    `);
    const risky = await db.query('SELECT church.risky_fn() AS n');
    const safe = await db.query('SELECT church.safe_fn() AS n');
    await db.exec('COMMIT');

    assert.equal(risky.rows[0].n, 3,
      'the shadowed temp table is what the unpinned definer sees — 3 rows, not the real 2');
    assert.equal(safe.rows[0].n, 2, 'the schema-qualified body is unaffected');
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

test('PART A pins only what is provably path-independent, and defers the rest with a reason', async () => {
  const db = await buildDb();
  try {
    await db.exec(MIGRATION);

    const pinned = (await db.query(
      `select regexp_replace(function, '\\(.*\\)', '') as name from _023_pinned order by 1`)).rows
      .map((r) => r.name);
    const deferred = (await db.query(
      `select regexp_replace(function, '\\(.*\\)', '') as name, reason, detail from _023_deferred`)).rows;

    assert.deepEqual(pinned, ['church.safe_fn', 'private.branding_impl', 'public.keepme_fn'],
      'every unpinned definer whose body names no relation unqualified gets a path — including '
      + 'public.keepme_fn, which the migration pins without touching its grants');
    assert.deepEqual(deferred.map((r) => r.name), ['church.risky_fn'],
      'the shadowable function is reported, not silently rewritten');
    assert.match(deferred[0].detail, /widgets/,
      'the report names the unqualified relation, so the fix is obvious to whoever reads it');

    const pinnedPath = await settings(db, 'church.safe_fn');
    assert.match(pinnedPath, /^search_path=pg_catalog, public, church, private, business, extensions$/);
    assert.doesNotMatch(pinnedPath, /pg_temp/,
      'pinning to a path that still contains pg_temp would leave the hole exactly where it was');

    assert.equal(await settings(db, 'church.already_fn'), 'search_path=""',
      'a function that already pinned its path keeps the pin it chose, even one 023 would not write');
    assert.equal(await settings(db, 'church.risky_fn'), '', 'deferred means untouched');
    assert.equal(await settings(db, 'church.plain_fn'), '', 'invoker functions are not 023’s business');

    // Nothing in 023 Part A may change who can call what.
    assert.equal(await canExecute(db, 'anon', 'public.keepme_fn(text)'), true);
    assert.equal(await canExecute(db, 'anon', 'private.branding_impl(text)'), true);
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

test('PART A is idempotent, and qualifying the body is what lets a pin happen', async () => {
  const db = await buildDb();
  try {
    await db.exec(MIGRATION);
    const firstPins = (await db.query('select count(*)::int as n from _023_pinned')).rows[0].n;
    assert.ok(firstPins >= 1, 'the first run has work to do');

    await db.exec(MIGRATION);
    assert.equal((await db.query('select count(*)::int as n from _023_pinned')).rows[0].n, 0,
      'a second run must find nothing to pin — and the report must not show the first run’s work');
    assert.equal((await db.query('select count(*)::int as n from _023_deferred')).rows[0].n, 1,
      'the one deferred function is still deferred, and still reported');

    await db.exec(`
      CREATE OR REPLACE FUNCTION church.risky_fn() RETURNS int
        LANGUAGE sql SECURITY DEFINER AS $$ SELECT count(*)::int FROM public.widgets $$;
    `);
    await db.exec(MIGRATION);
    assert.match(await settings(db, 'church.risky_fn'), /^search_path=/,
      'once the operator qualifies the reference, the same migration pins it — that is the '
      + 'handoff 023 is designed to leave behind');
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

test('PART B takes the passkey validators and the deleter away from the browser roles', async () => {
  const db = await buildDb();
  const TARGETS = [
    'church.validate_usher_passkey(text,text)',
    'public.validate_usher_passkey(text,text)',
    'church.delete_church_tenant_cascade(uuid)',
  ];
  try {
    for (const t of TARGETS) {
      assert.equal(await canExecute(db, 'anon', t), true, 'the fixture models the drifted state');
      assert.equal(await canExecute(db, 'authenticated', t), true);
    }

    await db.exec(MIGRATION);

    for (const t of TARGETS) {
      assert.equal(await canExecute(db, 'anon', t), false, `${t} must not be reachable by anon`);
      assert.equal(await canExecute(db, 'authenticated', t), false, `${t} must not be reachable by a member`);
      assert.equal(await canExecute(db, 'service_role', t), true,
        `${t} must stay executable by the service role: lib/usher-passkey.ts and the deletion path run there`);
    }

    // Behaviour, not just ACLs: an anon call must be refused by the server.
    await db.exec('BEGIN; SET LOCAL ROLE anon;');
    await assert.rejects(
      () => db.query(`SELECT church.delete_church_tenant_cascade('11111111-1111-1111-1111-111111111111')`),
      /permission denied for function (church\.)?delete_church_tenant_cascade/,
      // Postgres names the function, not the qualified path, in this message — the schema is
      // asserted by the ACL checks above rather than guessed at here.
    );
    await db.exec('ROLLBACK');

    // The privileged path must keep working — and an unknown tenant id must delete nothing.
    // This is also the safe probe for the live database: a uuid that matches no church row
    // exercises reachability without touching a real tenant.
    const rowsBefore = (await db.query('select count(*)::int as n from church.things')).rows[0].n;
    await db.query(`SELECT church.delete_church_tenant_cascade('11111111-1111-1111-1111-111111111111')`);
    const rowsAfter = (await db.query('select count(*)::int as n from church.things')).rows[0].n;
    assert.equal(rowsAfter, rowsBefore, 'the service role still executes it, and the no-match delete removed 0 rows');
    assert.equal(rowsAfter, 2, 'no church data moved while the revocation ran');
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

test('PART B refuses to revoke a function that a row policy calls, because policies run as the reader', async () => {
  const db = await buildDb({ policyCallsValidator: true });
  try {
    await assert.rejects(() => db.exec(MIGRATION), (error) => {
      // The abort leaves the transaction open in some clients; clear it before asserting.
      db.exec('ROLLBACK').catch(() => {});
      assert.match(error.message, /023 PART B refuses to revoke/);
      assert.match(error.message, /church\.churches · member_read \(SELECT\)/,);
      assert.match(error.message, /evaluated as the reader/);
      return true;
    }, 'a live policy that depends on the function must stop the migration, with the policy named');

    // Fail-closed means nothing partial survives: the transaction rolled back, so the grants
    // are exactly as they were and no search_path pin landed either.
    assert.equal(await canExecute(db, 'anon', 'church.validate_usher_passkey(text,text)'), true);
    assert.equal(await settings(db, 'church.safe_fn'), '',
      'the abort must roll Part A back too — 023 is one transaction, not two migrations');
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

/**
 * Production's `church.delete_church_tenant_cascade()` takes no arguments and is attached as a
 * trigger, while supabase-schema.sql defines a `(uuid)` deleter with the same name — measured
 * 2026-11-02. Two properties follow, and this fixture is the one the live database actually
 * has: 023 must revoke the zero-argument function it finds and report the signature that is
 * absent, and revoking a trigger function's EXECUTE must not stop the trigger from firing,
 * because that is what "the cascade trigger remains enabled" means for the churches using it.
 */
async function buildTriggerDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA church;

    CREATE TABLE church.things (id int);
    CREATE TABLE church.cascade_log (id serial PRIMARY KEY, fired_at timestamptz DEFAULT now());

    CREATE FUNCTION church.delete_church_tenant_cascade() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        INSERT INTO church.cascade_log DEFAULT VALUES;
        RETURN NEW;
      END $$;

    CREATE TRIGGER thing_cascade AFTER INSERT ON church.things
      FOR EACH ROW EXECUTE FUNCTION church.delete_church_tenant_cascade();

    GRANT USAGE ON SCHEMA church TO anon, authenticated;
    GRANT INSERT ON church.things TO anon;
    GRANT SELECT ON church.cascade_log TO anon;
    REVOKE EXECUTE ON FUNCTION church.delete_church_tenant_cascade() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION church.delete_church_tenant_cascade() TO anon, authenticated, service_role;
  `);
  return db;
}

test('the live shape: the zero-argument function is revoked, the absent overload is reported, and the trigger still fires', async () => {
  const db = await buildTriggerDb();
  try {
    const before = (await db.query('select count(*)::int as n from church.cascade_log')).rows[0].n;
    await db.exec('BEGIN; SET LOCAL ROLE anon;');
    await db.query('INSERT INTO church.things VALUES (1)');
    await db.exec('COMMIT');
    const mid = (await db.query('select count(*)::int as n from church.cascade_log')).rows[0].n;
    assert.equal(mid, before + 1, 'baseline: the trigger fires for an anon insert before 023 runs');

    await db.exec(MIGRATION);

    const acl = (await db.query(
      `select action, function from _023_acl where function like '%delete_church_tenant_cascade%' order by 2`)).rows;
    assert.deepEqual(acl, [
      { action: 'revoked', function: 'church.delete_church_tenant_cascade()' },
      { action: 'skipped', function: 'church.delete_church_tenant_cascade(uuid)' },
    ], '023 must act on the signature that exists and report the one the repository invented');

    for (const role of ['anon', 'authenticated']) {
      const ok = (await db.query(
        `select has_function_privilege($1, 'church.delete_church_tenant_cascade()', 'EXECUTE') as ok`, [role]))
        .rows[0].ok;
      assert.equal(ok, false, `${role} may no longer call it directly`);
    }
    assert.equal((await db.query(
      `select has_function_privilege('service_role', 'church.delete_church_tenant_cascade()', 'EXECUTE') as ok`))
      .rows[0].ok, true, 'service_role keeps it');

    // The part that decides whether a live church notices: privilege is checked when a trigger
    // is defined, not on every firing, so the revoked function must still run as the trigger.
    await db.exec('BEGIN; SET LOCAL ROLE anon;');
    await db.query('INSERT INTO church.things VALUES (2)');
    await db.exec('COMMIT');
    const after = (await db.query('select count(*)::int as n from church.cascade_log')).rows[0].n;
    assert.equal(after, mid + 1,
      'the cascade trigger must keep firing after the EXECUTE revoke — if this ever fails, the '
      + 'revoke is a behaviour change for every insert on that table and belongs in the app, not here');
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});


// ---------------------------------------------------------------------------
// migrations/024_usher_session_guard.sql — the two usher-session functions the live
// database has and this repository does not. Its default is to report, because these
// functions write and an unseen client could depend on them.
// ---------------------------------------------------------------------------
const USHER_FIXTURE = `
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA church;

    CREATE TABLE church.usher_sessions (
      token text PRIMARY KEY,
      event_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO church.usher_sessions (token) VALUES ('fresh-token');

    CREATE FUNCTION church.create_usher_session(p_church_slug text, p_token text,
                                                 p_expires_at timestamptz, p_event_id uuid)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        INSERT INTO church.usher_sessions (token, event_id) VALUES (p_token, p_event_id);
        RETURN gen_random_uuid();
      END $$;

    CREATE FUNCTION church.get_usher_session(p_token text)
      RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT EXISTS (SELECT 1 FROM church.usher_sessions u WHERE u.token = p_token) $$;

    GRANT USAGE ON SCHEMA church TO anon, authenticated;
    GRANT SELECT, INSERT ON church.usher_sessions TO anon;
    GRANT EXECUTE ON FUNCTION church.create_usher_session(text, text, timestamptz, uuid),
      church.get_usher_session(text) TO anon, authenticated, service_role;
`;

async function buildUsherDb(extra = '') {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.placeholder (id int);
    DROP TABLE public.placeholder;
  `);
  await db.exec(USHER_FIXTURE + extra);
  return db;
}

const report = async (db, like) => (await db.query(
  `select coalesce(string_agg(detail, ' | '), '') as detail from _024_report where item like $1`,
  [like])).rows[0].detail;

test('024 reports the live shape and revokes nothing while v_apply is false', async () => {
  const db = await buildUsherDb();
  try {
    await db.exec(MIGRATION_024);

    const both = await report(db, '%(%');
    assert.match(both, /SECURITY DEFINER \(runs as the owner\)/,
      'it must say, in words, that these run as the owner');
    assert.match(both, /anon CAN execute · authenticated CAN execute/, 'and who can reach them today');
    assert.match(both, /usher_sessions: 1 row\(s\)/, 'and what the session table holds');
    assert.match(both, /NEWER.*than the 30-day staleness window/s,
      'the newest row must be characterised as recent, not silently ignored');
    assert.match(await report(db, '%decision%'), /v_apply is false, so nothing was revoked/);

    assert.equal((await db.query(`select has_function_privilege('anon',
      'church.create_usher_session(text,text,timestamptz,uuid)', 'EXECUTE') as ok`)).rows[0].ok, true,
      'a report must not change a single privilege');
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

test('024 refuses to revoke a function whose session table is being written', async () => {
  const db = await buildUsherDb();
  try {
    await assert.rejects(() => db.exec(withApply(MIGRATION_024, true)), (error) => {
      assert.match(error.message, /024 refuses to revoke/);
      assert.match(error.message, /written inside 30 days/);
      assert.match(error.message, /token generated in the/);
      return true;
    }, 'someone is using it, so the answer is the three lines in the body, not a revoke');

    await db.exec('ROLLBACK').catch(() => {});
    assert.equal((await db.query(`select has_function_privilege('anon',
      'church.get_usher_session(text)', 'EXECUTE') as ok`)).rows[0].ok, true,
      'the refusal must leave the grants exactly as they were');
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

test('024 revokes for the browser roles once the table is provably stale, and keeps service_role', async () => {
  const db = await buildUsherDb(`
    UPDATE church.usher_sessions SET created_at = now() - interval '400 days';
  `);
  try {
    await db.exec(withApply(MIGRATION_024, true));
    assert.match(await report(db, '%usage%'), /older or absent/);

    for (const sig of ['church.create_usher_session(text,text,timestamptz,uuid)', 'church.get_usher_session(text)']) {
      assert.equal((await db.query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as ok`, [sig])).rows[0].ok, false,
        `${sig} must stop being reachable by anon`);
      assert.equal((await db.query(
        `select has_function_privilege('authenticated', $1, 'EXECUTE') as ok`, [sig])).rows[0].ok, false);
      assert.equal((await db.query(
        `select has_function_privilege('service_role', $1, 'EXECUTE') as ok`, [sig])).rows[0].ok, true,
        `${sig} must stay available to the application\'s privileged path`);
    }

    // Behaviour, not only ACLs.
    await db.exec('BEGIN; SET LOCAL ROLE anon;');
    await assert.rejects(() => db.query(`SELECT church.get_usher_session('fresh-token')`),
      /permission denied for function (church\.)?get_usher_session/);
    await db.exec('ROLLBACK');
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

test('024 stops outright when a row policy calls the function, because that makes it part of RLS', async () => {
  const db = await buildUsherDb(`
    ALTER TABLE church.usher_sessions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY token_owner ON church.usher_sessions FOR SELECT TO authenticated
      USING (church.get_usher_session(token));
    GRANT SELECT ON church.usher_sessions TO authenticated;
  `);
  try {
    // Read-only mode still has to be runnable, because measuring the situation is the whole
    // point of the default: it reports the policy dependency instead of refusing on it.
    await db.exec(MIGRATION_024);
    assert.match(await report(db, 'policy dependency'), /church\.usher_sessions · token_owner calls get_usher_session/);
    assert.match(await report(db, 'policy dependency'), /inside RLS, not beside it/);

    // Read-only mode must stay runnable even in this worst case: measuring the situation is the
    // point of the default, so the policy dependency is reported here rather than being fatal.
    await db.exec(MIGRATION_024);
    assert.match(await report(db, 'policy dependency'),
      /church\.usher_sessions · token_owner calls get_usher_session/);
    assert.match(await report(db, 'policy dependency'), /inside RLS, not beside it/);
    assert.equal((await db.query(`select has_function_privilege('authenticated',
      'church.get_usher_session(text)', 'EXECUTE') as ok`)).rows[0].ok, true,
      'a report changes nothing, not even when it has found something serious');

    await assert.rejects(() => db.exec(withApply(MIGRATION_024, true)), (error) => {
      assert.match(error.message, /024 stops here/);
      assert.match(error.message, /part of RLS rather than a spare API/);
      return true;
    }, 'a policy predicate is evaluated as the reader, so a revoke would break plain SELECTs');
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal((await db.query(`select has_function_privilege('authenticated',
      'church.get_usher_session(text)', 'EXECUTE') as ok`)).rows[0].ok, true);
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});

test('024 says so plainly when the functions are not in the database at all', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;`);
    await db.exec(MIGRATION_024);
    const rows = await db.query(`select item, detail from _024_report`);
    assert.equal(rows.rows.length, 1, 'one line, no invented findings');
    assert.equal(rows.rows[0].item, 'absent');
    assert.match(rows.rows[0].detail, /nothing to revoke/);
  } finally {
    await db.exec('DISCARD ALL').catch(() => {});
  }
});
