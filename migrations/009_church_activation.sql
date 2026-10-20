-- ============================================================================
-- Migration 009 — Church Activation Tables (payment gate DDL)
-- ============================================================================
--
-- The application's activation-payment flow (lib/activation, the
-- /api/church/activation/* routes, the admin layout gate) reads and writes:
--
--   * church.churches.activation_status      (active | pending_payment | suspended)
--   * church.churches.activation_paid_at
--   * church.activation_payments             (the activation ledger)
--
-- but NONE of those objects existed in the committed schema. On a fresh
-- deployment the entire payment gate was either crashing (insert into
-- church.activation_payments → relation does not exist) or, worse, failing
-- OPEN: getChurchBySlug() mapped a missing activation_status to 'active', so
-- every church skipped the one-time activation payment.
--
-- Migration 008 adds CHECK constraints and the append-only payment_events
-- audit log ON TOP of church.activation_payments, and VALIDATEs the
-- constraints unguarded — so on a FRESH database 008 fails until the tables
-- exist. Run this migration (009) BEFORE 008 on fresh databases; on existing
-- databases 009 is a no-op if 008 already ran.
--
-- Operational note (existing customers): rows that exist BEFORE this
-- migration operated without a payment gate, so they are grandfathered to
-- 'active'. Rows created AFTER this migration default to 'pending_payment'.
-- ============================================================================

-- 1. Activation columns on church.churches -----------------------------------
DO $$
DECLARE
  v_cut timestamptz := clock_timestamp();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'church' AND table_name = 'churches' AND column_name = 'activation_status'
  ) THEN
    ALTER TABLE church.churches
      ADD COLUMN activation_status text NOT NULL DEFAULT 'pending_payment'
      CHECK (activation_status IN ('active', 'pending_payment', 'suspended'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'church' AND table_name = 'churches' AND column_name = 'activation_paid_at'
  ) THEN
    ALTER TABLE church.churches
      ADD COLUMN activation_paid_at timestamptz;
  END IF;

  -- Grandfather rows that existed before the gate was introduced.
  UPDATE church.churches
     SET activation_status = 'active'
   WHERE activation_status = 'pending_payment'
     AND created_at IS NOT NULL
     AND created_at < v_cut;
END
$$;

CREATE INDEX IF NOT EXISTS churches_activation_status_idx
  ON church.churches (activation_status);

-- 2. The activation payment ledger -------------------------------------------
CREATE TABLE IF NOT EXISTS church.activation_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id uuid NOT NULL REFERENCES church.churches(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'UGX',
  provider text NOT NULL DEFAULT 'najiki',
  merchant_reference text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  initiated_by uuid,
  provider_transaction_id text,
  failure_reason text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS activation_payments_merchant_ref_uq
  ON church.activation_payments (merchant_reference);
CREATE INDEX IF NOT EXISTS activation_payments_church_id_idx
  ON church.activation_payments (church_id);
CREATE INDEX IF NOT EXISTS activation_payments_status_idx
  ON church.activation_payments (status);

ALTER TABLE church.activation_payments ENABLE ROW LEVEL SECURITY;

-- Service role only: the activation flow runs server-side with the
-- service key; no policy is granted to anon/authenticated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'activation_payments'
      AND schemaname = 'church'
      AND policyname = 'Service role full access on activation payments'
  ) THEN
    CREATE POLICY "Service role full access on activation payments"
    ON church.activation_payments
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END
$$;

-- Table grants: supabase-schema.sql's "GRANT ALL ON ALL TABLES IN SCHEMA
-- church" runs BEFORE this migration creates activation_payments, so it never
-- covers the new table. RLS policy alone is not enough — the role also needs
-- table-level privileges, or service-role reads fail with "permission denied".
GRANT SELECT, INSERT, UPDATE, DELETE ON church.activation_payments TO service_role;

-- 3. Re-apply the migration-008 guard constraints if they are missing --------
-- (008 ADDs them without an existence guard and VALIDATEs them unguarded; on
-- a database where 008 has not run, complete the job here so the activation
-- flow is safe even if 008 was skipped.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'church.activation_payments'::regclass
      AND conname = 'activation_payments_amount_positive_chk'
  ) THEN
    ALTER TABLE church.activation_payments
      ADD CONSTRAINT activation_payments_amount_positive_chk
      CHECK (amount > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'church.activation_payments'::regclass
      AND conname = 'activation_payments_merchant_ref_not_blank_chk'
  ) THEN
    ALTER TABLE church.activation_payments
      ADD CONSTRAINT activation_payments_merchant_ref_not_blank_chk
      CHECK (btrim(merchant_reference) <> '') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'church.activation_payments'::regclass
      AND conname = 'activation_payments_provider_not_blank_chk'
  ) THEN
    ALTER TABLE church.activation_payments
      ADD CONSTRAINT activation_payments_provider_not_blank_chk
      CHECK (btrim(provider) <> '') NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'church.activation_payments'::regclass
      AND conname = 'activation_payments_amount_positive_chk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE church.activation_payments
      VALIDATE CONSTRAINT activation_payments_amount_positive_chk;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'church.activation_payments'::regclass
      AND conname = 'activation_payments_merchant_ref_not_blank_chk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE church.activation_payments
      VALIDATE CONSTRAINT activation_payments_merchant_ref_not_blank_chk;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'church.activation_payments'::regclass
      AND conname = 'activation_payments_provider_not_blank_chk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE church.activation_payments
      VALIDATE CONSTRAINT activation_payments_provider_not_blank_chk;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS activation_payments_provider_txn_uq
  ON church.activation_payments (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
