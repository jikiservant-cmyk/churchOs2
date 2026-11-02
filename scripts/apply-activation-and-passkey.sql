-- ============================================================================
-- ONE PASTE — all the SQL this application needs after the activation-fee and
-- usher-code changes: migrations 017 + 018 + 012, then the read-only checks that
-- prove both reported problems are gone
-- ============================================================================
-- HOW TO USE IT
--   Paste the whole file into Supabase Dashboard -> SQL Editor -> Run (or into
--   psql as a role that can ALTER church.churches). One paste, in order, and it
--   prints its own verification at the end.
--
--   It is idempotent: every statement is guarded, so running it twice is a no-op
--   with a notice, not an error. It is additive: nothing is dropped, and no
--   church row is rewritten except by 012, which fills usher codes on rows that
--   have none and touches no other row. And nothing in this file touches money —
--   the payment ledger, the Na'jiki RPCs, their policies and their grants appear
--   nowhere in it, so it cannot change what a congregation is charged or settle.
--
--   If something fails halfway, nothing is left in a state you have to unwind:
--   each part is guarded and re-runnable, so fix the cause and paste the whole
--   file again.
--
-- WHAT HAS TO BE IN PLACE FIRST
--   supabase-schema.sql (church.churches must exist — PART 0 tells you within a
--   second if it does not) and migrations 011 + 012. If you have NOT yet run
--   scripts/fix-sms-wallet-rls.sql (migrations 015 + 016, the RLS repair), run
--   that first: every part of this file reads through the policies it restores,
--   and PART 0 prints how many of them are in place.
--
-- WHAT YOU SHOULD SEE
--   PART 0    counts, no error. If it prints a row for every query, the schema
--             is reachable.
--   PART 1    '017: activation_status now defaults to pending_payment ...' (or a
--             notice that a default already existed and was left alone), then a
--             one-row summary of churches_total / settled / awaiting_payment /
--             grandfathered_null.
--   PART 2    '018: passkey now defaults to a random 10-character code ...', then
--             churches_total / blank_passkeys / accepted_by_the_portal.
--   PART 3    backfilled_this_run / valid_format / invalid_format, then
--             still_missing = 0 and valid_for_portal = churches_total.
--   PART 4    a per-church verdict table. would_newly_gate = false for every row
--             means tightening the gate later changes nothing for anyone.
--   PART 5    every check green. everything_ok must read true.
--
-- Read PART 4 and PART 5 before you deploy. If a number there surprises you,
-- stop and understand it first: these are the same questions the application asks
-- on every request, so a surprise here is a surprise in production tomorrow.
-- ============================================================================


-- ============================================================================
-- PART 0 — READ-ONLY PREFLIGHT. Nothing here writes.
-- ============================================================================

-- 0.1 Does the database have the shape the application assumes?
select
  (to_regclass('church.churches') is not null)                as church_churches_exists,
  exists (select 1 from information_schema.columns
           where table_schema='church' and table_name='churches'
             and column_name='activation_status')             as has_activation_status,
  exists (select 1 from information_schema.columns
           where table_schema='church' and table_name='churches'
             and column_name='activation_paid_at')            as has_activation_paid_at,
  exists (select 1 from information_schema.columns
           where table_schema='church' and table_name='churches'
             and column_name='passkey')                       as has_passkey,
  exists (select 1 from information_schema.columns
           where table_schema='church' and table_name='churches'
             and column_name='passkey_hash')                  as has_passkey_hash,
  (select column_default is not null from information_schema.columns
    where table_schema='church' and table_name='churches'
      and column_name='passkey')                              as passkey_has_default,
  (select count(*) from pg_policies where schemaname='public'
    and tablename='admin_profiles')                            as admin_profiles_policies,
  (to_regclass('church.activation_payments') is not null)      as activation_ledger_exists,
  (to_regclass('church.sms_queue') is not null)                as sms_queue_exists
;

-- 0.2 What the application currently believes about every church.
--     The values are pulled out of to_jsonb by key rather than named as columns,
--     on purpose: on a database where 017 has never run, `activation_status` does
--     not exist yet, and a preflight that errors on the very absence it is
--     looking for is worse than no preflight. A missing key reads as NULL, which
--     is exactly what the application sees there too.
select
  count(*)                                                                              as churches_total,
  count(*) filter (where coalesce(trim(row->>'activation_status'),'')='')                as activation_status_blank,
  count(*) filter (where row->>'activation_status' = 'active')                          as marked_active,
  count(*) filter (where row->>'activation_status' = 'pending_payment')                 as marked_pending_payment,
  count(*) filter (where row->>'activation_status' = 'suspended')                       as marked_suspended,
  count(*) filter (where coalesce(trim(row->>'passkey'),'')='')                         as usher_code_blank
