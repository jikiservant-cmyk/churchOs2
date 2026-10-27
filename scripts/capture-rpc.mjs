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
function extractFunction(sql, name) {
  const head = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, 'i');
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
const withValues = args.includes('--show-values'); // never use on a live dump
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : 'migrations/013_provision_church_v3.sql';
const inputPath = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1);

const RPC_NAME = 'provision_church_v3';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!inputPath) {
  fail('No input file.\n\n  node scripts/capture-rpc.mjs <dump.sql> --out migrations/013_provision_church_v3.sql');
}

if (!existsSync(inputPath)) fail(`Input not found: ${inputPath}`);

const raw = readFileSync(inputPath, 'utf8');
const parsed = extractFunction(raw, RPC_NAME);
if (!parsed) fail(`No CREATE FUNCTION public.${RPC_NAME} found in ${basename(inputPath)}.`);

const scanText = checkMode ? raw : parsed.statement;
const findings = scanSecrets(scanText);
const blocking = findings.filter(f => f.severity === 'block');
const review = findings.filter(f => f.severity === 'review');

const contract = validateContract(RPC_NAME, parsed);
const writesPasskey = /passkey/i.test(parsed.body);

function report() {
  console.log(`\nRPC          public.${RPC_NAME}`);
  console.log(`Parameters   ${contract.params?.join(', ') ?? '?'}`);
  console.log(`Writes passkey  ${writesPasskey ? 'yes' : 'NO — passkey NOT NULL cannot be enforced until this is fixed'}`);
  console.log(`Contract     ${contract.ok ? 'matches the call site' : 'MISMATCH'}`);
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
  report();
  if (!contract.ok) fail('Committed definition does not match the call site.');
  if (blocking.length) fail('Committed definition contains credential material. Rotate it and remove it from history.');
  console.log('\n✔ definition is consistent with the call site\n');
  process.exit(0);
}

if (blocking.length && !force) {
  report();
  const redactedPath = `${outPath}.redacted.sql`;
  writeFileSync(redactedPath, redact(parsed.statement) + '\n');
  fail(
    `Refusing to write ${outPath}: ${blocking.length} credential(s) found.\n` +
    `   A redacted copy was written to ${redactedPath} so you can see the shape.\n` +
    `   If the credential is real, rotate it first. Then re-run with --force only\n` +
    `   after it has been removed from the definition.`
  );
}

report();

// A definition that does not match the call site must never land in the repo:
// committing it would replace one silent drift with another.
if (!contract.ok) {
  fail(
    `Refusing to write ${outPath}: the deployed definition does not match the call site.\n` +
    contract.problems.map(p => `   - ${p}`).join('\n') + '\n' +
    `   Either the app call site or the deployed function is wrong. Resolve that first.`
  );
}

const header = `-- 013 — public.${RPC_NAME}, captured from the deployed database.
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

`;
writeFileSync(outPath, header + parsed.statement + '\n');
console.log(`\n✔ wrote ${outPath}\n`);
