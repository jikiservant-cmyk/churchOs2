// Proof-of-concept harness for the RLS review, run against a real PostgreSQL
// (PGlite / PG16) with Row Level Security ENFORCED and the request JWT claims
// that Supabase's PostgREST sets for a browser session.
//
// This file reproduces the LEGACY policy shape: the fixture builds the FOR ALL
// policy that supabase-schema.sql shipped until migration 020, so the exploit lines
// below keep printing OPEN as documentation of what was wrong. It is deliberately NOT
// a test of the current schema — tests/sql/rls_church_row_guard.test.mjs applies the
// real hardened schema plus migrations 019 and 020 and asserts every one of these
// vectors is refused. The drift guards at the bottom pin both halves: they fail if
// the shipped schema ever grows the FOR ALL policy back, and they fail if the
// hardening is removed from either file.
//
// Nothing here is a mock of Postgres authorisation: the same `UPDATE` statement is
// what PostgREST issues for
//   PATCH https://<project>.supabase.co/rest/v1/churches?id=eq.<uuid>
// with `apikey: <anon key>` and the logged-in user's own access token, which any
// authenticated user can issue from devtools.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../../supabase-schema.sql', import.meta.url), 'utf8');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * A finding is *reported*, not asserted. The exploit checks must not flip CI red
 * when someone closes the hole — that would make the fix cost more than the bug —
 * so each one says OPEN or CLOSED and the file's exit status is decided only by the
 * defences that must hold in both worlds (cross-tenant denial, anon denial, no
 * profile forging).
 */
const openFindings = [];
const report = (id, name, exploitable, detail = '') => {
  const status = exploitable ? 'OPEN' : 'CLOSED';
  if (exploitable && !openFindings.includes(id)) openFindings.push(id);
  console.log(`${status}  [${id}] ${name}${detail ? `  — ${detail}` : ''}`);
};

const db = new PGlite();

await db.exec(`
  CREATE SCHEMA IF NOT EXISTS church;
  CREATE SCHEMA IF NOT EXISTS auth;

  -- Exactly how Supabase exposes the JWT to policies.
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$ LANGUAGE sql STABLE;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$ LANGUAGE sql STABLE;

  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;

  CREATE TABLE public.tenants (
    id uuid PRIMARY KEY,
    app_type text DEFAULT 'church',
    name text
  );

  CREATE TABLE public.admin_profiles (
    id uuid PRIMARY KEY,
    email text,
    full_name text,
    role text,
    tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
    app_type text DEFAULT 'church'
  );

  CREATE TABLE church.churches (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    sender_id text,
    theme_color text,
    is_active boolean DEFAULT true,
    passkey text,
    passkey_hash text,
    passkey_version integer NOT NULL DEFAULT 1,
    activation_status text,
    activation_paid_at timestamptz,
    created_at timestamptz DEFAULT now()
  );

  -- The destructive direction: church.churches has ON DELETE CASCADE children in
  -- the shipped schema, so deleting the church row deletes the flock's records.
  CREATE TABLE church.members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    church_id uuid NOT NULL REFERENCES church.churches(id) ON DELETE CASCADE,
    full_name text
  );

  -- supabase-schema.sql:843, verbatim. Created before the policies, because a
  -- policy expression is parsed at CREATE POLICY time.
  CREATE OR REPLACE FUNCTION church.my_tenant_id()
  RETURNS uuid AS $$
  BEGIN
    RETURN (
      SELECT tenant_id::uuid
      FROM public.admin_profiles
      WHERE id = auth.uid()
      LIMIT 1
    );
  END;
  $$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, church;

  -- ── shipped policy set ───────────────────────────────────────────────────
  ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.churches ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.members ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "Users can view their own profile"
    ON public.admin_profiles FOR SELECT TO authenticated USING (id = auth.uid());
  CREATE POLICY "Service role full access on profiles"
    ON public.admin_profiles FOR ALL TO service_role USING (true);

  -- supabase-schema.sql:391
  CREATE POLICY "Admins can manage their associated church"
    ON church.churches FOR ALL TO authenticated
    USING (id = church.my_tenant_id())
    WITH CHECK (id = church.my_tenant_id());
  -- supabase-schema.sql:1005 (a second, SELECT-only policy on the same table)
  CREATE POLICY "Pastors can view their own church"
    ON church.churches FOR SELECT TO authenticated USING (id = church.my_tenant_id());
  CREATE POLICY "Service role full access on churches"
    ON church.churches FOR ALL TO service_role USING (true);

  CREATE POLICY "members_rw_select" ON church.members FOR SELECT TO authenticated
    USING (church_id = church.my_tenant_id());

  GRANT USAGE ON SCHEMA public, church TO anon, authenticated, service_role;
  -- Supabase's default for the public schema is ALL to anon+authenticated; for a
  -- custom schema it depends on the project's default privileges. That difference
  -- decides whether the FOR ALL policy below also permits DELETE, so both shapes
  -- are exercised below: one with the narrow grant, one with ALL.
  GRANT SELECT ON public.admin_profiles TO authenticated;
  GRANT SELECT, UPDATE ON church.churches TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON church.members TO authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public, church TO service_role;
`);

