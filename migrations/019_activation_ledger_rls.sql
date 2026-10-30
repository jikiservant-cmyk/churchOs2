-- ============================================================================
-- 019 · PHASE A — activation ledger protection
-- Safe to run NOW, before or after the application deploy. Nothing in this file
-- removes a privilege anything currently uses.
--
-- Why: church.activation_payments is the real money record for activation and
-- top-ups. It has no CREATE TABLE in this repository (it was created outside the
-- migrations) and, as found in SECURITY_REVIEW-2026-10-30.md (P1-3), no policy
-- and possibly no RLS — which is the state in which any role holding a table
-- GRANT can read every church's payment history, or write rows that look like
-- settlements. The settlement RPC checks an amount against this ledger, so a
-- forgeable ledger is a forgeable activation.
--
-- This file only ADDS: row-level security plus an explicit service-role policy.
-- service_role keeps working (it bypasses RLS anyway, and the policy below keeps
-- it working even on a project where BYPASSRLS were revoked). Every other role
-- loses access to a table it has no legitimate reason to touch: the Next.js
-- server reads and writes it through the service-role connection
-- (lib/activation/index.ts getAdminClient), and so does the Na'jiki webhook
-- (getServiceDb). No browser code touches it.
--
-- Run it in the Supabase dashboard SQL editor, or with psql as a role that owns
-- the church schema.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Refuse to half-apply: the ledger must exist. If it does not, this project
--    was provisioned differently and an operator must look before anything else
--    runs. The DO block below prints what it found either way.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_ledger regclass := to_regclass('church.activation_payments');
BEGIN
  IF v_ledger IS NULL THEN
    RAISE NOTICE 'church.activation_payments does not exist in this database - skipping.';
    RAISE NOTICE 'Check the ledger name before running Phase B: SELECT table_schema, table_name FROM information_schema.tables WHERE table_name LIKE ''%%activation%%'' OR table_name LIKE ''%%payment%%'';';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS + give the service role an explicit policy.
--    Guarded by the same existence check so the file stays runnable on a
--    database that has not got the table.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('church.activation_payments') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE church.activation_payments ENABLE ROW LEVEL SECURITY';

  -- The ledger was created outside this repository's migrations, so the privileges
  -- the application holds on it are whatever whoever created it happened to run.
  -- Guarantee the service role's before RLS goes on: switching on security on a table
  -- the app cannot read would turn a working settlement flow into 'permission denied'.
  -- Additive only — nothing is revoked here.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON church.activation_payments TO service_role';

  -- FOR ALL for the service role, so the activation module and the webhook keep
  -- working even if BYPASSRLS is ever removed from that role. Insert-only would be
  -- tidier, but the settlement flow reads-then-writes and the retry-recovery path
  -- updates an existing row; both must not be the thing that breaks on a live church.
  EXECUTE 'DROP POLICY IF EXISTS "activation_payments service role" ON church.activation_payments';
  EXECUTE 'CREATE POLICY "activation_payments service role"
             ON church.activation_payments FOR ALL TO service_role
             USING (true) WITH CHECK (true)';

  -- Belt and braces: an explicit deny-by-omission note for anyone reading the
  -- dashboard. There is intentionally NO policy for anon or authenticated, so
  -- RLS refuses them. Do not add one to make a screen work — read the ledger
  -- through the server instead.
  RAISE NOTICE 'RLS enabled on church.activation_payments; service-role policy installed; anon/authenticated intentionally have none.';
  RAISE NOTICE 'If a read of the ledger ever returns nothing from a Next.js route, SUPABASE_SERVICE_ROLE_KEY is missing and createAdminClient() is running as the caller (see lib/supabase/service-client.ts).';
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Verification — read this output before you close the tab.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_relname text;
  v_rls boolean;
  v_policies integer;
BEGIN
  -- to_regclass(), not a ::regclass cast: the cast raises 'relation does not exist',
  -- which would turn this report block into a failed deployment on a project that
  -- has no ledger table at all.
  SELECT c.relname, c.relrowsecurity INTO v_relname, v_rls
    FROM pg_class c
   WHERE c.oid = to_regclass('church.activation_payments');
  IF v_relname IS NULL THEN
    RAISE NOTICE 'PHASE A NOT APPLIED: no ledger table to protect (see step 1).';
    RETURN;
  END IF;

  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'church' AND tablename = 'activation_payments';

  -- The check that matters for a live deployment: the application itself must still be
  -- able to reach the ledger, or Phase A has just broken activation instead of fixing it.
  IF NOT has_table_privilege('service_role', 'church.activation_payments', 'SELECT') THEN
    RAISE EXCEPTION 'PHASE A FAILED: service_role cannot SELECT church.activation_payments — grant it before enabling RLS';
  END IF;
  IF NOT has_table_privilege('service_role', 'church.activation_payments', 'INSERT') THEN
    RAISE EXCEPTION 'PHASE A FAILED: service_role cannot INSERT into church.activation_payments — the settlement write would fail';
  END IF;

  RAISE NOTICE 'VERIFY · table church.% · row-level security: % · policies: %', v_relname, v_rls, v_policies;
  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION 'PHASE A FAILED: RLS is still off on church.activation_payments';
  END IF;
  IF v_policies = 0 THEN
    RAISE EXCEPTION 'PHASE A FAILED: RLS is on but no policy exists - the service role would be the only writer and reads would return nothing';
  END IF;
END
$$;

COMMIT;

-- Who can still reach the ledger? Expect service_role only. Any anon/authenticated
-- row here is a table GRANT, not a policy: RLS still refuses them, so it is untidy
-- rather than unsafe, and worth a follow-up REVOKE when you next deploy.
SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE table_schema = 'church' AND table_name = 'activation_payments'
 GROUP BY grantee
 ORDER BY grantee;
