-- 014 — Enforce `passkey NOT NULL`, but only when the data and the write paths
--       actually support it.
--
-- Run order: 011 → 012 → verify → 014. Do not run this before 012.
--
-- Why it is gated
-- ---------------
-- The live table allows NULLs and 16 of 18 churches had none. Adding NOT NULL
-- before the backfill would either fail outright or, worse, tempt someone to
-- satisfy it with a placeholder code that every usher in that church shares
-- with an attacker.
--
-- So this migration refuses to proceed unless all three conditions hold, and it
-- says exactly which one failed:
--
--   1. 011 has been applied (the hash columns exist).
--   2. Every church has a non-empty passkey — i.e. 012 ran and was verified.
--   3. The deployed provisioning function writes a passkey. A new church
--      created without one would repeat the outage this whole exercise fixed.
--      This is checked against the *database*, not against the repo, because
--      the repo does not contain provision_church_v3 (see scripts/capture-rpc.mjs).
--
-- Rotation is the other write path, and it is verified in code:
-- lib/attendance-actions.ts updateChurchPasskey writes `passkey: trimmedKey`.
--
-- Once the constraint holds, the old `passkey: null` rotation bug and any
-- provisioning path that forgets a passkey fail loudly at the database instead
-- of silently locking a congregation out of check-in.
--
-- Safe to run more than once.

BEGIN;

DO $$
DECLARE
  v_missing_count  integer;
  v_missing_slugs  text;
  v_blank_count    integer;
  v_blank_slugs    text;
  v_has_v3         boolean;
  v_v3_body        text;
BEGIN
  -- 1. Columns from 011 must be present.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'church' AND table_name = 'churches'
       AND column_name = 'passkey_hash'
  ) THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: passkey_hash is missing. Apply migrations/011_usher_passkey_columns.sql first.';
  END IF;

  -- 2a. Every church must HAVE a passkey.
  SELECT count(*), string_agg(slug, ', ' ORDER BY slug)
    INTO v_missing_count, v_missing_slugs
    FROM church.churches
   WHERE passkey IS NULL;

  IF v_missing_count > 0 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: % church(es) have a NULL passkey (%). Apply migrations/012_usher_passkey_backfill.sql, distribute the codes, then re-run this.',
      v_missing_count, v_missing_slugs;
  END IF;

  -- 2b. …and it must be a usable one, not an empty string left by a bad write.
  SELECT count(*), string_agg(slug, ', ' ORDER BY slug)
    INTO v_blank_count, v_blank_slugs
    FROM church.churches
   WHERE trim(passkey) = '';

  IF v_blank_count > 0 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: % church(es) have a blank passkey (%). Set a real code before enforcing the constraint.',
      v_blank_count, v_blank_slugs;
  END IF;

  -- 3. Provisioning must write a passkey, or new churches repeat the bug.
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'provision_church_v3'
  ), (
    SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'provision_church_v3'
     LIMIT 1
  ) INTO v_has_v3, v_v3_body;

  IF NOT v_has_v3 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: public.provision_church_v3 does not exist, so provisioning is already broken. Capture it first (scripts/capture-rpc.mjs).';
  END IF;

  IF v_v3_body IS NULL OR v_v3_body NOT ILIKE '%passkey%' THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: public.provision_church_v3 never sets a passkey, so every newly provisioned church would have none. Fix the function first (see migrations/013).';
  END IF;

  RAISE NOTICE 'Preconditions satisfied: 0 NULL, 0 blank, provision_church_v3 writes a passkey.';
END $$;

ALTER TABLE church.churches ALTER COLUMN passkey SET NOT NULL;

COMMIT;

-- Confirm.
SELECT count(*)                                   AS churches,
       count(*) FILTER (WHERE trim(passkey) = '') AS still_blank,
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'church' AND table_name = 'churches'
           AND column_name = 'passkey')           AS passkey_nullable
  FROM church.churches;
