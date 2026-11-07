-- 026_live_alignment.sql — bring pre-existing databases up to the canonical
-- state after the 2026-11-06/07 live-fire repair on the production project.
--
-- Fresh installs built from supabase-schema.sql already satisfy most of this
-- file; every statement is idempotent so running it on either kind of database
-- is safe. It exists so the production database and the repo cannot drift the
-- way they had (the nightly flag crons failed every night with "Tenant access
-- denied" and the birthday cron fired inside the SMS dead window until this
-- alignment was applied).
--
-- What this fixes, in order:
--   1. attendance_flag_type enum gains 'missed_consecutive_events' (the streak
--      engine's flag type; live DB was missing it and the engine could not run).
--   2. attendance_flags.notes column guard (flag notes carry the live streak,
--      e.g. "missed 4 consecutive events").
--   3. Unique-constraint swap: legacy UNIQUE(member_id, flag_type) shadowed
--      flags across tenants; canonical shape is per-tenant
--      UNIQUE(church_id, member_id, flag_type).
--   4. refresh_inactive_30_days: canonical headless-safe body (nightly pg_cron
--      calls it with no JWT; the old live body raised "Tenant access denied")
--      plus ON CONFLICT DO NOTHING so legacy resolved rows or a concurrent
--      rerun can never crash the nightly insert.
--   5. enqueue_daily_birthdays: fixes the unaliased `i.id` reference (orphan
--      "i" made real birthday runs fail with 42P01), and adds the retry
--      exclusion `AND NOT (q.id = ANY (v_new_ids))` so rows just enqueued this
--      run are not re-poked (they were just dispatched; re-poking wasted an
--      HTTP call per row even though the claim is atomic).
--   6. Birthday cron moves 05:00 -> 06:00 UTC (09:00 Kampala). The mobile
--      network operator's sender filter rejects SMS from the shared sender
--      roughly between 20:00 and 08:00 Kampala (verified live: 03:37/03:46
--      sends failed at the operator, 08:55 delivered). 09:00 Kampala sits a
--      full hour inside the proven-safe window; 08:00:00 sharp was a
--      boundary coin-flip.

-- 1. Streak-engine flag type -------------------------------------------------
ALTER TYPE church.attendance_flag_type ADD VALUE IF NOT EXISTS 'missed_consecutive_events';

-- 2. Flag notes column -------------------------------------------------------
ALTER TABLE church.attendance_flags ADD COLUMN IF NOT EXISTS notes text;

-- 3. Unique constraint alignment ---------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flags_tenant_member_type_uniq') THEN
    ALTER TABLE church.attendance_flags
      DROP CONSTRAINT IF EXISTS attendance_flags_member_id_flag_type_key;
    ALTER TABLE church.attendance_flags
      ADD CONSTRAINT flags_tenant_member_type_uniq UNIQUE (church_id, member_id, flag_type);
  END IF;
END;
$do$;

-- 4. Inactivity engine — canonical body + conflict tolerance ------------------
CREATE OR REPLACE FUNCTION church.refresh_inactive_30_days(p_church_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = church, public, auth
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer := 0;
BEGIN
  IF p_church_id IS NULL THEN
    RAISE EXCEPTION 'Church ID is required';
  END IF;

  IF auth.uid() IS NOT NULL AND p_church_id IS DISTINCT FROM church.my_tenant_id() THEN
    RAISE EXCEPTION 'Unauthorized: cross-tenant access denied';
  END IF;

  -- Remove existing open flags for this church/type/members that are no longer inactive
  DELETE FROM church.attendance_flags f
  USING church.members m
  WHERE f.church_id = p_church_id
    AND f.flag_type = 'inactive_30_days'::church.attendance_flag_type
    AND f.member_id = m.id
    AND (
      -- Member has at least one present/late check-in in the last 30 days
      EXISTS (
        SELECT 1
        FROM church.attendance_logs al
        JOIN church.events e ON e.id = al.event_id
        WHERE al.member_id = m.id
          AND al.attendance_status IN ('present','late')
          AND e.event_date >= (CURRENT_DATE - 30)
          AND al.church_id = p_church_id
      )
    );

  -- Insert (or reopen) inactive flags for members who currently have no present/late logs
  WITH inactive_members AS (
    SELECT m.id AS member_id, p_church_id AS church_id
    FROM church.members m
    WHERE m.church_id = p_church_id
      AND NOT EXISTS (
        SELECT 1
        FROM church.attendance_logs al
        JOIN church.events e ON e.id = al.event_id
        WHERE al.member_id = m.id
          AND al.attendance_status IN ('present','late')
          AND e.event_date >= (CURRENT_DATE - 30)
          AND al.church_id = p_church_id
      )
  )
  INSERT INTO church.attendance_flags (id, church_id, member_id, flag_type, status, created_at)
  SELECT gen_random_uuid(), im.church_id, im.member_id,
         'inactive_30_days'::church.attendance_flag_type,
         'open'::church.attendance_flag_status,
         v_now
  FROM inactive_members im
  WHERE NOT EXISTS (
    SELECT 1
    FROM church.attendance_flags f
    WHERE f.church_id = im.church_id
      AND f.member_id = im.member_id
      AND f.flag_type = 'inactive_30_days'::church.attendance_flag_type
      AND f.status = 'open'::church.attendance_flag_status
  )
  ON CONFLICT (church_id, member_id, flag_type) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION church.refresh_inactive_30_days(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION church.refresh_inactive_30_days(uuid) TO authenticated, service_role;

-- 5. Birthday enqueue — alias fix + retry exclusion ---------------------------
CREATE OR REPLACE FUNCTION church.enqueue_daily_birthdays(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = church, public, vault, extensions
AS $$
DECLARE
  v_today            date;
  v_year             integer;
  v_secret           text := null;
  v_dispatch_url     constant text := 'https://vzvtirgkjvhnnqwmpsbj.supabase.co/functions/v1/church-najiki-dispatch';
  v_default_template constant text := 'Happy Birthday {name}! Everyone at {church} celebrates you today. May God bless you with joy, good health and a blessed year ahead.';
  v_new_ids          uuid[] := ARRAY[]::uuid[];
  v_retry_ids        uuid[] := ARRAY[]::uuid[];
  v_all_ids          uuid[] := ARRAY[]::uuid[];
  v_inserted         integer := 0;
  v_dispatched       integer := 0;
  v_preview          jsonb := '[]'::jsonb;
  v_id               uuid;
BEGIN
  v_today := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_year  := date_part('year', v_today)::integer;

  IF p_dry_run THEN
    WITH candidates AS (
      SELECT c.id AS church_id, c.slug AS church_slug, c.name AS church_name,
             c.sender_id, m.id AS member_id, m.full_name,
             btrim(m.phone_number) AS phone,
             coalesce(nullif(btrim(coalesce(ba.custom_template, '')), ''), v_default_template) AS template
      FROM church.churches c
      JOIN church.birthday_automation ba ON ba.church_id = c.id AND ba.enabled
      JOIN church.members m ON m.church_id = c.id
      WHERE c.activation_status = 'active'
        AND m.birthday IS NOT NULL
        AND coalesce(btrim(m.phone_number), '') <> ''
        AND date_part('month', m.birthday) = date_part('month', v_today)
        AND (   date_part('day', m.birthday) = date_part('day', v_today)
             OR (date_part('month', m.birthday) = 2 AND date_part('day', m.birthday) = 29
                 AND date_part('day', v_today) = 28
                 AND (v_year % 4 <> 0 OR (v_year % 100 = 0 AND v_year % 400 <> 0))))
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'church',   t.church_slug,
                     'member',   t.full_name,
                     'phone_last3', right(t.phone, 3),
                     'message',  replace(replace(t.template, '{name}', t.full_name), '{church}', t.church_name)
                   ) ORDER BY t.church_slug, t.full_name), '[]'::jsonb)
      INTO v_preview
      FROM candidates t;

    RETURN jsonb_build_object(
      'dry_run',      true,
      'kampala_date', v_today,
      'would_send',   jsonb_array_length(v_preview),
      'preview',      v_preview,
      'note',         'dry run: nothing was written and nothing was sent'
    );
  END IF;

  SELECT s.decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets s
  WHERE s.name = 'church_dispatch_secret_birthday'
  LIMIT 1;

  WITH candidates AS (
    SELECT c.id AS church_id, c.name AS church_name, c.sender_id,
           m.id AS member_id, m.full_name,
           btrim(m.phone_number) AS phone,
           coalesce(nullif(btrim(coalesce(ba.custom_template, '')), ''), v_default_template) AS template
    FROM church.churches c
    JOIN church.birthday_automation ba ON ba.church_id = c.id AND ba.enabled
    JOIN church.members m ON m.church_id = c.id
    WHERE c.activation_status = 'active'
      AND m.birthday IS NOT NULL
      AND coalesce(btrim(m.phone_number), '') <> ''
      AND date_part('month', m.birthday) = date_part('month', v_today)
      AND (   date_part('day', m.birthday) = date_part('day', v_today)
           OR (date_part('month', m.birthday) = 2 AND date_part('day', m.birthday) = 29
               AND date_part('day', v_today) = 28
               AND (v_year % 4 <> 0 OR (v_year % 100 = 0 AND v_year % 400 <> 0))))
  ),
  inserted AS (
    INSERT INTO church.sms_queue
          (tenant_id, recipient_phone, body, sender_id, idempotency_key, status, scheduled_at)
    SELECT t.church_id, t.phone,
           replace(replace(t.template, '{name}', t.full_name), '{church}', t.church_name),
           t.sender_id,
           'bday:' || t.member_id::text || ':' || v_year::text,
           'pending', now()
    FROM candidates t
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  )
  SELECT coalesce(array_agg(ins.id), ARRAY[]::uuid[]), count(*)::integer
    INTO v_new_ids, v_inserted
  FROM inserted ins;

  -- Retry only rows from PREVIOUS runs: the rows inserted above were just
  -- poked once, and the dispatcher's claim is atomic, so re-poking them is a
  -- wasted call even though it can never double-send or double-charge.
  SELECT coalesce(array_agg(q.id), ARRAY[]::uuid[])
    INTO v_retry_ids
  FROM (
    SELECT q.id
    FROM church.sms_queue q
    WHERE q.idempotency_key LIKE 'bday:%'
      AND q.status = 'pending'
      AND q.scheduled_at <= now()
      AND q.created_at >= now() - interval '72 hours'
      AND q.attempts < q.max_attempts
      AND NOT (q.id = ANY (v_new_ids))
    ORDER BY q.scheduled_at
    LIMIT 50
  ) q;

  v_all_ids := v_new_ids || v_retry_ids;

  IF coalesce(array_length(v_all_ids, 1), 0) > 0 THEN
    IF v_secret IS NULL THEN
      RETURN jsonb_build_object(
        'ok', true, 'dry_run', false, 'kampala_date', v_today,
        'enqueued', v_inserted, 'dispatched', 0,
        'warning', 'rows queued but NOT dispatched: vault secret church_dispatch_secret_birthday missing or unreadable'
      );
    END IF;

    BEGIN
      FOREACH v_id IN ARRAY v_all_ids LOOP
        PERFORM net.http_post(
          url     => v_dispatch_url,
          body    => jsonb_build_object('sms_id', v_id),
          headers => jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', v_secret),
          timeout_milliseconds => 8000
        );
        v_dispatched := v_dispatched + 1;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'birthday dispatch loop stopped early: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok',            true,
    'dry_run',       false,
    'kampala_date',  v_today,
    'enqueued',      v_inserted,
    'retried',       coalesce(array_length(v_retry_ids, 1), 0),
    'dispatched',    v_dispatched,
    'secret_present',(v_secret IS NOT NULL)
  );
END
$$;

REVOKE EXECUTE ON FUNCTION church.enqueue_daily_birthdays(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION church.enqueue_daily_birthdays(boolean) TO service_role;

-- 6. Birthday cron -> 09:00 Kampala (06:00 UTC) --------------------------------
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Retire the old 05:00 UTC schedule by name if a previous migration left it.
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'birthday-sms-daily-0500utc';
    -- And the new name, so re-running this migration never duplicates the job.
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'birthday-sms-daily-0600utc';

    PERFORM cron.schedule(
      'birthday-sms-daily-0600utc',
      '0 6 * * *',
      'SELECT church.enqueue_daily_birthdays(false)'
    );
  ELSE
    RAISE NOTICE 'pg_cron not available; birthday schedule skipped.';
  END IF;
END;
$do$;
