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
