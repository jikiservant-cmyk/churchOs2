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
