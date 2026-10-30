-- ============================================================================
-- 020 · PHASE B — close the self-activation and passkey hole on church.churches
--
--   ⚠ RUN THIS ONLY AFTER THE APPLICATION CODE FROM THIS PR IS DEPLOYED. ⚠
--
-- It takes write access to church.churches away from ordinary church accounts.
-- Every legitimate write to that table — passkey rotation, meeting-day and
-- service-type saves, self-healing of a missing passkey hash, and first-run
-- provisioning — goes through createAdminClient(). Until the version of
-- createAdminClient() that really uses the service-role key is live, the
-- application itself is an `authenticated` caller for those writes (see P0-2 in
-- SECURITY_REVIEW-2026-10-30.md), so running this file first would lock
-- settings saves and passkey rotation out of working churches. The order is:
-- deploy, verify the service-role fallback warning is NOT in the runtime logs,
-- then run this.
--
-- What it does, and why each part is shaped the way it is:
--
--   1. Drops every tenant-capable write policy on church.churches — the shipped
--      "Admins can manage their associated church" FOR ALL and any repaired variant
--      under another name. That policy was scoped only by tenancy, so any signed-in
--      member could UPDATE (and where the GRANT allowed it, DELETE) their own church
--      row: activation_status, activation_paid_at, passkey, passkey_hash. Replaced by
--      SELECT-only, which every church page still needs. A policy that also names
--      service_role is left alone and step 4 aborts if one is what remains.
--
--   2. Installs a BEFORE UPDATE guard on the billing and credential columns. The
--      policy alone would be enough for PostgREST, but a trigger also covers any
--      other path that reaches the table with an authenticated JWT, and it fails
--      closed: a missing claim string is treated as a trusted server connection
--      (service role, Edge function, SQL editor), and current_setting() here
--      cannot be set by a client — PostgREST writes it from the verified token.
--
--   3. Narrows church.sms_logs to read-only for tenants, so a church cannot
--      delete its own delivery evidence after a failed blast. Its writers are the
--      webhook and the dispatch Edge function, both service-role.
--
-- Safe to run twice: everything is IF EXISTS / OR REPLACE / DROP-then-CREATE.
--
-- If it stops with 'PHASE B FAILED', nothing was committed — and run ROLLBACK; in
-- that same session before anything else, because the verification block raises
-- inside the transaction this file opens, which leaves it aborted.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. What is installed right now. Read this output; it is the before picture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd, roles::text AS roles
      FROM pg_policies
     WHERE schemaname = 'church' AND tablename IN ('churches', 'sms_logs')
     ORDER BY tablename, policyname
  LOOP
    RAISE NOTICE 'BEFORE · %.% : % % %', 'church', r.tablename, r.policyname, r.cmd, r.roles;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Tenants read their church row; they no longer write it.
-- ---------------------------------------------------------------------------
-- 1a. The named policy first, then anything else with the same effect. Projects were
--     patched by hand and by migrations/016 under different names over the months; the
--     old paste here dropped only the shipped name, which left a repaired project still
--     open while reporting success. A policy that also lists service_role is NOT touched:
--     dropping one of those would take the application's own access with it, and the
--     verification at step 4 refuses to commit while such a policy is what remains.
DO $$
DECLARE
  r record;
  v_dropped integer := 0;
BEGIN
  DROP POLICY IF EXISTS "Admins can manage their associated church" ON church.churches;

  FOR r IN
    SELECT policyname
      FROM pg_policies
     WHERE schemaname = 'church' AND tablename = 'churches'
       AND cmd IN ('ALL', 'UPDATE', 'INSERT', 'DELETE')
       AND (roles::text LIKE '%authenticated%' OR roles::text = '{public}')
       AND roles::text NOT LIKE '%service_role%'
     ORDER BY policyname
  LOOP
    EXECUTE format('DROP POLICY %I ON church.churches', r.policyname);
    RAISE NOTICE 'PHASE B · dropped tenant write policy % on church.churches', r.policyname;
    v_dropped := v_dropped + 1;
  END LOOP;

  IF v_dropped = 0 THEN
    RAISE NOTICE 'PHASE B · no tenant-only write policy was present on church.churches (already narrowed, or it names service_role too - see step 4).';
  END IF;
END
$$;

-- 1b. Read stays: every church page renders the name, slug, theme and activation state.
DROP POLICY IF EXISTS "Churches are readable by their own members" ON church.churches;

CREATE POLICY "Churches are readable by their own members"
  ON church.churches FOR SELECT TO authenticated
  USING (id = church.my_tenant_id());

-- The service role needs no policy of its own (it bypasses RLS), and one is not
-- added here on purpose: an explicit FOR ALL TO service_role policy already
-- ships in supabase-schema.sql and in the provisioning migration, so adding a
-- second would leave two policies granting the same privilege and make a future
-- "which policy is load-bearing?" question unanswerable from the dashboard.

-- ---------------------------------------------------------------------------
-- 2. Column guard. Column-tolerant by design: activation_status/activation_paid_at
--    arrive with 017 and the passkey columns with 011, and a trigger body that
--    names a missing column does not fail at CREATE time — it fails EVERY UPDATE
--    on the table at run time. So the comparison goes through to_jsonb and skips
--    any column this database does not have.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION church.guard_church_privileged_columns()
RETURNS TRIGGER AS $$
DECLARE
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role text := coalesce(v_claims ->> 'role', 'service_role');
  v_new jsonb;
  v_old jsonb;
  v_column text;
  v_protected text[] := ARRAY[
    'activation_status', 'activation_paid_at',
    'passkey', 'passkey_hash', 'passkey_version', 'passkey_updated_at',
    'is_active'
  ];
