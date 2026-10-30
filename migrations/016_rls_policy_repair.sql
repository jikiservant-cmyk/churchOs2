-- 016: repair the RLS policies the SMS + wallet paths need.
--
-- Why this exists. RLS is deny-by-default: a table with RLS enabled and no
-- applicable policy returns ZERO ROWS AND NO ERROR for SELECT, and rejects
-- INSERT/UPDATE/DELETE with 42501. So a database that received
-- `ENABLE ROW LEVEL SECURITY` but not the policies that follow it does not look
-- broken. It looks empty. That is precisely what this app displayed:
--
--   * public.wallets unreadable
--         -> the messages page and GET /api/church/wallet/status get "no rows"
--         -> a funded wallet renders as `0 SMS remaining`
--   * public.admin_profiles unreadable by service_role
--         -> the enqueue guard gets no profile row
--         -> "Access denied: only pastors or administrators can enqueue
--            broadcasts", to the account that IS the pastor
--   * church.sms_queue without its INSERT policy
--         -> 42501 while queueing a broadcast
--
-- And the schema file could not heal itself: 33 `CREATE POLICY` statements had
-- no `DROP POLICY IF EXISTS` guard, and the FIRST is at line 354 — so every
-- re-run of supabase-schema.sql aborted there with 42710 (`policy already
-- exists`) and silently skipped everything below it, including the wallet,
-- sms_logs and sms_queue policies. Those guards are now in the schema file, but
-- re-applying 2,000 lines against a live church database is not a small act, so
-- this migration re-establishes only what messaging and the wallet require.
--
-- Deliberately additive and narrow.
--   * Policies are PERMISSIVE, so several policies for one role OR together:
--     re-running this never locks anyone out further, and any older equivalent
--     policy (`members_rw_select`, `sms_logs_rw_select`, …) can be dropped later
--     at leisure.
--   * The `authenticated` predicate is the same tenant check the rest of the
--     schema uses, so this restores access WITHOUT widening it across tenants.
--   * Idempotent: safe to run again, and it does not rewrite rows.

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION
      'auth.uid() is missing, so this is not a Supabase database or its auth schema was dropped. '
      'Aborting before touching any policy: without it no tenant check can be expressed.';
  END IF;
  IF to_regnamespace('church') IS NULL THEN
    RAISE EXCEPTION 'schema church does not exist; this database has not been provisioned with the ChurchOS schema';
  END IF;
END $$;

-- Every policy below calls it. If it is absent, no tenant predicate can be
-- written at all, so recreate it here rather than fail halfway. Same definition
-- as supabase-schema.sql: SECURITY DEFINER so the lookup is not itself filtered
-- by admin_profiles' policy (which would recurse), with a pinned search_path so
-- a caller cannot redirect which table it reads.
DO $$
BEGIN
  IF to_regprocedure('church.my_tenant_id()') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION church.my_tenant_id()
      RETURNS uuid AS $body$
      BEGIN
        RETURN (
          SELECT tenant_id::uuid
          FROM public.admin_profiles
          WHERE id = auth.uid()
          LIMIT 1
        );
      END;
      $body$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, church;
    $fn$;
    RAISE NOTICE '016: recreated church.my_tenant_id(), which was missing.';
  END IF;
  -- A missing EXECUTE grant makes every RLS check raise 42501, which surfaces as
  -- a failed query rather than an empty one. Grant it either way.
  EXECUTE 'GRANT EXECUTE ON FUNCTION church.my_tenant_id() TO authenticated, service_role';
END $$;

-- ── Policy repair ───────────────────────────────────────────────────────────
-- auth_write: 'none' = read only for portal users; 'dml' = tenant-scoped writes.
DO $$
DECLARE
  r record;
  v_repaired text := '';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.admin_profiles',
       'id = auth.uid()',
       'none',
       'the guard every admin route reads first'),
      ('public.wallets',
       'tenant_id = church.my_tenant_id()',
       'none',
       'credited only by SECURITY DEFINER RPCs'),
      ('public.wallet_transactions',
       'tenant_id = church.my_tenant_id()',
       'none',
       'polled after a top-up'),
      ('public.tenants',
       'id IN (SELECT tenant_id FROM public.admin_profiles WHERE id = auth.uid())',
       'none',
       'workspace identity'),
      ('church.sms_queue',
       'tenant_id = church.my_tenant_id()',
       'dml',
       'its INSERT policy is what lets a broadcast queue at all'),
      ('church.sms_logs',
       'tenant_id = church.my_tenant_id()',
       'dml',
       'dispatch writes, history reads'),
      ('church.members',
       'church_id = church.my_tenant_id()',
       'dml',
       'recipient verification'),
      ('church.new_converts',
       'church_id = church.my_tenant_id()',
       'dml',
       'recipient verification'),
      ('church.churches',
       'id = church.my_tenant_id()',
       'none',
       'sender_id lookup before dispatch')
    ) AS t(table_name, tenant_pred, auth_write, why)
  LOOP
    IF to_regclass(r.table_name) IS NULL THEN
      RAISE WARNING '016: % does not exist here — skipped (%). Apply supabase-schema.sql if that is unexpected.',
        r.table_name, r.why;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.table_name);

    EXECUTE format('DROP POLICY IF EXISTS "churchos_tenant_select" ON %s', r.table_name);
    EXECUTE format(
      'CREATE POLICY "churchos_tenant_select" ON %s FOR SELECT TO authenticated USING (%s)',
      r.table_name, r.tenant_pred);

    IF r.auth_write = 'dml' THEN
      EXECUTE format('DROP POLICY IF EXISTS "churchos_tenant_write" ON %s', r.table_name);
      EXECUTE format(
        'CREATE POLICY "churchos_tenant_write" ON %s FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
        r.table_name, r.tenant_pred, r.tenant_pred);
    END IF;

    -- Server-side routes read these with the service-role key. With RLS on and no
    -- service_role policy, that read returns 0 rows and no error — the shape that
    -- produced both reported symptoms.
    EXECUTE format('DROP POLICY IF EXISTS "churchos_service_role" ON %s', r.table_name);
    EXECUTE format(
      'CREATE POLICY "churchos_service_role" ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)',
      r.table_name);

    v_repaired := v_repaired || CASE WHEN v_repaired = '' THEN '' ELSE ', ' END || r.table_name;
  END LOOP;

  RAISE NOTICE '016: policies ensured on: %', coalesce(nullif(v_repaired, ''), 'nothing');
