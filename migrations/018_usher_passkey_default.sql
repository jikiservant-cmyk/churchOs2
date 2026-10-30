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
