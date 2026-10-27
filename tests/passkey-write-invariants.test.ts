// Guards the write shapes that migration 014 makes fatal.
//
// Once `church.churches.passkey` is NOT NULL, an UPDATE or INSERT that writes
// NULL to it fails with 23502 — and a DEFAULT does not apply to an explicit
// NULL, only to an omitted column. The rotation path used to write
// `passkey: null`, which silently blanked the field and locked congregations
// out of the usher portal.
//
// This is a source-level check rather than a database test because the mistake
// is made in application code, and the cheapest place to catch it is before it
// ships.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '.git'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Application code only — fixtures and tests are allowed to describe a church
// that has no passkey yet.
const APP_FILES = [
  ...walk(join(ROOT, 'lib')),
  ...walk(join(ROOT, 'app')),
  ...walk(join(ROOT, 'components')),
].filter(f => ['.ts', '.tsx'].includes(extname(f)));

const read = (f: string) => readFileSync(f, 'utf8');

// Strip comments before scanning. Prose that *warns against* `passkey: null`
// must not count as an occurrence of it — the comment explaining this bug would
// otherwise trip the check that exists because of it.
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');    // line comments, keeping URLs intact
}

describe('passkey write invariants (migration 014 makes these fatal)', () => {
  it('discovers the application source', () => {
    assert.ok(APP_FILES.length > 0);
  });

  it('no application code writes NULL to passkey', () => {
    const offenders: string[] = [];
    for (const file of APP_FILES) {
      const src = codeOnly(read(file));
      // `passkey: null` in an object literal, or `passkey = null` in SQL text.
      if (/\bpasskey\s*:\s*null\b/.test(src) || /\bpasskey\s*=\s*null\b/i.test(src)) {
        offenders.push(file.replace(ROOT, ''));
      }
    }
    assert.deepEqual(
      offenders, [],
      'These write NULL to a column that 014 makes NOT NULL, which fails with 23502:\n' +
      offenders.join('\n')
    );
  });

  it('no application code writes NULL to passkey_hash', () => {
    // passkey_hash stays nullable, so this is not fatal — but a nulling write is
    // how the readable code got shadowed in the first place.
    const offenders: string[] = [];
    for (const file of APP_FILES) {
      const src = codeOnly(read(file));
      if (/\bpasskey_hash\s*:\s*null\b/.test(src) || /\bpasskey_hash\s*=\s*null\b/i.test(src)) {
        offenders.push(file.replace(ROOT, ''));
      }
    }
    assert.deepEqual(offenders, [], `Unexpected NULL writes to passkey_hash:\n${offenders.join('\n')}`);
  });

  it('rotation keeps the readable passkey rather than only the hash', () => {
    const src = read(join(ROOT, 'lib', 'attendance-actions.ts'));
    const body = src.slice(src.indexOf('export async function updateChurchPasskey'));
    const update = body.slice(body.indexOf('.update({'), body.indexOf('})', body.indexOf('.update({')));

    assert.match(update, /passkey:\s*trimmedKey/, 'rotation must write the readable code back');
    assert.match(update, /passkey_hash:\s*passkeyHash/);
    assert.doesNotMatch(update, /passkey:\s*null/);
  });

  it('login self-heal never clears the hash it just verified', () => {
    const src = read(join(ROOT, 'lib', 'attendance-actions.ts'));
    const heal = src.slice(src.indexOf('Self-heal'), src.indexOf('if (!isMatch)'));
    assert.match(heal, /passkey_hash:\s*providedHash/);
    assert.doesNotMatch(heal, /passkey_hash:\s*null/);
  });

  it('the schema default matches the generator migrations/012 uses', () => {
    // A default that produced a shape the validator rejects would make every
    // provisioned church unusable, which is the failure this whole chain of
    // migrations exists to remove.
    const schema = read(join(ROOT, 'supabase-schema.sql'));
    assert.match(
      schema,
      /passkey text NOT NULL DEFAULT upper\(substr\(replace\(gen_random_uuid\(\)::text, '-', ''\), 1, 10\)\)/
    );
    assert.doesNotMatch(schema, /passkey text NOT NULL DEFAULT lpad\(floor\(random\(\)/, 'random() is not a CSPRNG');
  });
});
