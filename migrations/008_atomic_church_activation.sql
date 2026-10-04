-- ============================================================================
-- Migration 008 — Atomic Church Activation Transaction RPC (v2)
-- ============================================================================

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
END;
$$;

ALTER TABLE church.activation_payments
  VALIDATE CONSTRAINT activation_payments_amount_positive_chk;
ALTER TABLE church.activation_payments
  VALIDATE CONSTRAINT activation_payments_merchant_ref_not_blank_chk;
ALTER TABLE church.activation_payments
  VALIDATE CONSTRAINT activation_payments_provider_not_blank_chk;

-- Retain provider transaction uniqueness, including when this migration is rerun.
CREATE UNIQUE INDEX IF NOT EXISTS activation_payments_provider_txn_uq
  ON church.activation_payments (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

-- Append-only audit log. provider is nullable to accommodate rows created by
-- an earlier draft of this migration.
CREATE TABLE IF NOT EXISTS church.payment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id uuid,
  merchant_reference text NOT NULL,
  provider text,
  provider_status text,
  provider_transaction_id text,
  paid_amount numeric(14,2),
  currency text,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE church.payment_events
  ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE church.payment_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS payment_events_payment_id_idx
  ON church.payment_events (payment_id);
CREATE INDEX IF NOT EXISTS payment_events_merchant_reference_idx
  ON church.payment_events (merchant_reference);
CREATE INDEX IF NOT EXISTS payment_events_created_at_idx
  ON church.payment_events (created_at);

CREATE OR REPLACE FUNCTION church.payment_events_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'church.payment_events is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS payment_events_no_update_delete ON church.payment_events;
CREATE TRIGGER payment_events_no_update_delete
  BEFORE UPDATE OR DELETE ON church.payment_events
  FOR EACH ROW EXECUTE FUNCTION church.payment_events_block_mutation();

DROP TRIGGER IF EXISTS payment_events_no_truncate ON church.payment_events;
CREATE TRIGGER payment_events_no_truncate
  BEFORE TRUNCATE ON church.payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION church.payment_events_block_mutation();

REVOKE ALL ON church.payment_events FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA church TO service_role;
GRANT SELECT ON church.payment_events TO service_role;
REVOKE ALL ON FUNCTION church.payment_events_block_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION church._log_payment_event_v2(
  p_payment_id uuid,
  p_ref text,
  p_provider text,
  p_status text,
  p_txn text,
  p_amount numeric,
  p_currency text,
  p_outcome text
)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, church, pg_temp
AS $$
  INSERT INTO church.payment_events
    (payment_id, merchant_reference, provider, provider_status,
     provider_transaction_id, paid_amount, currency, outcome)
  VALUES
    (p_payment_id, p_ref, p_provider, p_status,
     p_txn, p_amount, p_currency, p_outcome);
$$;

REVOKE ALL ON FUNCTION church._log_payment_event_v2(
  uuid, text, text, text, text, numeric, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION church.activate_church_workspace_v2(
  p_merchant_reference text,
  p_provider text,
  p_provider_transaction_id text,
  p_paid_amount numeric,
  p_currency text,
  p_provider_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, church, pg_temp
AS $$
DECLARE
  v_payment church.activation_payments%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_ref text := nullif(btrim(p_merchant_reference), '');
  v_provider text := nullif(btrim(p_provider), '');
  v_status text := upper(nullif(btrim(p_provider_status), ''));
  v_currency text := upper(nullif(btrim(p_currency), ''));
  v_txn text := nullif(btrim(p_provider_transaction_id), '');
  v_new_payment_status text;
  v_church_status text;
  c_success constant text[] := ARRAY['SUCCESS', 'COMPLETED', 'PAID', 'CONFIRMED'];
  c_pending constant text[] := ARRAY['PENDING', 'PROCESSING', 'INITIATED', 'IN_PROGRESS'];
  c_cancelled constant text[] := ARRAY['CANCELLED', 'CANCELED'];
  c_failed constant text[] := ARRAY['FAILED', 'FAILURE', 'DECLINED', 'EXPIRED', 'REJECTED'];
BEGIN
  IF v_ref IS NULL OR v_provider IS NULL OR v_status IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PARAMETER',
      'error', 'Merchant reference, provider, and provider status are required'
    );
  END IF;

  SELECT * INTO v_payment
  FROM church.activation_payments
  WHERE merchant_reference = v_ref
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM church._log_payment_event_v2(
      NULL, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'not_found'
    );
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Payment record not found');
  END IF;

  -- The provider must match the provider recorded when this attempt was created.
  IF btrim(v_payment.provider) IS DISTINCT FROM v_provider THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'provider_mismatch'
    );
    RETURN jsonb_build_object('success', false, 'code', 'PROVIDER_MISMATCH', 'error', 'Provider does not match payment record');
  END IF;

  -- A transaction ID already attached to this payment may never be replaced.
  IF v_txn IS NOT NULL
     AND v_payment.provider_transaction_id IS NOT NULL
     AND v_payment.provider_transaction_id IS DISTINCT FROM v_txn THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'txn_id_conflict'
    );
    RETURN jsonb_build_object('success', false, 'code', 'TRANSACTION_ID_CONFLICT', 'error', 'Provider transaction ID conflict');
  END IF;

  -- Fast conflict check; the unique index below remains the race-safe enforcement.
  IF v_txn IS NOT NULL AND EXISTS (
    SELECT 1
    FROM church.activation_payments other_payment
    WHERE other_payment.provider = v_payment.provider
      AND other_payment.provider_transaction_id = v_txn
      AND other_payment.id <> v_payment.id
  ) THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'txn_id_conflict'
    );
    RETURN jsonb_build_object('success', false, 'code', 'TRANSACTION_ID_CONFLICT', 'error', 'Transaction ID is already used by another payment');
  END IF;

  -- Do not let stale failure/pending callbacks downgrade a paid payment.
  -- A duplicate success must still match provider, transaction, amount, and currency.
  IF v_payment.status = 'paid' THEN
    IF NOT (v_status = ANY (c_success)) THEN
      PERFORM church._log_payment_event_v2(
        v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'stale_after_paid'
      );
      RETURN jsonb_build_object('success', true, 'already_processed', true, 'activated', true);
    END IF;

    IF v_txn IS NULL THEN
      PERFORM church._log_payment_event_v2(
        v_payment.id, v_ref, v_provider, v_status, NULL, p_paid_amount, v_currency, 'missing_txn_id'
      );
      RETURN jsonb_build_object('success', false, 'code', 'MISSING_TRANSACTION_ID');
    END IF;

    IF p_paid_amount IS NULL
       OR p_paid_amount <= 0
       OR p_paid_amount <> trunc(p_paid_amount)
       OR p_paid_amount IS DISTINCT FROM v_payment.amount::numeric
       OR v_currency IS DISTINCT FROM v_payment.currency THEN
      PERFORM church._log_payment_event_v2(
        v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'duplicate_mismatch'
      );
      RETURN jsonb_build_object('success', false, 'code', 'PAYMENT_MISMATCH', 'error', 'Duplicate callback does not match recorded payment');
    END IF;

    -- Allow a verified duplicate to fill a transaction ID on a legacy paid row
    -- that predates transaction-ID enforcement.
    IF v_payment.provider_transaction_id IS NULL THEN
      BEGIN
        UPDATE church.activation_payments
        SET provider_transaction_id = v_txn
        WHERE id = v_payment.id;
      EXCEPTION WHEN unique_violation THEN
        PERFORM church._log_payment_event_v2(
          v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'txn_id_conflict'
        );
        RETURN jsonb_build_object('success', false, 'code', 'TRANSACTION_ID_CONFLICT');
      END;
    END IF;

    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'duplicate_ignored'
    );
    SELECT activation_status INTO v_church_status
    FROM church.churches WHERE id = v_payment.church_id;
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'activated', v_church_status = 'active',
      'church_id', v_payment.church_id,
      'verified_at', v_payment.verified_at
    );
  END IF;

  IF v_payment.status NOT IN ('pending', 'failed') THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'invalid_state'
    );
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_STATE', 'error', 'Payment is not eligible for activation');
  END IF;

  IF v_status = ANY (c_pending) THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'provider_pending'
    );
    RETURN jsonb_build_object('success', false, 'code', 'PROVIDER_PENDING', 'error', 'Payment is still pending');
  END IF;

  IF v_status = ANY (c_failed) OR v_status = ANY (c_cancelled) THEN
    IF v_payment.status = 'failed' THEN
      PERFORM church._log_payment_event_v2(
        v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'duplicate_failure'
      );
      RETURN jsonb_build_object('success', false, 'code', 'PROVIDER_FAILED', 'error', 'Payment attempt has already failed');
    END IF;

    v_new_payment_status := CASE
      WHEN v_status = ANY (c_cancelled) THEN 'cancelled'
      ELSE 'failed'
    END;

    BEGIN
      UPDATE church.activation_payments
      SET status = v_new_payment_status,
          failure_reason = 'Provider reported status: ' || v_status,
          provider_transaction_id = COALESCE(provider_transaction_id, v_txn)
      WHERE id = v_payment.id;
    EXCEPTION WHEN unique_violation THEN
      PERFORM church._log_payment_event_v2(
        v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'txn_id_conflict'
      );
      RETURN jsonb_build_object('success', false, 'code', 'TRANSACTION_ID_CONFLICT');
    END;

    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, v_new_payment_status
    );
    RETURN jsonb_build_object('success', false, 'code', upper(v_new_payment_status), 'error', 'Provider reported a non-success status');
  END IF;

  IF NOT (v_status = ANY (c_success)) THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'unknown_status'
    );
    RETURN jsonb_build_object('success', false, 'code', 'UNKNOWN_PROVIDER_STATUS', 'error', 'No state change was made');
  END IF;

  -- Success callbacks require a transaction ID and exact whole-UGX amount/currency match.
  IF v_txn IS NULL THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, NULL, p_paid_amount, v_currency, 'missing_txn_id'
    );
    RETURN jsonb_build_object('success', false, 'code', 'MISSING_TRANSACTION_ID');
  END IF;

  IF p_paid_amount IS NULL
     OR p_paid_amount <= 0
     OR p_paid_amount <> trunc(p_paid_amount)
     OR v_currency IS NULL THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'invalid_payment_data'
    );
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_PAYMENT_DATA');
  END IF;

  IF p_paid_amount IS DISTINCT FROM v_payment.amount::numeric
     OR v_currency IS DISTINCT FROM v_payment.currency THEN
    -- Leave the row pending/failed so a correct provider confirmation can still reconcile it.
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'amount_currency_mismatch'
    );
    RETURN jsonb_build_object('success', false, 'code', 'PAYMENT_MISMATCH', 'error', 'Amount or currency does not match payment record');
  END IF;

  -- A failed row with a recorded transaction can only recover using that same ID.
  -- If no ID was ever recorded, the verified success may bind the first one.
  BEGIN
    UPDATE church.activation_payments
    SET status = 'paid',
        verified_at = v_now,
        failure_reason = NULL,
        provider_transaction_id = COALESCE(provider_transaction_id, v_txn)
    WHERE id = v_payment.id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM church._log_payment_event_v2(
      v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency, 'txn_id_conflict'
    );
    RETURN jsonb_build_object('success', false, 'code', 'TRANSACTION_ID_CONFLICT', 'error', 'Transaction ID is already used by another payment');
  END;

  -- A successful payment does not automatically unsuspend a church.
  UPDATE church.churches
  SET activation_status = CASE
        WHEN activation_status = 'pending_payment' THEN 'active'
        ELSE activation_status
      END,
      activation_paid_at = CASE
        WHEN activation_status IN ('pending_payment', 'active')
          THEN COALESCE(activation_paid_at, v_now)
        ELSE activation_paid_at
      END
  WHERE id = v_payment.church_id
  RETURNING activation_status INTO v_church_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Church % not found for payment %', v_payment.church_id, v_payment.id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM church._log_payment_event_v2(
    v_payment.id, v_ref, v_provider, v_status, v_txn, p_paid_amount, v_currency,
    CASE WHEN v_church_status = 'active' THEN 'activated' ELSE 'paid_suspended' END
  );

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'activated', v_church_status = 'active',
    'church_id', v_payment.church_id,
    'merchant_reference', v_ref,
    'verified_at', v_now,
    'message', CASE
      WHEN v_church_status = 'active' THEN 'Payment verified and church activated'
      ELSE 'Payment verified; church remains suspended'
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_church_workspace_v2(
  p_merchant_reference text,
  p_provider text,
  p_provider_transaction_id text,
  p_paid_amount numeric,
  p_currency text,
  p_provider_status text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT church.activate_church_workspace_v2(
    p_merchant_reference,
    p_provider,
    p_provider_transaction_id,
    p_paid_amount,
    p_currency,
    p_provider_status
  );
$$;

REVOKE ALL ON FUNCTION church.activate_church_workspace_v2(text, text, text, numeric, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.activate_church_workspace_v2(text, text, text, numeric, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.activate_church_workspace_v2(text, text, text, numeric, text, text)
  TO service_role;

-- Disable the earlier RPC path if it exists; backend callers must migrate to v2.
DO $$
BEGIN
  IF to_regprocedure('public.activate_church_workspace_v1(text,text,numeric,text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.activate_church_workspace_v1(text, text, numeric, text, text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('church.activate_church_workspace_v1(text,text,numeric,text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION church.activate_church_workspace_v1(text, text, numeric, text, text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$$;
