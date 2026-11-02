import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import {
  USHER_PASSKEY_ALPHABET,
  USHER_PASSKEY_LENGTH,
  ensureChurchUsherPasskey,
  generateUsherPasskeyCode,
  getUsherJwtSecret,
  hashUsherPasskey,
  isPortalAcceptedPasskey,
  readUsableUsherPasskey,
  usherSecretProblem,
} from '../lib/usher-passkey.ts';

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const SECRET = 'a-very-long-usher-secret-of-at-least-32-bytes';
const CHURCH_ID = '11111111-1111-4111-8111-111111111111';

const ENV_KEYS = ['USHER_JWT_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

function applyTestSecret(value: string | undefined) {
  saved[ENV_KEYS[0]] = process.env[ENV_KEYS[0]];
  if (value === undefined) delete process.env.USHER_JWT_SECRET;
  else process.env.USHER_JWT_SECRET = value;
}
function restoreSecret() {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

/**
 * A PostgREST-shaped fake: `select().eq().maybeSingle()` for the read and
 * `select().eq().is()|.eq().update(patch).eq().select()` for the guarded write.
 * Every filter is recorded per operation, so a test can prove which value the
 * write was conditioned on rather than only that a write happened.
 */
function fakeClient(script: {
  read?: (columns: string, attempt: number) => { data: unknown; error: unknown };
  write?: (patch: Record<string, unknown>, filters: Array<[string, unknown]>) => { data: unknown; error: unknown };
}) {
  const state = {
    columns: '',
    filters: [] as Array<[string, unknown]>,
    patch: null as Record<string, unknown> | null,
    afterUpdate: false,
    reads: 0,
    writes: 0,
  };
  const calls: Array<{ op: 'read' | 'write'; columns: string; patch: Record<string, unknown> | null; filters: Array<[string, unknown]> }> = [];

  const node = (): any =>
    new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') return undefined;
          if (prop === 'select') {
            return (columns: string) => {
              if (!state.afterUpdate) {
                state.columns = columns;
                return node();
              }
              state.writes += 1;
              calls.push({ op: 'write', columns: state.columns, patch: state.patch, filters: state.filters });
              const outcome = script.write?.(state.patch ?? {}, state.filters) ?? { data: null, error: null };
              state.filters = [];
              state.afterUpdate = false;
              state.patch = null;
              return Promise.resolve(outcome);
            };
          }
          if (prop === 'update') {
            return (patch: Record<string, unknown>) => {
              state.patch = patch;
              state.afterUpdate = true;
              return node();
            };
          }
          if (prop === 'eq' || prop === 'is' || prop === 'ilike' || prop === 'in') {
            return (column: string, value: unknown) => {
              if (prop === 'eq' || prop === 'is') state.filters.push([column, value]);
              return node();
            };
          }
          if (prop === 'maybeSingle') {
            return () => {
              state.reads += 1;
              calls.push({ op: 'read', columns: state.columns, patch: null, filters: state.filters });
              const outcome = script.read?.(state.columns, state.reads) ?? { data: null, error: null };
              state.filters = [];
              return Promise.resolve(outcome);
            };
          }
          return () => node();
        },
      },
    );

  return {
    client: { schema: () => ({ from: () => node() }) } as any,
    calls,
  };
}

describe('Usher passkey — the code a church hands to its ushers', () => {
  test('a generated code is exactly what the portal validator accepts', () => {
    applyTestSecret(SECRET);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 400; i += 1) {
        const code = generateUsherPasskeyCode();
        assert.equal(code.length, USHER_PASSKEY_LENGTH);
        assert.match(code, /^[A-Z2-9]+$/);
        assert.ok(isPortalAcceptedPasskey(code), `${code} rejected by the portal rule`);
        for (const character of code) {
          assert.ok(!'IO01'.includes(character), `${code} contains an ambiguous character`);
          seen.add(character);
        }
      }
      assert.equal(seen.size, USHER_PASSKEY_ALPHABET.length, 'every alphabet character should be reachable');
    } finally {
      restoreSecret();
    }
  });

  test('the hash is the HMAC the login path compares, with its domain separation intact', () => {
    applyTestSecret(SECRET);
    try {
      const derived = crypto.createHmac('sha256', 'usher_jwt_domain_separation').update(SECRET).digest();
      const expected = crypto.createHmac('sha256', derived).update('AB23CD45').digest('hex');
      assert.equal(hashUsherPasskey('AB23CD45'), expected);
      assert.equal(hashUsherPasskey('  AB23CD45 '), expected, 'login trims the input, so the stored hash must too');
      assert.notEqual(hashUsherPasskey('AB23CD46'), expected);
      assert.notEqual(Buffer.from(expected, 'hex').length, 0);
    } finally {
      restoreSecret();
    }
  });

  test('an unusable secret is named instead of silently producing a wrong hash', () => {
    applyTestSecret(undefined);
    assert.match(String(usherSecretProblem()), /not set/);
    assert.throws(() => getUsherJwtSecret(), /USHER_JWT_SECRET/);

    applyTestSecret('REPLACE_ME_WITH_A_STRONG_RANDOM_SECRET');
    assert.match(String(usherSecretProblem()), /placeholder/);

    applyTestSecret('short');
    assert.match(String(usherSecretProblem()), /at least 32 are required/);

    applyTestSecret(SECRET);
    assert.equal(usherSecretProblem(), null);
    restoreSecret();
  });

  test('blank in every spelling means "no code", which is what drifted for new churches', () => {
    for (const blank of [null, undefined, '', '   ', 0, false, {}, []]) {
      assert.equal(readUsableUsherPasskey(blank), null, `${String(blank)} must count as no code`);
    }
    assert.equal(readUsableUsherPasskey('  AB23CD45  '), 'AB23CD45');
    assert.equal(isPortalAcceptedPasskey('AB'), false, 'too short for the portal');
    assert.equal(isPortalAcceptedPasskey('A'.repeat(33)), false, 'too long for the portal');
    assert.equal(isPortalAcceptedPasskey('AB*CD45'), false, 'punctuation is rejected at login');
  });
});

