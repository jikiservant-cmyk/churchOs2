// Executes migration 016 against a real PostgreSQL (PGlite, PG16) in the exact
// shape the incident produced:
//   * the tables exist, RLS is ENABLED on them, and the policies are MISSING
//     (what a schema re-run that aborted at `CREATE POLICY ... already exists`
//     leaves behind)
//   * privileges are granted, so a read does NOT error — it returns 0 rows
// Then it proves the reads the app performs were silently empty, that 016
// restores them, that it does not widen access across tenants, and that the
// migration is safe to re-run.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../migrations/016_rls_policy_repair.sql', import.meta.url), 'utf8');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const PASTOR = '99999999-9999-4999-8999-999999999999';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const db = new PGlite();

// Roles + the auth/PostgREST surface the policies depend on. PGlite's session
// user is a superuser, which bypasses RLS entirely, so every assertion below
// runs under `SET ROLE` — otherwise the test would prove nothing.
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $$
    SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid
  $$ LANGUAGE sql STABLE;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
`);

await db.exec(`
  CREATE SCHEMA church;
  CREATE TABLE public.tenants (id uuid PRIMARY KEY, app_type text DEFAULT 'church', name text);
  CREATE TABLE public.admin_profiles (
    id uuid PRIMARY KEY, email text, tenant_id uuid,
    role text NOT NULL DEFAULT 'pastor', app_type text DEFAULT 'church', full_name text);
  CREATE TABLE public.wallets (
    tenant_id uuid PRIMARY KEY, balance bigint NOT NULL DEFAULT 0,
    sms_rate int NOT NULL DEFAULT 70, app_type text NOT NULL DEFAULT 'church',
    last_updated timestamptz DEFAULT now());
  CREATE TABLE public.wallet_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
    reference_code text, amount bigint, status text);
  CREATE TABLE church.churches (id uuid PRIMARY KEY, name text, slug text, sender_id text);
  CREATE TABLE church.members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), church_id uuid, full_name text, phone_number text);
  CREATE TABLE church.new_converts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), church_id uuid, name text, contact text);
  CREATE TABLE church.sms_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, recipient_phone text, body text, status text, idempotency_key text UNIQUE);
  CREATE TABLE church.sms_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, body text, status text DEFAULT 'pending', idempotency_key text UNIQUE);
`);

// The drifted state: RLS on, privileges granted, policies absent.
await db.exec(`
  ALTER TABLE public.tenants            ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.admin_profiles     ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.wallets            ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.churches           ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.members            ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.new_converts       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.sms_logs           ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.sms_queue          ENABLE ROW LEVEL SECURITY;

  GRANT SELECT ON ALL TABLES IN SCHEMA public, church TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA church TO authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public, church TO service_role;
`);

// `church.my_tenant_id()` is also gone — 12 RPCs in this project have no repo
// definition, so the migration must be able to recreate the one every policy needs.
const asPastor = async (statement) => {
  await db.exec(`SET ROLE authenticated; SET request.jwt.claims = '{"sub":"${PASTOR}","role":"authenticated"}'`);
  try {
    return await db.query(statement);
  } finally {
    await db.exec('RESET request.jwt.claims; RESET ROLE');
  }
};

await db.exec(`
  GRANT USAGE ON SCHEMA public, church TO anon, authenticated, service_role;
`);

await db.exec(`
  INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'Grace Chapel'), ('${TENANT_B}', 'Other Chapel');
  INSERT INTO public.admin_profiles (id, tenant_id, role) VALUES ('${PASTOR}', '${TENANT_A}', 'pastor');
  INSERT INTO public.wallets (tenant_id, balance) VALUES ('${TENANT_A}', 350000), ('${TENANT_B}', 99000);
  INSERT INTO public.wallet_transactions (tenant_id, reference_code, amount, status) VALUES ('${TENANT_A}', 'CHURCH-A-1', 5000, 'pending');
  INSERT INTO church.churches (id, name, slug, sender_id) VALUES ('${TENANT_A}', 'Grace Chapel', 'grace', 'GRACE');
  INSERT INTO church.members (church_id, full_name, phone_number) VALUES ('${TENANT_A}', 'John', '+256700000001');
