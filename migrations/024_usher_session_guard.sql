-- ============================================================================
-- 024 · The two usher-session functions this repository has never seen.
--       DEFAULT ACTION: REPORT ONLY. Nothing in this file changes a privilege
--       until an operator flips one constant by hand.
--
-- WHY IT IS READ-ONLY BY DEFAULT: these functions WRITE, an usher kiosk or app
-- outside this repository could be calling them in the middle of a service, and
-- the whole point of this review has been not to break a live church's flows in
-- order to tighten a hole nobody is walking through. So the migration measures,
-- reports, and refuses; the decision stays with whoever can see the clients.
--
-- WHAT IS KNOWN (measured on the live project 2026-11-02, read-only):
--   * church.create_usher_session  — SECURITY DEFINER, executable by `anon`. It checks the
--     passkey, then accepts a caller-provided session token, a caller-provided expiry and a
--     caller-provided event id. It does not cap the expiry and does not verify that the event
--     belongs to the church whose passkey was just presented.
--   * church.get_usher_session     — SECURITY DEFINER, executable by `anon`. Returns the
--     stored session for a token.
--   * Neither name exists in this repository. `grep -rn create_usher_session app lib
--     components` → 0 hits, same for get_usher_session. The application runs its own usher
--     sessions instead: an `usher_session_<slug>` cookie plus lib/usher-passkey.ts, with the
--     attempt limits in lib/attendance-actions.ts. So the database holds a parallel
--     implementation of a mechanism the app already has, and nobody here reads it.
--
-- WHY THAT IS WORTH ACTING ON, stated as precisely as the evidence allows:
--   * It is passkey-checked, so a stranger still needs the church's code. This is not open
--     access, and it is not a substitute for the P1-7 column exposure either.
--   * A caller-chosen token with an uncapped expiry weakens rotation: the pastor can change
--     the passkey on the attendance screen and a session issued with an expiry in 2099 keeps
--     working until its own expiry says otherwise. How much that matters depends on whether
--     anything consumes those rows — which is what the freshness report below is for.
--   * An event id accepted without checking it belongs to the church is a cross-tenant write
--     on the row that binds a session to an event. If nothing reads that field it is a
--     data-integrity problem rather than an access one; if something does, it is the class of
--     bug this review has been calling the hard part. I cannot tell which from here, and I am
--     not going to guess in a migration that revokes privileges.
--   * Browser reachability is still UNVERIFIED. `church` grants USAGE to `anon` and 131
--     browser-role call sites use .schema("church"), which implies the schema is in the API's
--     exposed list; the catalogs hold no pgrst settings to confirm it (measured 2026-11-02).
--     Settle it with a request, not a grant list:
--       curl -s "$SUPABASE_URL/rest/v1/churches?select=id&limit=0" \
--            -H "apikey: $ANON_KEY" -H 'Accept-Profile: __nope__'
--     PostgREST answers with PGRST106 and, in that build, names the schemas it will accept.
--
-- THE DECISION, in the order that cannot break anything:
--   1. Run this file as it stands. It reports the exact signatures it found, who can execute
--      them, which session table it located, and how recently that table was written.
--   2. If nothing outside this repository uses them and the table is empty or stale, set
--      v_apply to true below and re-run: that revokes browser EXECUTE and preserves service_role.
--   3. If something does use them, the answer is not a revoke. It is three reviewed lines
--      inside the function, put under version control: generate the token in the database,
--      cap it with `LEAST(p_expires_at, now() + interval '12 hours')`, and refuse the event id
--      unless it belongs to the church row the passkey just matched.
--   Rollback of step 2, per function:
--     GRANT EXECUTE ON FUNCTION church.create_usher_session(<args>) TO anon, authenticated;
--     GRANT EXECUTE ON FUNCTION church.get_usher_session(<args>)   TO anon, authenticated;
-- ============================================================================

begin;

create temp table if not exists _024_report (item text not null, detail text not null);
truncate _024_report;

