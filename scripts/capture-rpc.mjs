#!/usr/bin/env node
// Capture a deployed RPC definition into the repository — safely.
//
// Why this exists
// ---------------
// `lib/provision-actions.ts` calls `provision_church_v3`, but the repository
// only defines `provision_church_v2`. A database rebuilt from this repo cannot
// provision a church at all, and the invite-code check that only v3 performs
// would silently disappear.
//
// The deployed definition has to come from the database, which means it must be
// reviewed for embedded secrets before it is committed. Doing that review by
// eye is unreliable, so this script:
//
//   1. extracts the one function statement from a pg_get_functiondef dump,
//   2. checks its signature against the argument list the app actually sends,
//   3. checks it writes a passkey (required before passkey NOT NULL),
//   4. scans for credential material and reports it WITHOUT printing values,
//   5. refuses to write anything if a credential is found.
//
// Usage
//   node scripts/capture-rpc.mjs <dump.sql> [--out migrations/013_provision_church_v3.sql]
//   node scripts/capture-rpc.mjs --check migrations/013_provision_church_v3.sql
//
// Producing the dump (run this against the database yourself):
//
//   SELECT pg_get_functiondef(p.oid)
//   FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
//   WHERE  n.nspname = 'public' AND p.proname = 'provision_church_v3';
//
// Save the result to a file. Do not paste it into chat, a ticket, or a PR
// comment — the definition may contain literal values.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

// ── The contract each RPC must satisfy. Derived from the call sites in this
//    repository, not from the database, so this is the independent side of the
//    comparison.
export const RPC_CONTRACTS = {
  provision_church_v3: {
    caller: 'lib/provision-actions.ts',
    required: ['p_user_id', 'p_name', 'p_slug', 'p_role', 'p_invite_code'],
    forbidden: ['p_ip'],
    // A church provisioned without a readable passkey is exactly the bug that
    // locked 16 churches out. Enforcing NOT NULL later depends on this.
    mustWrite: [
      { pattern: /passkey/i, description: 'assigns a passkey to the new church row' },
    ],
  },
};

// ── Secret detection. Every rule reports a location and a length, never the
//    matched text: the whole point is that secrets stay out of terminals,
//    logs, CI output and this transcript.
const SECRET_RULES = [
  { kind: 'jwt',            re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,               severity: 'block' },
  { kind: 'stripe-key',     re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,                             severity: 'block' },
  { kind: 'api-key',        re: /\bsb[ps]_[A-Za-z0-9]{20,}/g,                                               severity: 'block' },
  { kind: 'url-credential', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"$]+:[^\s:/@'"$]+@/gi,                     severity: 'block' },
  { kind: 'long-hex',       re: /\b[0-9a-fA-F]{32,}\b/g,                                                    severity: 'review' },
  { kind: 'long-base64',    re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,                                            severity: 'review' },
  { kind: 'secret-literal', re: /\b(?:secret|token|api_?key|password|passwd|private_?key)\w*\s*(?:text)?\s*(?:=|:=|DEFAULT)\s*'[^']{6,}'/gi, severity: 'block' },
];

function scanSecrets(sql) {
  const findings = [];
  const lines = sql.split('\n');
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    for (let i = 0; i < lines.length; i++) {
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        findings.push({ kind: rule.kind, severity: rule.severity, line: i + 1, length: m[0].length });
      }
    }
  }
  return findings;
}

function redact(sql) {
  let out = sql;
  for (const rule of SECRET_RULES) {
    out = out.replace(new RegExp(rule.re.source, rule.re.flags),
      (match) => `[REDACTED:${rule.kind}:${match.length}ch]`);
  }
  return out;
}

