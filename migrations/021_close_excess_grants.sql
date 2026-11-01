-- ============================================================================
-- 021 · PHASE C — close the table privileges RLS cannot
--
-- WHERE THIS CAME FROM
-- A read-only audit of the live project found, on church.churches:
--   * no tenant write POLICY at all (so no church account can UPDATE or DELETE a row —
--     the P0-1 exploit is not reachable on this database), and
--   * UPDATE, DELETE and TRUNCATE GRANTS held by both `anon` and `authenticated`.
-- The first fact is the one that matters to customers, and it means the live database
-- is safer than this repository's schema file describes. The second is the one worth
-- fixing today, because of how Postgres splits these two controls:
--
--   Row-level security filters DML. It does NOT apply to TRUNCATE.
--
-- A role holding TRUNCATE on church.churches can empty the whole table — every church
-- in the system, not one tenant's rows — regardless of every policy in this file, and
-- `church.members` and the rest hang off it with ON DELETE CASCADE. That privilege is
-- not reachable through PostgREST (no REST verb issues TRUNCATE), so this is not an
-- emergency; it is exactly the thing that turns a future SQL injection, or a tool that
-- lets someone run one statement, from bad into unrecoverable. A grant no code path
-- uses should not exist.
--
-- WHAT THIS FILE REVOKES, and why each one is safe:
--   1. TRUNCATE, REFERENCES, TRIGGER on every table in church/public/business, from
--      anon and authenticated. Supabase's data API has no verb that needs them: REST
--      does insert/select/update/delete/upsert and nothing else, and the objects
--      needing TRIGGER/REFERENCES are created by migrations running as the owner.
--   2. INSERT, UPDATE, DELETE on church.churches from anon and authenticated. Every
--      write to that table in the application goes through a service-role connection
--      (createAdminClient, getAdminClient, getServiceDb, the two Edge functions), and
--      020's column guard protects it regardless. This is the grant-level twin of
--      020's policy-level narrowing.
--   3. Everything except SELECT on church.activation_payments from anon and
--      authenticated. The ledger is read and written only by lib/activation (its
--      getAdminClient) and the webhook; no church account has a reason to touch
--      another church's payment history at all.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH
--   * SELECT on church.churches, for either role. public.churches_public is declared
--     WITH (security_invoker = true), so a visitor executing that view reads
--     church.churches AS THEMSELVES and needs SELECT on the base table underneath it.
--     supabase-schema.sql currently gives anon no policy on churches at all, so the
--     view returns zero rows either way — which is precisely why the privilege is kept
--     instead of "cleaned up": if a public read policy is ever restored (the schema
--     dropped "Churches are viewable by everyone"), the grant has to already be there,
--     or the page fails at the privilege layer while every policy still looks correct.
--     Revoking it buys nothing and costs a failure mode nobody would think to look for.
--     Step 5 asserts the privilege survived.
--   * DML privileges on any other table. migrations/016 gave members, new_converts,
--     sms_queue and sms_logs real `authenticated` write policies because those flows
--     talk to PostgREST directly; those grants are load-bearing and must stay until
--     each one is audited the way churches and the ledger were. The query at the foot
--     of this file shows what else is wider than its policies need.
--   * Anything granted to service_role, or to roles named churchos_*.
--
-- Safe to run twice. Run it AFTER 020: step 3 checks for exactly that ordering and
-- refuses to revoke DML while a tenant write policy is still live, because that would
-- be a behaviour change rather than a cleanup.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Before: the privilege surface this file is about to change.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  RAISE NOTICE 'PHASE C · non-SELECT privileges held by anon/authenticated before this file:';
  FOR r IN
    SELECT table_schema, table_name, grantee,
           string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
      FROM information_schema.role_table_grants
     WHERE grantee IN ('anon', 'authenticated')
       AND table_schema IN ('church', 'public', 'business')
       AND privilege_type <> 'SELECT'
     GROUP BY table_schema, table_name, grantee
     ORDER BY table_schema, table_name, grantee
  LOOP
    RAISE NOTICE '  BEFORE · %.% · % · %', r.table_schema, r.table_name, r.grantee, r.privileges;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. TRUNCATE / REFERENCES / TRIGGER, everywhere, for both browser roles.
