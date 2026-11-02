// Executes migration 018 (and 012 after it) against a real PostgreSQL (PGlite,
// PG16) shaped like the database that produces the reported symptom: the passkey
// columns exist (011 applied) but `passkey` has no DEFAULT (014 has not run), so
// a church created by an insert that omits the column — which is what
// `provision_church_v3` does — ends up with no usher code at all.
//
// It proves 018 closes that hole without ever writing a credential itself, that
// 012 remains the file that fills existing rows, and that both are safe to re-run.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../migrations/018_usher_passkey_default.sql', import.meta.url), 'utf8');
const backfill = readFileSync(new URL('../../migrations/012_usher_passkey_backfill.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../../supabase-schema.sql', import.meta.url), 'utf8');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const ddl = `
  CREATE SCHEMA church;
  -- 011 applied: the columns exist. 014 not applied: passkey has no DEFAULT.
  CREATE TABLE church.churches (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    passkey text,
    passkey_hash text,
    passkey_version integer NOT NULL DEFAULT 1,
    passkey_updated_at timestamptz
  );
`;

const db = new PGlite();
await db.exec(ddl);

// Reproduce the production shape exactly: the provisioning RPC does not name the
// column, so the row is born without a code.
await db.exec(`
  INSERT INTO church.churches (name, slug) VALUES ('Kasanga Hill Assembly', 'kasanga-hill');
`);
const bornWithout = await db.query(`select coalesce(trim(passkey),'<null>') as passkey from church.churches where slug='kasanga-hill'`);
check(
  'the symptom is real before the migration: a new church has no usher code',
  bornWithout.rows[0]?.passkey === '<null>',
  JSON.stringify(bornWithout.rows[0]),
);

await db.exec(migration);

const shape = await db.query(`
  select column_default from information_schema.columns
  where table_schema='church' and table_name='churches' and column_name='passkey'
`);
check(
  '018 installs the passkey DEFAULT where none existed',
  String(shape.rows[0]?.column_default ?? '').includes('gen_random_uuid'),
  String(shape.rows[0]?.column_default),
);

const afterRun = await db.query(`select coalesce(trim(passkey),'<null>') as passkey from church.churches where slug='kasanga-hill'`);
check(
  '018 writes no credential: the existing blank row is still blank',
  afterRun.rows[0]?.passkey === '<null>',
  JSON.stringify(afterRun.rows[0]),
);

// A church created after 018 — by any path, including a bare SQL insert — has a code.
await db.exec(`INSERT INTO church.churches (name, slug) VALUES ('Grace Chapel', 'grace-chapel');`);
const newborn = await db.query(`select passkey, passkey_hash from church.churches where slug='grace-chapel'`);
check(
  'a church created after 018 is born with a portal-acceptable code',
  /^[0-9A-F]{10}$/.test(String(newborn.rows[0]?.passkey ?? '')) && newborn.rows[0]?.passkey_hash === null,
  JSON.stringify(newborn.rows[0]),
);
// 012 is the file that fills existing rows; 018 only points at it.
await db.exec(backfill);
const repaired = await db.query(`
  select count(*) filter (where coalesce(trim(passkey),'') = '') as still_blank,
         count(*) filter (where passkey ~ '^[0-9A-Z]{10}$') as filled
  from church.churches
`);
check(
  '018 then 012 leaves no church without a code',
  repaired.rows[0]?.still_blank === 0 && repaired.rows[0]?.filled === 2,
  JSON.stringify(repaired.rows[0]),
);

const versions = await db.query(`select count(*) as bumped from church.churches where passkey_version <> 1`);
check(
  'no usher session is revoked by either file',
  versions.rows[0]?.bumped === 0,
  JSON.stringify(versions.rows[0]),
);

const existingBefore = await db.query(`select passkey from church.churches where slug='grace-chapel'`);
await db.exec(migration);
const existingAfter = await db.query(`select passkey from church.churches where slug='grace-chapel'`);
check(
  '018 is idempotent and never re-issues a code that exists',
  existingBefore.rows[0]?.passkey === existingAfter.rows[0]?.passkey,
  `${existingBefore.rows[0]?.passkey} → ${existingAfter.rows[0]?.passkey}`,
);

let repeatError = '';
try {
  await db.exec(migration);
  await db.exec(backfill);
} catch (error) {
  repeatError = String(error?.message ?? error);
}
check('both files can be pasted a second time without damage', repeatError === '', repeatError.split('\n')[0]?.slice(0, 80));

// A database that never received 011 must be told to go back, not half-migrated.
const bare = new PGlite();
await bare.exec(`
  CREATE SCHEMA church;
  CREATE TABLE church.churches (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, name text NOT NULL, slug text UNIQUE);
`);
let guardError = '';
try {
  await bare.exec(migration);
} catch (error) {
  guardError = String(error?.message ?? error);
}
check(
  '018 refuses to run before 011 and says which file to apply',
  /011_usher_passkey_columns\.sql/.test(guardError),
  guardError.split('\n')[0]?.slice(0, 90),
);

// The guard raised inside the migration's own BEGIN, leaving an aborted
// transaction. The SQL editor runs each "Run" in a fresh transaction; the test
// has to close it by hand.
await bare.exec('ROLLBACK;');
const rolledBack = await bare.query(`select count(*) as n from church.churches`);
check('that refusal left the database untouched', rolledBack.rows[0]?.n === 0, JSON.stringify(rolledBack.rows[0]));

// The default must be the schema's expression, not a lookalike: 10 hex chars from
// a CSPRNG, which is what the "previous default used random()" comment guards.
// Whole-line captures: the expression itself contains commas, which a
// [^,]+ pattern would cut off mid-call.
const trimExpr = (value) => String(value).trim().replace(/[;,]$/, '').trim();
const schemaDefault = schema.match(/passkey text NOT NULL DEFAULT (.*)$/m);
const migrationDefault = migration.match(/ALTER COLUMN passkey SET DEFAULT (.*)$/m);
check(
  '018 and supabase-schema.sql declare the same default, byte for byte',
  Boolean(schemaDefault && migrationDefault)
    && trimExpr(schemaDefault[1]) === trimExpr(migrationDefault[1])
    && trimExpr(schemaDefault[1]).startsWith('upper(substr(replace(gen_random_uuid()::text'),
  `${trimExpr(schemaDefault?.[1])} vs ${trimExpr(migrationDefault?.[1])}`,
);

const failures = results.filter((result) => !result.pass);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.map((failure) => failure.name).join('; ')}`);
  process.exit(1);
}
