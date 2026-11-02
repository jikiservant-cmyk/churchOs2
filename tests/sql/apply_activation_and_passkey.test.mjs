// Executes scripts/apply-activation-and-passkey.sql — the one paste the operator
// runs — against a real PostgreSQL (PGlite, PG16) built in the shape that produced
// both reported symptoms:
//
//   * church.churches has NO activation_status / activation_paid_at at all, even
//     though four files in the app read them (supabase-schema.sql never declares
//     them and no migration created them)
//   * the passkey columns exist (migration 011 was applied) but `passkey` has no
//     DEFAULT, because 014 never ran — so provisioning created churches with no
//     usher code, which is what "the code isn't there for the new churches" was
//
// Then it proves the paste fixes both, survives being pasted a second time, keeps
// its read-only promises, and embeds the migrations byte-identically so the paste
// cannot drift from the files CI tests.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../../scripts/apply-activation-and-passkey.sql', import.meta.url), 'utf8');
const m17 = readFileSync(new URL('../../migrations/017_activation_billing_columns.sql', import.meta.url), 'utf8');
const m18 = readFileSync(new URL('../../migrations/018_usher_passkey_default.sql', import.meta.url), 'utf8');
const m12 = readFileSync(new URL('../../migrations/012_usher_passkey_backfill.sql', import.meta.url), 'utf8');
const audit = readFileSync(new URL('../../scripts/activation-gate-audit.sql', import.meta.url), 'utf8');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── structure ───────────────────────────────────────────────────────────────
check('the paste embeds 017 verbatim', script.includes(m17.trim()), 'edit the migration and re-generate; never hand-edit this file');
check('the paste embeds 018 verbatim', script.includes(m18.trim()));
check('the paste embeds 012 verbatim', script.includes(m12.trim()));
check('the paste embeds the gate audit verbatim', script.includes(audit.trim()));

const order = [
  ['preflight', script.indexOf('-- PART 0 — READ-ONLY PREFLIGHT')],
  ['017', script.indexOf(m17.trim())],
  ['018', script.indexOf(m18.trim())],
  ['012', script.indexOf(m12.trim())],
  ['audit', script.indexOf(audit.trim())],
  ['verify', script.indexOf('-- PART 5 — READ-ONLY VERIFICATION')],
];
check(
  'the parts run in dependency order',
  order.every(([, at]) => at > 0) && order.every(([, at], i) => i === 0 || at > order[i - 1][1]),
  order.map(([name, at]) => `${name}@${at}`).join(' '),
);

const afterVerify = script.slice(order[5][1]);
const mutating = afterVerify
  .split('\n')
  .map((line) => line.replace(/--.*$/, '').trim())
  .filter((line) => /\b(update|insert|delete|alter|drop|truncate|create|grant)\b/i.test(line));
check('nothing after the verification marker writes', mutating.length === 0, mutating.slice(0, 2).join(' | '));
check(
  'the two decisions an operator might want are commented out, not runnable',
  /--\s+update church\.churches/.test(afterVerify) && afterVerify.includes('PART 6 — NOT RUN'),
);
const executable = script
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
// The audit reads church.activation_payments into a temp table; nothing here may
// write to it, change a privilege, or redefine a payment RPC — that is the line
// the user asked not to cross.
const writesLedger = /\b(insert into|update|delete from|truncate)\b[^;]*church\.activation_payments/i.test(executable);
const changesPrivileges = /\bgrant\b|\brevoke\b|\bcreate or replace function\b|\bdrop (table|function|policy|constraint)\b/i.test(executable);
check(
  'the paste never writes to the payment ledger and never touches privileges or RPCs',
  !writesLedger && !changesPrivileges,
  'the ledger is read by the audit and left alone by everything else',
);

