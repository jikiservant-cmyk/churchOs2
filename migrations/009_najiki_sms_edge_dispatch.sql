-- ChurchOS Na'jiki SMS Edge dispatch queue.
-- Apply after the base church.sms_queue, church.sms_logs, public.wallets and
-- public.wallet_transactions tables exist. This migration does not call an SMS
-- provider; only the Edge Function dispatches through Na'jiki.

ALTER TABLE church.sms_queue
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS lock_token uuid,
  ADD COLUMN IF NOT EXISTS najiki_sms_id text,
  ADD COLUMN IF NOT EXISTS najiki_reference text;

ALTER TABLE church.sms_logs
  ADD COLUMN IF NOT EXISTS najiki_sms_id text,
  ADD COLUMN IF NOT EXISTS najiki_reference text;

-- Preserve old queued jobs: give rows without a key a stable queue-ID-based key.
UPDATE church.sms_queue
   SET idempotency_key = 'churchos_' || id::text
 WHERE idempotency_key IS NULL
    OR length(btrim(idempotency_key)) < 8
    OR length(btrim(idempotency_key)) > 255;

-- The corrected queue contract uses lowercase states throughout its RPCs.
-- Normalize historical uppercase rows before workers scan or claim them.
UPDATE church.sms_queue
   SET status = lower(status)
 WHERE lower(status) IN ('pending', 'processing', 'sent', 'failed', 'cancelled')
   AND status <> lower(status);

CREATE INDEX IF NOT EXISTS sms_queue_due_pending_idx
  ON church.sms_queue (scheduled_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS sms_queue_expired_lease_idx
  ON church.sms_queue (locked_until, created_at)
  WHERE status = 'processing';

CREATE UNIQUE INDEX IF NOT EXISTS sms_logs_najiki_sms_id_uidx
  ON church.sms_logs (najiki_sms_id)
  WHERE najiki_sms_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sms_logs_najiki_reference_uidx
  ON church.sms_logs (najiki_reference)
  WHERE najiki_reference IS NOT NULL;

COMMENT ON COLUMN church.sms_queue.locked_until IS
  'Lease expiry for a single-row Edge Function claim; expired processing rows can be safely reclaimed.';
COMMENT ON COLUMN church.sms_queue.lock_token IS
  'Fencing token for the current Edge Function lease; stale workers cannot finalize a reclaimed row.';
COMMENT ON COLUMN church.sms_queue.najiki_sms_id IS
  'Na''jiki smsId returned by the gateway; used to correlate delivery webhooks.';
COMMENT ON COLUMN church.sms_logs.najiki_sms_id IS
  'Na''jiki smsId returned by the gateway; used to correlate delivery webhooks.';

-- Atomically claim one due row. A retry is the same queue ID and retains its
-- idempotency_key. PROCESSING rows become eligible again when their lease expires.
CREATE OR REPLACE FUNCTION church.claim_sms_queue_item(
  p_sms_id uuid,
  p_lock_token uuid,
  p_lease_seconds integer DEFAULT 90
)
RETURNS SETOF church.sms_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = church, public
AS $$
  UPDATE church.sms_queue q
     SET status = 'processing',
         attempts = q.attempts + 1,
         lock_token = p_lock_token,
         locked_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 600))),
         updated_at = now()
   WHERE q.id = p_sms_id
     AND (
       (q.status = 'pending' AND (q.scheduled_at IS NULL OR q.scheduled_at <= now()))
       OR
       (q.status = 'processing' AND (q.locked_until IS NULL OR q.locked_until <= now()))
     )
  RETURNING q.*;
$$;

