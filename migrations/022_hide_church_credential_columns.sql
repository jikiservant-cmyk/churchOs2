-- ============================================================================
-- 022 · PHASE D — hide the usher credential columns from the browser role
--
-- THE HOLE, WHICH IS NOT A POLICY BUG
-- Row-level security filters ROWS. It cannot hide a COLUMN. Production carries the
-- right tenant predicate on church.churches (`id = church.my_tenant_id()`, plus an
-- app_type scoping set outside this repository), and that is exactly why the following
-- succeeds for any signed-in account of a church, pastor or member alike:
--
--   GET /rest/v1/churches?id=eq.<that-church-uuid>&select=passkey
--
-- The row matches the policy, so the row is returned — and `passkey` is the shared
-- usher code, stored in the clear because the attendance screen has to show it to the
-- pastor. 020's trigger and 021's revoke closed WRITES to that column; nothing here
-- closed READS. The admin pages look role-gated (`layout.tsx` allows only pastor and
-- admin), but PostgREST does not consult that gate: the API honours row policies and
-- table privileges, nothing else. So a member's browser session can read the
-- credential that lets someone mark attendance for their congregation, and any future
-- column added to this table inherits the same exposure silently.
--
-- THE FIX: column-level SELECT, so the read fails where it must
-- Postgres supports `GRANT SELECT (col, ...)`, and it is subtractive by omission:
-- revoke the table-level SELECT from `anon`/`authenticated`, then grant back every
-- column except the four credential columns. A browser-role query that touches
-- `passkey`, `passkey_hash`, `passkey_version` or `passkey_updated_at` now fails with
-- 42501 instead of returning a code. The application is unaffected because every
-- legitimate read of those columns goes through a service-role connection — verified
-- call by call, not assumed:
--
--   app/c/[church_slug]/admin/(authenticated)/attendance/page.tsx:30,36  createAdminClient() -> select('passkey')
--   lib/attendance-actions.ts:61,229,432                                   admin / scopedDb.admin
--   lib/usher-passkey.ts:126,164,171                                       adminClient
--   lib/tenant.ts:38-40 (requireTenant)                                    createAdminClient() -> select('slug')
--
-- One query in the repository DID read the whole row as the caller —
-- `app/c/[church_slug]/admin/(authenticated)/messages/page.tsx` had
-- `.from('churches').select('*')` on the session client, using only id, name, slug,
-- theme_color and logo_url. It is changed to name those five in the same commit as this
-- file, because with column-level grants a `select=*` on this table is a permission
-- error, and a page that over-fetches is also a page that will break the next time a
-- secret column is added.
--
-- WHAT IS NOT BEING DONE, ON PURPOSE
--   * No hashing, no re-issue, no change to how the code is stored or compared. The
--     pastor has to be able to read the code aloud to an usher, so it stays a readable
--     value on the row. Anyone with the service key, the table owner, or the dashboard
--     still sees it in plain text — this migration protects tenants FROM EACH OTHER,
--     which is what RLS is for. It does not protect the column from an operator.
--   * `sender_id` and the billing columns stay readable by the tenant. They are
--     configuration and status the tenant's own screens display; hiding them buys no
--     secret back and would break `app/api/sms/enqueue/route.ts` and the activation
--     screen for nothing.
--   * No policy is created, dropped or edited here. 020 and 021 own that.
--
-- CONSEQUENCE TO KNOW BEFORE RUNNING IT
-- A browser-role `select=*` on church.churches stops working (42501, not a silent empty
-- result). Nothing in this repository does one any more. If a Retool/Make/Zapier
-- integration or a hand-written dashboard queries that table with the anon or
-- authenticated key and asks for everything, give it an explicit column list — or roll
-- this back with the statement at the foot of the file. A service-role key is unaffected.
--
-- Safe to run twice. The list of granted columns is built from the catalog, never
-- hard-coded, because databases in the field are at different migrations and a hard-coded
-- list would fail on a database where a column does not exist yet — the exact defect that
-- almost broke 020. It refuses to run rather than half-apply if a tenant POLICY predicate
-- references one of the four hidden columns, since policy expressions are evaluated with
-- the querying role's privileges and would start raising for every member.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Decide what is safe, from the catalog, and refuse if it is not.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_secret  text[] := ARRAY['passkey', 'passkey_hash', 'passkey_version', 'passkey_updated_at'];
  v_present text[];
  v_safe    text[];
  r         record;
  v_hits    text;