// ── the database the report actually described ──────────────────────────────
const brokenShape = `
  CREATE SCHEMA church;
  -- church.churches exactly as supabase-schema.sql ships it (no activation
  -- columns) plus migration 011's passkey columns, with no DEFAULT on passkey.
  CREATE TABLE church.churches (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    theme_color text DEFAULT 'bg-blue-600',
    created_at timestamptz DEFAULT now(),
    passkey text,
    passkey_hash text,
    passkey_version integer NOT NULL DEFAULT 1,
    passkey_updated_at timestamptz
  );
  CREATE TABLE church.activation_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    church_id uuid NOT NULL REFERENCES church.churches(id),
    merchant_reference text,
    amount numeric(14,2),
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz DEFAULT now()
  );
  INSERT INTO church.churches (name, slug) VALUES ('Legacy Assembly', 'legacy-assembly');
  INSERT INTO church.churches (name, slug) VALUES ('Kasanga Hill', 'kasanga-hill');
`;

const db = new PGlite();
await db.exec(brokenShape);

const before = await db.query(
  `select count(*) as n, count(*) filter (where coalesce(trim(passkey),'')='') as blank from church.churches`,
);
check(
  'the report is reproduced first: two churches, neither with an usher code, no billing columns',
  before.rows[0]?.n === 2 && before.rows[0]?.blank === 2
    && (await db.query(`select count(*) as c from information_schema.columns where table_schema='church' and table_name='churches' and column_name like 'activation%'`)).rows[0].c === 0,
  JSON.stringify(before.rows[0]),
);

let runError = '';
try {
  await db.exec(script);
} catch (error) {
  runError = String(error?.message ?? error);
}
check('the whole file runs as ONE paste', runError === '', runError.split('\n')[0]?.slice(0, 110));

const shape = await db.query(`
  select column_name, column_default from information_schema.columns
  where table_schema='church' and table_name='churches'
    and column_name in ('activation_status','activation_paid_at','passkey')
  order by column_name
`);
const defaults = Object.fromEntries(shape.rows.map((row) => [row.column_name, row.column_default]));
check(
  'the activation columns exist and the DEFAULT is the one that bills a new church',
  shape.rows.length === 3
    && String(defaults.activation_status ?? '').includes('pending_payment'),
  `activation_status default: ${defaults.activation_status}`,
);
check(
  'the usher code has its DEFAULT, so a row created outside the app gets one too',
  String(defaults.passkey ?? '').includes('gen_random_uuid'),
  String(defaults.passkey),
);

await db.exec(`INSERT INTO church.churches (name, slug) VALUES ('Grace Chapel', 'grace-chapel');`);
const created = (
  await db.query(`
    select activation_status, activation_paid_at, passkey, passkey_hash, passkey_version
    from church.churches where slug='grace-chapel'
  `)
).rows[0] ?? {};
check(
  'a church created after the paste has BOTH guarantees: it owes the fee, and it has a code',
  created.activation_status === 'pending_payment'
    && created.activation_paid_at === null
    && /^[0-9A-F]{10}$/.test(String(created.passkey ?? ''))
    && created.passkey_hash === null
    && created.passkey_version === 1,
  JSON.stringify({ status: created.activation_status, passkey: created.passkey, version: created.passkey_version }),
);

const after = await db.query(`
  select count(*) as n,
         count(*) filter (where coalesce(trim(passkey),'')='') as blank_code,
         count(*) filter (where passkey !~ '^[A-Za-z0-9_-]{6,32}$') as portal_would_reject,
         count(*) filter (where passkey_version <> 1) as usher_sessions_revoked
  from church.churches
`);
check(
  'every church now has a code the portal accepts, and no usher session was revoked',
  after.rows[0]?.n === 3 && after.rows[0]?.blank_code === 0
    && after.rows[0]?.portal_would_reject === 0 && after.rows[0]?.usher_sessions_revoked === 0,
  JSON.stringify(after.rows[0]),
);

const distinct = await db.query(`select count(distinct passkey) as d, count(*) as n from church.churches`);
check(
  'the codes are per church — not one shared value handed to everybody',
  distinct.rows[0]?.d === distinct.rows[0]?.n,
  JSON.stringify(distinct.rows[0]),
);