--    Built from pg_class rather than a table list, so a table created after this
--    file was written is covered the next time someone runs it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('church', 'public', 'business')
       AND c.relkind IN ('r', 'p')          -- ordinary and partitioned tables
       AND c.relname NOT LIKE 'pg_%'
     ORDER BY n.nspname, c.relname
  LOOP
    -- TRUNCATE is the privilege that bypasses RLS. REFERENCES and TRIGGER are swept
    -- up in the same statement because neither belongs to a role that only talks REST.
    BEGIN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I.%I FROM anon, authenticated',
                     r.schema_name, r.table_name);
      v_count := v_count + 1;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'PHASE C · skipped %.% (this connection cannot revoke there)', r.schema_name, r.table_name;
      WHEN undefined_table THEN
        NULL;   -- dropped or renamed since the catalog scan: nothing to revoke.
      WHEN undefined_object THEN
        NULL;   -- a database without the Supabase browser roles (bare staging PG):
                -- there is no grant there to remove, and this file must not abort on it.
    END;
  END LOOP;
  RAISE NOTICE 'PHASE C · TRUNCATE/REFERENCES/TRIGGER revoked on % tables', v_count;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. church.churches: DML off both browser roles.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_policy_writes integer;
BEGIN
  -- Refuse to revoke a privilege that a policy is currently handing to a tenant. That
  -- would change live behaviour rather than clean up, and it would mask the fact that
  -- 020 has not been applied yet.
  SELECT count(*) INTO v_policy_writes
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'church' AND c.relname = 'churches'
     -- 'i' is not a pg_policy command and FOR ALL is '*', so the correct write set is
     -- ('a' INSERT, 'w' UPDATE, 'd' DELETE, '*' ALL). Written as ('w','i','d','a') this
     -- check saw nothing on a database whose tenant policy is FOR ALL - which is every
     -- database this repository shipped - and the guard below would have revoked the
     -- grant out from under a live policy. Caught by tests/sql/grants_hardening.test.mjs.
     AND p.polcmd IN ('a', 'w', 'd', '*')
     AND (p.polroles::regrole[]::text LIKE '%authenticated%'
          OR p.polroles::regrole[]::text LIKE '%anon%'
          OR p.polroles = '{}');                     -- no TO clause = PUBLIC

  IF v_policy_writes > 0 THEN
    RAISE EXCEPTION
      'PHASE C aborted: church.churches still has % tenant write polic(y|ies). Run 020 first — it drops them, and revoking the grant underneath a live policy would change behaviour instead of tidying it.',
      v_policy_writes;
  END IF;

  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON church.churches FROM anon, authenticated';
  RAISE NOTICE 'PHASE C · church.churches: INSERT/UPDATE/DELETE revoked from anon and authenticated. SELECT deliberately kept (public.churches_public is security_invoker).';
END
$$;

-- ---------------------------------------------------------------------------
-- 4. The payment ledger: no browser role keeps a write privilege.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('church.activation_payments') IS NULL THEN
    RAISE NOTICE 'PHASE C · no church.activation_payments table here - ledger step skipped.';
    RETURN;
  END IF;

  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON church.activation_payments FROM anon, authenticated';
  RAISE NOTICE 'PHASE C · ledger: write privileges revoked from anon and authenticated.';

  IF has_table_privilege('authenticated', 'church.activation_payments', 'SELECT') THEN
    RAISE NOTICE 'PHASE C · NOTE: authenticated still holds SELECT on the ledger. 019''s service-only policy makes it read nothing, but the grant is wider than any code path needs; confirm nothing reads it as the caller, then REVOKE SELECT ON church.activation_payments FROM anon, authenticated;';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. After: this file refuses to commit if it half-applied, or if it took a SELECT
