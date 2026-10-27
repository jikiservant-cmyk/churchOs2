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
-- The generated codes are NOT printed to the log — that would copy 18 live
-- credentials into a transcript. Retrieve them afterwards with the SELECT that
-- follows, and hand each church its own code out of band.

BEGIN;

UPDATE church.churches
   SET passkey = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
       passkey_updated_at = now()
 WHERE coalesce(trim(passkey), '') = '';

COMMIT;

-- Retrieve the codes. Run this yourself when you are ready to distribute them;
-- it is intentionally not part of the migration above.
--
--   SELECT slug, passkey FROM church.churches ORDER BY slug;
--
-- Format check: every generated code must match ^[0-9A-F]{10}$ — the portal
-- validator accepts A-Z a-z 0-9 _ - and requires 6 to 32 characters.
SELECT count(*) AS churches_without_readable_passkey,
       count(*) FILTER (WHERE passkey ~ '^[0-9A-F]{10}$') AS generated_ok
  FROM church.churches
 WHERE coalesce(trim(passkey), '') = '';