await db.exec(`
  INSERT INTO public.tenants (id, name) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Ekero Family Chapel'),
    ('22222222-2222-2222-2222-222222222222', 'Bukoto Grace Assembly');
  INSERT INTO church.churches (id, name, slug, activation_status, passkey) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Ekero Family Chapel', 'ekero', 'pending_payment', 'CODEAAA1'),
    ('22222222-2222-2222-2222-222222222222', 'Bukoto Grace Assembly', 'bukoto', 'pending_payment', 'CODEBBB2');
  INSERT INTO church.members (church_id, full_name) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Nnakibuka Sarah'),
    ('11111111-1111-1111-1111-111111111111', 'Mwesigwa Peter'),
    ('22222222-2222-2222-2222-222222222222', 'Kato Ruth');
  INSERT INTO public.admin_profiles (id, email, role, tenant_id) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pastor@ekero.example', 'pastor', '11111111-1111-1111-1111-111111111111'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'staff@ekero.example', 'staff', '11111111-1111-1111-1111-111111111111'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'member@ekero.example', 'member', '11111111-1111-1111-1111-111111111111'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'pastor@bukoto.example', 'pastor', '22222222-2222-2222-2222-222222222222');
`);

const asUser = async (userId, statement) => {
  await db.exec('BEGIN');
  await db.exec(`SET LOCAL ROLE authenticated`);
  await db.exec(
    `SET LOCAL request.jwt.claims = '{"sub":"${userId}","role":"authenticated","email":"x@y.z"}'`,
  );
  await db.exec(`SET LOCAL request.jwt.claim.sub = '${userId}'`);
  try {
    const out = await db.query(statement);
    await db.exec('COMMIT');
    return { ok: true, rows: out.rows ?? [], affected: out.affectedRows ?? (out.rows?.length ?? 0) };
  } catch (error) {
    await db.exec('ROLLBACK');
    return { ok: false, error: String(error?.message ?? error) };
  }
};

const PASTOR_EKERO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF_EKERO = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MEMBER_EKERO = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PASTOR_BUKOTO = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const EKERO = '11111111-1111-1111-1111-111111111111';
const BUKOTO = '22222222-2222-2222-2222-222222222222';

// ── 1. the activation bypass proper ────────────────────────────────────────
const bypass = await asUser(
  PASTOR_EKERO,
  `UPDATE church.churches SET activation_status = 'active', activation_paid_at = now() WHERE id = '${EKERO}' RETURNING activation_status, activation_paid_at IS NOT NULL AS stamped`,
);
report(
  'P0-1',
  'a logged-in pastor clears their own activation gate with one UPDATE — no payment, no server code',
  bypass.ok && bypass.rows?.[0]?.activation_status === 'active',
  bypass.ok
    ? `rows affected: ${bypass.affected}; status is now "${bypass.rows[0]?.activation_status}"`
    : `denied: ${bypass.error?.split('\n')[0]?.slice(0, 70)}`,
);

