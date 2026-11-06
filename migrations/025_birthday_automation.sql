-- Birthday wishes — automatic SMS greetings on a member's birthday.
--
-- Three additive objects in the church schema (no existing table, function,
-- policy or grant is altered):
--
--   1. church.birthday_automation        per-church ON/OFF + optional message
--   2. church.enqueue_daily_birthdays()  finds today's birthdays and queues
--                                        one sms_queue row per member, then
--                                        pokes the EXISTING
--                                        church-najiki-dispatch Edge Function
--                                        (claim → wallet debit → Na'jiki → log)
--   3. one pg_cron job, 05:00 UTC        08:00 Africa/Kampala daily
--
-- Designed to be re-runnable: safe on a database that already has all three
-- (the objects this migration mirrors were applied by hand on 2026-11-06).
--
-- One manual prerequisite, per deployment (never in SQL, never in git):
--   SELECT vault.create_secret('<CHURCH_DISPATCH_SECRET value>', 'church_dispatch_secret_birthday');
-- The function reads that Vault entry at send time; the Edge Function keeps
-- verifying the same value from its own environment. Rotate one side, rotate
-- both.
--
-- Nothing is sent until a church opts in:
--   INSERT INTO church.birthday_automation (church_id, enabled)
--   SELECT id, true FROM church.churches WHERE slug = '<slug>'
--   ON CONFLICT (church_id) DO UPDATE SET enabled = true, updated_at = now();
--
-- Privacy: the feature is year-blind. Matching uses month and day only, the
-- message contains no year or age, and lib/birthday.ts rewrites every stored
-- birthday to placeholder year 2000 at the form/import doorway.

BEGIN;

CREATE TABLE IF NOT EXISTS church.birthday_automation (
  church_id uuid PRIMARY KEY REFERENCES church.churches(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  custom_template text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE church.birthday_automation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages birthday automation" ON church.birthday_automation;
CREATE POLICY "Service role manages birthday automation"
  ON church.birthday_automation
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Browsers never read or write this table directly: the settings screen goes
-- through a server action on the service-role connection after a pastor check.
REVOKE ALL ON church.birthday_automation FROM anon, authenticated;

CREATE OR REPLACE FUNCTION church.enqueue_daily_birthdays(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, church, public, net, vault, pg_temp
AS $fn$
DECLARE
  v_today            date;
  v_year             integer;
  v_secret           text := null;
  -- This deployment's Edge Function (verify_jwt=false + x-dispatch-secret).
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
  -- The service runs on Kampala time (Africa/Kampala, UTC+3 all year).
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

  -- Real run: the dispatch secret must exist and decrypt.
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
  SELECT coalesce(array_agg(i.id), ARRAY[]::uuid[]), count(*)::integer
    INTO v_new_ids, v_inserted
  FROM inserted;

  -- Self-heal: birthday rows queued on a previous day that never got dispatched
  -- (e.g. the secret was still missing, or the Edge call failed) get poked
  -- again, bounded to 50 and within 72 hours, respecting attempts/max_attempts.
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
      -- Queued rows stay pending; the next run retries them.
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
$fn$;

REVOKE ALL ON FUNCTION church.enqueue_daily_birthdays(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION church.enqueue_daily_birthdays(boolean) TO service_role;

-- Schedule the daily run — only where pg_cron exists and only once, so a
-- project whose job was renamed or rescheduled by hand is not fought over.
DO $do$
DECLARE
  v_job_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'pg_cron is not installed; schedule the job manually once it is.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_job_count FROM cron.job WHERE jobname = 'birthday-sms-daily-0500utc';
  IF v_job_count = 0 THEN
    PERFORM cron.schedule('birthday-sms-daily-0500utc', '0 5 * * *', $$
      SELECT church.enqueue_daily_birthdays(false)$$);
    RAISE NOTICE 'birthday-sms-daily-0500utc scheduled at 05:00 UTC (08:00 Africa/Kampala).';
  ELSE
    RAISE NOTICE 'birthday-sms-daily-0500utc already exists; leaving it as configured.';
  END IF;
END
$do$;

COMMIT;