describe('ensureChurchUsherPasskey — issue a code once, never twice', () => {
  const churchWith = (row: Record<string, unknown> | null, error: unknown = null) =>
    fakeClient({ read: () => ({ data: row, error }), write: () => ({ data: [row], error: null }) });

  test('a church that already has a readable code is left completely alone', () => {
    const { client, calls } = churchWith({ passkey: 'ZZ23AB45', passkey_hash: 'abcd', passkey_version: 4 });
    return runWithTestSecret(async () => {
      const result = await ensureChurchUsherPasskey(client, CHURCH_ID);
      assert.deepEqual(result, { status: 'present', passkey: 'ZZ23AB45' });
      assert.deepEqual(calls.filter((call) => call.op === 'write'), [], 'a re-issued code would lock every usher out mid-service');
    });
  });

  test('a blank code is filled with both the readable value and its hash', () => {
    const { client, calls } = churchWith({ passkey: '   ', passkey_hash: null, passkey_version: 1 });
    return runWithTestSecret(async () => {
      const result = await ensureChurchUsherPasskey(client, CHURCH_ID);
      assert.equal(result.status, 'generated');
      const write = calls.find((call) => call.op === 'write')!;
      const patch = write.patch as Record<string, string>;
      assert.match(patch.passkey, /^[A-Z2-9]{8}$/);
      assert.equal(patch.passkey_hash, hashUsherPasskey(patch.passkey), 'login compares the hash; it must match the code shown');
      assert.ok(Date.parse(patch.passkey_updated_at) > 0);
      assert.equal('passkey_version' in patch, false, 'bumping the version would revoke live usher sessions');
      assert.equal((result as { passkey: string }).passkey, patch.passkey);
    });
  });

  test('a NULL passkey is written under an `is null` guard so a concurrent issuer cannot be clobbered', () => {
    const { client, calls } = churchWith({ passkey: null, passkey_hash: null, passkey_version: 1 });
    return runWithTestSecret(async () => {
      assert.equal((await ensureChurchUsherPasskey(client, CHURCH_ID)).status, 'generated');
      const write = calls.find((call) => call.op === 'write')!;
      assert.deepEqual(write.filters.filter(([column]) => column === 'passkey'), [['passkey', null]]);
      assert.deepEqual(write.filters.filter(([column]) => column === 'id'), [['id', CHURCH_ID]], 'exactly one tenant guard, or the update is unscoped');
    });
  });

  test('a blank-string passkey is written under an equality guard on the exact value read', () => {
    const { client, calls } = churchWith({ passkey: '  ', passkey_hash: null, passkey_version: 1 });
    return runWithTestSecret(async () => {
      await ensureChurchUsherPasskey(client, CHURCH_ID);
      const write = calls.find((call) => call.op === 'write')!;
      assert.deepEqual(write.filters.filter(([column]) => column === 'passkey'), [['passkey', '  ']]);
    });
  });

  test('without a usable secret the readable code is still issued, unhashed', () => {
    const { client, calls } = churchWith({ passkey: null, passkey_hash: null, passkey_version: 1 });
    const previous = process.env.USHER_JWT_SECRET;
    delete process.env.USHER_JWT_SECRET;
    return (async () => {
      const result = await ensureChurchUsherPasskey(client, CHURCH_ID);
      assert.equal(result.status, 'generated');
      assert.equal((result as { hashed: boolean }).hashed, false);
      assert.match(String((result as { secretProblem: string | null }).secretProblem), /not set/);
      const patch = calls.find((call) => call.op === 'write')!.patch as Record<string, unknown>;
      assert.equal('passkey_hash' in patch, false, 'a hash derived from a placeholder secret would be unverifiable later');
      assert.match(String(patch.passkey), /^[A-Z2-9]{8}$/, 'the church still needs a code to hand out');
    })().finally(() => {
      if (previous === undefined) delete process.env.USHER_JWT_SECRET;
      else process.env.USHER_JWT_SECRET = previous;
    });
  });

  test('a lost race reports the code that won instead of inventing a second one', () => {
    const { client } = fakeClient({
      read: (_columns, attempt) =>
        attempt === 1
          ? { data: { passkey: null, passkey_hash: null, passkey_version: 1 }, error: null }
          : { data: { passkey: 'QQ77XY99' }, error: null },
      write: () => ({ data: [], error: null }),
    });
    return runWithTestSecret(async () => {
      assert.deepEqual(await ensureChurchUsherPasskey(client, CHURCH_ID), { status: 'present', passkey: 'QQ77XY99' });
    });
  });

  test('a missing church row is reported as missing, not as a blank code to fill', () => {
    const { client, calls } = churchWith(null);
    return runWithTestSecret(async () => {
      const result = await ensureChurchUsherPasskey(client, CHURCH_ID);
      assert.equal(result.status, 'unavailable');
      assert.equal((result as { reason: string }).reason, 'church-not-found');
      assert.equal(calls.filter((call) => call.op === 'write').length, 0, 'never write to a church that was not found');
    });
  });

  test('a lookup error is reported as such', () => {
    const { client } = fakeClient({ read: () => ({ data: null, error: { message: 'permission denied' } }) });
    return runWithTestSecret(async () => {
      const result = await ensureChurchUsherPasskey(client, CHURCH_ID);
      assert.equal(result.status, 'unavailable');
      assert.match((result as { reason: string }).reason, /lookup-failed: permission denied/);
    });
  });

  test('a non-uuid church id is refused before a single query runs', () => {
    const { client, calls } = churchWith({ passkey: null });
    return runWithTestSecret(async () => {
      for (const bad of ['', '   ', 'not-a-uuid', `${CHURCH_ID} OR 1=1`, 'grace-church']) {
        assert.equal((await ensureChurchUsherPasskey(client, bad as string)).status, 'unavailable');
      }
      assert.equal((await ensureChurchUsherPasskey(client, null as unknown as string) as { reason: string }).reason, 'invalid-church-id');
      assert.deepEqual(calls, [], 'nothing may be queried for an id that cannot be one');
    });
  });

  test('a write failure stops short of claiming a code exists', () => {
    const { client } = fakeClient({
      read: () => ({ data: { passkey: null, passkey_hash: null, passkey_version: 1 }, error: null }),
      write: () => ({ data: null, error: { message: 'row-level security' } }),
    });
    return runWithTestSecret(async () => {
      const result = await ensureChurchUsherPasskey(client, CHURCH_ID);
      assert.equal(result.status, 'unavailable');
      assert.match((result as { reason: string }).reason, /write-failed: row-level security/);
    });
  });
});

