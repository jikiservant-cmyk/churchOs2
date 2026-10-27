-- 014 — Enforce `passkey NOT NULL`, but only when the data and the write paths
--       actually support it.
--
-- Run order: 011 → 012 → capture and review the provisioning chain → 014.
--
-- Three things this migration learned the hard way, each of which changed it:
--
--   1. Provisioning is a CHAIN, not one function. On the live database
--      public.provision_church_v3 is an invoker-mode wrapper that delegates to
--      private.provision_church_v3_impl (SECURITY DEFINER), which calls
--      public.provision_church_v2 (SECURITY DEFINER). Pinning only the wrapper
--      attests to a function that contains no insert at all. This migration
--      therefore pins every routine in the chain and refuses if a pinned body
--      references a routine that was not pinned.
--
--   2. That insert path does not set `passkey` or `passkey_hash`. Making the
--      column NOT NULL without a default turns every future signup into
--      `23502: null value in column "passkey"`. Measured, not assumed:
--
--        passkey NOT NULL + DEFAULT, insert (name, slug)  -> succeeds
--        passkey NOT NULL, no DEFAULT, same insert        -> 23502
--
--      So this migration installs the DEFAULT first.
--
--      A default covers an OMITTED column. It does not cover `NULL` written
--      explicitly, and the difference is not cosmetic — measured on PG 16:
--
--        INSERT (id)             -> default applied
--        INSERT (id, p) VALUES (id, DEFAULT)  -> default applied
--        INSERT (id, p) VALUES (id, 'MINE')   -> value kept
--        INSERT (id, p) VALUES (id, NULL)     -> 23502, default NOT applied
--
--      So the DEFAULT makes NOT NULL safe for an insert that leaves `passkey`
--      out of its column list, and for one that writes DEFAULT. An insert that
--      names the column and passes NULL still fails.
--
--      The deployed v2 was reported to set neither passkey nor passkey_hash,
--      i.e. the omission case, which the default covers. The reviewer should
--      still confirm it that way rather than reading "has a default" as a
--      guarantee about the body: a chain that later writes `passkey = NULL`
--      while rotating would hit 23502 instead of silently blanking the field,
--      which is a better failure but still a failure.
--
--   3. The word "passkey" appearing in a body was a bad gate. It proved nothing
--      and, for a delegating wrapper, could not even be satisfied honestly. It
--      is now an advisory NOTICE only; the DEFAULT is the mechanism.
--
-- Gates, all of which must pass:
--   1. 011 applied.
--   2. No NULL passkeys and no blank ones (012 ran and was verified).
--   3. Exactly one FUNCTION overload of public.provision_church_v3 matches the
--      argument list the app sends.
--   3b. `authenticated` holds EXECUTE — the app calls with the user's token, so
--      a function nobody can call cannot provision anything.
--   4. Every routine in the reviewed chain is pinned by sha256 of its
--      pg_get_functiondef and is unchanged since review.
--   5. No pinned body references an unpinned routine.
--   6. `passkey` has a DEFAULT (installed by this migration if absent).
--
-- Safe to run more than once.

BEGIN;

