// A lint for two ways these hand-run files have actually broken, both of them found by being
// caught here rather than in the dashboard editor of a live project.
//
// 1. `RAISE EXCEPTION 'a' || 'b', arg;` is a syntax error in plpgsql. The format part of a RAISE
//    must be one string literal: plpgsql reads up to the first comma and stops, so the `||` —
//    which is idiomatic everywhere else in these files — is a parse failure. migrations/023 and
//    024 both shipped with this bug, in exactly the messages written to explain a failure, which
//    is the worst place to discover one.
//
// 2. `x NOT IN (subquery)` is not the negation people mean: one NULL on the right-hand side makes
//    every row drop out and the check silently passes. These migrations verify things ("no eligible
//    function was left unpinned"), so a silently-empty result is a false green. `NOT EXISTS` is
//    the form, and 023's own comment says why.
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const DIR = new URL('../../migrations/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

test('the newest migrations are inside the scan, so this cannot quietly become vacuous', () => {
  for (const wanted of ['023_harden_definer_routines.sql', '024_usher_session_guard.sql']) {
    assert.ok(files.includes(wanted), `${wanted} must be scanned — a per-file loop that skips a file is a passing test that proves nothing`);
  }
  assert.ok(files.length >= 15, `expected the full migrations/ set, found ${files.length} files`);
});

for (const file of files) {
  const source = readFileSync(new URL(file, DIR), 'utf8');

  test(`${file}: no RAISE with a concatenated format string`, () => {
    const offenders = [];
    for (const match of source.matchAll(/\braise\s+(?:exception|notice|warning)\b([\s\S]{0,600}?);/g)) {
      const head = match[1];
      // Everything up to the first comma at the top level is the format expression.
      const formatPart = head.split(/,(?![^']*')/)[0];
      if (/\|\|/.test(formatPart)) {
        offenders.push(source.slice(0, match.index).split('\n').length);
      }
    }
    assert.deepEqual(offenders, [],
      `RAISE with 'a' || 'b' is a plpgsql syntax error at line(s) ${offenders.join(', ')} — use one literal`);
  });

  test(`${file}: no NOT IN (subquery) on a verification check`, () => {
    const offenders = [];
    for (const match of source.matchAll(/\bnot\s+in\s*\(\s*select/gi)) {
      offenders.push(source.slice(0, match.index).split('\n').length);
    }
    assert.deepEqual(offenders, [],
      `NOT IN with a subquery turns one NULL into a passing check at line(s) ${offenders.join(', ')}`
      + ' — use NOT EXISTS');
  });

  test(`${file}: dollar-quoted blocks are balanced`, () => {
    const tags = source.match(/\$\$/g) ?? [];
    assert.equal(tags.length % 2, 0,
      'an unbalanced $$ would send the dashboard editor an incomplete statement');
    const begin = (source.match(/^\s*begin;/gmi) ?? []).length;
    const commitOrRollback = (source.match(/^\s*(commit|rollback);/gmi) ?? []).length;
    assert.ok(commitOrRollback >= begin,
      `every explicit BEGIN (${begin}) needs a terminating COMMIT/ROLLBACK (${commitOrRollback}) — a hand-run migration that leaves a transaction open is a footgun for whatever gets pasted into the editor next`);
  });
}