from (select to_jsonb(c) as row from church.churches c) churches_as_json;

-- ============================================================================
-- PART 1 — migrations/017_activation_billing_columns.sql, verbatim
-- ============================================================================

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

-- ============================================================================
-- PART 2 — migrations/018_usher_passkey_default.sql, verbatim
-- ============================================================================

-- ============================================================================
-- 018 — a church must never exist without an usher code (the DB half)
-- ============================================================================
-- WHY THIS EXISTS
-- The usher portal authenticates a church with the readable `passkey` on
-- church.churches. That column's DEFAULT is declared in supabase-schema.sql but
-- only reaches a live database through migration 014, which installs it solely
-- "if the column has none" — and 014 is the passkey NOT NULL migration, which
-- PROVISIONING_DRIFT.md documents as staged. `provision_church_v3` is a database
-- function this repository does not own and does not supply a code either.
--
-- So on any project where 014 has not run, a newly provisioned church is created
-- with passkey IS NULL: the admin Attendance screen renders an empty field,
-- "Copy portal link" copies nothing, and the usher portal answers "No usher
-- passkey is configured". Nothing was broken in the portal — the credential was
-- never issued, and no code path generated it.
--
-- WHAT THIS DOES
--   * one guard: refuses to run before 011/012 have, rather than re-declaring
--     their columns and drifting from them
--   * installs the 10-hex DEFAULT, and ONLY if the column currently has none —
--     the same conditional 014 uses, so a default somebody chose is never
--     overwritten
--   * counts what is still blank and points at the file that fills it
--
-- WHAT THIS DOES NOT DO
-- No passkey value is written here. Backfilling is migration 012's job — its
-- UPDATE is idempotent, refuses to touch a row that already has a code, does not
-- bump passkey_version (so live usher sessions survive) and deliberately never
-- prints the codes. Duplicating that statement here would only create two files
-- that can disagree about a credential.
--
-- Safe to run more than once.
-- ============================================================================

BEGIN;

-- 1. Preconditions, named rather than discovered through a 42703.
DO $$
BEGIN
  IF to_regclass('church.churches') IS NULL THEN
    RAISE EXCEPTION 'church.churches does not exist. Apply supabase-schema.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'church' AND table_name = 'churches' AND column_name = 'passkey'
  ) THEN
    RAISE EXCEPTION 'church.churches.passkey is missing — apply migrations/011_usher_passkey_columns.sql first, then 012, then this file.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'church' AND table_name = 'churches' AND column_name = 'passkey_hash'
  ) THEN
    RAISE EXCEPTION 'church.churches.passkey_hash is missing — apply migrations/011_usher_passkey_columns.sql first. Login compares against that hash; this migration will not invent the column.';
  END IF;
END
$$;

-- 2. The DEFAULT, only where there is none. Matches supabase-schema.sql:80
--    exactly (10 hex characters from gen_random_uuid, CSPRNG — not random()).
DO $$
DECLARE
  v_default text;
BEGIN
  SELECT column_default INTO v_default
  FROM information_schema.columns
  WHERE table_schema = 'church' AND table_name = 'churches' AND column_name = 'passkey';

  IF v_default IS NULL THEN
    ALTER TABLE church.churches
      ALTER COLUMN passkey SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    RAISE NOTICE '018: passkey now defaults to a random 10-character code, so an insert that omits it still gets one.';
  ELSE
    RAISE NOTICE '018: passkey already defaults to %; left alone.', v_default;
  END IF;
END
$$;

-- 3. Report. Counts only — never credential values.
SELECT
  count(*)                                                              AS churches_total,
  count(*) FILTER (WHERE coalesce(trim(passkey), '') = '')              AS blank_passkeys,
  count(*) FILTER (WHERE passkey ~ '^[A-Za-z0-9_-]{6,32}$')             AS accepted_by_the_portal,
  count(*) FILTER (WHERE coalesce(trim(passkey_hash), '') = '')        AS no_hash_yet,
  (SELECT column_default IS NOT NULL FROM information_schema.columns
    WHERE table_schema = 'church' AND table_name = 'churches'
      AND column_name = 'passkey')                                      AS default_is_set
FROM church.churches;

DO $$
DECLARE
  v_blank integer;