END $$;

-- Table privileges are a separate gate from RLS: without GRANT the query fails
-- 42501 (visible, not silent). Additive only — nothing is revoked here.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE (n.nspname, c.relname) IN (
      ('public','admin_profiles'), ('public','wallets'), ('public','wallet_transactions'),
      ('public','tenants'), ('church','sms_queue'), ('church','sms_logs'),
      ('church','members'), ('church','new_converts'), ('church','churches')
    )
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE %s TO authenticated', r.table_name);
    EXECUTE format('GRANT ALL ON TABLE %s TO service_role', r.table_name);
  END LOOP;
END $$;

-- ── Verification: name the silent-empty tables instead of guessing ──────────
-- A table with RLS on and no SELECT policy for a role reads as empty forever.
-- After a clean run this must print the NOTICE, never the WARNING.
DO $$
DECLARE
  v_silent text;
  v_no_select text;
BEGIN
  SELECT string_agg(x.table_name::text, ', ' ORDER BY x.table_name::text)
    INTO v_silent
    FROM (
      SELECT DISTINCT c.oid::regclass AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname, c.relname) IN (
        ('public','admin_profiles'), ('public','wallets'), ('public','wallet_transactions'),
        ('public','tenants'), ('church','sms_queue'), ('church','sms_logs'),
        ('church','members'), ('church','new_converts'), ('church','churches'))
        AND c.relrowsecurity
        AND NOT EXISTS (
          SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid)
    ) x;

  SELECT string_agg(y.table_name::text || ' [' || y.missing || ']', ', ' ORDER BY y.table_name::text)
    INTO v_no_select
    FROM (
      SELECT c.oid::regclass AS table_name,
             trim(both '/' from
               concat_ws('/',
                 CASE WHEN NOT EXISTS (
                   SELECT 1 FROM pg_policy pol
                    WHERE pol.polrelid = c.oid AND pol.polcmd IN ('r','*')
                      AND (pol.polroles = ARRAY[0]::oid[]
                           OR EXISTS (SELECT 1 FROM pg_roles ro
                                       WHERE ro.oid = ANY(pol.polroles) AND ro.rolname = 'authenticated')))
                   THEN 'authenticated-select' ELSE '' END,
                 CASE WHEN NOT EXISTS (
                   SELECT 1 FROM pg_policy pol
                    WHERE pol.polrelid = c.oid AND pol.polcmd IN ('r','*')
                      AND (pol.polroles = ARRAY[0]::oid[]
                           OR EXISTS (SELECT 1 FROM pg_roles ro
                                       WHERE ro.oid = ANY(pol.polroles) AND ro.rolname = 'service_role')))
                   THEN 'service_role' ELSE '' END)) AS missing
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname, c.relname) IN (
        ('public','admin_profiles'), ('public','wallets'), ('public','wallet_transactions'),
        ('public','tenants'), ('church','sms_queue'), ('church','sms_logs'),
        ('church','members'), ('church','new_converts'), ('church','churches'))
        AND c.relrowsecurity
    ) y
    WHERE y.missing <> '';

  IF v_silent IS NOT NULL THEN
    RAISE WARNING '016: RLS is ON with NO policy at all on: %. Reads there return 0 rows with no error.', v_silent;
  END IF;
  IF v_no_select IS NOT NULL THEN
    RAISE WARNING '016: no SELECT policy for the listed role(s) on: %', v_no_select;
  END IF;
  IF v_silent IS NULL AND v_no_select IS NULL THEN
    RAISE NOTICE '016: verification clean — every table the SMS and wallet paths read has a SELECT policy for authenticated and for service_role.';
  END IF;
END $$;
