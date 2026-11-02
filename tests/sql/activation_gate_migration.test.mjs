// Executes migration 017 and scripts/activation-gate-audit.sql against a real
// PostgreSQL (PGlite, PG16) in the two shapes that matter in production:
//
//   A. a database built from supabase-schema.sql, where the activation billing
//      columns have never existed — the exact state that let an unpaid church
//      walk into the workspace;
//   B. a live database that already has the column AND legacy surprise values
//      in it, where a plain `VALIDATE CONSTRAINT` would abort the deploy.
//
// Then it proves the audit script reads the same verdicts the app computes, and
// that neither file writes anything it should not.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../migrations/017_activation_billing_columns.sql', import.meta.url), 'utf8');
const audit = readFileSync(new URL('../../scripts/activation-gate-audit.sql', import.meta.url), 'utf8');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const baseDdl = `
  CREATE SCHEMA church;
  -- The base schema, as supabase-schema.sql declares it: church.churches with
  -- no activation_status and no activation_paid_at anywhere.
  CREATE TABLE church.churches (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE church.activation_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    church_id uuid NOT NULL REFERENCES church.churches(id),
    merchant_reference text,
    amount numeric(14,2),
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz DEFAULT now()
  );
`;

const rowsOf = (execResults, key) => {
  for (const entry of execResults) {
    if (Array.isArray(entry.rows) && entry.rows.length > 0 && key in entry.rows[0]) return entry.rows;
  }
  return [];
};

const errorText = (error) => String(error?.message ?? error);

// ── A. a database exactly as this repository ships it ───────────────────────
const a = new PGlite();
await a.exec(baseDdl);

// The audit must refuse politely rather than erroring on a missing column.
let refused = '';
try {
  await a.exec(audit);
} catch (error) {
  refused = errorText(error);
}
check(
  'the audit refuses to run on an unmigrated database and says what to do',
  /017_activation_billing_columns\.sql/.test(refused),
  refused.split('\n')[0]?.slice(0, 90) ?? 'it ran anyway',
);
// The guard raised inside the audit's own BEGIN, so the session is left in an
// aborted transaction. The SQL editor runs each "Run" in a fresh transaction;
// the test has to close it by hand before anything else can execute.
await a.exec('ROLLBACK;');

await a.exec(migration);

const shape = await a.query(`
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'church' and table_name = 'churches'
    and column_name in ('activation_status','activation_paid_at')
  order by column_name
`);
check(
  'both billing columns now exist',
  shape.rows.length === 2
    && shape.rows.every((row) => row.is_nullable === 'YES'),
  shape.rows.map((row) => `${row.column_name}:${row.data_type}`).join(' '),
);
check(
  'a new church is created owing the fee, not free',
  String(shape.rows.find((row) => row.column_name === 'activation_status')?.column_default ?? '').includes('pending_payment'),
  String(shape.rows.find((row) => row.column_name === 'activation_status')?.column_default),
);

const inserted = await a.query(
  `insert into church.churches (name, slug) values ('Grace Chapel','grace-chapel')
   returning activation_status, activation_paid_at`,
);
check(
  'an insert that never mentions billing still lands behind the gate',
  inserted.rows[0]?.activation_status === 'pending_payment' && inserted.rows[0]?.activation_paid_at === null,
  JSON.stringify(inserted.rows[0]),
);

const explicitNull = await a.query(
  `insert into church.churches (name, slug, activation_status) values ('Legacy','legacy-chapel', null)
   returning activation_status`,
);
check('the migration never rewrote an existing or explicit NULL', explicitNull.rows[0]?.activation_status === null);

let rejected = '';
try {
  await a.query(`insert into church.churches (name, slug, activation_status) values ('Junk','junk-chapel','banana')`);
} catch (error) {
  rejected = errorText(error);
}
check('a new row cannot invent a fourth state', /churches_activation_status_known/.test(rejected), rejected.split('\n')[0]?.slice(0, 70));

// The audit has to agree with lib/activation-gate.ts, row by row.
const audited = rowsOf(await a.exec(audit), 'slug');
const bySlug = Object.fromEntries(audited.map((row) => [row.slug, row]));
check(
  'the audit reports the pending church as billed today',
  bySlug?.['grace-chapel']?.verdict_today === 'pay:status-pending_payment',
  JSON.stringify(bySlug?.['grace-chapel']),
);
check(
  'the audit reports the NULL church as grandfathered now, payable if tightened',
  bySlug?.['legacy-chapel']?.verdict_today === 'allow:grandfathered'
    && bySlug?.['legacy-chapel']?.verdict_if_tightened === 'pay:status-missing'
    && bySlug?.['legacy-chapel']?.would_newly_gate === true,
  `${bySlug?.['legacy-chapel']?.verdict_today} → ${bySlug?.['legacy-chapel']?.verdict_if_tightened}`,
);