BEGIN
  IF to_regclass('church.churches') IS NULL THEN
    RAISE EXCEPTION 'PHASE D FAILED: church.churches does not exist in this database';
  END IF;

  SELECT coalesce(array_agg(c.column_name), ARRAY[]::text[]) INTO v_present
    FROM information_schema.columns c
   WHERE c.table_schema = 'church' AND c.table_name = 'churches'
     AND c.column_name = ANY (v_secret);

  SELECT coalesce(array_agg(c.column_name ORDER BY c.ordinal_position), ARRAY[]::text[]) INTO v_safe
    FROM information_schema.columns c
   WHERE c.table_schema = 'church' AND c.table_name = 'churches'
     AND NOT (c.column_name = ANY (v_secret));

  IF cardinality(v_safe) = 0 THEN
    RAISE EXCEPTION 'PHASE D FAILED: no columns left to grant on church.churches';
  END IF;
  -- `id` is not decoration: the tenancy predicate and every .eq('id', …) need it.
  IF NOT ('id' = ANY (v_safe)) THEN
    RAISE EXCEPTION 'PHASE D FAILED: church.churches has no id column, so a tenant predicate cannot survive a column grant';
  END IF;

  RAISE NOTICE 'PHASE D · hiding % credential column(s): % · granting back % column(s)',
    cardinality(v_present),
    coalesce((SELECT string_agg(x, ', ') FROM unnest(v_present) x), 'none present'),
    cardinality(v_safe);

  -- A policy whose predicate references a hidden column would go from "works" to
  -- "42501 for every member of every church", because RLS expressions are evaluated
  -- under the querying role's column privileges. Detect it and stop; do not quietly
  -- rewrite somebody else's policy from a cleanup script.
  FOR r IN
    SELECT p.policyname, p.qual, p.with_check
      FROM pg_policies p
     WHERE p.schemaname = 'church' AND p.tablename = 'churches'
       AND (p.roles::text LIKE '%authenticated%' OR p.roles::text LIKE '%anon%'
            OR p.roles::text LIKE '%public%')
  LOOP
    SELECT coalesce(string_agg(x, ', '), '') INTO v_hits
      FROM unnest(v_secret) AS x
     WHERE coalesce(r.qual, '') LIKE '%' || x || '%'
        OR coalesce(r.with_check, '') LIKE '%' || x || '%';
    IF v_hits <> '' THEN
      RAISE EXCEPTION
        'PHASE D aborted: policy % on church.churches references %, which this file hides from the browser role. Rewrite that policy first; a column grant and a predicate on the same column cannot both be true.',
        r.policyname, v_hits;
    END IF;
  END LOOP;

  -- A view over this table is the sneaky case, and the catalog stores its semantics in
  -- a place worth naming: `security_invoker` is NOT a pg_class column (relsecurity does
  -- not exist in any released Postgres — checked against PGlite's PG 18 during this
  -- file's own test run). It is a member of pg_class.reloptions, so that is what has to
  -- be read. A security_invoker view runs as the visitor, so exposing a hidden column
  -- through one would turn a public page into a 42501; a definer view that a browser
  -- role can read is worse still, since it hands the column out regardless of RLS. Both
  -- abort here. The repository's own public.churches_public selects id, name, slug,
  -- app_type, logo_url, theme_color, created_at — none hidden — which is why this passes,
  -- and it is checked rather than reasoned about.
  FOR r IN
    SELECT DISTINCT n2.nspname AS viewschema, c2.relname AS viewname, a.attname AS column_name,
           (coalesce(c2.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']) AS runs_as_caller
      FROM pg_depend d
      -- the dependency a view has on a table hangs off its pg_rewrite rule, not its
      -- pg_class row; joining pg_class to pg_depend.objid finds nothing and quietly
      -- makes this whole check a no-op, which is how the first draft behaved.
      JOIN pg_rewrite r2 ON r2.oid = d.objid
      JOIN pg_class c2 ON c2.oid = r2.ev_class AND c2.relkind = 'v'
      JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
      JOIN pg_attribute a ON a.attrelid = c2.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE d.refclassid = 'pg_class'::regclass
       AND d.refobjid = 'church.churches'::regclass
     ORDER BY 1, 2, 3
  LOOP
    IF r.column_name = ANY (v_secret)
       AND (r.runs_as_caller
            OR has_table_privilege('authenticated', format('%I.%I', r.viewschema, r.viewname)::regclass, 'SELECT')
            OR has_table_privilege('anon', format('%I.%I', r.viewschema, r.viewname)::regclass, 'SELECT')) THEN
      RAISE EXCEPTION
        'PHASE D aborted: %.%.% exposes the hidden column % to a browser role (security_invoker: %). Redefine the view without that column first — a column grant that the view walks around is not a fix.',
        r.viewschema, r.viewname, r.column_name, r.column_name, r.runs_as_caller;
    END IF;
  END LOOP;

END
$$;

-- ---------------------------------------------------------------------------
-- 2. Apply: revoke the table-level read, grant back everything but the credentials.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_secret  text[] := ARRAY['passkey', 'passkey_hash', 'passkey_version', 'passkey_updated_at'];
  v_present text[];
  v_list    text;
BEGIN
  SELECT coalesce(array_agg(c.column_name), ARRAY[]::text[]) INTO v_present
    FROM information_schema.columns c
   WHERE c.table_schema = 'church' AND c.table_name = 'churches'
     AND c.column_name = ANY (v_secret);

  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_list
    FROM information_schema.columns c
   WHERE c.table_schema = 'church' AND c.table_name = 'churches'
     AND NOT (c.column_name = ANY (v_secret));

  -- Column-level REVOKE first: a database that was once handed `GRANT SELECT
  -- (passkey)` by hand would otherwise keep that acl entry after the table-level
  -- revoke below, and the hole would look closed in the log and stay open.
  IF cardinality(v_present) > 0 THEN
    EXECUTE format('REVOKE SELECT (%s) ON church.churches FROM anon, authenticated',
      (SELECT string_agg(quote_ident(x), ', ') FROM unnest(v_present) x));
  END IF;

  EXECUTE 'REVOKE SELECT ON church.churches FROM anon, authenticated';
  EXECUTE format('GRANT SELECT (%s) ON church.churches TO anon, authenticated', v_list);
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Prove it by executing as the roles, not by reading an acl. This is the step that
--    decides whether the file commits: a hardening script that reports success while
--    breaking a read the application needs is worse than not hardening anything.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r         record;
  v_broken  text := '';
  v_still   text := '';
  v_saw_all boolean := false;
  v_can_set_role boolean := true;
BEGIN
  -- (a) every credential column present here must be unreadable to both browser roles.
  FOR r IN
    SELECT c.column_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'church' AND c.table_name = 'churches'
       AND c.column_name IN ('passkey', 'passkey_hash', 'passkey_version', 'passkey_updated_at')
     ORDER BY c.ordinal_position
  LOOP
    IF has_column_privilege('authenticated', 'church.churches', r.column_name, 'SELECT')
       OR has_column_privilege('anon', 'church.churches', r.column_name, 'SELECT') THEN
      v_still := v_still || r.column_name || ' ';
    END IF;
  END LOOP;
  IF v_still <> '' THEN
    RAISE EXCEPTION 'PHASE D FAILED: a browser role can still read church.churches.%', trim(v_still);
  END IF;

  -- (b) the reads the application actually makes as the caller must still work.
  --
  --     SET LOCAL ROLE is what makes this a proof instead of an assertion about an acl,
  --     and it needs this connection to be a member of `authenticated`. On Supabase it
  --     is; on a bare Postgres or a restricted migration role it may not be, and a
  --     hardening file must not abort its whole purpose because it could not do a
  --     victory lap. So the inability to switch roles is reported and the manual check
  --     is spelled out; anything the switch DOES run and find broken still aborts.
  v_can_set_role := true;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
  EXCEPTION WHEN insufficient_privilege THEN
    v_can_set_role := false;
    RAISE NOTICE 'PHASE D · runtime proof skipped, this connection cannot SET ROLE authenticated: %', SQLERRM;
    RAISE NOTICE 'PHASE D · verify by hand as that role: SELECT id, name, slug FROM church.churches must succeed, SELECT passkey FROM church.churches must fail with 42501.';
  END;

  IF v_can_set_role THEN
  BEGIN
    EXECUTE 'SELECT count(*) FROM (SELECT id, name, slug FROM church.churches) s';
  EXCEPTION WHEN OTHERS THEN
    v_broken := v_broken || 'caller-role read of id/name/slug: ' || SQLERRM || ' | ';
  END;
  IF to_regclass('public.churches_public') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT count(*) FROM public.churches_public';
    EXCEPTION WHEN OTHERS THEN
      v_broken := v_broken || 'public.churches_public: ' || SQLERRM
               || ' (the public landing/portal path — it must survive) | ';
    END;
  END IF;

  -- (c) select=* must now be refused for the browser role. That is a deliberate
  -- behaviour change, stated here so it is a fact in the log and not a surprise.
  IF v_can_set_role THEN
  BEGIN
    EXECUTE 'SELECT count(*) FROM (SELECT * FROM church.churches) s';
    v_saw_all := true;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;      -- expected
    WHEN OTHERS THEN
      v_broken := v_broken || 'unexpected error on select=*: ' || SQLERRM || ' | ';
  END;
  -- The switch is LOCAL to this transaction, so it would unwind at COMMIT anyway — but
  -- the assertions after it name roles explicitly and must not depend on which role is
  -- currently in effect while it still is.
  RESET ROLE;
  END IF;
  END IF;  -- v_can_set_role

  IF v_broken <> '' THEN
    RAISE EXCEPTION 'PHASE D FAILED: hiding the credential columns also broke a read something needs — %', trim(v_broken);
  END IF;

  -- (d) service_role keeps table-level SELECT: the app's passkey reads, rotations and
  --     the activation screen all run as that role, and every usher portal in the
  --     system depends on it staying that way.
  IF NOT has_table_privilege('service_role', 'church.churches', 'SELECT') THEN
    RAISE EXCEPTION 'PHASE D FAILED: service_role lost table-level SELECT on church.churches — the application reads passkey through that role';
  END IF;

  RAISE NOTICE 'PHASE D OK · credential columns unreadable to anon/authenticated (SELECT * refused: %)',
    CASE WHEN v_saw_all THEN 'no - table-level SELECT survives, check the grants' ELSE 'yes' END;
  RAISE NOTICE 'PHASE D · tenant reads of the granted columns and the public view both verified as authenticated';
END
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK (one statement, so a surprise is survivable):
--   GRANT SELECT ON church.churches TO anon, authenticated;
--
-- The resulting privilege shape, for any role:
--   SELECT a.attname,
--          has_column_privilege('authenticated', 'church.churches', a.attname, 'SELECT') AS auth_can_read,
--          has_column_privilege('anon',          'church.churches', a.attname, 'SELECT') AS anon_can_read
--     FROM pg_attribute a
--    WHERE a.attrelid = 'church.churches'::regclass AND a.attnum > 0 AND NOT a.attisdropped
--    ORDER BY a.attnum;
--
-- Same reasoning, next candidates — every table whose rows a tenant can read while it
-- holds a credential or a value the tenant should not see: church.members
-- (next_of_kin, phone_number for a member without admin rights), church.tenant_users,
-- and anything carrying a bearer token. Each needs its own who-reads-what-as-the-caller
-- audit, exactly as this file has one, before a column grant is touched.
-- ---------------------------------------------------------------------------
