// Executes migration 015 against a real PostgreSQL (PGlite, PG16) shaped like the
// live deployment that produced the incident:
//   * public.wallets exists WITHOUT sms_rate / app_type / last_updated
//   * public.admin_profiles exists WITHOUT app_type
//   * one funded wallet (balance 350000) whose balance the UI refused to show
// Then it proves the app's exact projection failed before 015 and works after,
// that no balance was rewritten, and that 015 is safe to re-run.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

await db.exec(`
  CREATE TABLE public.admin_profiles (
    id uuid PRIMARY KEY,
    email text,
    tenant_id uuid,
    role text NOT NULL DEFAULT 'pastor',
    full_name text,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.wallets (
    tenant_id uuid PRIMARY KEY,
    balance bigint NOT NULL DEFAULT 0
  );
`);
const TENANT = '11111111-1111-4111-8111-111111111111';
await db.query(`INSERT INTO public.wallets (tenant_id, balance) VALUES ($1, 350000)`, [TENANT]);
await db.query(`INSERT INTO public.admin_profiles (id, tenant_id, role) VALUES ($1, $2, 'pastor')`,
  ['99999999-9999-4999-8999-999999999999', TENANT]);

const columns = async (table) => (await db.query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 ORDER BY column_name`, [table])).rows.map(r => r.column_name);

const attempt = async (sql) => {
  try {
    await db.exec(sql);
    return null;
  } catch (error) {
    return error;
  }
};

const projection = async (select, table) => {
  try {
    return await db.query(`SELECT ${select} FROM public.${table} LIMIT 1`);
  } catch (error) {
    return { error };
  }
};

// ── The bug, reproduced ──────────────────────────────────────────────────────
check('pre-state: wallets has balance but no sms_rate',
  columns0(await columns('wallets')), JSON.stringify(await columns('wallets')));

const beforeWalletRead = await projection('balance, sms_rate, tenant_id', 'wallets');
check('pre-015 the app wallet projection fails', Boolean(beforeWalletRead.error),
  beforeWalletRead.error?.message ?? 'unexpected success');
check('pre-015 the failure is a missing-column error, not empty data',
  /does not exist|missing (?:FROM|target)/i.test(String(beforeWalletRead.error?.message ?? '')));

const beforeProfileRead = await projection("tenant_id, role, app_type", 'admin_profiles');
check('pre-015 the enqueue guard projection fails the same way',
  Boolean(beforeProfileRead.error), beforeProfileRead.error?.message ?? 'unexpected success');

// ── Apply 015 ────────────────────────────────────────────────────────────────
const sql = readFileSync(new URL('../../migrations/015_missing_schema_columns.sql', import.meta.url), 'utf8');
const applyError = await attempt(sql);
check('015 applies cleanly to a drifted database', applyError === null, applyError?.message ?? '');

// ── After ────────────────────────────────────────────────────────────────────
const afterWalletRead = await projection('balance, sms_rate, tenant_id', 'wallets');
check('post-015 the app wallet projection works', !afterWalletRead.error,
  afterWalletRead.error?.message ?? '');
check('post-015 the balance is the one that was already there',
  Number(afterWalletRead.rows?.[0]?.balance) === 350000,
  `balance=${afterWalletRead.rows?.[0]?.balance} sms_rate=${afterWalletRead.rows?.[0]?.sms_rate}`);
check('post-015 sms_rate defaults to 70 (the rate the UI assumed anyway)',
  Number(afterWalletRead.rows?.[0]?.sms_rate) === 70);
check('post-015 remaining SMS is 5000, not 0',
  Math.floor(Number(afterWalletRead.rows?.[0]?.balance) / Number(afterWalletRead.rows?.[0]?.sms_rate)) === 5000);

const afterProfileRead = await projection("tenant_id, role, app_type", 'admin_profiles');
check('post-015 the enqueue guard projection works', !afterProfileRead.error,
  afterProfileRead.error?.message ?? '');
check('post-015 the pastor still reads as pastor', afterProfileRead.rows?.[0]?.role === 'pastor');

// ── Idempotence: re-running must neither fail nor change the ledger ─────────
await db.query(`UPDATE public.wallets SET balance = 1400, sms_rate = 105 WHERE tenant_id = $1`, [TENANT]);
const rerunError = await attempt(sql);
check('015 is safe to re-run', rerunError === null, rerunError?.message ?? '');
const afterRerun = await projection('balance, sms_rate, tenant_id', 'wallets');
check('re-running 015 preserves a hand-set rate and the balance',
  Number(afterRerun.rows[0].balance) === 1400 && Number(afterRerun.rows[0].sms_rate) === 105,
  `balance=${afterRerun.rows[0].balance} sms_rate=${afterRerun.rows[0].sms_rate}`);

// ── The guard: a wallet table with no `balance` must refuse, not zero-fill ──
{
  const guarded = new PGlite();
  await guarded.exec(`
    CREATE TABLE public.admin_profiles (id uuid PRIMARY KEY, tenant_id uuid, role text);
    CREATE TABLE public.wallets (tenant_id uuid PRIMARY KEY);
  `);
  const error = await (async () => {
    try { await guarded.exec(sql); return null; } catch (e) { return e; }
  })();
  check('015 refuses when public.wallets.balance is absent',
    /Refusing to add it with a 0 default/i.test(String(error?.message ?? '')),
    error?.message ?? 'it applied, which it must not');
  const cols = (await guarded.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='wallets'`)).rows.map(r => r.column_name);
  check('the refusal happened before any wallet column was added',
    !cols.includes('balance') && !cols.includes('sms_rate'), JSON.stringify(cols));
  await guarded.exec(`DROP TABLE public.wallets; CREATE TABLE public.wallets (tenant_id uuid PRIMARY KEY, balance bigint NOT NULL DEFAULT 0);`);
  const afterRestore = await (async () => {
    try { await guarded.exec(sql); return null; } catch (e) { return e; }
  })();
  check('015 succeeds once the ledger column is restored', afterRestore === null, afterRestore?.message ?? '');
}

function columns0(cols) {
  return cols.includes('balance') && !cols.includes('sms_rate');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