await a.query(`update church.churches set activation_status='active', activation_paid_at=now() where slug='grace-chapel'`);
const paidBefore = await a.query(`select count(*)::int as n from church.churches`);
const afterSettle = rowsOf(await a.exec(audit), 'slug');
const settled = afterSettle.find((row) => row.slug === 'grace-chapel');
const stillPending = afterSettle.find((row) => row.slug === 'legacy-chapel');
const summary = rowsOf(await a.exec(audit), 'churches_total')[0];
check(
  'an active church is allowed, and its receipt is shown',
  settled?.verdict_today === 'allow:status-active' && settled?.paid_ledger_rows === 0,
  JSON.stringify({ verdict: settled?.verdict_today, receipts: settled?.paid_ledger_rows }),
);
await a.query(`update church.churches set activation_paid_at = now() where slug='legacy-chapel'`);
const grandfathered = rowsOf(await a.exec(audit), 'slug').find((row) => row.slug === 'legacy-chapel');
check(
  'a paid timestamp alone spares a NULL-status church from the gate',
  grandfathered?.verdict_today === 'allow:legacy-paid-timestamp'
    && grandfathered?.verdict_if_tightened === 'allow:legacy-paid-timestamp',
  String(grandfathered?.verdict_today),
);
const afterAudit = await a.query(`select count(*)::int as n from church.churches`);
check(
  'the audit is read-only — the row count is what it was',
  paidBefore.rows[0].n === afterAudit.rows[0].n && stillPending !== undefined,
  `${paidBefore.rows[0].n} rows before, ${afterAudit.rows[0].n} after`,
);
check('the audit summary counts every church once', summary?.churches_total === afterAudit.rows[0].n, JSON.stringify(summary));

const indexes = await a.query(`select indexname from pg_indexes where tablename = 'churches' and schemaname = 'church'`);
check(
  'the gate gets its partial index',
  indexes.rows.some((row) => row.indexname === 'churches_activation_unpaid_idx'),
  indexes.rows.map((row) => row.indexname).join(', '),
);

// Idempotency: this is pasted into the SQL editor, sometimes twice.
let repeatError = '';
try {
  await a.exec(migration);
} catch (error) {
  repeatError = errorText(error);
}
check('017 can be re-run without damage', repeatError === '', repeatError.split('\n')[0]?.slice(0, 80));

// A church that paid through the ledger must not be double-gated: the paid row
// is what `paid_ledger_rows` surfaces, and it only counts 'paid'.
await a.query(`
  insert into church.activation_payments (church_id, merchant_reference, amount, status)
  select id, 'ACT-1', 17000, 'paid' from church.churches where slug='grace-chapel'
`);
const withReceipt = rowsOf(await a.exec(audit), 'slug').find((row) => row.slug === 'grace-chapel');
check('a settled ledger row is visible to the audit', withReceipt?.paid_ledger_rows === 1, JSON.stringify({ rows: withReceipt?.paid_ledger_rows }));
await a.query(`
  insert into church.activation_payments (church_id, merchant_reference, amount, status)
  select id, 'ACT-2', 17000, 'pending' from church.churches where slug='grace-chapel'
`);
const withPendingOnly = rowsOf(await a.exec(audit), 'slug').find((row) => row.slug === 'grace-chapel');
check('an unpaid attempt is not counted as a receipt', withPendingOnly?.paid_ledger_rows === 1, JSON.stringify({ rows: withPendingOnly?.paid_ledger_rows }));

// ── B. a live database that already has the column, and legacy junk in it ────
const b = new PGlite();
await b.exec(baseDdl);
await b.exec(`ALTER TABLE church.churches ADD COLUMN activation_status text DEFAULT 'active';`);
await b.exec(`
  insert into church.churches (name, slug, activation_status) values
    ('Alpha','alpha-church','active'),
    ('Beta','beta-church','trial_period'),
    ('Gamma','gamma-church', null);
`);

let liveError = '';
try {
  await b.exec(migration);
} catch (error) {
  liveError = errorText(error);
}
check(
  'a half-migrated live database does not fail the deploy',
  liveError === '',
  liveError.split('\n')[0]?.slice(0, 90),
);

const liveShape = await b.query(`select column_default from information_schema.columns
  where table_schema='church' and table_name='churches' and column_name='activation_status'`);
check(
  "an existing default is reported, not overwritten",
  String(liveShape.rows[0]?.column_default ?? '').includes("'active'"),
  String(liveShape.rows[0]?.column_default),
);

const constraint = await b.query(`select convalidated from pg_constraint where conname = 'churches_activation_status_known'`);
check(
  'the domain check stays NOT VALID while a legacy value is present',
  constraint.rows.length === 1 && constraint.rows[0].convalidated === false,
  JSON.stringify(constraint.rows[0]),
);

const legacyRows = await b.query(`select slug, activation_status from church.churches order by slug`);
check(
  'no existing church row was touched',
  legacyRows.rows.length === 3
    && legacyRows.rows[0].activation_status === 'active'
    && legacyRows.rows[1].activation_status === 'trial_period'
    && legacyRows.rows[2].activation_status === null,
  legacyRows.rows.map((row) => `${row.slug}=${row.activation_status}`).join(' '),
);

const liveAudit = rowsOf(await b.exec(audit), 'slug');
check(
  'an unknown explicit status is billed under both policies (trial_period is not settled)',
  liveAudit.find((row) => row.slug === 'beta-church')?.verdict_today === 'pay:status-trial_period'
    && liveAudit.find((row) => row.slug === 'beta-church')?.would_newly_gate === false,
  JSON.stringify(liveAudit.find((row) => row.slug === 'beta-church')?.verdict_today),
);

// The gate must survive the junk: once validated, only the three states remain.
await b.query(`update church.churches set activation_status = 'pending_payment' where slug = 'beta-church'`);
await b.exec(migration);
const validated = await b.query(`select convalidated from pg_constraint where conname = 'churches_activation_status_known'`);
check(
  'once the offending rows are fixed, re-running validates the constraint',
  validated.rows[0]?.convalidated === true,
  JSON.stringify(validated.rows[0]),
);

const failures = results.filter((result) => !result.pass);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.map((failure) => failure.name).join('; ')}`);
  process.exit(1);
}