`);

// ── The incident, reproduced: RLS silently empties the reads ────────────────
// If RLS produced an error the caller would see one; the point is that it does not.
const walletRows = await asPastor('SELECT balance, sms_rate, tenant_id FROM public.wallets');
const rowsActuallyStored = Number((await db.query('SELECT count(*) FROM public.wallets')).rows[0].count);
check('pre-016 the wallet read returns 0 rows with NO error while 2 are stored',
  walletRows.rows.length === 0 && rowsActuallyStored === 2,
  `returned=${walletRows.rows.length} stored=${rowsActuallyStored}`);

const profileRows = await asPastor('SELECT role, tenant_id FROM public.admin_profiles');
check('pre-016 the admin_profiles read is silently empty too', profileRows.rows.length === 0,
  `rows=${profileRows.rows.length}`);

let insertError = null;
try {
  await asPastor(`INSERT INTO church.sms_queue (tenant_id, body) VALUES ('${TENANT_A}', 'hi')`);
} catch (error) {
  insertError = error;
}
check('pre-016 queueing a broadcast is rejected by RLS',
  insertError !== null && /row-level security/i.test(String(insertError.message)),
  insertError?.message ?? 'unexpected success');

// ── Apply 016 ────────────────────────────────────────────────────────────────
let applyError = null;
try {
  await db.exec(sql);
} catch (error) {
  applyError = error;
}
check('016 applies to a drifted database', applyError === null, applyError?.message ?? '');

// ── After: the same reads, same role, same claims ───────────────────────────
const afterWallet = await asPastor('SELECT tenant_id, balance FROM public.wallets');
check('post-016 the pastor sees their own funded wallet',
  afterWallet.rows.length === 1 && Number(afterWallet.rows[0].balance) === 350000,
  JSON.stringify(afterWallet.rows));
check('post-016 the other church wallet is still invisible (no widening)',
  !afterWallet.rows.some((r) => r.tenant_id === TENANT_B));

const afterProfile = await asPastor('SELECT role, tenant_id FROM public.admin_profiles');
check('post-016 the enqueue guard can read its own profile row',
  afterProfile.rows.length === 1 && afterProfile.rows[0].role === 'pastor',
  JSON.stringify(afterProfile.rows));

let insertErrorAfter = null;
try {
  await asPastor(`INSERT INTO church.sms_queue (tenant_id, body) VALUES ('${TENANT_A}', 'hi')`);
} catch (error) {
  insertErrorAfter = error;
}
check('post-016 queueing a broadcast succeeds', insertErrorAfter === null, insertErrorAfter?.message ?? '');

let crossTenantError = null;
try {
  await asPastor(`INSERT INTO church.sms_queue (tenant_id, body) VALUES ('${TENANT_B}', 'sneak')`);
} catch (error) {
  crossTenantError = error;
}
check('post-016 writing to ANOTHER tenant is still rejected',
  crossTenantError !== null && /row-level security/i.test(String(crossTenantError.message)),
  crossTenantError?.message ?? 'it was accepted — that would be a privilege escalation');

// church.my_tenant_id() had to be recreated for any of this to work
const fn = await db.query(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='church' AND p.proname='my_tenant_id'`);
check('016 recreated church.my_tenant_id() when it was missing', Number(fn.rows[0].count) === 1);

// service_role reads must work, since the routes use them
await db.exec(`SET ROLE service_role; RESET request.jwt.claims`);
const asService = await db.query('SELECT count(*) FROM public.wallets');
await db.exec('RESET ROLE');
check('post-016 service_role reads every wallet (the routes rely on it)',
  Number(asService.rows[0].count) === 2, `count=${asService.rows[0].count}`);

// ── Idempotence ─────────────────────────────────────────────────────────────
let rerunError = null;
try {
  await db.exec(sql);
} catch (error) {
  rerunError = error;
}
check('016 is safe to re-run', rerunError === null, rerunError?.message ?? '');
const afterRerun = await asPastor('SELECT balance FROM public.wallets');
check('after a re-run the balance is still 350000, not 0',
  afterRerun.rows.length === 1 && Number(afterRerun.rows[0].balance) === 350000,
  JSON.stringify(afterRerun.rows));
const policyCount = await db.query(`SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid WHERE pol.polname LIKE 'churchos_%'`);
// 9 select + 4 write (queue, logs, members, converts) + 9 service_role
check('re-running does not duplicate policies', Number(policyCount.rows[0].count) === 22, `count=${policyCount.rows[0].count}`);

// ── The precondition guard ──────────────────────────────────────────────────
{
  const bare = new PGlite();
  await bare.exec(`CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE SCHEMA church;`);
  let guardError = null;
  try {
    await bare.exec(sql);
  } catch (error) {
    guardError = error;
  }
  check('016 refuses before touching anything when auth.uid() is absent',
    guardError !== null && /auth\.uid\(\) is missing/i.test(String(guardError.message)),
    guardError?.message ?? 'it applied, which it must not');
  await bare.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