const after = await db.query(`select activation_status from church.churches where id='${EKERO}'`);
// Why a committed write is an activation: the gate the user must pass reads these
// two columns and nothing else. If that ever stops being true, this check flips —
// which is the correct direction for a security assertion.
const gateSource = readFileSync(new URL('../../lib/activation-gate.ts', import.meta.url), 'utf8');
const layoutSource = readFileSync(new URL('../../app/c/[church_slug]/admin/(authenticated)/layout.tsx', import.meta.url), 'utf8');
check(
  'a committed write IS an activation: the gate reads activation_status / activation_paid_at and nothing else',
  /activation_paid_at/.test(gateSource) && /activation_status/.test(gateSource)
    && /resolveActivationGate/.test(layoutSource) && /ChurchRow|activation/.test(layoutSource),
  `status after the PATCH: ${after.rows[0]?.activation_status}`,
);

// ── 2. does the role matter? staff and members share the policy ────────────
for (const [label, uid] of [['a staff account', STAFF_EKERO], ['a member account', MEMBER_EKERO]]) {
  const r = await asUser(uid, `UPDATE church.churches SET activation_status = 'active' WHERE id = '${BUKOTO}' AND 1=1`);
  const rOwn = await asUser(uid, `UPDATE church.churches SET activation_status = 'pending_payment' WHERE id = '${EKERO}'`);
  report('P0-1', `the policy is role-blind — ${label} can write its own church row too`, rOwn.ok,
    rOwn.ok ? 'update accepted' : 'denied');
  check(`tenancy holds for ${label}: another church row is not writable`, r.ok ? (r.affected === 0) : true, r.ok ? `rows affected: ${r.affected}` : r.error);
}

// ── 3. usher credential takeover through the same policy ───────────────────
const passkeyTakeover = await asUser(
  PASTOR_EKERO,
  `UPDATE church.churches SET passkey = 'ATTACK01', passkey_hash = null WHERE id = '${EKERO}' RETURNING passkey`,
);
report(
  'P0-1b',
  'the same statement rewrites the usher portal code, and no version bump means no one is logged out or alerted',
  passkeyTakeover.ok && passkeyTakeover.rows?.[0]?.passkey === 'ATTACK01',
  passkeyTakeover.ok ? `passkey is now "${passkeyTakeover.rows[0].passkey}"` : 'denied',
);

// ── 4. destruction: FOR ALL includes DELETE, and children cascade ──────────
await db.exec(`INSERT INTO church.members (church_id, full_name) SELECT '${EKERO}', 'temp' WHERE NOT EXISTS (select 1 from church.members where full_name='temp')`);
const membersBefore = await db.query(`select count(*)::int as n from church.members where church_id='${EKERO}'`);
const delWithoutGrant = await asUser(PASTOR_EKERO, `DELETE FROM church.churches WHERE id = '${EKERO}'`);
check(
  'DELETE is stopped by the table PRIVILEGE, not by the policy — the policy would allow it',
  !delWithoutGrant.ok && /permission denied/.test(delWithoutGrant.error ?? ''),
  `${delWithoutGrant.error?.split('\n')[0]?.slice(0, 60)} — so a project that granted ALL on church.* (Supabase's default for public) IS exposed`,
);

// Now grant what Supabase grants by default in the public schema and re-run: the
// policy is what fails, proving the fix has to be the policy, not the GRANT.
await db.exec(`GRANT DELETE ON church.churches TO authenticated`);
const delWithGrant = await asUser(PASTOR_EKERO, `DELETE FROM church.churches WHERE id = '${EKERO}'`);
const membersAfter = await db.query(`select count(*)::int as n from church.members where church_id='${EKERO}'`);
report(
  'P0-1c',
  'where the project granted DELETE, the same policy cascades the flock records away with the church row',
  delWithGrant.ok && delWithGrant.affected === 1 && membersAfter.rows[0]?.n === 0,
  `members ${membersBefore.rows[0]?.n} → ${membersAfter.rows[0]?.n} (your project: check information_schema.role_table_grants)`,
);