BEGIN
  SELECT count(*) INTO v_blank FROM church.churches WHERE coalesce(trim(passkey), '') = '';
  IF v_blank > 0 THEN
    RAISE NOTICE '018: % church(es) still have no usher code. Run migrations/012_usher_passkey_backfill.sql — it is idempotent, it will not touch rows that already have a code, and it does not print the codes it issues.', v_blank;
  ELSE
    RAISE NOTICE '018: every church has a readable usher code.';
  END IF;
END
$$;

COMMIT;

-- The application issues the same code on its own now — at provisioning, and the
-- first time a pastor opens Attendance — so a church is never waiting on this
-- file. What the DEFAULT adds is coverage for rows created outside the app.
--
--   * blank rows filled by 012/018 carry no passkey_hash; the portal accepts the
--     readable code and rewrites the hash on that first successful login
--     (validateUsherPasskey, "self-heal"), which is why this file never touches
--     hashes: the HMAC key lives in the app's USHER_JWT_SECRET, not in SQL.
--   * no passkey_version is bumped anywhere here, so ushers already signed in
--     stay signed in.

-- ============================================================================
-- PART 3 — migrations/012_usher_passkey_backfill.sql, verbatim
--   Fills a code for every church that has none. It does not touch a row that
--   already has one, does not bump passkey_version (signed-in ushers stay
--   signed in), and never prints the codes it writes.
-- ============================================================================

-- 012 — Issue a readable usher passkey where none exists.
--
-- Run this AFTER 011. Review both files before executing either.
--
-- Why this is needed
-- ------------------
-- The previous rotation path stored hash-only: `updateChurchPasskey` set
-- `passkey = NULL` alongside the hash, and the admin screen renders `passkey`.
-- Every church that ever rotated its code therefore has no readable passkey
-- left. On a database that also lacks the `passkey_hash` column, those churches
-- have NO usable credential of any kind — the portal cannot admit an usher
-- under any input, and no value in the database can be reproduced by a human.
--
-- This migration issues a fresh random code only for those rows. It does not
-- read, print or alter any existing credential.
--
-- Scope
--   * Touches rows where `passkey` is NULL or blank. Nothing else.
--   * Leaves existing readable passkeys and existing hashes untouched.
--   * Does NOT bump `passkey_version`, so live usher sessions survive.
--   * Safe to run more than once: rows it fills stop matching the WHERE clause.
--
-- The generated codes are NOT printed to the log — that would copy live
-- credentials into a transcript. Retrieve them afterwards through a private
-- channel with the SELECT below, and hand each church its own code.

BEGIN;

-- Generate and aggregate in one statement: RETURNING exposes exactly the rows
-- this run wrote, so the format count actually measures the generated values.
-- (An earlier revision counted rows that were still missing, which after the
-- UPDATE is always zero — it could never have caught a bad code.)
WITH backfilled AS (
  UPDATE church.churches
     SET passkey = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
         passkey_updated_at = now()
   WHERE coalesce(trim(passkey), '') = ''
  RETURNING passkey
)
SELECT count(*)                                              AS backfilled_this_run,
       count(*) FILTER (WHERE passkey ~ '^[0-9A-F]{10}$')     AS valid_format,
       count(*) FILTER (WHERE passkey !~ '^[0-9A-F]{10}$')    AS invalid_format
  FROM backfilled;

COMMIT;

-- State of the whole table after the run. Counts only — no credential values.
-- `valid_for_portal` checks the range the login validator actually accepts
-- (^[A-Za-z0-9_-]{6,32}$), not just the format this migration generates, so
-- pre-existing codes are covered too.
SELECT count(*)                                                       AS total_churches,
       count(*) FILTER (WHERE coalesce(trim(passkey), '') = '')       AS still_missing,
       count(*) FILTER (WHERE passkey ~ '^[A-Za-z0-9_-]{6,32}$')      AS valid_for_portal
  FROM church.churches;

-- Retrieve the codes through a private channel when you are ready to
-- distribute them. Deliberately not part of this file's output.
--
--   SELECT slug, passkey FROM church.churches ORDER BY slug;

-- ============================================================================
-- PART 4 — scripts/activation-gate-audit.sql, verbatim (READ ONLY)
--   What the activation screen will do with each church, today and if the
--   legacy-NULL policy is later tightened.
-- ============================================================================

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

-- ============================================================================
-- PART 5 — READ-ONLY VERIFICATION. Run this after the parts above.
-- ============================================================================

