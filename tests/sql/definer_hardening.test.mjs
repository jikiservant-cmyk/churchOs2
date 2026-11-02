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
