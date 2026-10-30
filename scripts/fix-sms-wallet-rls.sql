-- ============================================================================
-- ChurchOS — one-shot repair for "balance shows 0" + "only pastors or
-- administrators can enqueue broadcasts".
--
-- Paste this whole file into the Supabase SQL editor and run it once. It is
-- idempotent: running it twice is harmless and reports the same result.
--
-- It is the verbatim concatenation of the two committed migrations, in order,
-- followed by read-only verification queries so you can SEE the state:
--
--   migrations/015_missing_schema_columns.sql  columns CREATE TABLE never added
--   migrations/016_rls_policy_repair.sql       RLS policies the app depends on
--
-- Both failure modes produce the same symptom shape — a read that returns zero
-- rows with no error — which is why they are shipped as one script. The rest of
-- the file after these markers is copied, not hand-edited: tests/sql/
-- combined_fix_script.test.mjs fails if the two migrations and this script ever
-- disagree, so this paste cannot drift away from what is in the repository.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- PART 1 — migrations/015_missing_schema_columns.sql
-- ────────────────────────────────────────────────────────────────────────────

-- 015: add the columns supabase-schema.sql only ever declared inside CREATE TABLE.
--
-- Why this exists. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
-- already exists, so a database whose public.wallets / public.admin_profiles
-- predate those columns never receives them, and re-applying the schema file
-- cannot fix it — it silently skips both tables. `full_name`, `ip_address` and
-- `wallets.id` each got an explicit ALTER; `admin_profiles.app_type`,
-- `wallets.sms_rate`, `wallets.app_type` and `wallets.last_updated` did not.
--
-- The failure it repairs. A read that projects a nonexistent column returns
-- 42703, which Supabase hands back as `data: null` plus an `error` — and every
-- caller in this app treats "no rows" as a verdict:
--
--   * POST /api/sms/enqueue selected `tenant_id, role, app_type` from
--     admin_profiles and answered the error with
--     "Access denied: only pastors or administrators can enqueue broadcasts",
--     to a caller who *is* the pastor. `app_type` was never used by the guard.
--   * the messages page and GET /api/church/wallet/status selected
--     `balance, sms_rate, tenant_id` from wallets and rendered a funded wallet
--     as `0 SMS remaining`.
--   * the settle RPCs write `last_updated`, so a top-up callback could also die
--     mid-settlement on the same class of gap.
--
-- The admin layout selects only `role, tenant_id`, so it kept passing — which is
-- exactly why the portal opened, showed a zero, and then denied the send.
--
-- Safe to re-run. Nothing here rewrites rows: every statement is
-- ADD COLUMN IF NOT EXISTS with a default, and the default is the value the app
-- already assumes for a fresh wallet (sms_rate 70, app_type 'church').

-- ── Guard ───────────────────────────────────────────────────────────────────
-- `balance` is the ledger. If it is somehow absent, creating it defaulted to 0
-- would make every real balance look intentionally zero, which is the bug this
-- migration exists to remove. Refuse instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'wallets'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'wallets' AND column_name = 'balance'
  ) THEN
    RAISE EXCEPTION
      'public.wallets.balance is missing. Refusing to add it with a 0 default: that would '
      'present an unreadable ledger as an intentionally empty one. Restore the column, then re-run.';
  END IF;
END $$;

-- ── admin_profiles ──────────────────────────────────────────────────────────
-- Nullable, matching `app_type text DEFAULT 'church'` in the table definition.
-- Existing rows gain the default, which is what every reader already assumed.
ALTER TABLE public.admin_profiles
  ADD COLUMN IF NOT EXISTS app_type text DEFAULT 'church';

-- ── wallets ─────────────────────────────────────────────────────────────────
-- `sms_rate` is declared NOT NULL DEFAULT 70 in the table definition; the same
-- default is applied to pre-existing rows so no church's derived SMS count moves.
-- `app_type` is NOT NULL with no default in the definition — that shape cannot
-- be applied to a populated table, so it is created WITH the default. The column
-- is written as 'church' by public.initialize_tenant_wallet() either way.
ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS sms_rate integer NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS app_type text NOT NULL DEFAULT 'church',
  ADD COLUMN IF NOT EXISTS last_updated timestamptz DEFAULT now();

-- Backfill only rows that predate `last_updated`; never overwrite a real value.
UPDATE public.wallets SET last_updated = now() WHERE last_updated IS NULL;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expected: `missing_columns` returns zero rows, and every wallet has a
-- sms_rate > 0 so `Math.floor(balance / sms_rate)` cannot produce Infinity.
DO $$
DECLARE
  v_missing text;
  v_bad_rate integer;
