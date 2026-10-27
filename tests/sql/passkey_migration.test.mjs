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
// Provisioning is a chain on the live database: an invoker-mode wrapper
// delegates to a SECURITY DEFINER helper, which calls v2, which performs the
// insert. 014 pins every routine in that chain rather than the wrapper alone.
const m014 = readFileSync('migrations/014_passkey_not_null.sql', 'utf8');
const CALL_SITE_SIG = 'p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text';
// FOUR arguments on the live database, not the five supabase-schema.sql declares.
const V2_SIG = 'p_user_id uuid, p_name text, p_slug text, p_role text';
const IMPL_SIG = CALL_SITE_SIG;

async function scenario({ nulls = 0, total = 18, blanks = 0, chain = 'full' } = {}) {
  const d = new PGlite();
  await d.exec('CREATE ROLE authenticated;');
  await d.exec('CREATE SCHEMA church;');
  await d.exec('CREATE SCHEMA private;');
  await d.exec('GRANT USAGE ON SCHEMA private, church TO authenticated;');
  await d.exec(`CREATE TABLE church.churches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL, slug text NOT NULL UNIQUE, passkey text);`);
  for (let i = 0; i < total; i++) {
    const value = i < nulls ? null : (i < nulls + blanks ? '' : `CODE${i}XYZ`);
    await d.query('INSERT INTO church.churches (name, slug, passkey) VALUES ($1,$2,$3)',
      [`C${i}`, `church-${i}`, value]);
  }

  if (chain !== 'missing') {
    // v2 does the insert and — exactly like the live one — never mentions
    // passkey. NOT NULL without a DEFAULT would make this fail 23502.
    await d.exec(`CREATE FUNCTION public.provision_church_v2(p_user_id uuid, p_name text, p_slug text, p_role text)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $fn$ DECLARE v uuid; BEGIN
        INSERT INTO church.churches (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v;
        RETURN v; END $fn$;`);
  }
  if (chain === 'full') {
    await d.exec(`CREATE FUNCTION private.provision_church_v3_impl(p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $fn$ BEGIN
        RETURN public.provision_church_v2(p_user_id, p_name, p_slug, p_role);
      END $fn$;`);
    await d.exec(`CREATE FUNCTION public.provision_church_v3(p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text)
      RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
      AS $fn$ BEGIN
        RETURN private.provision_church_v3_impl(p_user_id, p_name, p_slug, p_role, p_invite_code);
      END $fn$;`);
  } else if (chain === 'wrapperonly') {
    // Wrapper that delegates to a routine the reviewer did not pin.
    await d.exec(`CREATE FUNCTION private.provision_church_v3_impl(p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text)
      RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $fn$ BEGIN
        RETURN public.provision_church_v2(p_user_id, p_name, p_slug, p_role);
      END $fn$;`);
    await d.exec(`CREATE FUNCTION public.provision_church_v3(p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text)
      RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
      AS $fn$ BEGIN
        RETURN private.provision_church_v3_impl(p_user_id, p_name, p_slug, p_role, p_invite_code);
      END $fn$;`);
  }
  await d.exec(readFileSync('migrations/011_usher_passkey_columns.sql', 'utf8'));
  return d;
}

const fp = async (d, schema, name, args) => (await d.query(`
  SELECT encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = 'f'
     AND pg_get_function_identity_arguments(p.oid) = $3`,
  [schema, name, args])).rows[0]?.fp;

async function fullChainPins(d) {
  return [
    { schema: 'public',  name: 'provision_church_v3',      args: CALL_SITE_SIG, fingerprint: await fp(d, 'public', 'provision_church_v3', CALL_SITE_SIG) },
    { schema: 'private', name: 'provision_church_v3_impl', args: IMPL_SIG,      fingerprint: await fp(d, 'private', 'provision_church_v3_impl', IMPL_SIG) },
    { schema: 'public',  name: 'provision_church_v2',      args: V2_SIG,        fingerprint: await fp(d, 'public', 'provision_church_v2', V2_SIG) },
  ];
}

const pinChain = (sql, pins) =>
  sql.replace(/v_pins CONSTANT jsonb := '\[\]'::jsonb;/, `v_pins CONSTANT jsonb := '${JSON.stringify(pins)}'::jsonb;`);

const nullable = async (d) => (await d.query(
  `SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='church' AND table_name='churches' AND column_name='passkey'`
)).rows[0].is_nullable;

const passkeyDefault = async (d) => (await d.query(
  `SELECT column_default FROM information_schema.columns
    WHERE table_schema='church' AND table_name='churches' AND column_name='passkey'`
)).rows[0].column_default;

async function tryExec(d, sql) {
  try { await d.exec(sql); return null; }
  catch (e) { try { await d.exec('ROLLBACK'); } catch { /* already closed */ } return e.message; }
}

// A. Nothing reviewed yet.
{
  const d = await scenario({ chain: 'full' });
  const err = await tryExec(d, m014);
  check('014 refuses while no chain is pinned', /no reviewed chain pinned/.test(err ?? ''), err?.slice(0, 60));
  check('014 names the routines worth reviewing',
    /public\.provision_church_v3/.test(err ?? '') && /private\.provision_church_v3_impl/.test(err ?? ''),
    (err ?? '').slice(-90));
  check('014 leaves passkey nullable when unpinned', (await nullable(d)) === 'YES');
  await d.close();
}

