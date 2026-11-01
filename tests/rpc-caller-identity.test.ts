// Which connection does an .rpc() call travel on, and why that is a security property.
//
// SECURITY_REVIEW-2026-10-30.md P1-8 is about eleven database functions the application
// calls that this repository has never seen. A read-only preflight on 2026-11-01 measured
// their properties: `authenticated` holds EXECUTE on all of them, `public` is the schema
// they live in, and three are SECURITY DEFINER — including the two denomination-invite
// functions that mint and redeem platform-level oversight of churches.
//
// Two consequences, and this file pins the one that is visible from source:
//
// 1. `authenticated` EXECUTE cannot be revoked from those functions, because the
//    application itself calls them with the caller's own session client. It does that on
//    purpose: lib/super-admin-overseer-actions.ts says so at the call site — "issue the
//    invite through the session client so the database RPC receives auth.uid()". A
//    SECURITY DEFINER function can only check the identity of its caller through
//    auth.uid(), so routing the call through a service-role connection does not merely
//    skip the Next.js guard, it BLINDS the guard inside the function: the bearer token
//    carries no user claim, auth.uid() is NULL, and the body either refuses outright or
//    falls back to whichever caller-supplied p_* argument it accepts. Both outcomes are
//    worse than the bug being prevented, and the second one is a privilege escalation.
//
// 2. So the Next.js layer is a convenience check, not the boundary — anyone with a member
//    JWT can POST /rpc/<name> directly and bypass it. The remaining defence is what the
//    function body does with auth.uid(), which is unknown until those definitions are read
//    and version-controlled. That half is tracked in the review file, not here.
//
// What this test therefore refuses to let a future refactor do is swap a session client
// for a privileged one on a security-relevant RPC, which is exactly the shape of the
// "use the admin client, it is simpler" tidy-up that produced the P0-2 confusion earlier
// in this review.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const OVERSEER_ACTIONS = read('../lib/overseer-actions.ts');
const SUPER_ADMIN_ACTIONS = read('../lib/super-admin-overseer-actions.ts');

/**
 * Receivers that would present something other than the caller's JWT. `admin` is the
 * name this codebase gives the service-role client everywhere it is used; the rest are
 * plausible future aliases, and a new one is meant to fail here and get added on purpose.
 */
const PRIVILEGED_RECEIVERS = new Set(['admin', 'service', 'serviceClient', 'privileged', 'db']);

