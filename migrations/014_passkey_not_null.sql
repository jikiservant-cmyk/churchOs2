-- 014 — Enforce `passkey NOT NULL`, but only when the data and the write paths
--       actually support it.
--
-- Run order: 011 → 012 → capture and review 013 → 014. Do not run before 013.
--
-- Why it is gated
-- ---------------
-- The live table allows NULLs and 16 of 18 churches had none. Adding NOT NULL
-- before the backfill would either fail outright or, worse, tempt someone to
-- satisfy it with a placeholder code that every usher in that church shares
-- with an attacker.
--
-- It also must not go in while the provisioning function is unreviewed: if
-- provision_church_v3 inserts a church without a passkey, NOT NULL turns that
-- into a hard failure at signup. So this migration refuses unless:
--
--   1. 011 has been applied.
--   2. Every church has a non-empty passkey (012 ran and was verified).
--   3. Exactly one *function* overload of public.provision_church_v3 matches
--      the argument list the app sends, so the check cannot land on the wrong
--      object. pg_proc also holds procedures, aggregates and window functions
--      under the same name; both lookups filter p.prokind = 'f'.
--   3b. `authenticated` holds EXECUTE on it — the app calls with the user's
--      token, so a function nobody can call cannot provision anything.
--   4. That overload's deployed text hashes to the fingerprint recorded below,
--      i.e. it is byte-identical to the definition a human reviewed.
--
-- Point 4 is deliberate. An earlier revision tested `prosrc ILIKE '%passkey%'`,
-- which proves only that the word appears — in a comment, a variable name, or
-- a dead branch — and would have passed for a function that never assigns one.
-- A pinned hash is a statement about the exact text that was reviewed, which
-- is what "reviewed" has to mean.
--
-- Rotation is the other write path, verified in code:
-- lib/attendance-actions.ts updateChurchPasskey writes `passkey: trimmedKey`.
--
-- Safe to run more than once.

BEGIN;

DO $$
DECLARE
  -- ── Fill this in before running ───────────────────────────────────────────
  -- Produced by the capture step:
  --   node scripts/capture-rpc.mjs provision_church_v3.def.sql \
  --        --out migrations/013_provision_church_v3.sql
  -- which prints the fingerprint of the definition it wrote. Until it holds a
  -- real sha256, this migration refuses to run — by design.
  v_expected_fingerprint CONSTANT text := 'UNREVIEWED';

  -- The argument list lib/provision-actions.ts sends. Pins the overload.
  v_expected_signature   CONSTANT text :=
    'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text';

  v_missing_count  integer;
  v_missing_slugs  text;
  v_blank_count    integer;
  v_blank_slugs    text;
  v_overloads      integer;
  v_oid            oid;
  v_signature      text;
  v_fingerprint    text;
  v_body           text;
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

  -- 2b. …and it must be usable, not an empty string.
  SELECT count(*), string_agg(slug, ', ' ORDER BY slug)
    INTO v_blank_count, v_blank_slugs
    FROM church.churches
   WHERE trim(passkey) = '';

  IF v_blank_count > 0 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: % church(es) have a blank passkey (%). Set a real code before enforcing the constraint.',
      v_blank_count, v_blank_slugs;
  END IF;

  -- 3. Exactly one FUNCTION overload with the signature the app calls.
  --
  -- p.prokind = 'f' is load-bearing. pg_proc also holds procedures ('p'),
  -- aggregates ('a') and window functions ('w'), any of which can share this
  -- name. Without the filter a procedure called provision_church_v3 would
  -- inflate the count — and min(p.oid) could return the procedure, handing
  -- pg_get_functiondef the wrong object to fingerprint.
  SELECT count(*) INTO v_overloads
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_church_v3'
     AND p.prokind = 'f';

  IF v_overloads = 0 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: no function public.provision_church_v3 exists, so provisioning is already broken. Capture it first (scripts/capture-rpc.mjs).';
  END IF;

  SELECT count(*), min(p.oid)
    INTO v_overloads, v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_church_v3'
     AND p.prokind = 'f'
     AND pg_get_function_identity_arguments(p.oid) = v_expected_signature;

  IF v_overloads = 0 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: no overload of provision_church_v3 accepts (%). The deployed function does not match the call site.',
      v_expected_signature;
  END IF;

  IF v_overloads > 1 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: % overloads of provision_church_v3 accept the call-site signature. Resolve the ambiguity before trusting this gate.',
      v_overloads;
  END IF;

  -- 3b. The app calls this with the user's token (lib/provision-actions.ts
  -- uses createClient(), not the admin client), so `authenticated` must hold
  -- EXECUTE. A function nobody can call cannot provision a church, whatever
  -- its body says. The role check keeps this portable to databases without
  -- Supabase's role set.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: authenticated cannot EXECUTE provision_church_v3, so church signup fails for every user. Grant EXECUTE to authenticated (and check service_role separately).';
  END IF;

  -- 4. The reviewed definition, identified by content rather than by name.
  v_signature   := pg_get_function_identity_arguments(v_oid);
  v_body        := (SELECT prosrc FROM pg_proc WHERE oid = v_oid);
  v_fingerprint := encode(sha256(convert_to(pg_get_functiondef(v_oid), 'UTF8')), 'hex');

  IF v_expected_fingerprint = 'UNREVIEWED' THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: no reviewed definition pinned. Current deployed fingerprint is sha256:%. Set v_expected_fingerprint after capturing the definition with scripts/capture-rpc.mjs.',
      v_fingerprint;
  END IF;

  IF v_fingerprint <> v_expected_fingerprint THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: provision_church_v3 has changed since review. Pinned %, deployed %. Re-capture and re-review before enforcing.',
      v_expected_fingerprint, v_fingerprint;
  END IF;

  -- Secondary, and only secondary: if the word appears nowhere in the body the
  -- fingerprint review cannot have concluded that it assigns one.
  IF v_body IS NULL OR v_body !~* 'passkey' THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: the reviewed provision_church_v3 body never mentions passkey, so new churches would get none.';
  END IF;

  RAISE NOTICE 'Preconditions satisfied: 0 NULL, 0 blank, one overload (%), fingerprint %.',
    v_signature, left(v_fingerprint, 16);
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