// B0. Full circle: the SQL-only generator's output is fed straight into 014.
//     This is the workflow the operator will actually use — no Node, no manual
//     copying of digests — so it is worth testing as one unit rather than two.
{
  const d = await scenario({ chain: 'full' });
  const { rows } = await d.query(readFileSync('scripts/capture-v3-pins.sql', 'utf8'));
  check('SQL generator finds all three chain routines', rows[0].routines_pinned === 3,
    String(rows[0].routines_pinned));

  const err = await tryExec(d, pinChain(m014, rows[0].v_pins));
  check('014 accepts pins produced entirely inside the database', err === null, err?.slice(0, 90));
  check('…and then enforces NOT NULL', (await nullable(d)) === 'NO');

  // A pin generated before an edit must stop matching after it.
  const before = rows[0].v_pins;
  await d.exec(`CREATE OR REPLACE FUNCTION public.provision_church_v2(V2SIG_REPLACED)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $fn$ DECLARE v uuid; BEGIN
      INSERT INTO church.churches (name, slug, passkey) VALUES (p_name, p_slug, 'HANDEDIT') RETURNING id INTO v;
      RETURN v; END $fn$;`.replace('V2SIG_REPLACED', V2_SIG));
  const stale = await d.query(readFileSync('scripts/capture-v3-pins.sql', 'utf8'));
  check('the generator sees a changed body as a different fingerprint',
    JSON.stringify(stale.rows[0].v_pins) !== JSON.stringify(before));
  await d.close();
}

// B. The whole chain reviewed: applies.
{
  const d = await scenario({ chain: 'full' });
  const err = await tryExec(d, pinChain(m014, await fullChainPins(d)));
  check('014 applies when the whole chain is pinned', err === null, err?.slice(0, 90));
  check('014 makes passkey NOT NULL', (await nullable(d)) === 'NO');
  check('014 installs a DEFAULT so inserts omitting passkey still work',
    (await passkeyDefault(d)) !== null, String(await passkeyDefault(d)));

  // The point of the default: v2's insert shape must still work afterwards.
  let insertErr = null;
  try { await d.query(`INSERT INTO church.churches (name, slug) VALUES ('New','new-church')`); }
  catch (e) { insertErr = e.message; }
  check('a provisioned church can still be inserted without a passkey', insertErr === null, insertErr ?? 'ok');
  const created = (await d.query(`SELECT passkey FROM church.churches WHERE slug='new-church'`)).rows[0];
  check('the generated code satisfies the portal validator',
    /^[A-Za-z0-9_-]{6,32}$/.test(created?.passkey ?? ''), `length ${created?.passkey?.length}`);

  // A DEFAULT covers an omitted column, not an explicit NULL. Encode the whole
  // matrix so no future reader concludes the default makes NULL safe.
  const tryInsert = async (label, sql) => {
    try { await d.query(sql); return null; } catch (e) { return `${e.code ?? ''}`; }
  };
  check('DEFAULT keyword gets a generated code',
    (await tryInsert('d', `INSERT INTO church.churches (name, slug, passkey) VALUES ('D','d-default','PLACEHOLDER')`) === null));
  await d.query(`UPDATE church.churches SET passkey = DEFAULT WHERE slug='d-default'`);
  const dflt = (await d.query(`SELECT passkey FROM church.churches WHERE slug='d-default'`)).rows[0].passkey;
  check('UPDATE … SET passkey = DEFAULT yields a valid code',
    /^[A-Za-z0-9_-]{6,32}$/.test(dflt ?? ''), String(dflt));

  const nullErr = await tryInsert('n', `INSERT INTO church.churches (name, slug, passkey) VALUES ('N','n-null', NULL)`);
  check('an explicit NULL is still rejected (23502) — the default does not apply',
    nullErr === '23502', `got ${nullErr ?? 'success'}`);

  const castNullErr = await tryInsert('c', `INSERT INTO church.churches (name, slug, passkey) VALUES ('N2','n-null2', NULL::text)`);
  check('…and NULL::text is rejected too', castNullErr === '23502', `got ${castNullErr ?? 'success'}`);

  const explicit = await tryInsert('e', `INSERT INTO church.churches (name, slug, passkey) VALUES ('E','e-explicit','MYCODE123')`);
  check('an explicit value is kept, never overwritten by the default',
    explicit === null && (await d.query(`SELECT passkey FROM church.churches WHERE slug='e-explicit'`)).rows[0].passkey === 'MYCODE123');
  await d.close();
}

