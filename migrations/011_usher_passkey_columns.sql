-- 011 — Usher passkey columns.
--
-- The application has always read and written church.churches.passkey_hash,
-- passkey_version and passkey_updated_at:
--
--   lib/attendance-actions.ts  .select('id, name, passkey, passkey_hash, passkey_version')
--                              .update({ passkey: null, passkey_hash: …, passkey_version: … })
--   supabase-schema.sql        provision_tenant() INSERT (…, passkey_hash, passkey_version, …)
--
-- …but no file in the repository ever created them. README told operators to run
-- migrations/002_passkey_hashing.sql, which does not exist. On a database built
-- from this repo the SELECT therefore fails with 42703
-- ("column church.churches.passkey_hash does not exist"), the lookup returns no
-- row, and the usher portal answers "Church not found." for every passkey —
-- including the one displayed in the database.
--
-- Safe to run more than once.

ALTER TABLE church.churches
  ADD COLUMN IF NOT EXISTS passkey_hash       text,
  ADD COLUMN IF NOT EXISTS passkey_version    integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS passkey_updated_at timestamptz;

-- Existing rows: version defaults to 1 so already-issued usher JWTs (which
-- carry passkey_version 1 when the claim is absent) stay valid.
UPDATE church.churches
   SET passkey_version = 1
 WHERE passkey_version IS NULL;

-- Any church that was provisioned before this migration carries a passkey_hash
-- generated from `slug || ':' || random uuid` — a value nobody was ever shown.
-- No usher can reproduce it, and while it is present the plaintext `passkey`
-- column is ignored. Clear it so the readable code works again; the login path
-- re-derives a correct hash from `passkey` on the next successful sign-in.
--
-- Only rows that still have a readable passkey are touched — a church whose
-- passkey was rotated to a hash-only value keeps that hash.
UPDATE church.churches
   SET passkey_hash = NULL
 WHERE passkey_hash IS NOT NULL
   AND passkey IS NOT NULL
   AND length(trim(passkey)) BETWEEN 4 AND 32;

-- Report the resulting state so the operator can see what the portal will do.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT slug,
           passkey                            AS readable_passkey,
           (passkey_hash IS NOT NULL)         AS has_hash,
           passkey_version
      FROM church.churches
     ORDER BY slug
  LOOP
    RAISE NOTICE 'church %: passkey=% hash=% version=%',
      rpad(r.slug, 24), coalesce(r.readable_passkey, '<none>'),
      r.has_hash, r.passkey_version;
  END LOOP;
END $$;
