// Guards for the two findings that were about the *application*, not the database:
// P0-2 (createAdminClient() was not actually the service role) and P1-5 (SameSite=None
// cookies with nothing refusing to be framed). See SECURITY_REVIEW-2026-10-30.md.
//
// These run in-process against the real modules — no mocks of the behaviour under
// test, and a source-level guard where the behaviour only exists inside Next.js'
// request lifecycle and would otherwise be untestable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createServiceClient,
  resolveServiceClient,
  serviceClientFallbackNotice,
  serviceClientHeaders,
} from '../lib/supabase/service-client.ts';
import {
  normaliseEmbedOrigin,
  parseEmbedHosts,
  resolveFrameAncestors,
} from '../lib/security/frame-ancestors.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('privileged service-role client', () => {
  it('refuses to pretend it is configured when either half is missing', () => {
    assert.deepEqual(resolveServiceClient({ url: 'https://x.supabase.co', serviceRoleKey: 'k' }), {
      configured: true, url: 'https://x.supabase.co', serviceRoleKey: 'k',
    });
    assert.equal(resolveServiceClient({ url: 'https://x.supabase.co', serviceRoleKey: '' }).configured, false);
    assert.equal(resolveServiceClient({ url: '', serviceRoleKey: 'k' }).configured, false);
    assert.equal(resolveServiceClient({ url: undefined, serviceRoleKey: undefined }).configured, false);
    // Whitespace-only values are what an empty Vercel env var with a stray newline
    // looks like, and a client built on them fails at request time instead of here.
    assert.equal(resolveServiceClient({ url: '  ', serviceRoleKey: '\n' }).configured, false);
  });

  it('trims the credential rather than sending it padded', () => {
    const resolved = resolveServiceClient({ url: ' https://x.supabase.co ', serviceRoleKey: '  secret\n' });
    assert.ok(resolved.configured);
    assert.equal(resolved.serviceRoleKey, 'secret');
    assert.deepEqual(serviceClientHeaders(' secret '), { apikey: 'secret', Authorization: 'Bearer secret' });
  });

  it('sends the service key as the bearer, which is the whole point of the fix', async () => {
    const built = createServiceClient({ url: 'https://x.supabase.co', serviceRoleKey: 'srv-key' });
    assert.ok(built, 'expected a configured client');
    assert.equal(built.privileged, true);
    // supabase-js picks the bearer per request as `session?.access_token ?? key`.
    // The old createAdminClient() had a cookie-backed session, so that expression
    // resolved to the *user's* token. Read the headers the auth client will use and
    // prove no session exists to override them.
    const authHeaders = (built.client.auth as unknown as { headers: Record<string, string> }).headers;
    assert.equal(authHeaders.Authorization, 'Bearer srv-key');
    assert.equal(authHeaders.apikey, 'srv-key');
    const session = await built.client.auth.getSession();
    assert.equal(session.data.session, null, 'a privileged client must never hold a user session');
  });

  it('builds nothing when the environment cannot support it, so callers can choose their failure mode', () => {
    assert.equal(createServiceClient({ url: 'https://x.supabase.co', serviceRoleKey: undefined }), null);
    assert.equal(createServiceClient({ url: '', serviceRoleKey: '' }), null);
  });

  it('tells the operator what they will see if it is unconfigured', () => {
    const notice = serviceClientFallbackNotice('missing-key');
    assert.match(notice, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(notice, /row-level-security/i);
    // The consequence of the trigger added with migration 020, stated up front: a
    // fallback turns protected writes into an error, and that must not be a mystery.
    assert.match(notice, /42501/);
  });

  it('is what createAdminClient() actually builds, without a cookie store attached', () => {
    const server = read('lib/supabase/server.ts');
    const body = server.slice(server.indexOf('export async function createAdminClient'));
    const untilNextExport = body.slice(0, body.indexOf('\nexport ', 10));
    assert.match(untilNextExport, /createServiceClient\(/, 'createAdminClient must go through the service-role builder');
    assert.doesNotMatch(
      untilNextExport,
      /createServerClient\(\s*url,\s*key/,
      'it must not hand the service key to a cookie-backed SSR client — that is P0-2',
    );
    // The degraded path is deliberate, but it has to be loud.
    assert.match(untilNextExport, /console\.error\(serviceClientFallbackNotice/);
  });

  it('leaves no module wiring the service key into a cookie-backed SSR client', () => {
    // The exact regression this guards is a copy of the old createAdminClient — same
    // factory, same key, a cookie store, and every "privileged" query quietly running
    // under the caller's own RLS. Comments may describe that shape (this repository
    // does, to explain it), so only live code is searched.
    const stripped = (source: string) => source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = stripped(readFileSync(path, 'utf8'));
          scanned += 1;
          if (/createServerClient\s*\(\s*[^;]{0,200}SUPABASE_SERVICE_ROLE_KEY/.test(source)) offenders.push(relative(ROOT, path));
        }
      }
    };
    for (const root of ['lib', 'app', 'supabase/functions']) walk(join(ROOT, root));
    // A scan that found no files would pass for the wrong reason.
    assert.ok(scanned > 40, `only ${scanned} source files were inspected — the walk is broken`);
    assert.deepEqual(
      offenders,
      [],
      `${offenders.join(', ')} builds a session-carrying client from the service-role key. `
        + 'Use createServiceClient() from lib/supabase/service-client.ts instead.',
    );
    // Vacuity guard: the pattern must find the shape it claims to forbid.
    assert.match(
      stripped("export async function bad() {\n  return createServerClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { cookies });\n}"),
      /createServerClient\s*\(\s*[^;]{0,200}SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe('framing policy', () => {
  it('normalises whatever shape the operator wrote in EMBED_HOSTS', () => {
    assert.equal(normaliseEmbedOrigin('https://partner.example/'), 'https://partner.example');
    assert.equal(normaliseEmbedOrigin('partner.example'), 'https://partner.example');
    assert.equal(normaliseEmbedOrigin('  '), null);
    assert.deepEqual(parseEmbedHosts('a.example, https://b.example  c.example'), [
      'https://a.example', 'https://b.example', 'https://c.example',
    ]);
    assert.deepEqual(parseEmbedHosts(undefined), []);
  });

  it('denies framing by default in production, keeping only the app own hosts', () => {
    const value = resolveFrameAncestors({
      isProduction: true,
      appHosts: ['churchos.example'],
      embedHostsRaw: undefined,
    });
    assert.equal(value, "'self' https://churchos.example");
    assert.doesNotMatch(value ?? '', /\*/);
  });

  it('adds only the hosts the operator names, and never infers a wildcard', () => {
    assert.equal(
      resolveFrameAncestors({ isProduction: true, appHosts: [], embedHostsRaw: 'https://partner.co.ug' }),
      "'self' https://partner.co.ug",
    );
    // A stray '*' inside the list must not turn the policy off; the explicit,
    // whole-value form is the only way to get that, so a typo cannot open the app.
    assert.equal(
      resolveFrameAncestors({ isProduction: true, appHosts: [], embedHostsRaw: 'partner.co.ug *' }),
      "'self' https://partner.co.ug",
    );
    assert.equal(
      resolveFrameAncestors({ isProduction: true, appHosts: [], embedHostsRaw: '*', allowAnyHost: true }),
      '*',
    );
  });

  it('stays out of the way in development and on previews', () => {
    assert.equal(
      resolveFrameAncestors({ isProduction: false, appHosts: ['localhost:3000'], embedHostsRaw: 'x.example' }),
      null,
      'a preview that refuses to be framed looks like a broken build, not a hardened one',
    );
  });

  it('is actually emitted by next.config.ts', () => {
    const config = read('next.config.ts');
    assert.match(config, /key: 'Content-Security-Policy', value: `frame-ancestors \$\{frameAncestors\}`/);
    assert.match(config, /isProduction: process\.env\.NODE_ENV === 'production'/);
    // A full CSP still needs nonces, and the config must keep saying so rather than
    // half-applying one and breaking every inline script in production.
    assert.match(config, /X-Content-Type-Options/);
    const noXfoDenyEverywhere = !/X-Frame-Options'?, value: 'DENY'/.test(config);
    assert.ok(noXfoDenyEverywhere, 'X-Frame-Options: DENY would break the legitimate partner embed the cookies are configured for');
  });
});
