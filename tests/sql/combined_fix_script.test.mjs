// Validates scripts/fix-sms-wallet-rls.sql — the one block of SQL to paste into
// the Supabase SQL editor. Two things must hold:
//
//   1. It stays the verbatim concatenation of migrations/015 and migrations/016.
//      A hand-edited copy of a migration in scripts/ is how a paste and a deploy
//      start disagreeing, so equality is asserted, not trusted.
//   2. Applied once to a database in BOTH drifted states at once — the columns
//      missing AND RLS enabled with no policies — the app's exact reads stop
//      returning empty, and cross-tenant access is still refused.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const scriptPath = new URL('scripts/fix-sms-wallet-rls.sql', root);
const script = readFileSync(scriptPath, 'utf8');
const m15 = readFileSync(new URL('migrations/015_missing_schema_columns.sql', root), 'utf8').trim();
const m16 = readFileSync(new URL('migrations/016_rls_policy_repair.sql', root), 'utf8').trim();

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── 1. the paste is the migrations ──────────────────────────────────────────
check('script contains migrations/015 verbatim', script.includes(m15));
check('script contains migrations/016 verbatim', script.includes(m16));
check('015 is applied before 016 (columns exist before policies read them)',
  script.indexOf(m15) < script.indexOf(m16));
const verificationIsReadOnly = !/;\s*(insert|update|delete|alter|create|drop)\b/i
  .test(script.slice(script.indexOf('-- 3.1')));
check('verification section is read-only', verificationIsReadOnly,
  verificationIsReadOnly ? '' : 'a mutating statement leaked into the verification section');

// ── 2. apply it to a doubly-drifted database ────────────────────────────────
const PASTOR = '99999999-9999-4999-8999-999999999999';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $$
    SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid
  $$ LANGUAGE sql STABLE;
`);
await db.exec(`
  CREATE SCHEMA church;
  CREATE TABLE public.tenants (id uuid PRIMARY KEY, app_type text DEFAULT 'church', name text);
  -- no app_type: the column the enqueue guard used to project and never read
  CREATE TABLE public.admin_profiles (
    id uuid PRIMARY KEY, email text, tenant_id uuid,
    role text NOT NULL DEFAULT 'pastor', full_name text);
  -- no sms_rate / app_type / last_updated: what CREATE TABLE IF NOT EXISTS left behind
  CREATE TABLE public.wallets (tenant_id uuid PRIMARY KEY, balance bigint NOT NULL DEFAULT 0);
  CREATE TABLE public.wallet_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
    reference_code text, amount bigint, status text);
  CREATE TABLE church.churches (id uuid PRIMARY KEY, name text, slug text, sender_id text);
  CREATE TABLE church.members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), church_id uuid, full_name text, phone_number text);
  CREATE TABLE church.new_converts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), church_id uuid, name text, contact text);
  CREATE TABLE church.sms_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, recipient_phone text, body text, status text, idempotency_key text UNIQUE);
  CREATE TABLE church.sms_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, body text, status text DEFAULT 'pending', idempotency_key text UNIQUE);

  ALTER TABLE public.tenants             ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.admin_profiles      ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.wallets             ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.churches            ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.members             ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.new_converts        ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.sms_logs            ENABLE ROW LEVEL SECURITY;
  ALTER TABLE church.sms_queue           ENABLE ROW LEVEL SECURITY;

  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public, church TO anon, authenticated, service_role;
  GRANT SELECT ON ALL TABLES IN SCHEMA public, church TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA church TO authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public, church TO service_role;
`);
await db.exec(`
  INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'Grace Chapel'), ('${TENANT_B}', 'Other Chapel');
  INSERT INTO public.admin_profiles (id, tenant_id, role) VALUES ('${PASTOR}', '${TENANT_A}', 'pastor');
  INSERT INTO public.wallets (tenant_id, balance) VALUES ('${TENANT_A}', 350000), ('${TENANT_B}', 99000);
  INSERT INTO public.wallet_transactions (tenant_id, reference_code, amount, status) VALUES ('${TENANT_A}', 'CHURCH-A-1', 5000, 'pending');
  INSERT INTO church.churches (id, name, slug, sender_id) VALUES ('${TENANT_A}', 'Grace Chapel', 'grace', 'GRACE');
