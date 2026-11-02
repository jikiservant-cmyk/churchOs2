-- ============================================================================
-- 023 · SECURITY DEFINER routines: pin the search_path that is unpinned, and
--       take the browser roles away from two functions this application never calls.
--
-- WHEN TO RUN: any time. This file needs no deploy, changes no row, no policy and
--              no column privilege, and it never rewrites a function body. Run it
--              before or after 022; the two do not interact.
--
-- WHY (measured on the live project, read-only, 2026-11-02):
--   * 66 SECURITY DEFINER routines exist across public, church, private and business.
--     63 of them pin their own search_path. Three do not:
--         church.is_pastor
--         church.messages_broadcast_trigger
--         church.delete_church_tenant_cascade
--     An unpinned search_path means the function resolves every unqualified name
--     through whatever path its CALLER chose — including the caller's temporary
--     schema, which is writable by any connection. That is the standard search_path
--     attack on definer functions, and it is why the other 63 pin one. The retrieved
--     bodies of these three reference schema-qualified application objects, so this is
--     recorded as a hardening gap and not as an exploit — a distinction that matters,
--     because Part A below only automates the case where the catalog proves the body
--     has no unqualified relation reference to exploit.
--   * `anon` can execute church.validate_usher_passkey and the two church usher-session
--     functions this repository has never seen. The validator is dead exposure for the
--     browser roles: the usher portal does not call it. It compares the code in TypeScript
--     on the service-role client (lib/usher-passkey.ts:123
--     `adminClient.schema('church').from('churches')`), and
--     `grep -rn validate_usher_passkey app lib components` returns nothing. And
--     supabase-schema.sql:741-742 and :1524-1527 ALREADY say, for exactly these three
--     signatures, `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO
--     service_role`. So Part B is not a new policy; it applies the policy this
--     repository already documents to a database that drifted away from it.
--
-- TWO GUARDS, BOTH FAIL-CLOSED:
--   Part A refuses to pin a function whose body has an unqualified reference that
--   resolves to a real relation, because pinning could change which object it finds.
--   Such functions are reported for a reviewed edit instead, never touched.
--   Part B refuses to revoke a function that any row-policy predicate in the database
--   mentions — production has policies this repository does not, and a policy that
--   calls the function is evaluated as the table's reader, so a revoke would break
--   ordinary SELECTs on that table. 022's step 1 checks the same way.
--
-- ============================================================================
-- APPLIED · 2026-11-02, on the live project, in a corrected hand-run form. What
-- this file claimed versus what the database actually contains:
--
--   * Pinned, to `search_path = pg_catalog, pg_temp`: church.is_pastor(),
--     church.messages_broadcast_trigger(), church.delete_church_tenant_cascade().
--     Every one of those bodies is schema-qualified today, so the pin changes no
--     resolution. One difference of substance from Part A below: this file deliberately
--     omits pg_temp from its list, while the applied pin puts it last. For a qualified
--     body the two are equivalent; they stop being equivalent the day an unqualified
--     reference appears, because a path containing pg_temp lets a caller's temporary
--     object win. Recorded rather than argued: church.is_pastor() is used by live RLS
--     policies, so tightening its path is a policy-behaviour change and needs the same
--     care the first time around.
--   * `church.delete_church_tenant_cascade(uuid)` — the signature this file (and
--     supabase-schema.sql:743) names — **does not exist in the live database**. The live
--     function of that name is a zero-argument trigger function, and it is that one whose
--     browser EXECUTE was revoked. So the repository's revoke at :743-744 has never
--     reached production's function, and re-running the schema file would not fix it
--     either: it would add an overload next to the trigger rather than change it. Both
--     spellings are in Part B's list now, and the null-skip below is why a wrong
--     signature produced a report line instead of a failed migration.
--   * `public.validate_usher_passkey(text,text)` is absent from the live database
--     entirely; the surviving `church.validate_usher_passkey(text,text)` wrapper calls that
--     missing function, so it would error if anything invoked it. Revoking it therefore
--     closes exposure without a downside, and is more evidence for the grep: nothing in
--     this application has depended on that path.
--   * The policy guard found no policy referencing either revoke target, the cascade
--     trigger stayed enabled, and `authenticated` still executes church.is_pastor() —
--     which is what proved the live policies use it.
--
-- Re-running this file is safe: the three pinned functions no longer match the "has no
-- search_path" filter, and the two absent signatures land in the `skipped` report.
-- ============================================================================

