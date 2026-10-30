-- ============================================================================
-- activation-gate-audit — READ ONLY
-- ============================================================================
-- What this tells you, before you change anything in production:
--
--   * every church, and what the activation screen will do with it under the
--     CURRENT rule (legacy NULL rows are grandfathered and let through)
--   * the same verdict under the TIGHTENED rule
--     (ACTIVATION_GATE_LEGACY_NULL=pay, where a NULL status with no payment
--     timestamp must pay first)
--
-- Run this first. If `would_newly_gate` is 0, flipping the tightened policy
-- changes nothing for existing congregations and is safe. If it is not 0, the
-- bottom of the file has the exact statements to settle each row properly —
-- either confirm it is paid and mark it active, or let it be billed.
--
-- Nothing here writes. Requires migrations/017_activation_billing_columns.sql.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('church.churches') IS NULL
     OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'church' AND table_name = 'churches'
          AND column_name = 'activation_status') THEN
    RAISE EXCEPTION 'church.churches has no activation_status column yet. Apply migrations/017_activation_billing_columns.sql first, then re-run this audit.'
      USING HINT = 'This script only reads. It changed nothing.';
  END IF;
END
$$;

-- Gate verdict, computed exactly the way lib/activation-gate.ts computes it:
-- settled statuses pass, 'suspended' gets its own notice, an explicit
-- non-settled status must pay, and a blank status is decided by the policy.
CREATE TEMP TABLE _gate_audit ON COMMIT DROP AS
SELECT
  c.id,
  c.slug,
  c.name,
  c.activation_status,
  c.activation_paid_at,
  c.created_at,
  paid.ledger_paid,
  CASE
    WHEN btrim(coalesce(c.activation_status, '')) = '' THEN
      CASE WHEN c.activation_paid_at IS NOT NULL THEN 'allow:legacy-paid-timestamp'
           ELSE 'allow:grandfathered' END
    WHEN lower(btrim(c.activation_status)) IN ('active', 'activated', 'paid') THEN 'allow:status-' || lower(btrim(c.activation_status))
    WHEN lower(btrim(c.activation_status)) = 'suspended' THEN 'suspended'
    ELSE 'pay:status-' || lower(btrim(c.activation_status))
  END AS gate_now,
  CASE
    WHEN btrim(coalesce(c.activation_status, '')) = '' AND c.activation_paid_at IS NULL THEN 'pay:status-missing'
    WHEN btrim(coalesce(c.activation_status, '')) = '' AND c.activation_paid_at IS NOT NULL THEN 'allow:legacy-paid-timestamp'
    WHEN lower(btrim(c.activation_status)) IN ('active', 'activated', 'paid') THEN 'allow:status-' || lower(btrim(c.activation_status))
    WHEN lower(btrim(c.activation_status)) = 'suspended' THEN 'suspended'
    ELSE 'pay:status-' || lower(btrim(c.activation_status))
  END AS gate_if_legacy_null_pay
FROM church.churches c
LEFT JOIN LATERAL (
  SELECT count(*)::int AS ledger_paid
  FROM church.activation_payments p
  WHERE p.church_id = c.id AND p.status = 'paid'
) paid ON TRUE;

SELECT
  slug,
  name,
  coalesce(nullif(btrim(activation_status), ''), '<null>') AS activation_status,
  activation_paid_at,
  coalesce(ledger_paid, 0) AS paid_ledger_rows,
  gate_now                 AS verdict_today,
  gate_if_legacy_null_pay  AS verdict_if_tightened,
  (gate_now LIKE 'allow%' AND gate_if_legacy_null_pay LIKE 'pay%') AS would_newly_gate
FROM _gate_audit
ORDER BY would_newly_gate DESC, gate_now, slug;

SELECT
  count(*)                                                   AS churches_total,
  count(*) FILTER (WHERE gate_now LIKE 'allow%')             AS allowed_today,
  count(*) FILTER (WHERE gate_now LIKE 'pay%')               AS billed_today,
  count(*) FILTER (WHERE gate_now = 'suspended')             AS suspended,
  count(*) FILTER (WHERE gate_now LIKE '%grandfathered')     AS null_status_no_receipt,
  count(*) FILTER (WHERE gate_now LIKE 'allow%' AND gate_if_legacy_null_pay LIKE 'pay%') AS would_newly_gate
FROM _gate_audit;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Only after you have read the report. Each is one church, deliberately not a
-- bulk update: a congregation that has never paid should not be marked active,
-- and one that has paid should not be left NULL forever.
--
-- settle a row you have confirmed is a paying customer:
--   update church.churches
--      set activation_status = 'active',
--          activation_paid_at = coalesce(activation_paid_at, created_at)
--    where slug = '<slug-from-the-report>';
--
-- bill a row that was simply never set:
--   update church.churches set activation_status = 'pending_payment'
--    where slug = '<slug-from-the-report>';
--
-- then set ACTIVATION_GATE_LEGACY_NULL=pay in Vercel so no future row can be
-- silently free, and re-run this audit: would_newly_gate must read 0.
-- ─────────────────────────────────────────────────────────────────────────────