-- Candidate listing is advisory only; claim_sms_queue_item remains the sole
-- authority and safely resolves races between workers.
CREATE OR REPLACE FUNCTION church.list_sms_queue_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = church, public
AS $$
  SELECT q.id
    FROM church.sms_queue q
   WHERE (q.status = 'pending' AND (q.scheduled_at IS NULL OR q.scheduled_at <= now()))
      OR (q.status = 'processing' AND (q.locked_until IS NULL OR q.locked_until <= now()))
   ORDER BY COALESCE(q.scheduled_at, q.created_at), q.created_at
   LIMIT greatest(1, least(p_limit, 500));
$$;

-- Idempotent wallet debit. Schema inspection confirms church.churches.id is
-- also public.tenants.id (create_tenant_for_church copies NEW.id), and
-- public.wallets.tenant_id references public.tenants.id; therefore this is an
-- exact UUID mapping, not a cast or a guessed cross-tenant relationship.
CREATE OR REPLACE FUNCTION church.reserve_sms_queue_debit(
  p_sms_id uuid,
  p_lock_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = church, public
AS $$
DECLARE
  v_tenant_id uuid;
  v_wallet_id uuid;
  v_balance bigint;
  v_rate integer;
  v_existing public.wallet_transactions%ROWTYPE;
  v_reference text := 'smsq_debit_' || p_sms_id::text;
BEGIN
  SELECT q.tenant_id
    INTO v_tenant_id
    FROM church.sms_queue q
   WHERE q.id = p_sms_id
     AND q.status = 'processing'
     AND q.lock_token = p_lock_token
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_claimed');
  END IF;

  SELECT wt.*
    INTO v_existing
    FROM public.wallet_transactions wt
   WHERE wt.reference_code = v_reference
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'success' THEN
      RETURN jsonb_build_object(
        'result', 'already_debited',
        'amount', abs(v_existing.amount),
        'wallet_id', v_existing.wallet_id
      );
    END IF;
    RETURN jsonb_build_object('result', 'debit_conflict');
  END IF;

  SELECT w.id, w.balance, w.sms_rate
    INTO v_wallet_id, v_balance, v_rate
    FROM public.wallets w
   WHERE w.tenant_id = v_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'wallet_missing');
  END IF;

  IF v_balance < v_rate THEN
    RETURN jsonb_build_object('result', 'insufficient_balance', 'rate', v_rate, 'balance', v_balance);
  END IF;

  UPDATE public.wallets
     SET balance = balance - v_rate,
         last_updated = now()
   WHERE id = v_wallet_id;

  INSERT INTO public.wallet_transactions (
    tenant_id, wallet_id, amount, type, direction, description,
    reference_code, status, idempotency_key, product, reference_id
  ) VALUES (
    v_tenant_id, v_wallet_id, -v_rate, 'SMS_SENT', 'debit',
    'SMS queue dispatch via Na''jiki', v_reference, 'success',
    v_reference, 'sms', p_sms_id::text
  );

  RETURN jsonb_build_object('result', 'debited', 'amount', v_rate, 'wallet_id', v_wallet_id);
END;
$$;

