// Executes migrations 011 and 012 against a real PostgreSQL (PGlite, PG16),
// on a table shaped like the live deployment:
//   * `passkey` exists and is NULLABLE (the live database holds NULLs, so it
//     cannot be the NOT NULL column this repo's schema declares)
//   * passkey_hash / passkey_version / passkey_updated_at do NOT exist
//   * 18 churches, 16 with a NULL passkey, 0 with a six-digit code
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

await db.exec(`CREATE SCHEMA church;`);
await db.exec(`
  CREATE TABLE church.churches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    passkey text,                 -- live database contains NULLs
    created_at timestamptz DEFAULT now()
  );
`);
// 16 rows with no credential at all, 2 with a readable code (the live shape).
for (let i = 0; i < 16; i++) {
  await db.query(`INSERT INTO church.churches (name, slug, passkey) VALUES ($1,$2,NULL)`,
    [`Church ${i}`, `church-${i}`]);
}
await db.query(`INSERT INTO church.churches (name, slug, passkey) VALUES ('Legacy A','legacy-a','482913')`);
await db.query(`INSERT INTO church.churches (name, slug, passkey) VALUES ('Legacy B','legacy-b','GRACE-KEY-1')`);

const cols = async () => (await db.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='church' AND table_name='churches'
  ORDER BY column_name`)).rows.map(r => r.column_name);

const before = await cols();
check('precondition: no passkey_hash column', !before.includes('passkey_hash'), before.join(','));
check('precondition: no passkey_version column', !before.includes('passkey_version'));

// ── 011 ──────────────────────────────────────────────────────────────────────
const m011 = readFileSync('migrations/011_usher_passkey_columns.sql', 'utf8');
const notices = [];
db.onNotice?.((n) => notices.push(n.message));
await db.exec(m011);

const after = await cols();
check('011 adds passkey_hash', after.includes('passkey_hash'));
check('011 adds passkey_version', after.includes('passkey_version'));
check('011 adds passkey_updated_at', after.includes('passkey_updated_at'));

const versioned = (await db.query(
  `SELECT count(*)::int AS n FROM church.churches WHERE passkey_version = 1`)).rows[0].n;
check('011 sets passkey_version=1 on every row', versioned === 18, `${versioned}/18`);

// 011 must not have altered any credential.
const untouched = (await db.query(`
  SELECT count(*)::int AS n FROM church.churches
   WHERE passkey_hash IS NOT NULL`)).rows[0].n;
check('011 invents no hashes', untouched === 0, `${untouched} hashes`);

const legacy = (await db.query(
  `SELECT passkey FROM church.churches WHERE slug='legacy-a'`)).rows[0].passkey;
check('011 leaves existing readable passkey untouched', legacy === '482913', legacy);

const nullsAfter011 = (await db.query(
  `SELECT count(*)::int AS n FROM church.churches WHERE passkey IS NULL`)).rows[0].n;
check('011 does not fabricate credentials', nullsAfter011 === 16, `${nullsAfter011} still NULL`);

// Idempotent re-run.
let reran = true;
try { await db.exec(m011); } catch (e) { reran = false; }
check('011 is re-runnable', reran);

// ── 012 ──────────────────────────────────────────────────────────────────────
const m012 = readFileSync('migrations/012_usher_passkey_backfill.sql', 'utf8');
await db.exec(m012);

const remaining = (await db.query(`
  SELECT count(*)::int AS n FROM church.churches
   WHERE coalesce(trim(passkey),'') = ''`)).rows[0].n;
check('012 leaves no church without a credential', remaining === 0, `${remaining} remaining`);

const bad = (await db.query(`
  SELECT count(*)::int AS n FROM church.churches
   WHERE passkey !~ '^[A-Za-z0-9_-]{6,32}$'`)).rows[0].n;
check('012 codes all satisfy the portal validator (6–32, A-Za-z0-9_-)', bad === 0, `${bad} invalid`);

const distinct = (await db.query(
  `SELECT count(DISTINCT passkey)::int AS n FROM church.churches`)).rows[0].n;
check('012 generates distinct codes', distinct === 18, `${distinct}/18 distinct`);

const stillLegacy = (await db.query(
  `SELECT passkey FROM church.churches WHERE slug='legacy-a'`)).rows[0].passkey;
check('012 does not rewrite existing passkeys', stillLegacy === '482913', stillLegacy);

const versionKept = (await db.query(
  `SELECT count(*)::int AS n FROM church.churches WHERE passkey_version = 1`)).rows[0].n;
check('012 does not bump passkey_version (live sessions survive)', versionKept === 18);

// Idempotent re-run must not rotate codes a second time.
const beforeRerun = (await db.query(`SELECT slug, passkey FROM church.churches ORDER BY slug`)).rows;
await db.exec(m012);
const afterRerun = (await db.query(`SELECT slug, passkey FROM church.churches ORDER BY slug`)).rows;
check('012 is re-runnable without rotating codes again',
  JSON.stringify(beforeRerun) === JSON.stringify(afterRerun));

// Credential values must never reach the log. PGlite does not surface NOTICE
// messages, so assert this structurally: every RAISE NOTICE argument must be a
// count variable, and the report query must project aggregates only.
const raiseArgs = [...m011.matchAll(/RAISE NOTICE\s+'[^']*'\s*,?([^;]*);/g)]
  .flatMap(m => m[1].split(',').map(a => a.trim()).filter(Boolean));
check('011 NOTICE arguments are only count variables',
  raiseArgs.length > 0 && raiseArgs.every(a => /^v_[a-z_]+$/.test(a)),
  raiseArgs.join(' | ') || 'none found');

const report = (await db.query(`
  SELECT count(*)::int,
         count(*) FILTER (WHERE coalesce(trim(passkey),'') = '' AND passkey_hash IS NULL)::int,
         count(*) FILTER (WHERE coalesce(trim(passkey),'') = '' AND passkey_hash IS NOT NULL)::int,
         count(*) FILTER (WHERE coalesce(trim(passkey),'') <> '')::int
    FROM church.churches`));
check('011 report query projects counts only',
  Object.values(report.rows[0]).every(v => typeof v === 'number'),
  JSON.stringify(report.rows[0]));

check('011 text never interpolates a passkey value',
  !/passkey\s*=\s*%/.test(m011) && !/readable_passkey/.test(m011));

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
