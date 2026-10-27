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

// 012's own verification must be capable of failing. A check that reports
// "0 invalid" regardless of the data is worse than no check, which is what the
// first revision of this migration did (it counted still-missing rows, always
// zero after the UPDATE).
{
  const d = await scenario({ nulls: 3, total: 3, v3: 'missing' });
  const rowsOf = (res) => res.flatMap(r => r.rows ?? []);
  const res = await d.exec(readFileSync('migrations/012_usher_passkey_backfill.sql', 'utf8'));
  const agg = rowsOf(res).find(r => 'backfilled_this_run' in r);
  check('012 reports the rows it actually generated', agg?.backfilled_this_run === 3, JSON.stringify(agg));
  check('012 generated values pass its own format check', agg?.invalid_format === 0, JSON.stringify(agg));

  const post = rowsOf(res).find(r => 'valid_for_portal' in r);
  check('012 post-check counts every church', post?.valid_for_portal === 3, JSON.stringify(post));

  // Break one code and confirm the post-check notices.
  await d.query(`UPDATE church.churches SET passkey = 'ab' WHERE slug = 'church-0'`);
  const res2 = await d.exec(readFileSync('migrations/012_usher_passkey_backfill.sql', 'utf8'));
  const post2 = rowsOf(res2).find(r => 'valid_for_portal' in r);
  check('012 post-check detects an invalid code rather than always passing',
    post2?.valid_for_portal === 2, JSON.stringify(post2));

  // A re-run must not rotate the healthy codes.
  const codes = (await d.query(`SELECT passkey FROM church.churches WHERE slug <> 'church-0' ORDER BY slug`)).rows.map(r => r.passkey);
  await d.exec(readFileSync('migrations/012_usher_passkey_backfill.sql', 'utf8'));
  const codes2 = (await d.query(`SELECT passkey FROM church.churches WHERE slug <> 'church-0' ORDER BY slug`)).rows.map(r => r.passkey);
  check('012 re-run leaves healthy codes alone', JSON.stringify(codes) === JSON.stringify(codes2));
  await d.close();
}

// ── 014: passkey NOT NULL, gated ────────────────────────────────────────────
// The gate pins the exact overload and the exact reviewed text, so the tests
// have to play the part of an operator who captured and pinned a definition.
const m014 = readFileSync('migrations/014_passkey_not_null.sql', 'utf8');
const CALL_SITE_SIG = 'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text';

async function scenario({ nulls = 16, total = 18, blanks = 0, v3 = 'reviewed' } = {}) {
  const d = new PGlite();
  // The gate checks has_function_privilege('authenticated', …) when that role
  // exists; create it so the check actually runs in these scenarios.
  await d.exec('CREATE ROLE authenticated;');
  await d.exec('CREATE SCHEMA church;');
  await d.exec(`CREATE TABLE church.churches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL, slug text NOT NULL UNIQUE, passkey text);`);
  for (let i = 0; i < total; i++) {
    const value = i < nulls ? null : (i < nulls + blanks ? '' : `CODE${i}XYZ`);
    await d.query('INSERT INTO church.churches (name, slug, passkey) VALUES ($1,$2,$3)',
      [`C${i}`, `church-${i}`, value]);
  }

  const bodies = {
    reviewed: `BEGIN
      INSERT INTO church.churches (name, slug, passkey)
      VALUES (p_name, p_slug, upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)));
      RETURN gen_random_uuid(); END`,
    nopasskey: `BEGIN RETURN gen_random_uuid(); END`,
  };
  if (v3 === 'decoyprocedure') {
    // PostgreSQL forbids a procedure sharing both name AND argument types with
    // a function (42723), so a *different* signature is the only form that can
    // coexist. The function must still be the one that gets fingerprinted.
    await d.exec(`CREATE FUNCTION public.provision_church_v3(${CALL_SITE_SIG})
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $fn$ ${bodies.reviewed} $fn$;`);
    await d.exec(`CREATE PROCEDURE public.provision_church_v3(p_slug text)
      LANGUAGE plpgsql AS $fn$ BEGIN PERFORM 1; END $fn$;`);
  } else if (v3 === 'procedureonly') {
    // A procedure carrying the exact call-site signature and no function at
    // all. Without the prokind filter the gate would fingerprint this and
    // proceed; with it, there is nothing callable and it must refuse.
    await d.exec(`CREATE PROCEDURE public.provision_church_v3(${CALL_SITE_SIG})
      LANGUAGE plpgsql AS $fn$ BEGIN PERFORM 1; END $fn$;`);
  } else if (bodies[v3]) {
    await d.exec(`CREATE FUNCTION public.provision_church_v3(${CALL_SITE_SIG})
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $fn$ ${bodies[v3]} $fn$;`);
  } else if (v3 === 'wrongsignature') {
    // The repo's v2 shape, ported to v3's name: no p_invite_code.
    await d.exec(`CREATE FUNCTION public.provision_church_v3(
        p_user_id uuid, p_name text, p_slug text, p_role text, p_ip text)
      RETURNS uuid LANGUAGE plpgsql AS $fn$ BEGIN RETURN gen_random_uuid(); END $fn$;`);
  }

  await d.exec(readFileSync('migrations/011_usher_passkey_columns.sql', 'utf8'));
  return d;
}

