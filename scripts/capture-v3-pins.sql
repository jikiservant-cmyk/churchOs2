-- Generate the v_pins array for migrations/014_passkey_not_null.sql — in SQL.
--
-- Why this exists
-- ---------------
-- scripts/capture-rpc.mjs needs Node and a checked-out repository. The person
-- who holds database access is often not the person who can run either. This
-- query produces the same bytes from the database alone, so the pin can be
-- produced wherever the bodies are reviewed.
--
-- It is not merely a convenience. Because it calls pg_get_functiondef in the
-- same database that 014 later compares against, it cannot disagree with it by
-- a trailing byte — a failure mode the Node script actually had.
--
-- Safe to paste the output: these are sha256 digests and signatures. No
-- function body and no credential appears in the result.
--
-- Usage
-- -----
--   1. Run this. Copy the single `v_pins` value it returns.
--   2. Review the three bodies separately (they are not returned here).
--   3. Paste the value into v_pins in migrations/014_passkey_not_null.sql,
--      replacing  '[]'::jsonb.
--   4. Run 014. It recomputes each digest and refuses if any body changed.
--
-- If 014 reports "changed since review", re-run this query and re-review — it
-- means one of the functions was altered after it was signed off.

WITH pinned AS (
  SELECT n.nspname                AS schema,
         p.proname                AS name,
         pg_get_function_identity_arguments(p.oid) AS args,
         encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS fingerprint,
         -- Order the array the way the chain runs, so the output reads as a
         -- call path rather than an arbitrary list.
         CASE
           WHEN n.nspname = 'public'  AND p.proname = 'provision_church_v3'      THEN 1
           WHEN n.nspname = 'private' AND p.proname = 'provision_church_v3_impl' THEN 2
           WHEN n.nspname = 'public'  AND p.proname = 'provision_church_v2'      THEN 3
           ELSE 9
         END                      AS chain_order
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prokind = 'f'
     AND n.nspname IN ('public', 'private')
     AND p.proname IN ('provision_church_v3', 'provision_church_v3_impl', 'provision_church_v2')
)
SELECT jsonb_agg(
         jsonb_build_object(
           'schema', schema,
           'name',   name,
           'args',   args,
           'fingerprint', fingerprint
         )
         ORDER BY chain_order, schema, name
       ) AS v_pins,
       count(*) AS routines_pinned
  FROM pinned;

-- What to paste into 014 (variadic replacement of the empty array):
--
--   v_pins CONSTANT jsonb := '<the value above>'::jsonb;
--
-- The `routines_pinned` column must be 3. If it is fewer, one of the routines
-- is missing or lives in a different schema than expected — check before
-- pinning, because 014 refuses a chain it cannot fully resolve.
--
-- Sanity check that costs nothing, run separately if you want the signature
-- list without the digests:
--
--   SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE p.prokind = 'f'
--      AND p.proname IN ('provision_church_v3','provision_church_v3_impl','provision_church_v2')
--    ORDER BY 1, 2;