-- Return a transient/insufficient-balance row to PENDING without changing its
-- queue ID or idempotency key. Insufficient-balance waits do not consume retries.
CREATE OR REPLACE FUNCTION church.release_sms_queue_item(
  p_sms_id uuid,
  p_lock_token uuid,
  p_retry_at timestamptz,
  p_error text,
  p_restore_attempt boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = church, public
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE church.sms_queue q
     SET status = 'pending',
         attempts = CASE WHEN p_restore_attempt THEN greatest(0, q.attempts - 1) ELSE q.attempts END,
         scheduled_at = COALESCE(p_retry_at, now() + interval '30 seconds'),
         last_error = left(COALESCE(p_error, 'Temporary dispatch condition'), 1000),
         lock_token = NULL,
         locked_until = NULL,
         updated_at = now()
   WHERE q.id = p_sms_id
     AND q.status = 'processing'
     AND q.lock_token = p_lock_token;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

-- Final successful acceptance by Na'jiki. Updating the log only from PENDING
-- avoids overwriting a very fast DELIVERED/FAILED webhook.
CREATE OR REPLACE FUNCTION church.complete_sms_queue_item(
  p_sms_id uuid,
  p_lock_token uuid,
  p_najiki_sms_id text,
  p_najiki_reference text,
  p_gateway_status text DEFAULT 'queued'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = church, public
AS $$
DECLARE
  v_tenant_id uuid;
  v_broadcast_id uuid;
  v_idempotency_key text;
  v_total integer;
  v_sent integer;
  v_failed integer;
  v_rows integer;
BEGIN
  SELECT q.tenant_id, q.broadcast_id, q.idempotency_key
    INTO v_tenant_id, v_broadcast_id, v_idempotency_key
    FROM church.sms_queue q
   WHERE q.id = p_sms_id
     AND q.status = 'processing'
     AND q.lock_token = p_lock_token
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE church.sms_queue
     SET status = 'sent',
         processed_at = now(),
         last_error = NULL,
         najiki_sms_id = p_najiki_sms_id,
         najiki_reference = p_najiki_reference,
         lock_token = NULL,
         locked_until = NULL,
         updated_at = now()
   WHERE id = p_sms_id;

  UPDATE church.sms_logs
     SET status = 'Queued',
         message_provider_status = left(COALESCE(p_gateway_status, 'queued'), 100),
         provider_message_id = p_najiki_sms_id,
         najiki_sms_id = p_najiki_sms_id,
         najiki_reference = p_najiki_reference,
         error_message = NULL,
         updated_at = now()
   WHERE tenant_id = v_tenant_id
     AND idempotency_key = v_idempotency_key
     AND status = 'PENDING';

  IF v_broadcast_id IS NOT NULL THEN
    SELECT b.total_recipients, b.sent_count, b.failed_count
      INTO v_total, v_sent, v_failed
      FROM church.broadcasts b
     WHERE b.id = v_broadcast_id
     FOR UPDATE;
    IF FOUND THEN
      v_sent := COALESCE(v_sent, 0) + 1;
      UPDATE church.broadcasts
         SET sent_count = v_sent,
             status = CASE
               WHEN v_sent + COALESCE(v_failed, 0) >= v_total AND COALESCE(v_failed, 0) = 0 THEN 'COMPLETED'
               WHEN v_sent + COALESCE(v_failed, 0) >= v_total AND v_sent = 0 THEN 'FAILED'
               WHEN v_sent + COALESCE(v_failed, 0) >= v_total THEN 'PARTIAL'
               ELSE 'PROCESSING'
             END,
             started_at = COALESCE(started_at, now()),
             completed_at = CASE WHEN v_sent + COALESCE(v_failed, 0) >= v_total THEN now() ELSE NULL END,
             updated_at = now()
       WHERE id = v_broadcast_id;
    END IF;
  END IF;

  RETURN true;
END;
$$;

-- A definitive 4xx rejection is terminal and refunds a prior debit exactly
-- once. Ambiguous network/5xx failures are retried with the same idempotency
-- key instead; they must not be refunded while the gateway outcome is unknown.
CREATE OR REPLACE FUNCTION church.fail_sms_queue_item(
  p_sms_id uuid,
  p_lock_token uuid,
  p_error text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = church, public
AS $$
DECLARE
  v_tenant_id uuid;
  v_broadcast_id uuid;
  v_key text;
  v_debit public.wallet_transactions%ROWTYPE;
  v_wallet_id uuid;
  v_refund_reference text := 'smsq_refund_' || p_sms_id::text;
  v_refunded boolean := false;
  v_total integer;
  v_sent integer;
  v_failed integer;
BEGIN
  SELECT q.tenant_id, q.broadcast_id, q.idempotency_key
    INTO v_tenant_id, v_broadcast_id, v_key
    FROM church.sms_queue q
   WHERE q.id = p_sms_id
     AND q.status = 'processing'
     AND q.lock_token = p_lock_token
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_claimed');
  END IF;

  SELECT wt.*
    INTO v_debit
    FROM public.wallet_transactions wt
   WHERE wt.reference_code = 'smsq_debit_' || p_sms_id::text
   FOR UPDATE;

  IF FOUND AND v_debit.status = 'success' THEN
    SELECT w.id INTO v_wallet_id
      FROM public.wallets w
     WHERE w.tenant_id = v_tenant_id
     FOR UPDATE;

    IF v_wallet_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.wallet_transactions WHERE reference_code = v_refund_reference
    ) THEN
      UPDATE public.wallets
         SET balance = balance + abs(v_debit.amount), last_updated = now()
       WHERE id = v_wallet_id;

      INSERT INTO public.wallet_transactions (
        tenant_id, wallet_id, amount, type, direction, description,
        reference_code, status, idempotency_key, product, reference_id
      ) VALUES (
        v_tenant_id, v_wallet_id, abs(v_debit.amount), 'REFUND', 'credit',
        'Refund for rejected Na''jiki SMS queue item', v_refund_reference,
        'success', v_refund_reference, 'sms', p_sms_id::text
      );
      v_refunded := true;
    ELSIF v_wallet_id IS NOT NULL THEN
      v_refunded := true;
    END IF;
  END IF;

  UPDATE church.sms_queue
     SET status = 'failed',
         last_error = left(COALESCE(p_error, 'Na''jiki permanently rejected the SMS'), 1000),
         lock_token = NULL,
         locked_until = NULL,
         processed_at = now(),
         updated_at = now()
   WHERE id = p_sms_id;

  UPDATE church.sms_logs
     SET status = 'FAILED',
         error_message = left(COALESCE(p_error, 'Na''jiki permanently rejected the SMS'), 1000),
         updated_at = now()
   WHERE tenant_id = v_tenant_id
     AND idempotency_key = v_key
     AND status = 'PENDING';

  IF v_broadcast_id IS NOT NULL THEN
    SELECT b.total_recipients, b.sent_count, b.failed_count
      INTO v_total, v_sent, v_failed
      FROM church.broadcasts b
     WHERE b.id = v_broadcast_id
     FOR UPDATE;
    IF FOUND THEN
      v_failed := COALESCE(v_failed, 0) + 1;
      UPDATE church.broadcasts
         SET failed_count = v_failed,
             status = CASE
               WHEN COALESCE(v_sent, 0) + v_failed >= v_total AND COALESCE(v_sent, 0) = 0 THEN 'FAILED'
               WHEN COALESCE(v_sent, 0) + v_failed >= v_total THEN 'PARTIAL'
               ELSE 'PROCESSING'
             END,
             started_at = COALESCE(started_at, now()),
             completed_at = CASE WHEN COALESCE(v_sent, 0) + v_failed >= v_total THEN now() ELSE NULL END,
             updated_at = now()
       WHERE id = v_broadcast_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('result', 'failed', 'refunded', v_refunded);
END;
$$;

REVOKE ALL ON FUNCTION church.claim_sms_queue_item(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION church.list_sms_queue_candidates(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION church.reserve_sms_queue_debit(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION church.release_sms_queue_item(uuid, uuid, timestamptz, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION church.complete_sms_queue_item(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION church.fail_sms_queue_item(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION church.claim_sms_queue_item(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION church.list_sms_queue_candidates(integer) TO service_role;
GRANT EXECUTE ON FUNCTION church.reserve_sms_queue_debit(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION church.release_sms_queue_item(uuid, uuid, timestamptz, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION church.complete_sms_queue_item(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION church.fail_sms_queue_item(uuid, uuid, text) TO service_role;

-- Retire the old batch claimer so new workers cannot accidentally keep using
-- the no-lease, in-process dispatch design. Existing calls are replaced in app code.
DROP FUNCTION IF EXISTS church.claim_sms_queue_batch(uuid, integer);