-- If either part aborts, nothing is committed — and in a client that keeps the failed
-- transaction open (psql does), issue ROLLBACK; before trying again.
--
-- ROLLBACK, one statement per function, if Part B turns out to be wrong about a caller
-- outside this repository:
--   GRANT EXECUTE ON FUNCTION church.validate_usher_passkey(text,text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.validate_usher_passkey(text,text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION church.delete_church_tenant_cascade() TO anon, authenticated;
--   (and the same for the (uuid) overload, where it exists)
-- A search_path pin is reverted with, per function:
--   ALTER FUNCTION <schema>.<name>(<args>) RESET search_path;
-- ============================================================================

begin;

-- The oids travel with the names so the verification step compares identities rather
-- than matching on function names, which two overloads share.
create temp table if not exists _023_pinned   (oid oid primary key, function text not null, was text);
create temp table if not exists _023_deferred (oid oid primary key, function text not null, reason text not null, detail text);
create temp table if not exists _023_acl      (function text not null, action text not null, detail text);

-- Re-running 023 in one session must report this run, not the last one, and the pinned
-- table's primary key would otherwise collide with its own leftovers.
truncate _023_pinned, _023_deferred, _023_acl;

-- ----------------------------------------------------------------------------
-- PART A · pin search_path on definer routines that have none, where the body
--          is provably indifferent to the path.
-- ----------------------------------------------------------------------------
do $$
declare
  v_path     constant text := 'pg_catalog, public, church, private, business, extensions';
  r          record;
  v_body     text;
  v_unq      text;
  v_kind     text;
begin
  -- Name resolution inside this block must use the same list the functions will get,
  -- otherwise "this unqualified name resolves" is tested against the wrong path.
  perform set_config('search_path', v_path, true);

  for r in
    select p.oid, n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           case p.prokind when 'p' then 'PROCEDURE' else 'FUNCTION' end as kind,
           pg_get_userbyid(p.proowner) as owner,
           coalesce(array_to_string(p.proconfig, ', '), '(none)') as settings
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef
       and n.nspname in ('public', 'church', 'private', 'business')
       -- aggregates and window functions take no SET clause, and they are not the
       -- shape that reads tables on someone else's behalf anyway
       and p.prokind in ('f', 'p')
       and not exists (
             select 1 from unnest(p.proconfig) as c
              where c like 'search_path=%' or c like 'search_path =%'
           )
       -- leave anything installed by an extension alone: it is owned by that
       -- extension's script and a pin here would be lost, or worse, unexpected
       and not exists (
             select 1 from pg_depend d
              where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
           )
     order by n.nspname, p.proname, args
  loop
    v_kind := r.kind;
    if not pg_has_role(current_user, r.owner, 'MEMBER') then
      raise exception
        '023 PART A cannot alter %.%(%): it is owned by % and the current role % is not a member of that role. Run this as the owner (the dashboard SQL editor runs as postgres).',
        r.nspname, r.proname, r.args, r.owner, current_user;
    end if;

    v_body := pg_get_functiondef(r.oid);

    -- Any unqualified name that resolves to a real relation on the path we are about
    -- to pin is a reason to stop. plpgsql bodies are not tracked in pg_depend, so the
    -- body text is the only evidence available, and `to_regclass` is what turns a
    -- guess into a catalog fact: a captured word that names no relation (a plpgsql
    -- variable in `SELECT x INTO y`, a set-returning function after FROM) resolves to
    -- NULL and is not a reason to defer.
    select string_agg(distinct m[1], ', ' order by m[1])
      into v_unq
      from (
            select regexp_matches(lower(v_body),
                   '(?:from|join|update|into)[[:space:]]+([a-z_][a-z0-9_$]*)', 'g') as m
           ) q
     where m[1] not in ('lateral', 'only', 'values', 'select', 'unnest', 'if', 'case')
       and to_regclass(m[1]) is not null;

    if v_unq is not null then
      insert into _023_deferred values
        (r.oid, format('%I.%I(%s)', r.nspname, r.proname, r.args),
         'body reads at least one relation unqualified',
         'unqualified names that resolve today: ' || v_unq
         || ' — qualify them in a reviewed edit and re-run 023; pinning the path from here '
         || 'could change which object the body finds, which is the opposite of hardening');
      continue;
    end if;

    -- %I on the names, %s only on the two constants this file defines: the argument list is
    -- already quoted by pg_get_function_identity_arguments() and v_path is a literal above, so
    -- nothing here is data-driven. A quoted v_path would also work but stores as
    -- search_path="a, b", which is not how the 63 already-pinned routines read in the catalog.
    execute format('ALTER %s %I.%I(%s) SET search_path = %s',
                   v_kind, r.nspname, r.proname, r.args, v_path);

    insert into _023_pinned values (r.oid, format('%I.%I(%s)', r.nspname, r.proname, r.args), r.settings);
  end loop;

  perform set_config('search_path', 'pg_catalog, public', true);
end;
$$;

-- What Part A changed must be verifiable, not assumed: no eligible routine may be left
-- unpinned, pg_temp must not have crept into any of the pins, and every deferral must
-- carry a reason a human can act on.
do $$
declare
  v_left      int;
  v_bad       int;
  v_pinned    int;
  v_deferred  int;
begin
  select count(*) into v_pinned   from _023_pinned;
  select count(*) into v_deferred from _023_deferred;

  select count(*) into v_left
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname in ('public','church','private','business')
     and p.prokind in ('f','p')
     and not exists (select 1 from unnest(p.proconfig) c
                      where c like 'search_path=%' or c like 'search_path =%')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
     -- a deliberately deferred function is not "left unpinned"; `not exists`, never
     -- `not in`, because a NULL on the right-hand side would make every row pass
     and not exists (select 1 from _023_deferred d where d.oid = p.oid);

  select count(*) into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join _023_pinned q on q.oid = p.oid
   where not exists (select 1 from unnest(p.proconfig) c
                      where c ~ '^search_path *=' and c !~ 'pg_temp');

  if v_left > 0 then
    raise exception
      '023 PART A verification failed: % eligible definer routine(s) are still unpinned. Nothing was committed — see the report and rerun.', v_left;
  end if;
  if v_bad > 0 then
    raise exception
      '023 PART A verification failed: % function(s) were pinned to a path containing pg_temp, which would leave the shadowing hole open. Nothing was committed.', v_bad;
  end if;

  raise notice '023 PART A · pinned search_path on % definer routine(s); % deferred for a reviewed body edit',
    v_pinned, v_deferred;
end;
$$;

-- ----------------------------------------------------------------------------
-- PART B · the browser roles may not reach the passkey validators or the tenant
--          deleter. The application never calls them; the schema file already says so.
-- ----------------------------------------------------------------------------
do $$
declare
  v_targets  text[] := array[
    'church.validate_usher_passkey(text,text)',
    'public.validate_usher_passkey(text,text)',
    -- Both spellings, because they are different functions: the (uuid) overload is what
    -- supabase-schema.sql defines, and the zero-argument one is what the live database
    -- actually has, attached as a trigger. The null-skip turns a non-existent signature
    -- into a report line, which is exactly how this file's own error stayed harmless.
    'church.delete_church_tenant_cascade(uuid)',
    'church.delete_church_tenant_cascade()'
  ];
  v_name     text;
  v_oid      regprocedure;
  v_policies text;
  v_callers  text;
  v_sr       oid;
begin
  foreach v_name in array v_targets loop
    v_oid := to_regprocedure(v_name);
    if v_oid is null then
      insert into _023_acl values (v_name, 'skipped',
        'no routine with this exact signature exists here — the live signature differs, '
        || 'so re-run the inventory in SECURITY_REVIEW-2026-10-30.md P1-8 before assuming this is covered');
      continue;
    end if;

    -- Guard: a policy predicate that mentions the name at all, qualified or not. Such a
    -- policy runs as the table's reader, so revoking EXECUTE would break plain SELECTs.
    select string_agg(x, '; ' order by x) into v_policies
      from (
        -- polcmd is type "char", which has no unambiguous ||; cast it, do not guess.
        select n.nspname || '.' || c.relname || ' · ' || p.polname
               || ' (' || CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                                       WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                                       ELSE p.polcmd::text END || ')' as x
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
          join pg_namespace n on n.oid = c.relnamespace
         where coalesce(pg_get_expr(p.polqual, c.oid), '') || ' '
            || coalesce(pg_get_expr(p.polwithcheck, c.oid), '')
               like '%' || split_part(split_part(v_name, '.', 2), '(', 1) || '%'
      ) y;
    if v_policies is not null then
      raise exception
        '023 PART B refuses to revoke %. A row-policy predicate calls it: %. Revoking EXECUTE from the browser roles would break ordinary reads on that table, because policies are evaluated as the reader, not as the policy author. Fix the policy first, then rerun.',
        v_name, v_policies;
    end if;

    -- Report, without blocking: an invoker function that calls this one inherits the need
    -- for the caller to hold EXECUTE. If one of these is browser-reachable, read it before
    -- trusting the revoke — a chain that works today would otherwise fail quietly at 3am.
    select string_agg(x, ', ' order by x) into v_callers
      from (
        select format('%I.%I', n.nspname, p.proname) as x
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where p.oid <> v_oid
           and n.nspname in ('public','church','private','business')
           and not p.prosecdef
           -- prokind first: pg_get_functiondef() raises on an aggregate rather than
           -- returning text, and an aggregate in one of these schemas is enough to fail
           -- the whole migration on a name-collision technicality.
           and p.prokind = 'f'
           and pg_get_functiondef(p.oid) like '%' || split_part(split_part(v_name, '.', 2), '(', 1) || '('
      ) z;

    -- service_role is the role the application's privileged path presents (proven by
    -- tests/admin-client-identity.test.ts), and supabase-schema.sql grants these three to
    -- it. Granting it here cannot widen what the app could already do, and it means the
    -- service path never depends on a PUBLIC-implicit execute it may lose later.
    v_sr := to_regrole('service_role');

    execute format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_oid);
    begin
      -- On a bare PostgreSQL there is no service_role at all; the revoke is still right.
      if v_sr is not null then
        execute format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_oid);
      end if;
    exception when undefined_object then
      null;
    end;

    if has_function_privilege('anon', v_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception
        '023 PART B failed: % is still executable by a browser role after the revoke. Something granted it outside this file (a group role, most likely) — has_function_privilege resolves membership, so revoke on THAT role rather than editing this file to make the check pass.',
        v_name;
    end if;
    if v_sr is not null and not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception
        '023 PART B failed: service_role lost EXECUTE on %, which the deletion and attendance paths need. Nothing was committed.', v_name;
    end if;

    insert into _023_acl values (v_name, 'revoked',
      'anon and authenticated can no longer execute it'
      || case when v_callers is not null
              then '; check these invoker functions that reference it: ' || v_callers
              else '; no other function in public/church/private/business calls it' end);
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- Report. Supabase's SQL editor shows the last result set, so this is the part to read.
-- ----------------------------------------------------------------------------
select 'pinned' as action, function as target, coalesce(was, '(none)') as detail from _023_pinned
union all
select 'deferred', function, reason || ' — ' || coalesce(detail, '') from _023_deferred
union all
select action, function, coalesce(detail, '') from _023_acl
order by 1, 2;

do $$
begin
  raise notice '023 · if anything here looks wrong, roll it back with ALTER FUNCTION <schema>.<name>(<args>) RESET search_path and GRANT EXECUTE ON FUNCTION <schema>.<name>(<args>) TO anon, authenticated';
end;
$$;

commit;
