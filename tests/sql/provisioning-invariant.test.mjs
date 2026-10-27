// Why `provision_church_v3` being SECURITY INVOKER is not a style question.
//
// The live ACL preflight reported prosecdef = false. A SECURITY INVOKER
// function runs with the caller's privileges, so every write it performs is
// subject to RLS for the `authenticated` role. This file reproduces the
// repository's declared policies against a real PostgreSQL and shows that such
// a function cannot create a church.
//
// This is a MODEL of supabase-schema.sql, not the deployed database. It pins
// the reasoning so that "just flip it to SECURITY INVOKER" cannot be presented
// later as a harmless simplification.
//
// Declared policies being modelled (line numbers from supabase-schema.sql):
//   public.tenants        383-367  SELECT for authenticated, FOR ALL for service_role
//   public.admin_profiles 370-382  SELECT for authenticated, FOR ALL for service_role
//   church.churches       383-395  FOR ALL for authenticated WITH CHECK (id = church.my_tenant_id())
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const SIG = 'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text';

async function buildSchema() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA church;
    CREATE SCHEMA auth;

    CREATE TABLE public.tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
    CREATE TABLE public.admin_profiles (id uuid PRIMARY KEY, tenant_id uuid);
    CREATE TABLE church.churches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      passkey text
    );

    -- A brand-new signup: auth.uid() has a value, but no admin_profiles row
    -- exists yet, so my_tenant_id() is NULL. That is the chicken-and-egg case.
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION church.my_tenant_id() RETURNS uuid LANGUAGE sql STABLE
      SECURITY DEFINER SET search_path = public, church AS $$
      SELECT tenant_id::uuid FROM public.admin_profiles WHERE id = auth.uid() LIMIT 1 $$;

    GRANT USAGE ON SCHEMA church, auth, public TO authenticated;
    GRANT SELECT, INSERT ON church.churches, public.tenants, public.admin_profiles TO authenticated;

    ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Users can view tenants they are admins of" ON public.tenants
      FOR SELECT TO authenticated
      USING (id IN (SELECT tenant_id FROM public.admin_profiles WHERE id = auth.uid()));

    ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Users can view their own profile" ON public.admin_profiles
      FOR SELECT TO authenticated USING (id = auth.uid());

    ALTER TABLE church.churches ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Admins can manage their associated church" ON church.churches
      FOR ALL TO authenticated
      USING (id = church.my_tenant_id())
      WITH CHECK (id = church.my_tenant_id());
  `);
  return db;
}

// The three writes provisioning has to perform, in any implementation.
const PROVISION = `
  DECLARE v_tenant uuid; v_id uuid;
  BEGIN
    INSERT INTO public.tenants (name) VALUES (p_name) RETURNING id INTO v_tenant;
    INSERT INTO church.churches (name, slug, passkey)
      VALUES (p_name, p_slug, 'ABCDEF1234') RETURNING id INTO v_id;
    INSERT INTO public.admin_profiles (id, tenant_id) VALUES (p_user_id, v_tenant);
    RETURN v_id;
  END`;

async function define(db, name, mode, searchPath) {
  await db.exec(`CREATE FUNCTION public.${name}(${SIG}) RETURNS uuid
    LANGUAGE plpgsql SECURITY ${mode} SET search_path = ${searchPath}
    AS $fn$ ${PROVISION} $fn$;
    GRANT EXECUTE ON FUNCTION public.${name}(uuid,text,text,text,text) TO authenticated;`);
}

async function callAsAuthenticated(db, name) {
  await db.exec('SET ROLE authenticated');
  try {
    await db.exec(`SELECT public.${name}(gen_random_uuid(), 'New Church', 'new-church', 'pastor', NULL)`);
    return null;
  } catch (e) {
    return e.message;
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('provisioning cannot run as SECURITY INVOKER against these policies', () => {
  it('SECURITY INVOKER is rejected by RLS before it can create anything', async () => {
    const db = await buildSchema();
    await define(db, 'prov_invoker', 'INVOKER', 'public, church');
    const err = await callAsAuthenticated(db, 'prov_invoker');
    assert.ok(err, 'expected the call to fail for a brand-new user');
    assert.match(err, /row-level security policy/i);
    await db.close();
  });

  it('the first blocked write is the tenant, so no partial church is created', async () => {
    const db = await buildSchema();
    await define(db, 'prov_invoker2', 'INVOKER', 'public, church');
    await callAsAuthenticated(db, 'prov_invoker2');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM church.churches');
    assert.equal(rows[0].n, 0, 'an aborted function must not leave a church behind');
    await db.close();
  });

  it('SECURITY DEFINER is the only mode that completes', async () => {
    const db = await buildSchema();
    await define(db, 'prov_definer', 'DEFINER', 'public, church');
    const err = await callAsAuthenticated(db, 'prov_definer');
    assert.equal(err, null, `expected success, got: ${err}`);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM church.churches');
    assert.equal(rows[0].n, 1);
    await db.close();
  });

  it('an empty search_path breaks any unqualified reference', async () => {
    const db = await buildSchema();
    await db.exec(`CREATE FUNCTION public.prov_unqualified(${SIG}) RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $fn$ DECLARE v uuid; BEGIN
        INSERT INTO churches (name, slug, passkey) VALUES (p_name, p_slug, 'X') RETURNING id INTO v;
        RETURN v; END $fn$;`);
    let err = null;
    try { await db.exec(`SELECT public.prov_unqualified(gen_random_uuid(),'C','c-1','pastor',NULL)`); }
    catch (e) { err = e.message; }
    assert.ok(err, 'unqualified reference should not resolve when search_path is empty');
    assert.match(err, /does not exist/i);
    await db.close();
  });

  it('a fully-qualified body works under search_path = \'\'', async () => {
    const db = await buildSchema();
    await define(db, 'prov_qualified', 'DEFINER', "''");
    const err = await callAsAuthenticated(db, 'prov_qualified');
    assert.equal(err, null, `expected success, got: ${err}`);
    await db.close();
  });
});