--    surface the public pages depend on.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM information_schema.role_table_grants
   WHERE grantee IN ('anon', 'authenticated')
     AND table_schema IN ('church', 'public', 'business')
     AND privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER');

  IF v_left > 0 THEN
    RAISE EXCEPTION 'PHASE C FAILED: % TRUNCATE/REFERENCES/TRIGGER grant(s) still held by a browser role', v_left;
  END IF;

  IF has_table_privilege('authenticated', 'church.churches', 'UPDATE')
     OR has_table_privilege('anon', 'church.churches', 'DELETE') THEN
    RAISE EXCEPTION 'PHASE C FAILED: a browser role still holds DML on church.churches';
  END IF;

  -- has_table_privilege() is the assertion that counts, not the catalog scan above:
  -- it resolves privileges a browser role inherits through a group role, which
  -- information_schema.role_table_grants does not list. Two tables are checked so the
  -- sweep itself is under test, not only the churches step. This is the privilege that
  -- RLS cannot constrain, so losing it silently is the failure this file exists for.
  IF has_table_privilege('authenticated', 'church.churches', 'TRUNCATE')
     OR has_table_privilege('anon', 'church.churches', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'church.members', 'TRUNCATE') THEN
    RAISE EXCEPTION 'PHASE C FAILED: a browser role can still TRUNCATE a church table through a group role - revoke that membership or the group grant, do not edit this file';
  END IF;

  IF NOT has_table_privilege('anon', 'church.churches', 'SELECT') THEN
    RAISE EXCEPTION 'PHASE C FAILED: anon lost SELECT on church.churches — public.churches_public is security_invoker, so every public page would start failing with permission denied instead of simply returning no rows';
  END IF;

  RAISE NOTICE 'PHASE C OK · TRUNCATE/REFERENCES/TRIGGER gone from browser roles · churches DML revoked · SELECT surface preserved';

  FOR r IN
    SELECT table_schema, table_name, grantee,
           string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
      FROM information_schema.role_table_grants
     WHERE grantee IN ('anon', 'authenticated')
       AND table_schema IN ('church', 'public', 'business')
     GROUP BY table_schema, table_name, grantee
     HAVING string_agg(privilege_type, ',') <> 'SELECT'
     ORDER BY 1, 2, 3
  LOOP
    RAISE NOTICE '  AFTER · %.% · % · %', r.table_schema, r.table_name, r.grantee, r.privileges;
  END LOOP;
END
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK, kept here because "we had to give it back in a hurry" is how revoke
-- scripts get abandoned:
--   GRANT INSERT, UPDATE, DELETE, TRUNCATE ON church.churches TO anon, authenticated;
--   GRANT INSERT, UPDATE, DELETE ON church.activation_payments TO anon, authenticated;
-- and to regenerate the per-table sweep:
--   SELECT 'GRANT TRUNCATE, REFERENCES, TRIGGER ON ' || table_schema || '.' || table_name
--          || ' TO anon, authenticated;'
--     FROM information_schema.tables
--    WHERE table_schema IN ('church','public','business')
--      AND table_type = 'BASE TABLE';
--
-- Which OTHER tables hand a browser role a write privilege no policy will use? Run
-- this read-only; it is how the next candidate gets chosen, and it is deliberately
-- not acted on by this file:
--   SELECT g.table_schema, g.table_name, g.grantee, g.privilege_type,
--          (SELECT count(*) FROM pg_policy p
--             JOIN pg_class c ON c.oid = p.polrelid
--            WHERE c.relname = g.table_name AND p.polcmd IN ('a','w','d','*')) AS write_policies
--     FROM information_schema.role_table_grants g
--    WHERE g.grantee IN ('anon','authenticated')
--      AND g.privilege_type IN ('INSERT','UPDATE','DELETE')
--      AND g.table_schema IN ('church','public')
--    ORDER BY write_policies, g.table_name;
-- ---------------------------------------------------------------------------