BEGIN
  SELECT string_agg(need.table_name || '.' || need.column_name, ', ' ORDER BY need.table_name, need.column_name)
    INTO v_missing
    FROM (
      VALUES
        ('admin_profiles', 'app_type'),
        ('wallets', 'sms_rate'),
        ('wallets', 'app_type'),
        ('wallets', 'last_updated')
    ) AS need(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = need.table_name
        AND c.column_name = need.column_name
   );

  IF v_missing IS NULL THEN
    RAISE NOTICE '015: all four columns present.';
  ELSE
    RAISE EXCEPTION '015: still missing: %', v_missing;
  END IF;

  SELECT count(*) INTO v_bad_rate FROM public.wallets WHERE sms_rate IS NULL OR sms_rate <= 0;
  IF v_bad_rate > 0 THEN
    RAISE WARNING '015: % wallet(s) have a non-positive sms_rate; the UI divides by it', v_bad_rate;
  END IF;

  RAISE NOTICE '015: wallets=% , rates used=%',
    (SELECT count(*) FROM public.wallets),
    (SELECT coalesce(string_agg(distinct sms_rate::text, '/'),'none') FROM public.wallets);
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- PART 2 — migrations/016_rls_policy_repair.sql
-- ────────────────────────────────────────────────────────────────────────────

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


-- ────────────────────────────────────────────────────────────────────────────
-- PART 3 — verification (read-only). Expected output is spelled out below each
-- query; if anything reads "FAIL", post the row here and it can be diagnosed.
-- ────────────────────────────────────────────────────────────────────────────

-- 3.1 Column inventory. EXPECT: every row says 'present'. Any 'MISSING (run
-- failed)' means part 1 of this script did not apply — usually because the table
-- lives under a different schema in that project.
select need.table_name, need.column_name,
       case when ic.column_name is null then 'MISSING (run failed)' else 'present' end as state
from (values
  ('wallets','balance'), ('wallets','tenant_id'), ('wallets','sms_rate'),
  ('wallets','app_type'), ('wallets','last_updated'),
  ('admin_profiles','tenant_id'), ('admin_profiles','role'), ('admin_profiles','app_type')
) as need(table_name, column_name)
left join information_schema.columns ic
  on  ic.table_schema = 'public'
  and ic.table_name   = need.table_name
  and ic.column_name  = need.column_name
order by 1, 2;

-- 3.2 RLS coverage. EXPECT: rls_on may be t or f, but whenever rls_on = t then
-- policies_total > 0, select_for_authenticated = t and select_for_service_role = t.
-- Anything with rls_on = t and policies_total = 0 is a table that reads as
-- permanently empty — the exact fault behind both symptoms.
select
  c.oid::regclass                                        as table_name,
  c.relrowsecurity                                       as rls_on,
  count(pol.polname)                                     as policies_total,
  count(*) filter (where pol.polname like 'churchos_%')   as created_by_this_script,
  bool_or(pol.polcmd in ('r','*') and (pol.polroles = array[0]::oid[]
        or exists (select 1 from pg_roles r where r.oid = any (pol.polroles)
                                            and r.rolname = 'authenticated'))) as select_for_authenticated,
  bool_or(pol.polcmd in ('r','*') and (pol.polroles = array[0]::oid[]
        or exists (select 1 from pg_roles r where r.oid = any (pol.polroles)
                                            and r.rolname = 'service_role')))  as select_for_service_role
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy pol on pol.polrelid = c.oid
where (n.nspname, c.relname) in (
  ('public','admin_profiles'), ('public','wallets'), ('public','wallet_transactions'),
  ('public','tenants'), ('church','sms_queue'), ('church','sms_logs'),
  ('church','members'), ('church','new_converts'), ('church','churches'))
group by c.oid, c.relname, n.nspname, c.relrowsecurity
order by c.oid::regclass::text;

-- 3.3 The verdict, in one row. EXPECT: everything_ok = t.
-- If needs_attention lists table names, part 2 did not reach them (usually the
-- schema/church objects live under a different name in that project).
with checked as (
  select c.oid::regclass::text as table_name, c.relrowsecurity as rls_on,
         count(pol.polname) as policies
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policy pol on pol.polrelid = c.oid
  where (n.nspname, c.relname) in (
    ('public','admin_profiles'), ('public','wallets'), ('public','wallet_transactions'),
    ('public','tenants'), ('church','sms_queue'), ('church','sms_logs'),
    ('church','members'), ('church','new_converts'), ('church','churches'))
  group by c.oid, c.relname, n.nspname, c.relrowsecurity
),
missing_columns as (
  select count(*) as n from (
    values ('public','wallets','sms_rate'), ('public','wallets','app_type'),
           ('public','wallets','last_updated'), ('public','admin_profiles','app_type')
  ) need(schema, tbl, col)
  where not exists (
    select 1 from information_schema.columns ic
     where ic.table_schema = need.schema and ic.table_name = need.tbl
       and ic.column_name = need.col)
)
select
  (select n = 0 from missing_columns)                       as columns_ok,
  coalesce((select string_agg(table_name, ', ' order by table_name)
              from checked where rls_on and policies = 0), '') as silent_empty_tables,
  (select n from missing_columns)                          as still_missing_columns,
  (select n = 0 from missing_columns)
    and not exists (select 1 from checked where rls_on and policies = 0) as everything_ok;

-- 3.4 Your wallets, as the app now reads them. EXPECT: the same balance you can
-- see in the Table Editor, and remaining_sms > 0 for a funded church.
select
  w.tenant_id,
  t.name                                                   as church,
  w.balance                                                as ugx,
  w.sms_rate,
  floor(w.balance / nullif(w.sms_rate, 0))::int            as remaining_sms
from public.wallets w
left join public.tenants t on t.id = w.tenant_id
order by w.balance desc
limit 20;