// ── Extract a single function statement from a possibly multi-statement dump.
function extractFunction(sql, name, schema = 'public') {
  // Match the schema explicitly when one was given, else accept any/none.
  const qualifier = schema ? `${schema}\\.` : '(?:[a-z_][a-z0-9_]*\\.)?';
  const head = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qualifier}${name}\\s*\\(`, 'i');
  const start = sql.search(head);
  if (start === -1) return null;

  // Find the argument list: the first balanced paren group after the header.
  let depth = 0, argsEnd = -1, i = sql.indexOf('(', start);
  for (let j = i; j < sql.length; j++) {
    if (sql[j] === '(') depth++;
    else if (sql[j] === ')') { depth--; if (depth === 0) { argsEnd = j; break; } }
  }
  if (argsEnd === -1) return null;

  // The body is dollar-quoted. Find the opening tag after the argument list.
  const tagMatch = /\$([A-Za-z_]\w*)?\$/.exec(sql.slice(argsEnd));
  if (!tagMatch) return null;
  const tag = tagMatch[0];
  const tagStart = argsEnd + tagMatch.index;
  const tagEnd = sql.indexOf(tag, tagStart + tag.length);
  if (tagEnd === -1) return null;

  const end = sql.indexOf(';', tagEnd + tag.length);
  return {
    statement: sql.slice(start, end === -1 ? sql.length : end + 1).trim(),
    params: sql.slice(sql.indexOf('(', start) + 1, argsEnd),
    body: sql.slice(tagStart + tag.length, tagEnd),
  };
}

// Split a parameter list on top-level commas only, so a DEFAULT expression
// containing a comma (`DEFAULT 'a,b'`, `DEFAULT ARRAY[1,2]`) does not split a
// parameter in half and silently corrupt the pin.
function splitParams(params) {
  const out = [];
  let depth = 0, quote = null, current = '';
  for (let i = 0; i < params.length; i++) {
    const ch = params[i];
    if (quote) {
      current += ch;
      if (ch === quote && params[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

// Normalise a dump's parameter list into exactly what
// pg_get_function_identity_arguments returns, because that is what
// migrations/014 compares against.
//
// Measured against PostgreSQL 16 rather than assumed:
//
//   (p_user_id uuid, p_invite_code text DEFAULT NULL) -> "p_user_id uuid, p_invite_code text"
//   (INOUT x int)                                     -> "INOUT x integer"
//   (a uuid, VARIADIC b int[])                        -> "a uuid, VARIADIC b integer[]"
//   (OUT o1 int, IN i1 text DEFAULT 'z')               -> "OUT o1 integer, i1 text"
//
// So: IN is dropped (it is implied), OUT / INOUT / VARIADIC are KEPT, and any
// DEFAULT clause is removed. An earlier revision dropped OUT parameters and all
// mode prefixes; for the three deployed provisioning signatures — all plain IN
// — it happened to be right, but it would have emitted an unmatchable pin for
// any function with an OUT parameter.
// PostgreSQL reports canonical type names: `int` comes back as `integer`.
// A dump from pg_get_functiondef is already canonical, so this map only matters
// for a hand-written or reformatted one — but a pin with `int` instead of
// `integer` fails at 014 as "routine does not exist", which is a bad error for
// a cosmetic difference.
const TYPE_ALIASES = {
  int: 'integer', int4: 'integer',
  int2: 'smallint', int8: 'bigint',
  bool: 'boolean',
  float4: 'real', float8: 'double precision',
  decimal: 'numeric',
  varchar: 'character varying', char: 'character',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
  varbit: 'bit varying',
};

function canonicalType(type) {
  const m = type.trim().match(/^(.*?)(\[\])?$/);
  const base = m[1].toLowerCase().split(/[\s(]/)[0];
  const mapped = TYPE_ALIASES[base];
  if (!mapped) return type.trim();
  // Preserve any modifier, e.g. varchar(50) -> character varying(50).
  const rest = type.trim().slice(base.length);
  return `${mapped}${rest}`;
}

function identityArgs(params) {
  return splitParams(params)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const stripped = p
        .replace(/\s+DEFAULT\s+[\s\S]*$/i, '')   // drop the default expression
        .replace(/^IN\s+/i, '')                    // IN is implied, PostgreSQL omits it
        .replace(/\s+/g, ' ')
        .trim();
      const m = stripped.match(/^(?:(INOUT|OUT|VARIADIC)\s+)?(\S+)\s+([\s\S]+)$/);
      if (!m) return stripped;
      const [, mode, name, type] = m;
      return `${mode ? mode + ' ' : ''}${name} ${canonicalType(type)}`;
    })
    .join(', ');
}

function parseParamNames(params) {
  return params
    .split(',')
    .map(p => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map(p => p.split(' ')[0]);
}

export function validateContract(name, parsed) {
  const contract = RPC_CONTRACTS[name];
  const problems = [];
  if (!contract) return { ok: true, problems: [], contract: null };

  const names = parseParamNames(parsed.params);
  for (const p of contract.required) {
    if (!names.includes(p)) problems.push(`missing parameter ${p} (app sends it from ${contract.caller})`);
  }
  for (const p of contract.forbidden) {
    if (names.includes(p)) problems.push(`unexpected parameter ${p}: the call site never sends it`);
  }
  for (const { pattern, description } of contract.mustWrite) {
    if (!pattern.test(parsed.body)) problems.push(`body never ${description}`);
  }
  return { ok: problems.length === 0, problems, contract, params: names };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const force = args.includes('--force');
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : 'migrations/013_provision_church_v3.sql';
// A fingerprint observed on the live database, e.g. from
//   SELECT encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') ...
// It answers "is this the function that is deployed?", which is NOT the same
// question as "has a human read this body?". --expect settles the first only.
const expectIdx = args.indexOf('--expect');
const rpcIdx = args.indexOf('--rpc');
const expected = expectIdx !== -1 ? args[expectIdx + 1] : null;
// Indexes of values belonging to flags; -1 when the flag is absent, so the
// subtraction below cannot accidentally exclude argument 0.
const flagValues = [outIdx, expectIdx, rpcIdx].filter(i => i !== -1).map(i => i + 1);
const inputPath = args.find((a, i) => !a.startsWith('--') && !flagValues.includes(i));

// Targets may be schema-qualified, because the provisioning chain is not all
// in `public`: on the live database it is
//   public.provision_church_v3 -> private.provision_church_v3_impl -> public.provision_church_v2
// and a pin that covers less than the whole chain attests to the wrong thing.
const targetSpec = rpcIdx !== -1 ? args[rpcIdx + 1] : 'public.provision_church_v3';
const [TARGET_SCHEMA, RPC_NAME] = targetSpec.includes('.')
  ? targetSpec.split('.')
  : ['public', targetSpec];

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!inputPath) {
  fail('No input file.\n\n  node scripts/capture-rpc.mjs <dump.sql> --out migrations/013_provision_church_v3.sql');
}

if (!existsSync(inputPath)) fail(`Input not found: ${inputPath}`);

if (expected !== null && !/^[0-9a-f]{64}$/.test(expected)) {
  fail(`--expect must be 64 lowercase hex characters (sha256), got ${expected.length} characters.`);
}

const raw = readFileSync(inputPath, 'utf8');
const parsed = extractFunction(raw, RPC_NAME, TARGET_SCHEMA);
if (!parsed) fail(`No CREATE FUNCTION ${TARGET_SCHEMA}.${RPC_NAME} found in ${basename(inputPath)}.`);

const scanText = checkMode ? raw : parsed.statement;
const findings = scanSecrets(scanText);
const blocking = findings.filter(f => f.severity === 'block');
const review = findings.filter(f => f.severity === 'review');

const contract = validateContract(RPC_NAME, parsed);
const writesPasskey = /passkey/i.test(parsed.body);
const fingerprint = fingerprintOf(parsed.statement);

// 014 pins the reviewed definition by content, so this has to be the hash of
// exactly what pg_get_functiondef returns — the statement as written, not the
// migration file that wraps it in a header.
// Hash the definition exactly as pg_get_functiondef returns it.
//
// pg_get_functiondef ends with a newline. An earlier version hashed the
// trimmed statement, so every pin it produced disagreed with the database by
// a single trailing byte and 014 reported "changed since review" on a
// definition nobody had touched. Measured:
//
//   pg_get_functiondef(oid) last 12 chars  -> "$function$\n"
//   sha256(raw)     == encode(sha256(...)) inside PostgreSQL
//   sha256(trimmed) != that
//
// The extractor trims to find the statement boundary, so the newline is put
// back here. pg_get_functiondef emits exactly one trailing newline.
function fingerprintOf(statement) {
  const text = statement.replace(/\s+$/, '') + '\n';
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function report(fingerprint) {
  if (fingerprint) console.log(`Fingerprint  sha256:${fingerprint}`);
  console.log(`\nRPC          ${TARGET_SCHEMA}.${RPC_NAME}`);
  const args = identityArgs(parsed.params);
  console.log(`Parameters   ${args || '(none)'}`);
  console.log(`Writes passkey  ${writesPasskey ? 'yes' : 'NO — passkey NOT NULL cannot be enforced until this is fixed'}`);
  if (!contract.contract) {
    console.log('Contract     no contract for this routine — it is reviewed as part of the chain, not on its own');
  } else {
    console.log(`Contract     ${contract.ok ? 'matches the call site' : 'MISMATCH'}`);
  }
  for (const p of contract.problems ?? []) console.log(`   ✖ ${p}`);

  if (findings.length === 0) {
    console.log('Secrets      none detected');
  } else {
    console.log(`Secrets      ${findings.length} finding(s), values never printed:`);
    for (const f of findings) {
      console.log(`   ${f.severity === 'block' ? '✖ BLOCK' : '! review'}  ${f.kind}  line ${f.line}, ${f.length} chars`);
    }
  }
}

if (checkMode) {
  report(fingerprintOf(raw.trim().endsWith(';') ? raw.trim() : parsed.statement));
  if (!contract.ok) fail('Committed definition does not match the call site.');
  if (blocking.length) fail('Committed definition contains credential material. Rotate it and remove it from history.');
  console.log('\n✔ definition is consistent with the call site\n');
  process.exit(0);
}

if (blocking.length && !force) {
  report(fingerprint);
  const redactedPath = `${outPath}.redacted.sql`;
  writeFileSync(redactedPath, redact(parsed.statement) + '\n');
  fail(
    `Refusing to write ${outPath}: ${blocking.length} credential(s) found.\n` +
    `   A redacted copy was written to ${redactedPath} so you can see the shape.\n` +
    `   If the credential is real, rotate it first. Then re-run with --force only\n` +
    `   after it has been removed from the definition.`
  );
}

report(fingerprint);

// Bind the capture to the deployed function before anything is committed.
if (expected !== null && fingerprint !== expected) {
  fail(
    `Refusing to write ${outPath}: this dump is not the deployed function.\n` +
    `   expected  sha256:${expected}\n` +
    `   this file sha256:${fingerprint}\n` +
    `   Re-dump with pg_get_functiondef, or check you captured the right overload.`
  );
}

// A definition that does not match the call site must never land in the repo:
// committing it would replace one silent drift with another.
if (!contract.ok) {
  fail(
    `Refusing to write ${outPath}: the deployed definition does not match the call site.\n` +
    contract.problems.map(p => `   - ${p}`).join('\n') + '\n' +
    `   Either the app call site or the deployed function is wrong. Resolve that first.`
  );
}

const header = `-- 013 — ${TARGET_SCHEMA}.${RPC_NAME}, captured from the deployed database.
--
-- The application has always called this function (lib/provision-actions.ts),
-- but the repository only ever defined provision_church_v2. A database rebuilt
-- from this repo therefore could not provision a church at all.
--
-- Generated by scripts/capture-rpc.mjs from pg_get_functiondef output.
-- Re-verify with:  node scripts/capture-rpc.mjs --check ${outPath}
--
-- Contract checked at capture time:
--   parameters   ${contract.params?.join(', ')}
--   writes a readable passkey: ${writesPasskey ? 'yes' : 'NO'}
--   embedded credentials:     ${blocking.length ? 'FOUND — DO NOT COMMIT' : 'none detected'}
--   sha256 fingerprint:       ${fingerprint}${expected !== null ? '\n--   matches the live database: yes' : ''}
--
-- Paste this fingerprint into migrations/014_passkey_not_null.sql as
-- v_expected_fingerprint once you have reviewed the body below.

`;
writeFileSync(outPath, header + parsed.statement + '\n');
console.log(`\n✔ wrote ${outPath}`);
if (expected !== null) console.log('\n✔ this file is byte-identical to the deployed function.');
console.log(`\nNext: review the body, then add this entry to v_pins in migrations/014_passkey_not_null.sql:`);
console.log(`   ${JSON.stringify({
  schema: TARGET_SCHEMA,
  name: RPC_NAME,
  args: identityArgs(parsed.params),
  fingerprint,
})}`);
console.log(`\n014 pins every routine on the church-insert path and refuses if a pinned`);
console.log(`body calls one that was not pinned. Capture the whole chain.\n`);