do $$
declare
  -- The switch. Everything else in this file is a guard around it.
  v_apply        constant boolean := false;
  v_stale_days   constant int     := 30;
  v_names        constant text[]  := array['create_usher_session', 'get_usher_session'];
  v_stamp_cols   constant text[]  := array['last_used_at', 'updated_at', 'created_at', 'issued_at'];

  r              record;
  v_seen         int := 0;
  v_policy_hits  text;
  v_callers      text;
  v_rel          text;
  v_stamp        text;
  v_rows         bigint;
  v_newest       timestamptz;
  v_fresh        boolean;
  v_oid          oid;
  v_sr           oid;
begin
  v_sr := to_regrole('service_role');

  -- Guard 1 · before anything else, for all targets together. A row-policy predicate that calls
  -- one of these names makes the function part of RLS, and a policy is evaluated as the table's
  -- reader — so a revoke there breaks ordinary SELECTs, a worse outcome than an unhardened spare
  -- function. With v_apply false this is reported rather than fatal, because being able to
  -- measure the situation is the entire point of the default.
  select string_agg(x, '; ' order by x) into v_policy_hits
    from (
      select n2.nspname || '.' || c.relname || ' · ' || p2.polname || ' calls ' || fn.name as x
        from pg_policy p2
        join pg_class c on c.oid = p2.polrelid
        join pg_namespace n2 on n2.oid = c.relnamespace
        cross join unnest(v_names) as fn(name)
       where n2.nspname in ('church', 'public', 'private', 'business')
         and (coalesce(pg_get_expr(p2.polqual, c.oid), '') || ' '
              || coalesce(pg_get_expr(p2.polwithcheck, c.oid), '')) like '%' || fn.name || '%'
    ) y;

  if v_policy_hits is not null then
    if v_apply then
      raise exception
        '024 stops here: a row-policy predicate calls one of these functions (%). That makes it part of RLS rather than a spare API, and policies are evaluated as the table reader, so a revoke would break ordinary reads on those tables. Fix the policy first — and update SECURITY_REVIEW-2026-10-30.md P1-10, because this file assumed none of them were policy predicates.',
        v_policy_hits;
    end if;
    insert into _024_report values
      ('policy dependency', v_policy_hits
       || ' — a revoke is off the table while a policy calls it, apply or not. This is the finding: '
       || 'these functions are inside RLS, not beside it.');
  end if;

  for r in
    select p.oid, n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           p.prosecdef,
           coalesce(array_to_string(p.proconfig, ', '), '(no search_path)') as settings,
           has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as member_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.proname = any (v_names)
       and n.nspname in ('church', 'public', 'private', 'business')
       and p.prokind = 'f'
     order by n.nspname, p.proname, args
  loop
    v_seen := v_seen + 1;
    v_oid := r.oid;

    insert into _024_report values
      (format('%I.%I(%s)', r.nspname, r.proname, r.args),
       -- %s on a boolean renders t/f, which reads like a typo in a report an operator has to
       -- make a decision from, so every flag is spelled out.
       format('%s · %s · anon %s · authenticated %s',
              case when r.prosecdef then 'SECURITY DEFINER (runs as the owner)'
                   else 'invoker (RLS applies to its reads)' end,
              r.settings,
              case when r.anon_exec then 'CAN execute' else 'cannot execute' end,
              case when r.member_exec then 'CAN execute' else 'cannot execute' end));

    -- Guard 1 runs above the loop, across every target at once. It is the highest-severity fact
    -- in this file, and an operator should not have to work through the staleness question first
    -- to discover that the function is part of RLS.

    -- Report, never block: an invoker function that calls this one inherits the caller's need
    -- for EXECUTE, so a chain that works today could fail quietly after a revoke.
    select string_agg(x, ', ' order by x) into v_callers
      from (
        select format('%I.%I', n3.nspname, p3.proname) as x
          from pg_proc p3
          join pg_namespace n3 on n3.oid = p3.pronamespace
         where p3.oid <> v_oid
           and p3.prokind = 'f'
           and not p3.prosecdef
           and n3.nspname in ('church', 'public', 'private', 'business')
           and pg_get_functiondef(p3.oid) like '%' || r.proname || '('
      ) z;
    if v_callers is not null then
      insert into _024_report values
        (format('%I.%I(%s) · callers', r.nspname, r.proname, r.args),
         'invoker functions that reference it, read these before trusting a revoke: ' || v_callers);
    end if;

    -- The usage evidence. plpgsql dependencies are not in pg_depend, so the session table is
    -- located by name and then measured, rather than assumed from a model of the flow.
    select format('%I.%I', n4.nspname, c4.relname),
           (select a.attname
              from pg_attribute a
             where a.attrelid = c4.oid
               and a.attname = any (v_stamp_cols)
             order by array_position(v_stamp_cols, a.attname)
             limit 1)
      into v_rel, v_stamp
      from pg_class c4
      join pg_namespace n4 on n4.oid = c4.relnamespace
     where c4.relkind in ('r', 'p')
       and n4.nspname in ('church', 'public', 'private', 'business')
       and (c4.relname ilike '%usher_session%' or c4.relname ilike '%usher_token%')
     order by 1
     limit 1;

    if v_rel is null then
      insert into _024_report values
        (format('%I.%I(%s) · usage', r.nspname, r.proname, r.args),
         'no table named like an usher session or token was found in church/public/private/business, '
         || 'so "is anything reading this" cannot be answered from the catalogs. Ask the clients.');
      v_fresh := true;   -- unknown is treated as live, which is the only safe default
    elsif v_stamp is null then
      execute format('select count(*)::bigint from %s', v_rel) into v_rows;
      insert into _024_report values
        (format('%I.%I(%s) · usage', r.nspname, r.proname, r.args),
         format('%s holds %s row(s) and has no %s-style column, so recency is unmeasurable — treat it as live',
                v_rel, v_rows, 'timestamp'));
      v_fresh := true;
    else
      execute format('select count(*)::bigint, max(%I) from %s', v_stamp, v_rel)
        into v_rows, v_newest;
      v_fresh := v_rows > 0 and v_newest > now() - make_interval(days => v_stale_days);
      insert into _024_report values
        (format('%I.%I(%s) · usage', r.nspname, r.proname, r.args),
         format('%s: %s row(s), newest %s is %s than the %s-day staleness window',
                v_rel, v_rows, coalesce(v_newest::text, '(none)'),
                case when v_fresh then 'NEWER' else 'older or absent' end, v_stale_days));
    end if;

    if not v_apply then
      insert into _024_report values
        (format('%I.%I(%s) · decision', r.nspname, r.proname, r.args),
         'v_apply is false, so nothing was revoked. Set it to true and re-run only if the usage '
         || 'line above shows the table empty or stale and you have confirmed no client outside this '
         || 'repository calls this function.');
      continue;
    end if;

    if v_fresh then
      raise exception
        '024 refuses to revoke % on a function whose session table was written inside % days. Someone is using it: fix the three lines inside the body instead (token generated in the database, expiry capped with LEAST(now() + interval ''12 hours''), event id checked against the church the passkey matched), and keep this file as the audit trail.',
        format('%I.%I(%s)', r.nspname, r.proname, r.args), v_stale_days;
    end if;

    -- %s with a hand-built signature string parses as SQL and trips over the type names; the
    -- oid is the identity, and oid::regprocedure renders it quoted and complete.
    execute format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
                   v_oid::regprocedure);
    if v_sr is not null then
      execute format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_oid::regprocedure);
    end if;

    if has_function_privilege('anon', v_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception
        '024 failed: % is still executable by a browser role after the revoke. Something granted it outside this file — a group role, most likely, since has_function_privilege resolves membership while information_schema does not. Revoke on THAT role; do not edit this check.',
        format('%I.%I(%s)', r.nspname, r.proname, r.args);
    end if;
    if v_sr is not null and not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception
        '024 failed: service_role lost EXECUTE on %, which the deletion and attendance paths need. Nothing was committed.', format('%I.%I(%s)', r.nspname, r.proname, r.args);
    end if;

    insert into _024_report values
      (format('%I.%I(%s) · applied', r.nspname, r.proname, r.args),
       'browser roles can no longer execute it; service_role kept its grant');
  end loop;

  if v_seen = 0 then
    insert into _024_report values
      ('absent', 'neither church.create_usher_session nor church.get_usher_session exists in this '
       || 'database — nothing to revoke, and if this is the live project, the drift report in '
       || 'SECURITY_REVIEW-2026-10-30.md P1-10 needs updating');
  end if;
end;
$$;

-- The report is the product of this file. Supabase's SQL editor shows the last result set.
select item, detail from _024_report order by 1;

commit;
