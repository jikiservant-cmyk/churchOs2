-- ============================================================================
-- Migration 010 — Denomination / Overseer Support
-- ============================================================================
--
-- The denomination sign-in flow (app/d/*, /overseer, invite-coding during
-- church provisioning, my_login_context routing, the overseer dashboard RPCs)
-- depends on database objects that were never present in the committed
-- schema:
--
--   * public.admin_role_enum lacked 'overseer' entirely — inserting an
--     overseer profile failed with invalid_enum_value, and login routing
--     (profile.role === 'overseer') could never match.
--   * church.denominations / denominations_public / denominations_admins /
--     denomination_invites did not exist.
--   * church.churches.denomination_id did not exist (invite-coding during
--     provisioning silently stored NULL).
--   * The RPCs the app calls — my_login_context, get_denomination_branding,
--     provision_church_v3, join_denomination_with_invite, overseer_* — did
--     not exist, so every call fell back to degraded behaviour.
--
-- This migration creates all of them, idempotently.
-- ============================================================================

-- 1. Role enum: add 'overseer' ------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'overseer') THEN
    ALTER TYPE public.admin_role_enum ADD VALUE IF NOT EXISTS 'overseer';
  END IF;
END
$$;

-- 2. Denominations -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS church.denominations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL,
  logo_url text,
  primary_color text,
  tagline text,
  website_url text,
  description text,
  is_listed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE church.denominations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'denominations' AND schemaname = 'church'
      AND policyname = 'Service role full access on denominations'
  ) THEN
    CREATE POLICY "Service role full access on denominations"
    ON church.denominations
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END
$$;

-- Public directory view. Intentionally NOT security_invoker: it runs as the
-- table owner so anon can read it; only listed denominations are exposed and
-- only public branding columns.
CREATE OR REPLACE VIEW church.denominations_public AS
  SELECT slug, name, logo_url, primary_color
  FROM church.denominations
  WHERE is_listed = true;

GRANT SELECT ON church.denominations_public TO anon, authenticated;

-- Overseer ↔ denomination link. No user-facing policies: rows are read and
-- written only by the SECURITY DEFINER RPCs below.
CREATE TABLE IF NOT EXISTS church.denominations_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  denomination_id uuid NOT NULL REFERENCES church.denominations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.admin_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (denomination_id, user_id)
);

ALTER TABLE church.denominations_admins ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'denominations_admins' AND schemaname = 'church'
      AND policyname = 'Service role full access on denominations_admins'
  ) THEN
    CREATE POLICY "Service role full access on denominations_admins"
    ON church.denominations_admins
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END
$$;

-- Pastor invite codes issued by overseers.
CREATE TABLE IF NOT EXISTS church.denomination_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  denomination_id uuid NOT NULL REFERENCES church.denominations(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  uses_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  revoked boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS denomination_invites_denomination_idx
  ON church.denomination_invites (denomination_id);

ALTER TABLE church.denomination_invites ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'denomination_invites' AND schemaname = 'church'
      AND policyname = 'Service role full access on denomination_invites'
  ) THEN
    CREATE POLICY "Service role full access on denomination_invites"
    ON church.denomination_invites
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END
$$;

-- Table grants: supabase-schema.sql's "GRANT ALL ON ALL TABLES IN SCHEMA
-- church" runs BEFORE this migration creates denominations /
-- denominations_admins / denomination_invites, so it never covers them.
-- RLS policy alone is not enough — the role also needs table-level
-- privileges, or service-role reads fail with "permission denied".
GRANT SELECT, INSERT, UPDATE, DELETE ON church.denominations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON church.denominations_admins TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON church.denomination_invites TO service_role;

-- Link a church to a denomination (nullable: independent churches have none).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'church' AND table_name = 'churches' AND column_name = 'denomination_id'
  ) THEN
    ALTER TABLE church.churches
      ADD COLUMN denomination_id uuid REFERENCES church.denominations(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS churches_denomination_id_idx
  ON church.churches (denomination_id);

-- 3. my_login_context — the sign-in routing RPC --------------------------------
--
-- Called by the login action, the root/login pages and the overseer gate with
-- the caller's session. Returns a single row describing where this account
-- belongs. Fails closed: no profile → no row → the caller uses its own
-- profile-table fallback.
CREATE OR REPLACE FUNCTION public.my_login_context()
RETURNS TABLE (
  account_type text,
  church_id uuid,
  church_name text,
  church_slug text,
  denomination_id uuid,
  denomination_name text,
  denomination_slug text,
  role text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, church
AS $$
  WITH me AS (
    SELECT id, role, tenant_id
    FROM public.admin_profiles
    WHERE id = auth.uid()
  ),
  overseer_denom AS (
    SELECT d.id AS denom_id, d.name AS denom_name, d.slug AS denom_slug
    FROM me m
    JOIN church.denominations_admins da ON da.user_id = m.id
    JOIN church.denominations d ON d.id = da.denomination_id
    LIMIT 1
  )
  SELECT
    CASE
      WHEN m.role = 'overseer' THEN 'overseer'
      WHEN m.role IN ('pastor', 'admin') AND m.tenant_id IS NOT NULL THEN 'pastor'
      ELSE 'none'
    END AS account_type,
    c.id AS church_id,
    c.name AS church_name,
    c.slug AS church_slug,
    COALESCE(od.denom_id, c.denomination_id) AS denomination_id,
    COALESCE(od.denom_name, den.name) AS denomination_name,
    COALESCE(od.denom_slug, den.slug) AS denomination_slug,
    m.role AS role
  FROM me m
  LEFT JOIN church.churches c ON c.id = m.tenant_id
  CROSS JOIN LATERAL (SELECT * FROM overseer_denom LIMIT 1) od
  LEFT JOIN church.denominations den ON den.id = c.denomination_id;
$$;

REVOKE ALL ON FUNCTION public.my_login_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_login_context() TO anon, authenticated;

-- 4. get_denomination_branding — public by-slug branding ------------------------
--
-- Unlisted denominations still resolve by slug (direct portal links); they are
-- just absent from the public directory view.
CREATE OR REPLACE FUNCTION church.get_denomination_branding(p_slug text)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  logo_url text,
  primary_color text,
  tagline text,
  website_url text,
  description text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, church
AS $$
  SELECT d.id, d.name, d.slug, d.logo_url, d.primary_color, d.tagline, d.website_url, d.description
  FROM church.denominations d
  WHERE d.slug = lower(btrim(p_slug));
$$;

CREATE OR REPLACE FUNCTION public.get_denomination_branding(p_slug text)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  logo_url text,
  primary_color text,
  tagline text,
  website_url text,
  description text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT * FROM church.get_denomination_branding(p_slug);
$$;

REVOKE ALL ON FUNCTION public.get_denomination_branding(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_denomination_branding(text) TO anon, authenticated;

-- 5. provision_church_v3 — atomic church provisioning ---------------------------
--
-- Parameters match the app's validateProvisionV3Payload contract:
--   p_user_id, p_name, p_slug, p_role required; p_invite_code, p_ip optional.
-- SECURITY DEFINER + auth.uid() check so it can never provision for another
-- user. Creates the church (activation_status = 'pending_payment') and links
-- the caller's profile; returns the new tenant id.
CREATE OR REPLACE FUNCTION church.provision_church_v3(
  p_user_id uuid,
  p_name text,
  p_slug text,
  p_role text,
  p_invite_code text DEFAULT NULL,
  p_ip text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, church, auth
AS $$
DECLARE
  v_slug text := lower(btrim(p_slug));
  v_name text := btrim(p_name);
  v_denom_id uuid;
  v_invite church.denomination_invites%ROWTYPE;
  v_existing_tenant uuid;
  v_church_id uuid;
  v_user_email text;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'provision_church_v3: p_user_id must be the calling user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_role IS DISTINCT FROM 'pastor' THEN
    RAISE EXCEPTION 'p_role must be pastor'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_name IS NULL OR length(v_name) < 3 OR length(v_name) > 50 THEN
    RAISE EXCEPTION 'Church name must be between 3 and 50 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(v_slug) < 3 OR length(v_slug) > 30 THEN
    RAISE EXCEPTION 'Invalid workspace slug'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Already provisioned? Return the existing tenant (idempotent).
  SELECT tenant_id INTO v_existing_tenant
  FROM public.admin_profiles
  WHERE id = p_user_id AND tenant_id IS NOT NULL;
  IF FOUND THEN
    RETURN v_existing_tenant;
  END IF;

  IF EXISTS (SELECT 1 FROM church.churches WHERE slug = v_slug) THEN
    RAISE EXCEPTION 'Workspace URL (slug) is already taken'
      USING ERRCODE = 'unique_violation';
  END IF;

  IF p_invite_code IS NOT NULL AND btrim(p_invite_code) <> '' THEN
    SELECT * INTO v_invite
    FROM church.denomination_invites
    WHERE code = upper(btrim(p_invite_code))
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Denomination invite code not found'
        USING ERRCODE = 'no_data_found';
    END IF;
    IF v_invite.revoked THEN
      RAISE EXCEPTION 'Denomination invite code has been revoked'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
      RAISE EXCEPTION 'Denomination invite code has expired'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_invite.max_uses IS NOT NULL AND v_invite.max_uses > 0
       AND COALESCE(v_invite.uses_count, 0) >= v_invite.max_uses THEN
      RAISE EXCEPTION 'Denomination invite code has reached its usage limit'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_denom_id := v_invite.denomination_id;
  END IF;

  v_church_id := gen_random_uuid();

  SELECT u.email INTO v_user_email
  FROM auth.users u
  WHERE u.id = p_user_id;

  INSERT INTO church.churches
    (id, name, slug, app_type, denomination_id, activation_status, ip_address)
  VALUES
    (v_church_id, v_name, v_slug, 'church', v_denom_id, 'pending_payment', p_ip);

  -- Link the profile. Never overwrite an existing role (e.g. overseer) and
  -- never clobber a tenant that was linked concurrently.
  INSERT INTO public.admin_profiles (id, email, tenant_id, role, app_type)
  VALUES (p_user_id, v_user_email, v_church_id, 'pastor', 'church')
  ON CONFLICT (id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        app_type = 'church'
  WHERE public.admin_profiles.tenant_id IS NULL;

  IF v_invite.id IS NOT NULL THEN
    UPDATE church.denomination_invites
       SET uses_count = COALESCE(uses_count, 0) + 1
     WHERE id = v_invite.id;
  END IF;

  RETURN v_church_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.provision_church_v3(
  p_user_id uuid,
  p_name text,
  p_slug text,
  p_role text,
  p_invite_code text DEFAULT NULL,
  p_ip text DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT church.provision_church_v3(p_user_id, p_name, p_slug, p_role, p_invite_code, p_ip);
$$;

REVOKE ALL ON FUNCTION public.provision_church_v3(uuid, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_church_v3(uuid, text, text, text, text, text) TO authenticated;

-- 6. join_denomination_with_invite — attach an EXISTING church ------------------
CREATE OR REPLACE FUNCTION church.join_denomination_with_invite(p_invite_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, church
AS $$
DECLARE
  v_tenant uuid;
  v_invite church.denomination_invites%ROWTYPE;
  v_denom uuid;
  v_current uuid;
BEGIN
  SELECT tenant_id INTO v_tenant
  FROM public.admin_profiles
  WHERE id = auth.uid();

  IF NOT FOUND OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'No church workspace is linked to your account'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT denomination_id INTO v_current
  FROM church.churches
  WHERE id = v_tenant
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Church workspace not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_current IS NOT NULL THEN
    RAISE EXCEPTION 'This church is already part of a denomination network'
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT * INTO v_invite
  FROM church.denomination_invites
  WHERE code = upper(btrim(p_invite_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Denomination invite code not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invite.revoked THEN
    RAISE EXCEPTION 'Denomination invite code has been revoked'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    RAISE EXCEPTION 'Denomination invite code has expired'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_invite.max_uses IS NOT NULL AND v_invite.max_uses > 0
     AND COALESCE(v_invite.uses_count, 0) >= v_invite.max_uses THEN
    RAISE EXCEPTION 'Denomination invite code has reached its usage limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_denom := v_invite.denomination_id;

  UPDATE church.churches
     SET denomination_id = v_denom
   WHERE id = v_tenant;

  UPDATE church.denomination_invites
     SET uses_count = COALESCE(uses_count, 0) + 1
   WHERE id = v_invite.id;

  RETURN v_denom;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_denomination_with_invite(p_invite_code text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT church.join_denomination_with_invite(p_invite_code);
$$;

REVOKE ALL ON FUNCTION public.join_denomination_with_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_denomination_with_invite(text) TO authenticated;

-- 7. Overseer helpers -----------------------------------------------------------
--
-- All overseer RPCs resolve the caller's denomination through
-- denominations_admins AND require role = 'overseer'. Any other account gets
-- an error, never another denomination's data.

CREATE OR REPLACE FUNCTION church._overseer_denomination_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, church
AS $$
DECLARE
  v_denom uuid;
BEGIN
  SELECT d.id INTO v_denom
  FROM public.admin_profiles ap
  JOIN church.denominations_admins da ON da.user_id = ap.id
  JOIN church.denominations d ON d.id = da.denomination_id
  WHERE ap.id = auth.uid()
    AND ap.role = 'overseer'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account is not an overseer of a denomination'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN v_denom;
END;
$$;

REVOKE ALL ON FUNCTION church._overseer_denomination_id() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION church.overseer_denomination_totals()
RETURNS TABLE (
  church_count bigint,
  member_total bigint,
  giving_total numeric,
  active_churches_30d bigint,
  denomination_name text,
  denomination_slug text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, church
AS $$
BEGIN
  RETURN QUERY
  WITH my_denom AS (
    SELECT d.id, d.name, d.slug
    FROM church.denominations d
    WHERE d.id = church._overseer_denomination_id()
  ),
  my_churches AS (
    SELECT c.id AS church_id
    FROM my_denom
    JOIN church.churches c ON c.denomination_id = my_denom.id
  )
  SELECT
    (SELECT count(*) FROM my_churches) AS church_count,
    (SELECT coalesce(sum(mc.count), 0)::bigint
       FROM (SELECT c2.church_id, count(*) AS count
             FROM my_churches c2
             JOIN church.members m ON m.church_id = c2.church_id
             GROUP BY c2.church_id) mc) AS member_total,
    (SELECT coalesce(sum(w.balance), 0)
       FROM my_churches c3
       JOIN public.wallets w ON w.tenant_id = c3.church_id) AS giving_total,
    (SELECT count(DISTINCT al.church_id)
       FROM my_churches c4
       JOIN church.attendance_logs al ON al.church_id = c4.church_id
      WHERE al.created_at >= now() - interval '30 days') AS active_churches_30d,
    my_denom.name AS denomination_name,
    my_denom.slug AS denomination_slug
  FROM my_denom;
END;
$$;

CREATE OR REPLACE FUNCTION public.overseer_denomination_totals()
RETURNS TABLE (
  church_count bigint,
  member_total bigint,
  giving_total numeric,
  active_churches_30d bigint,
  denomination_name text,
  denomination_slug text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT * FROM church.overseer_denomination_totals();
$$;

REVOKE ALL ON FUNCTION public.overseer_denomination_totals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_denomination_totals() TO authenticated;

CREATE OR REPLACE FUNCTION church.overseer_church_summary()
RETURNS TABLE (
  church_id uuid,
  church_name text,
  slug text,
  pastor_name text,
  pastor_email text,
  member_count bigint,
  attendance_30d bigint,
  total_giving numeric,
  joined_at timestamptz,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, church
AS $$
BEGIN
  RETURN QUERY
  WITH my_churches AS (
    SELECT c.id AS church_id, c.name, c.slug, c.created_at, c.activation_status
    FROM church.churches c
    WHERE c.denomination_id = church._overseer_denomination_id()
  )
  SELECT
    mc.church_id,
    mc.name AS church_name,
    mc.slug,
    COALESCE(p.full_name, p.email, 'Pastor') AS pastor_name,
    p.email AS pastor_email,
    (SELECT count(*) FROM church.members m WHERE m.church_id = mc.church_id) AS member_count,
    (SELECT count(*) FROM church.attendance_logs al
      WHERE al.church_id = mc.church_id AND al.created_at >= now() - interval '30 days') AS attendance_30d,
    (SELECT coalesce(sum(w.balance), 0) FROM public.wallets w WHERE w.tenant_id = mc.church_id) AS total_giving,
    mc.created_at AS joined_at,
    COALESCE(mc.activation_status, 'active') AS status
  FROM my_churches mc
  LEFT JOIN LATERAL (
    SELECT ap.full_name, ap.email
    FROM public.admin_profiles ap
    WHERE ap.tenant_id = mc.church_id
      AND ap.role IN ('pastor', 'admin')
    ORDER BY ap.created_at ASC
    LIMIT 1
  ) p ON true
  ORDER BY mc.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.overseer_church_summary()
RETURNS TABLE (
  church_id uuid,
  church_name text,
  slug text,
  pastor_name text,
  pastor_email text,
  member_count bigint,
  attendance_30d bigint,
  total_giving numeric,
  joined_at timestamptz,
  status text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT * FROM church.overseer_church_summary();
$$;

REVOKE ALL ON FUNCTION public.overseer_church_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_church_summary() TO authenticated;

CREATE OR REPLACE FUNCTION church.overseer_list_invites()
RETURNS TABLE (
  id uuid,
  code text,
  max_uses integer,
  uses_count integer,
  expires_at timestamptz,
  revoked boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, church
AS $$
BEGIN
  RETURN QUERY
  SELECT inv.id, inv.code, inv.max_uses, inv.uses_count, inv.expires_at, inv.revoked, inv.created_at
  FROM church.denomination_invites inv
  WHERE inv.denomination_id = church._overseer_denomination_id()
  ORDER BY inv.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.overseer_list_invites()
RETURNS TABLE (
  id uuid,
  code text,
  max_uses integer,
  uses_count integer,
  expires_at timestamptz,
  revoked boolean,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT * FROM church.overseer_list_invites();
$$;

REVOKE ALL ON FUNCTION public.overseer_list_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_list_invites() TO authenticated;

CREATE OR REPLACE FUNCTION church.overseer_create_invite(
  p_code text DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  code text,
  max_uses integer,
  uses_count integer,
  expires_at timestamptz,
  revoked boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, church
AS $$
DECLARE
  v_denom uuid := church._overseer_denomination_id();
  v_code text;
BEGIN
  IF p_code IS NOT NULL AND btrim(p_code) <> '' THEN
    v_code := upper(btrim(p_code));
  ELSE
    v_code := 'INV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  END IF;

  INSERT INTO church.denomination_invites
    (denomination_id, code, max_uses, expires_at, created_by)
  VALUES
    (v_denom, v_code, p_max_uses, p_expires_at, auth.uid())
  RETURNING id, code, max_uses, uses_count, expires_at, revoked, created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.overseer_create_invite(
  p_code text DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  code text,
  max_uses integer,
  uses_count integer,
  expires_at timestamptz,
  revoked boolean,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT * FROM church.overseer_create_invite(p_code, p_max_uses, p_expires_at);
$$;

REVOKE ALL ON FUNCTION public.overseer_create_invite(text, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_create_invite(text, integer, timestamptz) TO authenticated;

-- Two overloads so both call shapes used by the app work:
--   { p_invite_id: <uuid> }  and  { p_code: <text> }
CREATE OR REPLACE FUNCTION church.overseer_revoke_invite(p_invite_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, church
AS $$
DECLARE
  v_result boolean;
BEGIN
  UPDATE church.denomination_invites
     SET revoked = true
   WHERE id = p_invite_id
     AND denomination_id = church._overseer_denomination_id()
  RETURNING true INTO v_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite not found in your denomination'
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.overseer_revoke_invite(p_invite_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT church.overseer_revoke_invite(p_invite_id);
$$;

REVOKE ALL ON FUNCTION public.overseer_revoke_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_revoke_invite(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION church.overseer_revoke_invite(p_code text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, church
AS $$
DECLARE
  v_result boolean;
BEGIN
  UPDATE church.denomination_invites
     SET revoked = true
   WHERE code = upper(btrim(p_code))
     AND denomination_id = church._overseer_denomination_id()
  RETURNING true INTO v_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite not found in your denomination'
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.overseer_revoke_invite(p_code text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT church.overseer_revoke_invite(p_code);
$$;

REVOKE ALL ON FUNCTION public.overseer_revoke_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_revoke_invite(text) TO authenticated;

CREATE OR REPLACE FUNCTION church.overseer_detach_church(p_church_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, church
AS $$
DECLARE
  v_result boolean;
BEGIN
  UPDATE church.churches
     SET denomination_id = NULL
   WHERE id = p_church_id
     AND denomination_id = church._overseer_denomination_id()
  RETURNING true INTO v_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Church not found in your denomination'
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.overseer_detach_church(p_church_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT church.overseer_detach_church(p_church_id);
$$;

REVOKE ALL ON FUNCTION public.overseer_detach_church(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overseer_detach_church(uuid) TO authenticated;
