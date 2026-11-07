-- 027_denomination_layer.sql — the denominations/diocese system, captured
-- verbatim from the production database (2026-11-07) where it was built
-- live and battle-tested end-to-end (17/17 checks: invites, joins, guard
-- rails, detach, dashboards, routing, branding).
--
-- Model: a denomination (diocese) is an umbrella org. Membership is two
-- independent relations — churches.denomination_id (a church belongs to a
-- diocese) and church.denomination_admins (a user oversees a diocese).
-- Overseers see aggregates for member churches only, always scoped through
-- private.my_denomination_id(); nothing grants cross-tenant data access.
--
-- Joining works with hashed invite codes: overseers mint 'church' codes,
-- super-admins mint 'overseer' codes; only the SHA-256 hash is stored.
--
-- Intentionally NOT included here: public.provision_church_v2/v3 (church
-- signup provisioning RPCs). They pre-date this layer, are managed directly
-- in the production database, and are documented in docs/DENOMINATIONS.md.

-- ---------------------------------------------------------------------------
-- Schema and tables
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS church.denominations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL,
  logo_url      text,
  primary_color text,
  background_url text,
  login_title   text,
  login_tagline text,
  login_layout  text DEFAULT 'centered',
  is_listed     boolean NOT NULL DEFAULT false,
  created_at    timestamptz DEFAULT now(),
  CONSTRAINT denominations_slug_key UNIQUE (slug),
  CONSTRAINT denominations_slug_canonical CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT denominations_color_hex CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT denominations_logo_https CHECK (logo_url IS NULL OR logo_url ~ '^https://'),
  CONSTRAINT denominations_bg_https CHECK (background_url IS NULL OR background_url ~ '^https://'),
  CONSTRAINT denominations_layout_valid CHECK (login_layout = ANY (ARRAY['centered'::text, 'split'::text, 'fullbleed'::text]))
);

CREATE TABLE IF NOT EXISTS church.denomination_admins (
  user_id         uuid PRIMARY KEY,
  denomination_id uuid NOT NULL,
  created_at      timestamptz DEFAULT now(),
  CONSTRAINT denomination_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT denomination_admins_denomination_id_fkey FOREIGN KEY (denomination_id) REFERENCES church.denominations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS church.denomination_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  denomination_id uuid NOT NULL,
  code_hash       text NOT NULL,
  label           text,
  max_uses        integer NOT NULL,
  used_count      integer NOT NULL DEFAULT 0,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz DEFAULT now(),
  invite_type     text NOT NULL,
  CONSTRAINT denomination_invites_code_hash_key UNIQUE (code_hash),
  CONSTRAINT denomination_invites_denomination_id_fkey FOREIGN KEY (denomination_id) REFERENCES church.denominations(id) ON DELETE CASCADE,
  CONSTRAINT denomination_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT denomination_invites_invite_type_check CHECK (invite_type = ANY (ARRAY['church'::text, 'overseer'::text])),
  CONSTRAINT denomination_invites_max_uses_check CHECK (max_uses >= 1 AND max_uses <= 1000),
  CONSTRAINT denomination_invites_used_count_check CHECK (used_count >= 0),
  CONSTRAINT invite_uses_within_max CHECK (used_count <= max_uses)
);

-- ---------------------------------------------------------------------------
-- Row level security (verbatim from production)
-- ---------------------------------------------------------------------------
ALTER TABLE church.denominations ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.denomination_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.denomination_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Listed denominations are public" ON church.denominations;
CREATE POLICY "Listed denominations are public" ON church.denominations
  FOR SELECT TO anon, authenticated
  USING (is_listed);

DROP POLICY IF EXISTS "Overseers read own denomination" ON church.denominations;
CREATE POLICY "Overseers read own denomination" ON church.denominations
  FOR SELECT TO authenticated
  USING (id = private.my_denomination_id());

DROP POLICY IF EXISTS "Service role full access on denominations" ON church.denominations;
CREATE POLICY "Service role full access on denominations" ON church.denominations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own overseer row" ON church.denomination_admins;
CREATE POLICY "Users read own overseer row" ON church.denomination_admins
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid() AS uid));

DROP POLICY IF EXISTS "Service role full access on denomination_admins" ON church.denomination_admins;
CREATE POLICY "Service role full access on denomination_admins" ON church.denomination_admins
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on denomination_invites" ON church.denomination_invites;
CREATE POLICY "Service role full access on denomination_invites" ON church.denomination_invites
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Public picker view (pre-auth pages; only listed dioceses)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.denominations_public AS
  SELECT slug, name, logo_url, primary_color
  FROM church.denominations d
  WHERE is_listed;

