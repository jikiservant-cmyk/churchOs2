-- 011 — Usher passkey columns (structural only).
--
-- Why this exists
-- ---------------
-- The application reads and writes three columns on church.churches:
--
--   lib/attendance-actions.ts   .select('id, name, passkey, passkey_hash, passkey_version')
--                               .update({ passkey: …, passkey_hash: …, passkey_version: … })
--   supabase-schema.sql         provisioning INSERT (…, passkey_hash, passkey_version, …)
--
-- No file in this repository ever created them. README pointed at
-- migrations/002_passkey_hashing.sql, which does not exist. On a database
-- without them the SELECT fails with 42703 ("column church.churches.passkey_hash
-- does not exist"), the lookup returns no row, and the usher portal answers
-- "Church not found." for every passkey.
--
-- This migration is ADDITIVE ONLY.
--   * It adds columns. It does not drop, rename or overwrite anything.
--   * It does not clear, rewrite or read back any existing hash.
--   * It does not touch the `passkey` values.
--   * It prints counts, never credential values. Nothing secret enters the
--     server log, a psql transcript or a migration history table.
--
-- On a database where these columns are absent — the confirmed production
-- state — every added column is NULL for every row, so there is nothing to
-- clear and no data can be lost.
--
-- Running it more than once is a no-op.

BEGIN;

ALTER TABLE church.churches
  ADD COLUMN IF NOT EXISTS passkey_hash       text,
  ADD COLUMN IF NOT EXISTS passkey_version    integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS passkey_updated_at timestamptz;

-- Rows created before the column existed get the lowest version. Usher JWTs
-- issued before that claim existed also behave as version 1, so live sessions
-- are not invalidated by this migration.
UPDATE church.churches
   SET passkey_version = 1
 WHERE passkey_version IS NULL;

COMMIT;

-- State report — counts only, deliberately no passkey or hash values.
DO $$
DECLARE
  v_total      integer;
  v_no_passkey integer;
  v_hash_only  integer;
  v_readable   integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE coalesce(trim(passkey), '') = '' AND passkey_hash IS NULL),
         count(*) FILTER (WHERE coalesce(trim(passkey), '') = '' AND passkey_hash IS NOT NULL),
         count(*) FILTER (WHERE coalesce(trim(passkey), '') <> '')
    INTO v_total, v_no_passkey, v_hash_only, v_readable
    FROM church.churches;

  RAISE NOTICE 'church.churches: % total, % with a readable passkey, % hash-only, % with NO credential at all',
    v_total, v_readable, v_hash_only, v_no_passkey;

  IF v_hash_only > 0 THEN
    RAISE NOTICE '% church(es) can only be entered with a code that was never displayed. See migrations/012 for the backfill.',
      v_hash_only;
  END IF;

  IF v_no_passkey > 0 THEN
    RAISE NOTICE '% church(es) have NO usher passkey at all and cannot log ushers in until one is set. Next step: migrations/012_usher_passkey_backfill.sql',
      v_no_passkey;
  END IF;
END $$;