// ── 5. the parts that hold ─────────────────────────────────────────────────
const crossRead = await asUser(PASTOR_BUKOTO, `SELECT slug FROM church.churches`);
check(
  'cross-tenant READ is denied: Bukoto sees only its own row',
  crossRead.ok && crossRead.rows.length === 1 && crossRead.rows[0].slug === 'bukoto',
  JSON.stringify(crossRead.rows),
);

const profileForge = await asUser(
  PASTOR_BUKOTO,
  `INSERT INTO public.admin_profiles (id, email, role, tenant_id) VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'evil@x.example', 'pastor', '${EKERO}')`,
);
check(
  'DEFENCE HOLDS: joining another tenant is denied, so my_tenant_id() cannot be pointed at a victim church',
  !profileForge.ok && /row-level security|permission denied/.test(profileForge.error ?? ''),
  profileForge.error?.split('\n')[0]?.slice(0, 80) || 'insert accepted',
);

const anonProbe = await (async () => {
  await db.exec('BEGIN');
  await db.exec('SET LOCAL ROLE anon');
  try {
    const r = await db.query(`SELECT count(*)::int as n FROM church.churches`);
    await db.exec('ROLLBACK');
    return { ok: true, rows: r.rows };
  } catch (error) {
    await db.exec('ROLLBACK');
    return { ok: false, error: String(error?.message ?? error) };
  }
})();
check(
  'an unauthenticated (anon) request cannot even read the church table',
  !anonProbe.ok && /row-level security|permission denied/.test(anonProbe.error ?? ''),
  anonProbe.ok ? `anon read ${anonProbe.rows[0]?.n} rows` : anonProbe.error.split('\n')[0].slice(0, 80),
);

// ── 6. drift guards: the shipped schema must NOT look like this fixture ─────
check(
  'the shipped schema no longer gives authenticated any write policy on church.churches',
  !/ON church\.churches\s+FOR (ALL|UPDATE|INSERT|DELETE)\s+TO (authenticated|public)/i.test(schema)
    && !/ON church\.churches FOR (ALL|UPDATE|INSERT|DELETE) TO (authenticated|public)/i.test(schema),
  'the FOR ALL policy is the bug; if this fails, someone re-added it',
);
check(
  'the shipped schema keeps churches readable for their own members',
  /ON church\.churches\s+FOR SELECT\s+TO authenticated/.test(schema),
);
check(
  'the shipped schema installs the column guard function and trigger',
  /CREATE OR REPLACE FUNCTION church\.guard_church_privileged_columns\(\)/.test(schema)
    && /CREATE TRIGGER guard_church_privileged_columns\s+BEFORE UPDATE ON church\.churches/.test(schema),
);
check(
  'the guard compares via jsonb so it cannot break on a database missing 011 or 017',
  (schema.match(/IF v_new \? v_column AND \(v_new -> v_column\) IS DISTINCT FROM \(v_old -> v_column\)/g) || []).length >= 1
    && !/IF\s+NEW\.(activation_status|passkey_hash|is_active)\s+IS DISTINCT FROM/i.test(schema),
  'a trigger naming an absent column fails every UPDATE at run time, not at CREATE time',
);
check(
  'both hardening migrations are shipped',
  readFileSync(new URL('../../migrations/019_activation_ledger_rls.sql', import.meta.url), 'utf8').includes('ENABLE ROW LEVEL SECURITY')
    && readFileSync(new URL('../../migrations/020_close_church_row_writes.sql', import.meta.url), 'utf8').includes('guard_church_privileged_columns'),
);

const failures = results.filter((r) => !r.pass);
console.log(
  `\n${results.length - failures.length}/${results.length} isolation defences hold`
    + ` · open findings reported: ${openFindings.length ? openFindings.join(', ') : 'none'}`,
);
console.log(
  'The OPEN lines above describe the LEGACY fixture this harness builds, not your\n'
  + 'production database. They do not fail this file on purpose: a security fix must never\n'
  + 'cost more than the bug. The closed state is asserted by\n'
  + 'tests/sql/rls_church_row_guard.test.mjs, which runs migrations/019 and 020 for real.',
);
if (failures.length) {
  console.error(`UNEXPECTED — a control that must hold has broken: ${failures.map((f) => f.name).join('; ')}`);
  process.exit(1);
}