GRANT SELECT ON public.denominations_public TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.hash_invite_code(p_code text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = ""
AS $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')),
      'sha256'
    ),
    'hex'
  );
$$;

CREATE OR REPLACE FUNCTION private.my_denomination_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ""
STABLE
AS $$
  select da.denomination_id
  from church.denomination_admins da
  where da.user_id = auth.uid()
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Login routing: overseer membership wins; then church pastor; then none.
-- A user holding both hats lands on the diocese dashboard but keeps full
-- church access (church pages authorise via admin_profiles independently).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.my_login_context_impl()
RETURNS TABLE (account_type text, denomination_slug text, denomination_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
STABLE
AS $$
declare
  v_slug text;
  v_name text;
begin
  select d.slug, d.name into v_slug, v_name
  from church.denomination_admins da
  join church.denominations d on d.id = da.denomination_id
  where da.user_id = auth.uid();

  if found then
    return query select 'overseer'::text, v_slug, v_name;
    return;
  end if;

  select d.slug, d.name into v_slug, v_name
  from public.admin_profiles ap
  join church.churches c on c.id::text = ap.tenant_id
  left join church.denominations d on d.id = c.denomination_id
  where ap.id = auth.uid()
    and ap.role = 'pastor'::public.admin_role_enum
    and ap.app_type = 'church';

  if found then
    return query select 'pastor'::text, v_slug, v_name;
    return;
  end if;

  return query select 'none'::text, null::text, null::text;
end;
$$;

CREATE OR REPLACE FUNCTION public.my_login_context()
RETURNS TABLE (account_type text, denomination_slug text, denomination_name text)
LANGUAGE sql
SET search_path = ""
STABLE
AS $$
  select * from private.my_login_context_impl();
$$;
REVOKE EXECUTE ON FUNCTION public.my_login_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_login_context() TO authenticated;
REVOKE EXECUTE ON FUNCTION private.my_login_context_impl() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.my_login_context_impl() TO authenticated;

-- ---------------------------------------------------------------------------
-- Branding (public diocese pages, pre-auth)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.get_denomination_branding_impl(p_slug text)
RETURNS TABLE (slug text, name text, logo_url text, primary_color text,
               background_url text, login_title text, login_tagline text, login_layout text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ""
STABLE
AS $$
  select d.slug, d.name, d.logo_url, d.primary_color, d.background_url,
         d.login_title, d.login_tagline, d.login_layout
  from church.denominations d
  where d.slug = pg_catalog.lower(pg_catalog.btrim(p_slug))
  limit 1;
$$;

CREATE OR REPLACE FUNCTION public.get_denomination_branding(p_slug text)
RETURNS TABLE (slug text, name text, logo_url text, primary_color text,
               background_url text, login_title text, login_tagline text, login_layout text)
LANGUAGE sql
SET search_path = ""
STABLE
AS $$
  select * from private.get_denomination_branding_impl(p_slug);
$$;
REVOKE EXECUTE ON FUNCTION public.get_denomination_branding(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_denomination_branding(text) TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.get_denomination_branding_impl(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.get_denomination_branding_impl(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Church join (pastor + invite code)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.join_denomination_with_invite_impl(p_invite_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
AS $$
declare
  v_tenant uuid := church.my_tenant_id();
  v_inv_id uuid;
  v_inv_den uuid;
begin
  if auth.uid() is null or v_tenant is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.admin_profiles ap
    where ap.id = auth.uid()
      and ap.role = 'pastor'::public.admin_role_enum
      and ap.app_type = 'church'
  ) then
    raise exception 'Only the pastor can join a denomination' using errcode = '42501';
  end if;

  perform 1 from church.churches
  where id = v_tenant and denomination_id is null
  for update;
  if not found then
    raise exception 'Your church already belongs to a denomination';
  end if;

  select i.id, i.denomination_id into v_inv_id, v_inv_den
  from church.denomination_invites i
  where i.code_hash = private.hash_invite_code(p_invite_code)
    and i.invite_type = 'church'
    and i.revoked_at is null
    and i.expires_at > pg_catalog.now()
    and i.used_count < i.max_uses
  for update;

  if not found then
    raise exception 'Invalid or expired invite code';
  end if;

  update church.churches set denomination_id = v_inv_den where id = v_tenant;
  update church.denomination_invites set used_count = used_count + 1 where id = v_inv_id;

  return v_inv_den;
end;
$$;

CREATE OR REPLACE FUNCTION public.join_denomination_with_invite(p_invite_code text)
RETURNS uuid
LANGUAGE sql
SET search_path = ""
AS $$
  select private.join_denomination_with_invite_impl(p_invite_code);
$$;
REVOKE EXECUTE ON FUNCTION public.join_denomination_with_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_denomination_with_invite(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION private.join_denomination_with_invite_impl(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.join_denomination_with_invite_impl(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Overseer invite management
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.overseer_create_invite_impl(p_label text, p_max_uses integer, p_expires_in_days integer)
RETURNS TABLE (invite_id uuid, code text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
AS $$
#variable_conflict use_column
declare
  v_den uuid := private.my_denomination_id();
  v_raw text;
  v_code text;
  v_id uuid;
  v_exp timestamptz;
begin
  if v_den is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_max_uses is null or p_max_uses < 1 or p_max_uses > 1000 then
    raise exception 'max uses must be between 1 and 1000';
  end if;
  if p_expires_in_days is null or p_expires_in_days < 1 or p_expires_in_days > 90 then
    raise exception 'expiry must be between 1 and 90 days';
  end if;

  v_raw := pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'));
  v_code := pg_catalog.substr(v_raw, 1, 8) || '-' || pg_catalog.substr(v_raw, 9, 8) || '-' ||
            pg_catalog.substr(v_raw, 17, 8) || '-' || pg_catalog.substr(v_raw, 25, 8);
  v_exp := pg_catalog.now() + pg_catalog.make_interval(days => p_expires_in_days);

  insert into church.denomination_invites
    (denomination_id, code_hash, label, max_uses, expires_at, created_by, invite_type)
  values
    (v_den, private.hash_invite_code(v_code), nullif(pg_catalog.btrim(p_label), ''),
     p_max_uses, v_exp, auth.uid(), 'church')
  returning id into v_id;

  return query select v_id, v_code, v_exp;
end;
$$;

CREATE OR REPLACE FUNCTION public.overseer_create_invite(p_label text, p_max_uses integer, p_expires_in_days integer)
RETURNS TABLE (invite_id uuid, code text, expires_at timestamptz)
LANGUAGE sql
SET search_path = ""
AS $$
  select * from private.overseer_create_invite_impl(p_label, p_max_uses, p_expires_in_days);
$$;
REVOKE EXECUTE ON FUNCTION public.overseer_create_invite(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_create_invite(text, integer, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION private.overseer_create_invite_impl(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.overseer_create_invite_impl(text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION private.overseer_list_invites_impl()
RETURNS TABLE (invite_id uuid, label text, created_at timestamptz, expires_at timestamptz,
               revoked_at timestamptz, max_uses integer, used_count integer, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
STABLE
AS $$
#variable_conflict use_column
declare
  v_den uuid := private.my_denomination_id();
begin
  if v_den is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select i.id, i.label, i.created_at, i.expires_at, i.revoked_at, i.max_uses, i.used_count,
         case
           when i.revoked_at is not null then 'revoked'
           when i.expires_at <= now() then 'expired'
           when i.used_count >= i.max_uses then 'used up'
           else 'active'
         end::text
  from church.denomination_invites i
  where i.denomination_id = v_den
  order by i.created_at desc;
end;
$$;

CREATE OR REPLACE FUNCTION public.overseer_list_invites()
RETURNS TABLE (invite_id uuid, label text, created_at timestamptz, expires_at timestamptz,
               revoked_at timestamptz, max_uses integer, used_count integer, status text)
LANGUAGE sql
SET search_path = ""
STABLE
AS $$
  select * from private.overseer_list_invites_impl();
$$;
REVOKE EXECUTE ON FUNCTION public.overseer_list_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_list_invites() TO authenticated;
REVOKE EXECUTE ON FUNCTION private.overseer_list_invites_impl() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.overseer_list_invites_impl() TO authenticated;

CREATE OR REPLACE FUNCTION private.overseer_revoke_invite_impl(p_invite_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
AS $$
declare
  v_den uuid := private.my_denomination_id();
begin
  if v_den is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update church.denomination_invites
  set revoked_at = now()
  where id = p_invite_id
    and denomination_id = v_den
    and revoked_at is null;

  if not found then
    raise exception 'Invite not found';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION public.overseer_revoke_invite(p_invite_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = ""
AS $$
  select private.overseer_revoke_invite_impl(p_invite_id);
$$;
REVOKE EXECUTE ON FUNCTION public.overseer_revoke_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_revoke_invite(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION private.overseer_revoke_invite_impl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.overseer_revoke_invite_impl(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.overseer_detach_church_impl(p_church_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
AS $$
declare
  v_den uuid := private.my_denomination_id();
begin
  if v_den is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update church.churches
  set denomination_id = null
  where id = p_church_id
    and denomination_id = v_den;

  if not found then
    raise exception 'Church not found in your denomination';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION public.overseer_detach_church(p_church_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = ""
AS $$
  select private.overseer_detach_church_impl(p_church_id);
$$;
REVOKE EXECUTE ON FUNCTION public.overseer_detach_church(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_detach_church(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION private.overseer_detach_church_impl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.overseer_detach_church_impl(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Overseer dashboards — aggregates only, always scoped to the caller's own
-- diocese. NOTE: totals intentionally mirror production, which returns five
-- columns; the app snapshot builder also expects a giving_total metric and
-- renders its error card when absent (known issue, see docs/DENOMINATIONS.md).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.overseer_church_summary_impl()
RETURNS TABLE (church_id uuid, church_name text, slug text, pastor_email text,
               member_count bigint, attendance_30d bigint, last_event_date date,
               sms_sent_30d bigint, last_active_at timestamptz, joined_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
STABLE
AS $$
#variable_conflict use_column
declare
  v_den uuid := private.my_denomination_id();
begin
  if v_den is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  with mine as (
    select c.id, c.name, c.slug, c.created_at
    from church.churches c
    where c.denomination_id = v_den
  ),
  mem as (
    select m.church_id as cid, count(*) as cnt, max(m.created_at) as last_upd
    from church.members m
    join mine on mine.id = m.church_id
    group by m.church_id
  ),
  att as (
    select a.church_id as cid,
           count(*) filter (
             where a.attendance_status in ('present', 'late')
               and a.check_in_time >= now() - interval '30 days'
           ) as cnt_30,
           max(a.created_at) as last_log
    from church.attendance_logs a
    join mine on mine.id = a.church_id
    group by a.church_id
  ),
  ev as (
    select e.church_id as cid, max(e.event_date) as last_date, max(e.created_at) as last_created
    from church.events e
    join mine on mine.id = e.church_id
    group by e.church_id
  ),
  sms as (
    select s.tenant_id as cid, count(*) as cnt
    from church.sms_logs s
    join mine on mine.id = s.tenant_id
    where s.created_at >= now() - interval '30 days'
    group by s.tenant_id
  ),
  pas as (
    select distinct on (p.tenant_id) p.tenant_id as cid, p.email
    from public.admin_profiles p
    join mine on p.tenant_id = mine.id::text
    where p.role = 'pastor'::public.admin_role_enum
      and p.app_type = 'church'
    order by p.tenant_id, p.created_at
  )
  select mine.id,
         mine.name,
         mine.slug,
         pas.email,
         coalesce(mem.cnt, 0),
         coalesce(att.cnt_30, 0),
         ev.last_date,
         coalesce(sms.cnt, 0),
         greatest(mem.last_upd, att.last_log, ev.last_created),
         mine.created_at
  from mine
  left join mem on mem.cid = mine.id
  left join att on att.cid = mine.id
  left join ev on ev.cid = mine.id
  left join sms on sms.cid = mine.id
  left join pas on pas.cid = mine.id::text
  order by mine.name;
end;
$$;

CREATE OR REPLACE FUNCTION public.overseer_church_summary()
RETURNS TABLE (church_id uuid, church_name text, slug text, pastor_email text,
               member_count bigint, attendance_30d bigint, last_event_date date,
               sms_sent_30d bigint, last_active_at timestamptz, joined_at timestamptz)
LANGUAGE sql
SET search_path = ""
STABLE
AS $$
  select * from private.overseer_church_summary_impl();
$$;
REVOKE EXECUTE ON FUNCTION public.overseer_church_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_church_summary() TO authenticated;
REVOKE EXECUTE ON FUNCTION private.overseer_church_summary_impl() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.overseer_church_summary_impl() TO authenticated;

CREATE OR REPLACE FUNCTION private.overseer_denomination_totals_impl()
RETURNS TABLE (church_count bigint, member_total bigint, attendance_30d_total bigint,
               sms_30d_total bigint, active_churches_30d bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
STABLE
AS $$
begin
  if private.my_denomination_id() is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select count(*),
         coalesce(sum(s.member_count), 0)::bigint,
         coalesce(sum(s.attendance_30d), 0)::bigint,
         coalesce(sum(s.sms_sent_30d), 0)::bigint,
         count(*) filter (where s.last_active_at >= now() - interval '30 days')
  from private.overseer_church_summary_impl() s;
end;
$$;

CREATE OR REPLACE FUNCTION public.overseer_denomination_totals()
RETURNS TABLE (church_count bigint, member_total bigint, attendance_30d_total bigint,
               sms_30d_total bigint, active_churches_30d bigint)
LANGUAGE sql
SET search_path = ""
STABLE
AS $$
  select * from private.overseer_denomination_totals_impl();
$$;
REVOKE EXECUTE ON FUNCTION public.overseer_denomination_totals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_denomination_totals() TO authenticated;
REVOKE EXECUTE ON FUNCTION private.overseer_denomination_totals_impl() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.overseer_denomination_totals_impl() TO authenticated;

-- ---------------------------------------------------------------------------
-- Super-admin: mint OVERSEER invites (one admin row per user is enforced at
-- redemption; a person may be an overseer and a pastor simultaneously).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_denomination_overseer_invite(
  p_denomination_id uuid, p_label text, p_max_uses integer, p_expires_in_days integer
)
RETURNS TABLE (invite_id uuid, code text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_raw text;
  v_code text;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.admin_profiles ap
     WHERE ap.id = v_user_id
       AND ap.role = 'super_admin'::public.admin_role_enum
  ) THEN
    RAISE EXCEPTION 'Super-admin access required' USING ERRCODE = '42501';
  END IF;

  IF p_max_uses IS NULL OR p_max_uses < 1 OR p_max_uses > 1000 THEN
    RAISE EXCEPTION 'max uses must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  IF p_expires_in_days IS NULL OR p_expires_in_days < 1 OR p_expires_in_days > 90 THEN
    RAISE EXCEPTION 'expiry must be between 1 and 90 days' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM church.denominations d WHERE d.id = p_denomination_id
  ) THEN
    RAISE EXCEPTION 'Denomination not found' USING ERRCODE = '22023';
  END IF;

  v_raw := pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'));
  v_code := pg_catalog.substr(v_raw, 1, 8) || '-' || pg_catalog.substr(v_raw, 9, 8) || '-' ||
            pg_catalog.substr(v_raw, 17, 8) || '-' || pg_catalog.substr(v_raw, 25, 8);
  v_exp := pg_catalog.now() + pg_catalog.make_interval(days => p_expires_in_days);

  INSERT INTO church.denomination_invites
    (denomination_id, code_hash, label, max_uses, expires_at, created_by, invite_type)
  VALUES
    (p_denomination_id, private.hash_invite_code(v_code), nullif(pg_catalog.btrim(p_label), ''),
     p_max_uses, v_exp, v_user_id, 'overseer')
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_code, v_exp;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.create_denomination_overseer_invite(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_denomination_overseer_invite(uuid, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.redeem_denomination_overseer_invite(p_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ""
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_invite church.denomination_invites%ROWTYPE;
  v_code_hash text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_code IS NULL OR p_code !~* '^[A-F0-9]{8}(-[A-F0-9]{8}){3}$' THEN
    RAISE EXCEPTION 'This invitation is invalid or has expired.' USING ERRCODE = '22023';
  END IF;

  v_code_hash := private.hash_invite_code(p_code);

  SELECT invite.*
    INTO v_invite
    FROM church.denomination_invites AS invite
   WHERE invite.code_hash = v_code_hash
     AND invite.invite_type = 'overseer'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This invitation is invalid or has expired.' USING ERRCODE = '22023';
  END IF;

  IF v_invite.revoked_at IS NOT NULL
     OR v_invite.expires_at <= pg_catalog.clock_timestamp()
     OR v_invite.used_count >= v_invite.max_uses THEN
    RAISE EXCEPTION 'This invitation is invalid, expired, or fully redeemed.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM church.denomination_admins AS admin_link
     WHERE admin_link.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'This account is already linked to a denomination.' USING ERRCODE = '23505';
  END IF;

  UPDATE church.denomination_invites
     SET used_count = used_count + 1
   WHERE id = v_invite.id;

  INSERT INTO church.denomination_admins (user_id, denomination_id)
  VALUES (v_user_id, v_invite.denomination_id);

  RETURN v_invite.denomination_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.redeem_denomination_overseer_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_denomination_overseer_invite(text) TO authenticated;