/** Every `await <receiver>.rpc('<name>'` in the source, with its 1-based line number. */
function rpcCallSites(source: string, fnName: string) {
  // No `await` in the pattern on purpose: three of these calls sit inside a Promise.all,
  // where they are not awaited at the call site, and requiring it would have quietly
  // hidden the three read RPCs whose scoping this test exists to keep honest.
  const pattern = new RegExp(`([A-Za-z_$][\\w$.]*)\\.rpc\\(\\s*['"]${fnName}['"]`, 'g');
  const sites: { receiver: string; line: number }[] = [];
  for (const match of source.matchAll(pattern)) {
    sites.push({
      receiver: (match[1] ?? '').split('.').pop() ?? '',
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return sites;
}

describe('security-relevant RPCs travel on the caller’s own session connection', () => {
  // The functions whose bodies are told to rely on auth.uid(), plus the read-only
  // aggregates whose RLS scoping depends on the same claim. If any of these ever moves to
  // a service-role connection, the SQL-side check stops having anything to check.
  const IDENTITY_DEPENDENT = [
    'create_denomination_overseer_invite',
    'redeem_denomination_overseer_invite',
    'overseer_create_invite',
    'overseer_revoke_invite',
    'overseer_detach_church',
    'overseer_church_summary',
    'overseer_list_invites',
    'overseer_denomination_totals',
    'my_login_context',
  ];

  // Nine call sites across the two modules as the preflight measured them. A name that
  // disappears from the source makes the loop above vacuous, so the total is pinned too:
  // if this fails, the call moved somewhere the scan does not read, and the new home
  // needs the same rule rather than a bumped number.
  it('every call site of an identity-dependent RPC is on a session client', () => {
      let sitesFound = 0;
      for (const [file, source] of [
        ['lib/overseer-actions.ts', OVERSEER_ACTIONS],
        ['lib/super-admin-overseer-actions.ts', SUPER_ADMIN_ACTIONS],
      ] as const) {
        const sites = IDENTITY_DEPENDENT.flatMap((fnName) =>
          rpcCallSites(source, fnName).map((site) => ({ ...site, fnName })));
        sitesFound += sites.length;
        for (const site of sites) {
          assert.ok(
            !PRIVILEGED_RECEIVERS.has(site.receiver),
            `${file}:${site.line} calls ${site.fnName}() on \`${site.receiver}\`, which is the `
            + 'service-role connection. The definer body’s auth.uid() would be NULL, so the '
            + 'only remaining guard is the Next.js check that a direct REST call skips.',
          );
          assert.equal(
            site.receiver,
            'supabase',
            `${file}:${site.line} calls ${site.fnName}() on \`${site.receiver}\`; the convention here `
            + 'is that `supabase` is the session client returned by createClient()/requireSuperAdmin(). '
            + 'If this is an intentional rename, extend PRIVILEGED_RECEIVERS with the real alias.',
          );
        }
      }
      assert.equal(sitesFound, 9,
        `expected the 9 audited call sites, found ${sitesFound} — a moved or renamed call is `
        + 'not a passing test, it is an unchecked one');
  });

  it('the invite-minting action keeps its documented reason for using the session client', () => {
    // The comment is the specification for the line above it. If someone drops it, the
    // next reader has no reason not to "simplify" the call onto `admin`.
    assert.match(
      SUPER_ADMIN_ACTIONS,
      /session client[\s\S]{0,120}auth\.uid\(\)/,
      'the reason the RPC is issued on the caller’s client must stay next to the call site',
    );
    const call = SUPER_ADMIN_ACTIONS.match(
      /const \{[^}]*supabase[^}]*\} = await requireSuperAdmin\(\);[\s\S]{0,2000}?await supabase\.rpc\(\s*'create_denomination_overseer_invite'/,
    );
    assert.ok(call, 'create_denomination_overseer_invite must be reached through requireSuperAdmin()');
  });

  it('requireSuperAdmin() fails closed on the role it reads, not on the read itself', () => {
    assert.match(
      SUPER_ADMIN_ACTIONS,
      /profile\?\.role !== 'super_admin'[\s\S]{0,160}return \{ user: null, admin: null, supabase: null \}/,
      'a null profile or a read error must land in the same refusal as a wrong role',
    );
  });

  it('every mutating overseer action re-checks denomination membership before the RPC', () => {
    for (const fn of ['createOverseerInvite', 'revokeOverseerInvite', 'detachOverseerChurch']) {
      const body = OVERSEER_ACTIONS.slice(
        OVERSEER_ACTIONS.indexOf(`export async function ${fn}`),
      );
      const upto = body.slice(0, body.indexOf('\n}\n') > 0 ? body.indexOf('\nexport async function', 20) : body.length);
      assert.match(upto, /await supabase\.auth\.getUser\(\)/, `${fn} must resolve the caller`);
      assert.match(
        upto,
        /isAuthorizedOverseer\(supabase, user\.id\)/,
        `${fn} must check membership on the session client before the RPC`,
      );
      assert.match(
        upto,
        /return \{ error: 'Forbidden/,
        `${fn}'s refusal must be a return, not a throw that a caller can swallow`,
      );
    }
  });

  it('isAuthorizedOverseer() reads membership through the caller, so RLS is the enforcement', () => {
    // If this were moved to the admin client, "any row exists for that user" would be
    // answered by a connection that ignores RLS — a wider read than the caller has.
    const guard = OVERSEER_ACTIONS.slice(
      OVERSEER_ACTIONS.indexOf('async function isAuthorizedOverseer'),
      OVERSEER_ACTIONS.indexOf('*/', OVERSEER_ACTIONS.indexOf('async function isAuthorizedOverseer')),
    );
    assert.ok(guard.length > 0, 'the membership guard must exist in this module');
    assert.doesNotMatch(guard, /createAdminClient|createServiceClient/,
      'the guard must not be widened to a service-role read');
    assert.match(guard, /\.eq\('user_id', userId\)/,
      'the read must be pinned to the caller’s own id, not filtered afterwards in JS');
    // A swallowed error is the other way this guard can rot.
    assert.match(guard, /return !error && data\?\.user_id === userId/,
      'an RLS rejection must read as "not an overseer", which is the fail-closed direction');
  });
});