`);

const asPastor = async (statement) => {
  await db.exec(`SET ROLE authenticated; SET request.jwt.claims = '{"sub":"${PASTOR}","role":"authenticated"}'`);
  try {
    return await db.query(statement);
  } finally {
    await db.exec('RESET request.jwt.claims; RESET ROLE');
  }
};

/** For statements expected to fail: PGlite rejects where PostgREST would resolve
 *  to { data, error }, so a read that must not throw still needs a wrapper. */
const attemptPastor = async (statement) => {
  try {
    return { rows: (await asPastor(statement)).rows, error: null };
  } catch (error) {
    return { rows: [], error };
  }
};

const beforeBalance = await attemptPastor('SELECT balance, sms_rate, tenant_id FROM public.wallets');
check('before the script: the wallet read is impossible on both counts',
  /does not exist/i.test(String(beforeBalance.error?.message ?? '')),
  beforeBalance.error?.message ?? 'it succeeded, so the fixture is not drifted');

let applyError = null;
try {
  await db.exec(script);
} catch (error) {
  applyError = error;
}
check('the pasted script applies once to a doubly-drifted database',
  applyError === null, applyError?.message ?? '');

const afterBalance = await attemptPastor('SELECT balance, sms_rate, tenant_id FROM public.wallets');
check('after: the balance read returns the funded wallet',
  !afterBalance.error && afterBalance.rows.length === 1 && Number(afterBalance.rows[0].balance) === 350000,
  afterBalance.error?.message ?? JSON.stringify(afterBalance.rows));
check('after: remaining SMS computes as 5000, not 0 or NaN',
  Number(afterBalance.rows[0].balance) / Number(afterBalance.rows[0].sms_rate) === 5000,
  `sms_rate=${afterBalance.rows[0].sms_rate}`);

const afterProfile = await attemptPastor('SELECT tenant_id, role, app_type FROM public.admin_profiles');
check('after: the enqueue guard projection (tenant_id, role, app_type) works',
  !afterProfile.error && afterProfile.rows.length === 1 && afterProfile.rows[0].role === 'pastor',
  afterProfile.error?.message ?? JSON.stringify(afterProfile.rows));

let queueError = null;
try {
  await asPastor(`INSERT INTO church.sms_queue (tenant_id, body) VALUES ('${TENANT_A}', 'Service starting shortly')`);
} catch (error) {
  queueError = error;
}
check('after: a broadcast can be queued', queueError === null, queueError?.message ?? '');

let crossTenantError = null;
try {
  await asPastor(`INSERT INTO church.sms_queue (tenant_id, body) VALUES ('${TENANT_B}', 'sneak')`);
} catch (error) {
  crossTenantError = error;
}
check('after: another church is still refused (the repair widens nothing)',
  /row-level security/i.test(String(crossTenantError?.message ?? '')),
  crossTenantError?.message ?? 'it was accepted');

const otherWallet = await attemptPastor('SELECT tenant_id FROM public.wallets');
check('after: another church wallet stays invisible to the pastor',
  otherWallet.rows.length === 1 && otherWallet.rows[0].tenant_id === TENANT_A);

await db.exec(`SET ROLE service_role`);
const asService = await db.query('SELECT count(*) FROM public.wallets');
await db.exec('RESET ROLE');
check('after: service_role reads every wallet, which the routes depend on',
  Number(asService.rows[0].count) === 2, `count=${asService.rows[0].count}`);

// ── 3. the script's own verdict query ───────────────────────────────────────
const verdictSql = script.slice(script.indexOf('-- 3.3'), script.indexOf('-- 3.4'))
  .replace(/^--.*$/gm, '');
const verdict = await db.query(verdictSql);
check('the script reports everything_ok = true after repair',
  verdict.rows[0]?.everything_ok === true,
  JSON.stringify(verdict.rows[0]));

// ── 4. idempotence, and re-run after a deliberate regression ───────────────
let rerunError = null;
try {
  await db.exec(script);
} catch (error) {
  rerunError = error;
}
check('the script is safe to paste twice', rerunError === null, rerunError?.message ?? '');
const afterRerun = await asPastor('SELECT balance, sms_rate FROM public.wallets');
check('a re-run does not change the ledger or the rate',
  Number(afterRerun.rows[0].balance) === 350000 && Number(afterRerun.rows[0].sms_rate) === 70,
  JSON.stringify(afterRerun.rows[0]));

await db.exec(`DROP POLICY "churchos_tenant_select" ON public.wallets`);
const regressed = await attemptPastor('SELECT balance FROM public.wallets');
check('if that policy is dropped again, the read goes silently empty (the fault, isolated)',
  regressed.rows.length === 0 && !regressed.error,
  `rows=${regressed.rows.length} error=${regressed.error?.message ?? 'none'}`);
let healError = null;
try {
  await db.exec(script);
} catch (error) {
  healError = error;
}
const healed = await attemptPastor('SELECT balance FROM public.wallets');
check('and pasting the script again heals it', healError === null && healed.rows.length === 1,
  healError?.message ?? `rows=${healed.rows.length}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