DO $$
DECLARE
  -- ── Fill this in before running ───────────────────────────────────────────
  -- One entry per routine on the church-insert path, from the capture step:
  --
  --   node scripts/capture-rpc.mjs <dump.sql> --out migrations/013_...sql
  --
  -- An empty array means "nothing reviewed", which refuses. Do not populate
  -- this from a fingerprint alone: the point is that a human read each body.
  v_pins CONSTANT jsonb := '[]'::jsonb;
  -- Example shape (do not uncomment without doing the review):
  -- v_pins CONSTANT jsonb := '[
  --   {"schema":"public", "name":"provision_church_v3",      "args":"p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text", "fingerprint":"…"},
  --   {"schema":"private","name":"provision_church_v3_impl", "args":"p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text", "fingerprint":"…"},
  --   {"schema":"public", "name":"provision_church_v2",      "args":"p_user_id uuid, p_name text, p_slug text, p_role text, p_ip text", "fingerprint":"…"}
  -- ]'::jsonb;

  v_expected_signature CONSTANT text :=
    'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text';

  v_missing_count  integer;
  v_missing_slugs  text;
  v_blank_count    integer;
  v_blank_slugs    text;
  v_overloads      integer;
  v_oid            oid;
  v_pin            jsonb;
  v_schema         text;
  v_name           text;
  v_args           text;
  v_expected       text;
  v_fingerprint    text;
  v_pinned         text[] := '{}';
  v_chain_source   text := '';
  v_unpinned       text[] := '{}';
  v_reached        text[] := '{}';
  v_r              record;
  v_has_default    boolean;
  v_default_expr   text;
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
  -- p.prokind = 'f' counts functions only: pg_proc also holds procedures,
  -- aggregates and window functions under the same name. PostgreSQL forbids a
  -- procedure sharing both name and argument types with a function (42723), so
  -- this does not change the outcome — it makes the diagnosis accurate instead
  -- of blaming the call site.
  SELECT count(*), min(p.oid)
    INTO v_overloads, v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_church_v3'
     AND p.prokind = 'f'
     AND pg_get_function_identity_arguments(p.oid) = v_expected_signature;

  IF v_overloads = 0 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: no function public.provision_church_v3(%) exists. Capture it first (scripts/capture-rpc.mjs).',
      v_expected_signature;
  END IF;

  IF v_overloads > 1 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: % overloads of provision_church_v3 accept the call-site signature. Resolve the ambiguity before trusting this gate.',
      v_overloads;
  END IF;

  -- 3b. The app calls this with the user's token (lib/provision-actions.ts uses
  -- createClient(), not the admin client), so `authenticated` must hold
  -- EXECUTE. The role check keeps this portable to databases without
  -- Supabase's role set.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: authenticated cannot EXECUTE provision_church_v3, so church signup fails for every user. Grant EXECUTE to authenticated.';
  END IF;

  -- 4. Every routine in the chain, pinned by content.
  IF jsonb_array_length(v_pins) = 0 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: no reviewed chain pinned. Provisioning is a chain — public.provision_church_v3 delegates to other routines that perform the insert — so pinning the wrapper alone attests to a function that may contain no insert. Capture and review each routine, then fill v_pins. Routines named like the chain in this database: %',
      coalesce((
        SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY 1)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname LIKE '%provision_church%'
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ), '<none found>');
  END IF;

  FOR v_pin IN SELECT * FROM jsonb_array_elements(v_pins)
  LOOP
    v_schema   := v_pin->>'schema';
    v_name     := v_pin->>'name';
    v_args     := v_pin->>'args';
    v_expected := v_pin->>'fingerprint';

    IF v_schema IS NULL OR v_name IS NULL OR v_args IS NULL
       OR v_expected IS NULL OR v_expected !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION
        'Refusing NOT NULL: malformed pin %. Each entry needs schema, name, args and a 64-character sha256 fingerprint.', v_pin;
    END IF;

    SELECT count(*), min(p.oid)
      INTO v_overloads, v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = v_schema AND p.proname = v_name AND p.prokind = 'f'
       AND pg_get_function_identity_arguments(p.oid) = v_args;

    IF v_overloads = 0 THEN
      RAISE EXCEPTION
        'Refusing NOT NULL: pinned routine %.%(%) does not exist. The chain changed; re-capture and re-review.',
        v_schema, v_name, v_args;
    END IF;
    IF v_overloads > 1 THEN
      RAISE EXCEPTION
        'Refusing NOT NULL: % overloads of %.%(%) match the pin. Resolve the ambiguity.', v_overloads, v_schema, v_name, v_args;
    END IF;

    v_fingerprint := encode(sha256(convert_to(pg_get_functiondef(v_oid), 'UTF8')), 'hex');
    IF v_fingerprint <> v_expected THEN
      RAISE EXCEPTION
        'Refusing NOT NULL: %.% has changed since review. Pinned %, deployed %. Re-capture and re-review.',
        v_schema, v_name, v_expected, v_fingerprint;
    END IF;

    v_pinned := v_pinned || (v_schema || '.' || v_name);
    v_chain_source := v_chain_source || E'\n' || coalesce((SELECT prosrc FROM pg_proc WHERE oid = v_oid), '');
  END LOOP;

  -- 5. Tripwire: nothing reachable from a pinned body may go unpinned.
  --
  --    Transitive, not one hop. Pinning only the wrapper should not merely
  --    reveal the wrapper's callee and then require a second run — the whole
  --    reachable set is walked here, so one failure message names everything
  --    that still needs review.
  --
  --    Over-approximates on purpose: an identifier that merely looks like a
  --    call is reported rather than ignored, because under-reporting means a
  --    pin that does not cover the insert path at all. Each routine is visited
  --    at most once (excluded by v_unpinned), so this terminates.
  LOOP
    v_reached := '{}';
    FOR v_r IN
      SELECT n.nspname AS s, p.proname AS n, p.oid AS o
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prokind = 'f'
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\_%'
         AND (n.nspname || '.' || p.proname) <> ALL (v_pinned)
         AND (n.nspname || '.' || p.proname) <> ALL (v_unpinned)
         AND v_chain_source ~* (E'\\y' || p.proname || E'\\y[[:space:]]*\\(')
    LOOP
      v_unpinned := v_unpinned || (v_r.s || '.' || v_r.n);
      v_reached  := v_reached  || (v_r.s || '.' || v_r.n);
      v_chain_source := v_chain_source || E'\n' || coalesce((SELECT prosrc FROM pg_proc WHERE oid = v_r.o), '');
    END LOOP;
    EXIT WHEN coalesce(array_length(v_reached, 1), 0) = 0;
  END LOOP;

  IF array_length(v_unpinned, 1) > 0 THEN
    RAISE EXCEPTION
      'Refusing NOT NULL: the reviewed chain calls routines that were not reviewed: %. Capture and pin them too, or the pin does not attest to the church-insert path. (If one of these is an identifier that merely looks like a call, pin it anyway — this tripwire is deliberately noisy.)',
      array_to_string(v_unpinned, ', ');
  END IF;

  -- 6. The mechanism that actually makes NOT NULL safe: a default on the
  --    column, so an insert that omits `passkey` still succeeds.
  SELECT column_default IS NOT NULL, column_default
    INTO v_has_default, v_default_expr
    FROM information_schema.columns
   WHERE table_schema = 'church' AND table_name = 'churches'
     AND column_name = 'passkey';

  IF NOT coalesce(v_has_default, false) THEN
    ALTER TABLE church.churches
      ALTER COLUMN passkey SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    RAISE NOTICE 'passkey had no DEFAULT; installed a random 10-hex default so inserts that omit it still succeed.';
  END IF;

  IF v_chain_source !~* 'passkey' THEN
    RAISE NOTICE 'Advisory: no pinned routine mentions passkey. Fine for an insert that omits the column — the DEFAULT covers it. An insert that writes NULL explicitly would still fail 23502; check the chain does not do that.';
  ELSIF v_chain_source ~* 'passkey[[:space:]]*(,|\))?[[:space:]]*[^;]{0,40}\yNULL\y' THEN
    RAISE NOTICE 'Advisory: a pinned routine appears to write NULL to passkey. A DEFAULT does not apply to an explicit NULL, so NOT NULL would reject that path with 23502. Confirm this is not on the insert path.';
  END IF;

  RAISE NOTICE 'Preconditions satisfied: 0 NULL, 0 blank, % chain routine(s) verified, passkey has a DEFAULT.',
    array_length(v_pinned, 1);
END $$;

ALTER TABLE church.churches ALTER COLUMN passkey SET NOT NULL;

COMMIT;

-- Confirm. `passkey_default` must not be null, or future signups will fail.
SELECT count(*)                                   AS churches,
       count(*) FILTER (WHERE trim(passkey) = '') AS still_blank,
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'church' AND table_name = 'churches'
           AND column_name = 'passkey')           AS passkey_nullable,
       (SELECT column_default FROM information_schema.columns
         WHERE table_schema = 'church' AND table_name = 'churches'
           AND column_name = 'passkey')           AS passkey_default
  FROM church.churches;