// C. THE regression this migration exists for: pinning only the wrapper.
{
  const d = await scenario({ chain: 'wrapperonly' });
  const wrapperOnly = [{
    schema: 'public', name: 'provision_church_v3', args: CALL_SITE_SIG,
    fingerprint: await fp(d, 'public', 'provision_church_v3', CALL_SITE_SIG),
  }];
  const err = await tryExec(d, pinChain(m014, wrapperOnly));
  check('014 refuses a wrapper-only pin', /calls routines that were not reviewed/.test(err ?? ''), err?.slice(0, 70));
  check('014 names the unreviewed helper', /private\.provision_church_v3_impl/.test(err ?? ''));
  check('014 names the unreviewed v2', /public\.provision_church_v2/.test(err ?? ''));
  check('014 leaves passkey nullable in that case', (await nullable(d)) === 'YES');
  await d.close();
}

// D. A pinned routine changed after review.
{
  const d = await scenario({ chain: 'full' });
  const pins = await fullChainPins(d);
  await d.exec(`CREATE OR REPLACE FUNCTION public.provision_church_v2(${V2_SIG})
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $fn$ DECLARE v uuid; BEGIN
      INSERT INTO church.churches (name, slug, passkey) VALUES (p_name, p_slug, 'HANDEDIT') RETURNING id INTO v;
      RETURN v; END $fn$;`);
  const err = await tryExec(d, pinChain(m014, pins));
  check('014 detects a changed routine deep in the chain',
    /provision_church_v2 has changed since review/.test(err ?? ''), err?.slice(0, 70));
  await d.close();
}

// E. A pinned routine that no longer exists at all.
{
  const d = await scenario({ chain: 'full' });
  const pins = await fullChainPins(d);
  pins.push({ schema: 'public', name: 'provision_church_v9', args: IMPL_SIG, fingerprint: 'a'.repeat(64) });
  const err = await tryExec(d, pinChain(m014, pins));
  check('014 refuses a stale pin for a routine that does not exist',
    /no function matches pinned/.test(err ?? ''), err?.slice(0, 60));
  check('…and says so plainly when nothing shares the name',
    /Existing: none/.test(err ?? ''), err?.slice(-40));
  await d.close();
}

// E2. THE live trap: the deployed v2 takes FOUR arguments, the repository's
//     takes five. A pin copied from supabase-schema.sql must fail, and the
//     message must show the signature that actually exists.
{
  const d = await scenario({ chain: 'full' });
  const pins = await fullChainPins(d);
  const v2 = pins.find(p => p.name === 'provision_church_v2');
  v2.args = 'p_user_id uuid, p_name text, p_slug text, p_role text, p_ip text';
  const err = await tryExec(d, pinChain(m014, pins));
  check('014 rejects a pin using the repo\'s 5-argument v2 signature',
    /no function matches pinned/.test(err ?? ''), err?.slice(0, 60));
  check('014 then shows the 4-argument signature that is deployed',
    /public\.provision_church_v2\(p_user_id uuid, p_name text, p_slug text, p_role text\)/.test(err ?? ''),
    err?.slice(-140));
  check('014 leaves passkey nullable after a pin miss', (await nullable(d)) === 'YES');
  await d.close();
}

// F. Data gates.
{
  const d = await scenario({ chain: 'full', nulls: 16 });
  const err = await tryExec(d, pinChain(m014, await fullChainPins(d)));
  check('014 refuses before the backfill', /16 church\(es\) have a NULL passkey/.test(err ?? ''));
  await d.close();
}
{
  const d = await scenario({ chain: 'full', nulls: 0, blanks: 3 });
  const err = await tryExec(d, pinChain(m014, await fullChainPins(d)));
  check('014 refuses on blank passkeys', /3 church\(es\) have a blank passkey/.test(err ?? ''));
  await d.close();
}

// G. The app's role must be able to call the function at all.
{
  const d = await scenario({ chain: 'full' });
  await d.exec(`REVOKE EXECUTE ON FUNCTION public.provision_church_v3(${CALL_SITE_SIG}) FROM PUBLIC, authenticated`);
  const err = await tryExec(d, pinChain(m014, await fullChainPins(d)));
  check('014 refuses when authenticated cannot EXECUTE provisioning',
    /authenticated cannot EXECUTE provision_church_v3/.test(err ?? ''), err?.slice(0, 80));
  await d.close();
}

// H. Re-running is harmless once applied.
{
  const d = await scenario({ chain: 'full' });
  const pins = await fullChainPins(d);
  await d.exec(pinChain(m014, pins));
  const err = await tryExec(d, pinChain(m014, pins));
  check('014 is re-runnable', err === null, err?.slice(0, 90));
  await d.close();
}

// I. An existing default is left alone.
{
  const d = await scenario({ chain: 'full' });
  await d.query(`ALTER TABLE church.churches ALTER COLUMN passkey SET DEFAULT 'PRESET01'`);
  const err = await tryExec(d, pinChain(m014, await fullChainPins(d)));
  check('014 does not overwrite an existing default', err === null && (await passkeyDefault(d))?.includes('PRESET01'),
    String(await passkeyDefault(d)));
  await d.close();
}

// J. Refusal messages must not leak credential values.
{
  const d = await scenario({ chain: 'full', nulls: 2, total: 4 });
  const err = (await tryExec(d, pinChain(m014, await fullChainPins(d)))) ?? '';
  check('014 refusal lists slugs, never passkeys',
    /church-0/.test(err) && !/CODE\dXYZ/.test(err), err.slice(0, 50));
  await d.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