BEGIN
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  v_new := to_jsonb(NEW);
  v_old := to_jsonb(OLD);
  FOREACH v_column IN ARRAY v_protected LOOP
    IF v_new ? v_column AND (v_new -> v_column) IS DISTINCT FROM (v_old -> v_column) THEN
      RAISE EXCEPTION
        'church.churches: the billing and credential column % is written only by the application service role', v_column
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, church;

DROP TRIGGER IF EXISTS guard_church_privileged_columns ON church.churches;
CREATE TRIGGER guard_church_privileged_columns
  BEFORE UPDATE ON church.churches
  FOR EACH ROW EXECUTE FUNCTION church.guard_church_privileged_columns();

-- ---------------------------------------------------------------------------
-- 3. sms_logs: tenants read, the service role writes. Rebuilt from 016's shape
--    with FOR ALL -> SELECT for authenticated; the USING expression is unchanged,
--    so a church still sees exactly its own logs and nothing else.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('church.sms_logs') IS NULL THEN
    RAISE NOTICE 'church.sms_logs does not exist here - skipping the audit-trail step.';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'church' AND tablename = 'sms_logs'
       AND policyname = 'sms_logs_churchos_service_write'
  ) THEN
    RAISE NOTICE 'sms_logs_churchos_service_write not installed here (016 never ran) - skipping.';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "sms_logs_churchos_service_write" ON church.sms_logs;
  CREATE POLICY "sms_logs_churchos_service_write"
    ON church.sms_logs FOR SELECT TO authenticated
    USING (church_id = church.my_tenant_id());

  -- Anything else that still lets this role group write to the audit trail is reported,
  -- not deleted: unlike church.churches, an SMS write path the operator relies on and
  -- this file cannot see is a plausible thing to find here, and a delivery log that
  -- stops writing is a worse outcome than a delete that is still possible.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'church' AND tablename = 'sms_logs'
       AND cmd IN ('ALL', 'UPDATE', 'DELETE')
       AND roles::text LIKE '%authenticated%'
  ) THEN
    RAISE NOTICE 'PHASE B · church.sms_logs still has a tenant ALL/UPDATE/DELETE policy; review it by hand (P2-8).';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Verification — this file refuses to commit if the hardening did not land.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_all integer;
  v_select_only boolean;
  v_trigger integer;
BEGIN
  -- Matched as text on purpose. A policy created without a TO clause applies to
  -- PUBLIC — which includes authenticated and would otherwise hide here — and
  -- 'public'::regrole does not resolve, because PUBLIC is a pseudo-role: casting it
  -- aborts this whole migration on a database where the hardening worked.
  SELECT count(*) INTO v_all
    FROM pg_policies
   WHERE schemaname = 'church' AND tablename = 'churches'
     AND (roles::text LIKE '%authenticated%' OR roles::text = '{public}')
     AND cmd IN ('ALL', 'UPDATE', 'INSERT', 'DELETE');

  SELECT count(*) = 0 INTO v_select_only
    FROM pg_policies
   WHERE schemaname = 'church' AND tablename = 'churches'
     AND (roles::text LIKE '%authenticated%' OR roles::text = '{public}')
     AND cmd IN ('ALL', 'UPDATE', 'INSERT', 'DELETE');

  IF NOT v_select_only THEN
    RAISE EXCEPTION
      'PHASE B FAILED: % tenant-capable write polic(y|ies) still exist on church.churches. They name service_role as well, so this file will not drop them blindly: create a separate FOR ALL TO service_role policy, narrow the mixed one to SELECT, and re-run 020.',
      v_all;
  END IF;

  SELECT count(*) INTO v_trigger
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'church' AND c.relname = 'churches'
     AND t.tgname = 'guard_church_privileged_columns' AND NOT t.tgisinternal;

  IF v_trigger <> 1 THEN
    RAISE EXCEPTION 'PHASE B FAILED: the column guard trigger is not installed (found %)', v_trigger;
  END IF;

  RAISE NOTICE 'PHASE B OK · church.churches is SELECT-only for authenticated · column guard trigger active';
END
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd, roles::text AS roles
      FROM pg_policies
     WHERE schemaname = 'church' AND tablename IN ('churches', 'sms_logs')
     ORDER BY tablename, policyname
  LOOP
    RAISE NOTICE 'AFTER · %.% : % % %', 'church', r.tablename, r.policyname, r.cmd, r.roles;
  END LOOP;
END
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- 5. After you run this, prove it on a live church (see the handover notes):
--    a) in a signed-in browser, one PATCH to /rest/v1/churches?id=eq.<uuid> with
--       {"activation_status":"active"} must now fail (it used to return 204);
--    b) rotating a passkey in Settings and saving meeting days must still work —
--       those are the service-role paths, and if they fail, the code from this
--       PR is not the version that is deployed;
--    c) a new church must still provision end to end.
-- ---------------------------------------------------------------------------