-- 5.1 The two guarantees, as one row.
select
  (select count(*) = 2 from information_schema.columns
    where table_schema='church' and table_name='churches'
      and column_name in ('activation_status','activation_paid_at'))      as activation_columns_present,
  (select count(*) from information_schema.columns
    where table_schema='church' and table_name='churches'
      and column_name='activation_status' and column_default is not null)  as activation_default_set,
  exists (select 1 from pg_constraint where conname='churches_activation_status_known')
                                                                           as activation_domain_check,
  (select convalidated from pg_constraint
    where conname='churches_activation_status_known')                      as domain_check_validated,
  (select count(*) from information_schema.columns
    where table_schema='church' and table_name='churches'
      and column_name='passkey' and column_default is not null)            as passkey_default_set,
  exists (select 1 from pg_indexes where schemaname='church'
    and tablename='churches' and indexname='churches_activation_unpaid_idx')
                                                                           as gate_index_present
;

-- 5.2 No church may be left without a usable usher code, and no code may be
--     something the portal would reject on login (^[A-Za-z0-9_-]{6,32}$).
select
  count(*)                                                    as churches_total,
  count(*) filter (where coalesce(trim(passkey),'')='')        as still_without_a_code,
  count(*) filter (where passkey !~ '^[A-Za-z0-9_-]{6,32}$')   as code_rejected_by_login,
  count(*) filter (where coalesce(trim(passkey_hash),'')='')   as hash_not_yet_self_healed
from church.churches;

-- 5.3 The gate, in the shape lib/activation-gate.ts computes it. A church listed
--     here is a church whose pastor will be shown the activation screen.
select
  c.slug,
  c.name,
  coalesce(nullif(trim(c.activation_status),'<null>'),'<null>') as activation_status,
  case
    when coalesce(trim(c.activation_status),'') = '' then
      case when c.activation_paid_at is not null then 'allow (has a paid timestamp)'
           else 'allow (grandfathered — set ACTIVATION_GATE_LEGACY_NULL=pay to bill it)' end
    when lower(trim(c.activation_status)) in ('active','activated','paid') then 'allow'
    when lower(trim(c.activation_status)) = 'suspended' then 'suspended notice'
    else 'PAY — activation screen'
  end as what_the_app_will_do
from church.churches c
order by case when lower(coalesce(trim(c.activation_status),'')) in ('active','activated','paid') then 1 else 0 end,
         c.slug;

-- 5.4 Everything this file was for, in one row.
with activation as (
  -- What ACTIVATION_GATE_LEGACY_NULL=pay would newly bill: no status, no paid
  -- timestamp. Counted directly, and deliberately NOT read from a
  -- current_setting() — the application takes that decision from an environment
  -- variable in Vercel, which a SQL console has never heard of, so a GUC term
  -- here would sit at 0 forever and look like good news.
  select count(*) as unresolved
  from church.churches
  where coalesce(trim(activation_status),'') = ''
    and activation_paid_at is null
), passkeys as (
  select count(*) as blank from church.churches where coalesce(trim(passkey),'') = ''
), shape as (
  select (select count(*) = 2 from information_schema.columns
           where table_schema='church' and table_name='churches'
             and column_name in ('activation_status','activation_paid_at')) as columns_ok,
         (select count(*) from information_schema.columns
           where table_schema='church' and table_name='churches'
             and column_name='passkey' and column_default is not null) = 1   as passkey_default_ok
)
select
  shape.columns_ok                as activation_columns_exist,
  shape.passkey_default_ok        as new_churches_get_an_usher_code,
  passkeys.blank = 0              as every_church_has_an_usher_code,
  activation.unresolved           as churches_a_tighter_gate_would_newly_bill,
  (shape.columns_ok and shape.passkey_default_ok and passkeys.blank = 0) as everything_ok
from shape, passkeys, activation;

-- ============================================================================
-- PART 6 — NOT RUN. Deliberately commented out: these are decisions, not setup.
-- ============================================================================
--
-- Test the payment flow on your own workspace (it will then be held on the
-- activation screen until it pays or you restore it):
--
--   update church.churches
--      set activation_status = 'pending_payment', activation_paid_at = null
--    where slug = 'your-test-slug';
--
-- Put it back afterwards:
--
--   update church.churches
--      set activation_status = 'active', activation_paid_at = now()
--    where slug = 'your-test-slug';
--
-- Grandfather a congregation you know has paid, so a future tightening cannot
-- touch it (one church at a time; do not bulk-update this column):
--
--   update church.churches
--      set activation_status = 'active',
--          activation_paid_at = coalesce(activation_paid_at, created_at)
--    where slug = '<slug-from-part-4>';
--
-- A church whose passkey was blank until now has no hash yet — 5.2 counts those.
-- That is by design: the portal accepts the readable code and rewrites
-- passkey_hash on that first successful login (validateUsherPasskey). No SQL can
-- compute the hash here, because its key is USHER_JWT_SECRET in the app.
