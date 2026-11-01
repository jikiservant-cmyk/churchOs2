// What identity does the application's privileged connection actually present to
// PostgREST?
//
// This is not an academic question, and it is not a style preference: migrations/020
// narrows `authenticated` policies on church.churches and migrations/021 revokes
// `anon`/`authenticated` table privileges on the same table. If the app's own admin
// writes were running as the caller, those files would break passkey rotation,
// meeting-day saves and webhook activation — and SECURITY_REVIEW-2026-10-30.md's P0-2
// originally asserted exactly that, from reading supabase-js's `_getAccessToken()`
// source rather than testing it. The property below is the one that decides whether
// the run order is "non-negotiable" or "either way", so it is now pinned by a test
// instead of by a paragraph.
//
// Run `node scripts/probe-admin-client-identity.mjs` to watch the library decide, for
// both constructions, instead of trusting the paragraph below.
//
// The mechanism that made the claim plausible:
//
//     async _getAccessToken() {
//       const { data } = await this.auth.getSession();
//       return data.session?.access_token ?? this.supabaseKey;   // ← a session WINS
//     }
//
// So a client that can see a user's session cookie sends that user's JWT no matter
// which key it was constructed with. `createServiceClient()` is built to be
// incapable of that — no cookie store, an empty auth storage, and the header pinned —
// and these tests prove each half of that sentence against the real installed
// libraries rather than against my reading of them.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createServiceClient,
  resolveServiceClient,
  serviceClientFallbackNotice,
  serviceClientHeaders,
} from '../lib/supabase/service-client.ts';

const SERVICE_KEY = 'service-key-abcdef';
const USER_JWT = 'eyJhbGciOi.user-token.ends-here';

type Captured = { authorization?: string | null; apikey?: string | null };
const captured: Captured[] = [];

function fetchSpy() {
  return async (_url: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    captured.push({ authorization: headers.get('authorization'), apikey: headers.get('apikey') });
    // Stop the request here. Everything that matters already happened: the headers.
    return new Response(JSON.stringify({ code: 'PGRST116', message: 'captured' }), {
      status: 406,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function restCall(client: { schema(s: string): any; auth?: any }) {
  await client.schema('church').from('churches').update({ activation_status: 'active' });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  captured.length = 0;
  globalThis.fetch = originalFetch;
});

describe('createServiceClient() authenticates as the service role, always', () => {
  it('pins Authorization to the service key on a real PostgREST request', async () => {
    globalThis.fetch = fetchSpy() as typeof fetch;
    const built = createServiceClient({
      url: 'https://probe.supabase.co',
      serviceRoleKey: SERVICE_KEY,
    });
    assert.ok(built, 'a configured environment must build a client');
    assert.equal(built.privileged, true);

    // The spy replaces fetch globally, which is what supabase-js uses when no
    // `global.fetch` option was given — i.e. exactly how the app runs it.
    await restCall(built.client);

    assert.equal(captured.length, 1, 'one statement, one request');
    assert.equal(captured[0].authorization, `Bearer ${SERVICE_KEY}`,
      'the bearer token must be the service key — a user JWT here means every '
      + 'narrowed authenticated policy now applies to the app’s own writes');
    assert.equal(captured[0].apikey, SERVICE_KEY);
  });

  it('stays the service role even though a session-shaped token exists in the environment', async () => {
    // The regression this guards: someone "tidies" createServiceClient by routing it
    // through @supabase/ssr with the request's cookie store. supabase-js would then
    // prefer data.session.access_token over this.supabaseKey and every privileged
    // write in a logged-in request would silently change role. We assert the client
    // has no way to see one: no auth store, and the header is what we set.
    const storage = new Map<string, string>([['sb-probe-auth-token', JSON.stringify({
      access_token: USER_JWT, token_type: 'bearer', user: { id: 'u1' },
    })]]);
    (globalThis as any).__USER_SESSION_LIVES_HERE = storage;

    globalThis.fetch = fetchSpy() as typeof fetch;
    const built = createServiceClient({ url: 'https://probe.supabase.co', serviceRoleKey: SERVICE_KEY });
    assert.ok(built);

    // Nothing in the client reads that map — prove it by asking the client for its own
    // session, which must be absent, then by sending a statement.
    const { data } = await built.client.auth.getSession();
    assert.equal(data.session, null, 'a service connection must not be able to see a user session');

    await restCall(built.client);
    assert.equal(captured[0].authorization, `Bearer ${SERVICE_KEY}`);
    assert.notEqual(captured[0].authorization, `Bearer ${USER_JWT}`);
  });

  it('returns null instead of a lying client when the key is missing', () => {
    assert.equal(createServiceClient({ url: 'https://x.supabase.co', serviceRoleKey: '' }), null);
    assert.equal(createServiceClient({ url: '', serviceRoleKey: SERVICE_KEY }), null);
    assert.equal(createServiceClient({ url: null, serviceRoleKey: undefined }), null);

    assert.deepEqual(resolveServiceClient({ url: ' https://x.supabase.co ', serviceRoleKey: ' k ' }),
      { configured: true, url: 'https://x.supabase.co', serviceRoleKey: 'k' },
      'whitespace-only values are the shape of a Vercel env var set to a space');
  });

  it('names the database error the fallback will produce, because 42501 is what an operator sees', () => {
    const notice = serviceClientFallbackNotice('missing-key');
    assert.match(notice, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(notice, /42501/);
    assert.match(notice, /falling back/);
  });

  it('serviceClientHeaders is the whole contract, spelled once', () => {
    assert.deepEqual(serviceClientHeaders('  key  '), { apikey: 'key', Authorization: 'Bearer key' });
  });
});
