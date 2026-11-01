#!/usr/bin/env node
// Which bearer token does a request from `createAdminClient()` actually carry?
//
// SECURITY_REVIEW-2026-10-30.md originally asserted, from supabase-js source, that the
// "admin" client sends the *user's* JWT inside a logged-in request, because
// `_getAccessToken()` prefers `data.session.access_token` over the constructed key:
//
//     return e.session?.access_token ?? this.supabaseKey
//
// That is true of a client whose auth storage can see a session. It is NOT true of
// `lib/supabase/server.ts` as deployed, which builds the client with
// `cookies: { getAll: () => [], setAll: () => {} }` — no storage, no session, so the
// service key is what goes out. The difference decides whether migrations/020 (which
// narrows `authenticated` policies) and 021 (which revokes `authenticated` table
// privileges) are safe to run before the application is redeployed, so it should be
// measured rather than argued. It is also the kind of thing that changes with a library
// bump: pin it here and re-run after any @supabase/* upgrade.
//
//   node scripts/probe-admin-client-identity.mjs
//
// Exits non-zero if the deployed construction stops being service-role, or if a client
// that CAN see a session stops preferring that session (both are load-bearing claims).
import { createServerClient } from '@supabase/ssr';

const URL_ = 'https://probe.supabase.co';
const SERVICE_KEY = 'SERVICE_KEY_ABCDEF';
const USER_JWT = 'USER_JWT_XYZ';

const captured = [];
const fetchSpy = async (_url, init = {}) => {
  const headers = new Headers(init.headers ?? {});
  captured.push(headers.get('authorization'));
  // Stop here; the header is the whole question.
  return new Response(JSON.stringify({ code: 'PGRST116', message: 'probe' }), {
    status: 406, headers: { 'content-type': 'application/json' },
  });
};

// A session in the cookie store, exactly as a signed-in browser request would have it.
// Storage key is derived from the project hostname: sb-<first-label>-auth-token.
const SESSION_COOKIE = {
  name: 'sb-probe-auth-token',
  value: JSON.stringify({
    access_token: USER_JWT, token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1' },
  }),
};

async function ask(label, client) {
  captured.length = 0;
  await client.schema('church').from('churches').update({ activation_status: 'active' });
  const bearer = captured[0] ?? '(no request)';
  const who = bearer === `Bearer ${SERVICE_KEY}` ? 'service_role'
    : bearer === `Bearer ${USER_JWT}` ? 'authenticated (the caller’s JWT)'
    : `unexpected: ${bearer}`;
  console.log(`${label}\n    Authorization: ${bearer}\n    PostgREST role: ${who}\n`);
  return bearer;
}

// (a) exactly how lib/supabase/server.ts builds createAdminClient()
const admin = createServerClient(URL_, SERVICE_KEY, {
  cookies: { getAll: () => [], setAll: () => {} },
  global: { fetch: fetchSpy },
});
// (b) the same call with a real session visible — this is the shape the report assumed
const withSession = createServerClient(URL_, SERVICE_KEY, {
  cookies: { getAll: () => [SESSION_COOKIE], setAll: () => {} },
  global: { fetch: fetchSpy },
});

const a = await ask('(a) createAdminClient() as deployed (empty cookie store)', admin);
const b = await ask('(b) the same construction with a session in the cookie store', withSession);

let failed = 0;
if (a !== `Bearer ${SERVICE_KEY}`) {
  console.error('FAIL (a): the admin client is not presenting the service key. Every claim in');
  console.error('          the review about "the app writes as the caller" becomes true again,');
  console.error('          and 020/021 must be re-planned around a redeploy.');
  failed = 1;
}
if (b !== `Bearer ${USER_JWT}` && b !== `Bearer ${SERVICE_KEY}`) {
  console.error('FAIL (b): the library neither preferred the session nor fell back to the key.');
  console.error('          Check the @supabase/ssr + supabase-js versions before trusting either');
  console.error('          reading of P0-2.');
  failed = 1;
}
console.log(b === `Bearer ${USER_JWT}`
  ? '(b) shows the session winning when storage exposes it — the trap service-client.ts avoids.'
  : '(b) still shows the service key: this @supabase/ssr version did not hydrate a session from '
    + 'a hand-written cookie (expected — the real name/chunking differs). Case (a) is the one '
    + 'the deployment depends on, and it is what matters here.');
process.exit(failed);