// The money side must be untouched: 017 only ever sets a *default*, so a church
// that has already settled keeps its 'active' status through the paste.
await db.exec(`update church.churches set activation_status='active', activation_paid_at=now() where slug='legacy-assembly';`);
const settled = (await db.query(`select activation_status from church.churches where slug='legacy-assembly'`)).rows[0];
check('a church that has paid stays paid', settled?.activation_status === 'active', JSON.stringify(settled));

// ── the verification block must say what it claims ──────────────────────────
const verdictSql = script
  .slice(script.indexOf('-- 5.4 Everything this file was for'))
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .trim();
check(
  'the one-row summary is a single read-only select',
  /^with .+;$/is.test(verdictSql) && !/\b(update|insert|alter|drop)\b/i.test(verdictSql),
);
const verdict = await db.query(verdictSql.replace(/;\s*$/, ''));
check(
  'the paste reports everything_ok = true against the database it just fixed',
  verdict.rows.length === 1
    && verdict.rows[0].everything_ok === true
    && verdict.rows[0].every_church_has_an_usher_code === true
    && verdict.rows[0].activation_columns_exist === true,
  JSON.stringify(verdict.rows[0]),
);

check(
  '5.4 counts the grandfathered rows rather than reading a GUC no SQL console sets',
  verdict.rows[0]?.churches_a_tighter_gate_would_newly_bill === 1,
  `newly billed if the gate were tightened: ${verdict.rows[0]?.churches_a_tighter_gate_would_newly_bill} — the one church still with no status and no receipt`
    + ' (a current_setting() term would have reported 0 and looked like good news)',
);

// ── pasting it again ────────────────────────────────────────────────────────
const codesBefore = (await db.query(`select md5(string_agg(passkey, ',' order by slug)) as h from church.churches`)).rows[0].h;
let secondRunError = '';
try {
  await db.exec(script);
} catch (error) {
  secondRunError = String(error?.message ?? error);
}
const afterRerun = await db.query(`
  select count(*) as n,
         md5(string_agg(passkey, ',' order by slug)) as codes,
         count(*) filter (where activation_status='active') as settled
  from church.churches
`);
check(
  'pasting it a second time changes nothing: no error, no new rows, no re-issued code',
  secondRunError === '' && afterRerun.rows[0]?.n === 3 && afterRerun.rows[0]?.codes === codesBefore && afterRerun.rows[0]?.settled === 1,
  secondRunError.split('\n')[0]?.slice(0, 100) || JSON.stringify(afterRerun.rows[0]),
);

// ── a preflight must survive the absence it is looking for ──────────────────
// PART 0 runs before 017, so on the broken database it cannot name the missing
// columns directly; and on a database with no passkey columns at all, 018 has to
// refuse and say which migration is missing rather than guess.
let refusal = '';
const bare = new PGlite();
try {
  await bare.exec(`
    CREATE SCHEMA church;
    CREATE TABLE church.churches (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, name text NOT NULL, slug text UNIQUE, created_at timestamptz DEFAULT now());
    INSERT INTO church.churches (name, slug) VALUES ('No Columns Church','no-cols');
  `);
  await bare.exec(script);
} catch (error) {
  refusal = String(error?.message ?? error);
}
check(
  'a database without migration 011 is refused by name, not silently half-migrated',
  /011_usher_passkey_columns\.sql/.test(refusal),
  refusal.split('\n')[0]?.slice(0, 100) || 'it ran without complaining',
);

let noChurch = '';
const empty = new PGlite();
try {
  await empty.exec(script);
} catch (error) {
  noChurch = String(error?.message ?? error);
}
check(
  'pasting it into a project with no church.churches stops with an explanation',
  /church_churches_exists|church\.churches/.test(noChurch),
  noChurch.split('\n')[0]?.slice(0, 100) || 'it ran',
);

const failures = results.filter((result) => !result.pass);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.map((failure) => failure.name).join('; ')}`);
  process.exit(1);
}