/** The suite above must run with a usable secret; node:test wants a promise back. */
async function runWithTestSecret(run: () => Promise<void> | void) {
  applyTestSecret(SECRET);
  try {
    await run();
  } finally {
    restoreSecret();
  }
}

describe('Usher passkey — where the guarantee is enforced', () => {
  test('provisioning issues the code instead of hoping a migration ran', () => {
    const actions = source('../lib/provision-actions.ts');
    assert.match(actions, /ensureChurchUsherPasskey/, 'a new church must leave setup with a code');
    // The church exists by then; a passkey failure must not undo it.
    assert.match(actions, /usher passkey step failed/);
  });

  test('the attendance screen fills the field it is about to render', () => {
    const page = source('../app/c/[church_slug]/admin/(authenticated)/attendance/page.tsx');
    assert.match(page, /ensureChurchUsherPasskey/);
    assert.ok(!/passkey=\{churchDetails\?\.passkey \|\| ''\}/.test(page), 'the screen must render the ensured code, not the raw column');
  });

  test('the crypto lives in one module and is not browser-reachable', () => {
    const actions = source('../lib/attendance-actions.ts');
    assert.ok(!/function computePasskeyHash/.test(actions), 'two HMAC implementations will drift apart');
    assert.match(actions, /from '\.\/usher-passkey'/);
    const shared = source('../lib/usher-passkey.ts');
    assert.ok(!/^'use server';/m.test(shared),
      'ensureChurchUsherPasskey must not become a server action; it takes no authorization of its own');
  });

  test('018 never writes a credential and keeps the schema default byte-identical', () => {
    const migration = source('../migrations/018_usher_passkey_default.sql');
    assert.ok(!/SET\s+passkey\s*=/i.test(migration), 'backfilling codes is migration 012s job; two files will disagree');
    assert.ok(!/passkey_hash\s*=/i.test(migration.replace(/patch[^\n]*/g, '')), 'the hash needs USHER_JWT_SECRET, which SQL does not have');
    assert.ok(
      migration.includes("upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))"),
      'the default must match supabase-schema.sql exactly',
    );
    assert.match(migration, /ALTER COLUMN passkey SET DEFAULT/);
    assert.match(migration, /SELECT column_default INTO v_default/);
  });
});