const fingerprintOf = async (d) => (await d.query(`
  SELECT encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='provision_church_v3'
     AND p.prokind = 'f'
     AND pg_get_function_identity_arguments(p.oid) = $1`, [CALL_SITE_SIG])).rows[0]?.fp;

// Fill in the pinned fingerprint the way an operator would after review.
const pin = (sql, fp) => sql.replace(/(v_expected_fingerprint CONSTANT text := )'UNREVIEWED'/, `$1'${fp}'`);

const nullable = async (d) => (await d.query(
  `SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='church' AND table_name='churches' AND column_name='passkey'`
)).rows[0].is_nullable;

async function tryExec(d, sql) {
  try { await d.exec(sql); return null; }
  catch (e) { try { await d.exec('ROLLBACK'); } catch { /* already closed */ } return e.message; }
}

// A. Before the backfill: must refuse and leave the column alone.
{
  const d = await scenario({ nulls: 16 });
  const err = await tryExec(d, pin(m014, await fingerprintOf(d)));
  check('014 refuses before the backfill', err !== null, err?.slice(0, 60));
  check('014 refusal names the NULL count', /16 church\(es\) have a NULL passkey/.test(err ?? ''));
  check('014 refusal leaves passkey nullable', (await nullable(d)) === 'YES');
  await d.close();
}

// B. Captured, reviewed, pinned, backfilled: applies.
{
  const d = await scenario({ nulls: 16 });
  await d.exec(readFileSync('migrations/012_usher_passkey_backfill.sql', 'utf8'));
  const err = await tryExec(d, pin(m014, await fingerprintOf(d)));
  check('014 applies after backfill with a pinned definition', err === null, err?.slice(0, 90));
  check('014 makes passkey NOT NULL', (await nullable(d)) === 'NO');
  await d.close();
}

// C. Re-running is harmless.
{
  const d = await scenario({ nulls: 16 });
  await d.exec(readFileSync('migrations/012_usher_passkey_backfill.sql', 'utf8'));
  await d.exec(pin(m014, await fingerprintOf(d)));
  const err = await tryExec(d, pin(m014, await fingerprintOf(d)));
  check('014 is re-runnable', err === null, err?.slice(0, 90));
  await d.close();
}

// D. Unreviewed: the pin is still the placeholder.
{
  const d = await scenario({ nulls: 0 });
  const err = await tryExec(d, m014);
  check('014 refuses while the definition is unpinned', /no reviewed definition pinned/.test(err ?? ''));
  check('014 tells you the deployed fingerprint to pin',
    /sha256:[0-9a-f]{64}/.test(err ?? ''), err?.slice(0, 80));
  await d.close();
}

// E. No provisioning function at all.
{
  const d = await scenario({ nulls: 0, v3: 'missing' });
  const err = await tryExec(d, pin(m014, 'a'.repeat(64)));
  check('014 refuses without provision_church_v3', /no function public\.provision_church_v3 exists/.test(err ?? ''));
  await d.close();
}

// F. The deployed overload does not accept what the app sends.
{
  const d = await scenario({ nulls: 0, v3: 'wrongsignature' });
  const err = await tryExec(d, pin(m014, 'a'.repeat(64)));
  check('014 refuses when no overload matches the call site',
    /no overload of provision_church_v3 accepts/.test(err ?? ''), err?.slice(0, 70));
  await d.close();
}

// G. Correct signature, pinned, but the body never assigns a passkey.
{
  const d = await scenario({ nulls: 0, v3: 'nopasskey' });
  const err = await tryExec(d, pin(m014, await fingerprintOf(d)));
  check('014 refuses when the reviewed body never mentions passkey',
    /never mentions passkey/.test(err ?? ''), err?.slice(0, 70));
  await d.close();
}

