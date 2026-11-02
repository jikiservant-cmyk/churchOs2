-- ============================================================================
-- 017 — the activation billing state, declared in the database at last
-- ============================================================================
-- WHY THIS EXISTS
-- `church.churches.activation_status` and `activation_paid_at` are read by
-- app/c/[church_slug]/admin/(authenticated)/layout.tsx (the gate that decides
-- whether an unpaid church sees the dashboard or the payment screen), by
-- app/c/[church_slug]/admin/activation/page.tsx, by lib/activation/index.ts and
-- by migrations/008's settlement RPC — and NOTHING in this repository ever
-- created them. supabase-schema.sql does not declare either column, and
-- provision_church_v2 never writes one. So on any database where the column is
-- absent or unfilled, the value is NULL, and `getChurchBySlug` used to report
-- NULL as 'active'. Result: an unpaid church could reach the whole workspace,
-- and the activation screen it should have been held on redirected it away.
--
-- WHAT THIS DOES
--   1. adds the two columns if they are missing (no-op where they exist)
--   2. gives new churches `activation_status = 'pending_payment'` by DEFAULT,
--      but only if the column has no default today — so a church created by any
--      path, including a direct insert, starts unpaid instead of free
--   3. constrains the domain to the three states the app can act on, WITHOUT
--      validating existing rows, so a legacy surprise value can never make this
--      migration fail and block the deploy
--   4. adds the partial index the gate and the audit query both want
--   5. reports what it found, and what it deliberately left alone
--
-- WHAT THIS DOES NOT DO
-- It never changes an existing church's status. No row is updated, no church is
-- newly locked out. Grandfathered congregations stay grandfathered until a human
-- decides otherwise — see scripts/activation-gate-audit.sql for the list and the
-- ACTIVATION_GATE_LEGACY_NULL switch that tightens the rule.
--
-- Idempotent: re-run it as many times as you like.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('church.churches') IS NULL THEN
    RAISE EXCEPTION 'church.churches does not exist. Apply supabase-schema.sql first — this migration only adds the billing-state columns to it.'
      USING HINT = 'Nothing was changed.';
  END IF;
END
$$;

ALTER TABLE church.churches ADD COLUMN IF NOT EXISTS activation_status text;
ALTER TABLE church.churches ADD COLUMN IF NOT EXISTS activation_paid_at timestamptz;

COMMENT ON COLUMN church.churches.activation_status IS
  'Billing gate. pending_payment = the workspace is locked behind the activation screen; active = settled; suspended = blocked deliberately (paying does not clear it — see migrations/008). NULL means this row predates the column: lib/activation-gate.ts decides, and the default policy grandfathers it.';
COMMENT ON COLUMN church.churches.activation_paid_at IS
  'Set once by activate_church_workspace_v2 when a signed Na''jiki settlement matches the ledger row. A NULL status carrying this timestamp is treated as paid.';

-- 1. Default, only when none exists. Overwriting a default someone chose on a
--    live database would silently change every future insert.
DO $$
DECLARE
  v_default text;
BEGIN
  SELECT column_default INTO v_default
  FROM information_schema.columns
  WHERE table_schema = 'church' AND table_name = 'churches' AND column_name = 'activation_status';

  IF v_default IS NULL THEN
    ALTER TABLE church.churches ALTER COLUMN activation_status SET DEFAULT 'pending_payment';
    RAISE NOTICE '017: activation_status now defaults to pending_payment — a new church cannot enter the workspace before paying.';
  ELSE
    RAISE NOTICE '017: activation_status already defaults to %; left alone.', v_default;
  END IF;
END
$$;

-- 2. Domain check, NOT VALID. The name is checked because Postgres has no
--    "ADD CONSTRAINT IF NOT EXISTS".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'churches_activation_status_known') THEN
    ALTER TABLE church.churches
      ADD CONSTRAINT churches_activation_status_known
      CHECK (activation_status IS NULL OR activation_status IN ('pending_payment', 'active', 'suspended'))
      NOT VALID;
    RAISE NOTICE '017: added churches_activation_status_known (NOT VALID).';
  ELSE
    RAISE NOTICE '017: churches_activation_status_known already exists.';
  END IF;
END
$$;

DO $$
DECLARE
  v_unexpected integer;
BEGIN
  SELECT count(*) INTO v_unexpected
  FROM church.churches
  WHERE activation_status IS NOT NULL
    AND btrim(activation_status) <> ''
    AND activation_status NOT IN ('pending_payment', 'active', 'suspended');

  IF v_unexpected = 0 THEN
    ALTER TABLE church.churches VALIDATE CONSTRAINT churches_activation_status_known;
    RAISE NOTICE '017: every existing row is inside the domain; constraint validated.';
  ELSE
    RAISE NOTICE '017: % church(es) carry an unexpected activation_status. The constraint stays NOT VALID so this migration cannot fail on them; the gate still routes them to the payment screen. Run scripts/activation-gate-audit.sql to list them.', v_unexpected;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS churches_activation_unpaid_idx
  ON church.churches (slug)
  WHERE activation_status IS DISTINCT FROM 'active';

-- 3. Self-check, in the shape the app reads it.
SELECT
  (SELECT count(*) FROM church.churches)                                              AS churches_total,
  (SELECT count(*) FROM church.churches WHERE activation_status = 'active')          AS settled,
  (SELECT count(*) FROM church.churches WHERE activation_status = 'pending_payment') AS awaiting_payment,
  (SELECT count(*) FROM church.churches WHERE activation_status = 'suspended')       AS suspended,
  (SELECT count(*) FROM church.churches
    WHERE activation_status IS NULL OR btrim(activation_status) = '')                 AS grandfathered_null,
  (SELECT column_default IS NOT NULL FROM information_schema.columns
    WHERE table_schema = 'church' AND table_name = 'churches'
      AND column_name = 'activation_status')                                          AS default_is_set
;

COMMIT;