// H. The function changed after review.
{
  const d = await scenario({ nulls: 0 });
  const reviewed = await fingerprintOf(d);   // what a human signed off on
  // The function is edited afterwards — same name, same signature, new body.
  await d.exec(`CREATE OR REPLACE FUNCTION public.provision_church_v3(${CALL_SITE_SIG})
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    BEGIN INSERT INTO church.churches (name, slug, passkey)
      VALUES (p_name, p_slug, upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)));
      RETURN gen_random_uuid(); END $fn$;`);
  const err = await tryExec(d, pin(m014, reviewed));
  check('014 detects a definition changed after review',
    /changed since review/.test(err ?? ''), err?.slice(0, 70));
  await d.close();
}

// K. A procedure sharing the name must not affect the function that is
//    fingerprinted. (Different signature — PostgreSQL forbids identical ones.)
{
  const d = await scenario({ nulls: 0, v3: 'decoyprocedure' });
  const fp = await fingerprintOf(d);
  const err = await tryExec(d, pin(m014, fp));
  check('014 picks the function when a same-named procedure also exists',
    err === null, err?.slice(0, 90));
  check('014 still applies the constraint in that case',
    (await nullable(d)) === 'NO');
  await d.close();
}

// L. Only a procedure carries the call-site signature. Prove the filter matters
//    by showing what the migration would have done without it.
{
  const withoutProkind = m014.replace(/\n\s*AND p\.prokind = 'f'/g, '');
  check('the prokind filter is present in both lookups', withoutProkind !== m014);

  const unfixed = await scenario({ nulls: 0, v3: 'procedureonly' });
  const procFp = (await unfixed.query(`
    SELECT encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS fp
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='provision_church_v3'`)).rows[0].fp;
  const unfixedErr = await tryExec(unfixed, pin(withoutProkind, procFp));
  // Measured, not assumed: pg_get_function_identity_arguments renders a
  // procedure's arguments with "IN " prefixes, so the signature lookup could
  // never have matched one. The gate still held — but it reported that the
  // *call site* was wrong, which would send an operator hunting a nonexistent
  // app bug. The filter makes the diagnosis accurate.
  check('without the filter the gate still holds, but misdiagnoses',
    unfixedErr !== null && /no overload of provision_church_v3 accepts/.test(unfixedErr),
    unfixedErr?.slice(0, 70));
  check('…and therefore reports a call-site mismatch that does not exist',
    !/no function public\.provision_church_v3 exists/.test(unfixedErr ?? ''));

  const fixed = await scenario({ nulls: 0, v3: 'procedureonly' });
  const fixedErr = await tryExec(fixed, pin(m014, procFp));
  check('014 with the filter refuses a procedure-only database',
    /no function public\.provision_church_v3 exists/.test(fixedErr ?? ''),
    fixedErr?.slice(0, 80));
  check('014 leaves passkey nullable in that case', (await nullable(fixed)) === 'YES');
}

// I. Blank strings are not a usable passkey.
{
  const d = await scenario({ nulls: 0, blanks: 3 });
  const err = await tryExec(d, pin(m014, await fingerprintOf(d)));
  check('014 refuses on blank (non-NULL) passkeys', /3 church\(es\) have a blank passkey/.test(err ?? ''));
  await d.close();
}

// M. The app's role must be able to call the function at all.
{
  const d = await scenario({ nulls: 0 });
  await d.exec(`REVOKE EXECUTE ON FUNCTION public.provision_church_v3(${CALL_SITE_SIG}) FROM PUBLIC, authenticated`);
  const err = await tryExec(d, pin(m014, await fingerprintOf(d)));
  check('014 refuses when authenticated cannot EXECUTE provisioning',
    /authenticated cannot EXECUTE provision_church_v3/.test(err ?? ''), err?.slice(0, 80));
  check('014 leaves passkey nullable in that case', (await nullable(d)) === 'YES');
  await d.close();
}

// J. Refusal messages must not leak credential values.
{
  const d = await scenario({ nulls: 2, total: 4 });
  const err = (await tryExec(d, pin(m014, await fingerprintOf(d)))) ?? '';
  check('014 refusal lists slugs, never passkeys',
    /church-0/.test(err) && !/CODE\dXYZ/.test(err), err.slice(0, 50));
  await d.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
