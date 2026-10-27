import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHURCH_ADMIN_ROLES,
  hasAllowedRole,
  isSameOriginRequest,
  isSameOriginRequestForHeaders,
  publicUrlFor,
} from '../lib/auth-security.ts';

describe('authentication boundary helpers', () => {
  it('allows only pastor/admin for church-administration operations', () => {
    assert.equal(hasAllowedRole('pastor', CHURCH_ADMIN_ROLES), true);
    assert.equal(hasAllowedRole('admin', CHURCH_ADMIN_ROLES), true);
    for (const role of ['staff', 'usher', 'member', 'overseer', null, undefined]) {
      assert.equal(hasAllowedRole(role, CHURCH_ADMIN_ROLES), false, `denies ${String(role)}`);
    }
  });

  it('requires an exact same-origin match for browser mutations', () => {
    assert.equal(isSameOriginRequest('https://church.example/api/sms/enqueue', 'https://church.example'), true);
    assert.equal(isSameOriginRequest('https://church.example:8443/api/action', 'https://church.example:8443'), true);
    assert.equal(isSameOriginRequest('https://church.example/api/action', null), false);
    assert.equal(isSameOriginRequest('https://church.example/api/action', 'null'), false);
    assert.equal(isSameOriginRequest('https://church.example/api/action', 'https://evil.example'), false);
    assert.equal(isSameOriginRequest('https://church.example/api/action', 'https://church.example.evil.example'), false);
    assert.equal(isSameOriginRequest('https://church.example/api/action', 'https://sub.church.example'), false);
    assert.equal(isSameOriginRequest('https://church.example/api/action', 'https://church.example/extra-path'), false);
    assert.equal(isSameOriginRequest('https://church.example/api/action', 'https://user@church.example'), false);
    assert.equal(isSameOriginRequest('https://church.example/api/action', 'not a URL'), false);
  });

  it('resolves the expected origin from headers, not the internal bind URL', () => {
    const withHost = (host: string, extra: Record<string, string> = {}) =>
      new Headers({ host, ...extra });

    // Regression: `next dev -H 0.0.0.0` makes request.url report
    // http://0.0.0.0:3000, so every real browser mutation was rejected.
    assert.equal(
      isSameOriginRequestForHeaders('https://church.example', withHost('church.example')),
      true,
    );
    assert.equal(
      isSameOriginRequestForHeaders('https://church.example', withHost('0.0.0.0:3000',
        { 'x-forwarded-host': 'church.example' })),
      true,
    );

    // A cross-site attacker can never forge Host, so these must fail.
    assert.equal(
      isSameOriginRequestForHeaders('https://evil.example', withHost('church.example')),
      false,
    );
    assert.equal(
      isSameOriginRequestForHeaders('null', withHost('church.example')),
      false,
    );
    assert.equal(
      isSameOriginRequestForHeaders(null, withHost('church.example')),
      false,
    );
    // Non-canonical origins (suffix, path, credentials, subdomain) stay rejected.
    for (const origin of [
      'https://church.example.evil.example',
      'https://sub.church.example',
      'https://church.example/extra',
      'https://user@church.example',
      'not a URL',
    ]) {
      assert.equal(isSameOriginRequestForHeaders(origin, withHost('church.example')), false,
        `rejects ${origin}`);
    }

    // A synthesized Request (tests, internal callers) may carry no Host header
    // at all; then the request URL is the only origin evidence available.
    assert.equal(
      isSameOriginRequestForHeaders('https://church.test', new Headers(), 'https://church.test/api/x'),
      true,
    );
    // With neither headers nor a URL, there is nothing to validate.
    assert.equal(isSameOriginRequestForHeaders('https://church.example', new Headers()), false);
  });
});

describe('redirect targets', () => {
  it('builds redirects from the public host, not the internal bind address', () => {
    const headers = new Headers({ host: '0.0.0.0:3000', 'x-forwarded-host': 'church.example', 'x-forwarded-proto': 'https' });
    assert.equal(
      publicUrlFor('/', headers, 'http://0.0.0.0:3000/api/auth/logout').toString(),
      'https://church.example/',
    );
    // Host header alone is enough when no proxy sets forwarded headers.
    assert.equal(
      publicUrlFor('/?error=x', new Headers({ host: 'church.example' }), 'http://0.0.0.0:3000/admin').toString(),
      'https://church.example/?error=x',
    );
    // No usable header at all falls back to the request URL.
    assert.equal(
      publicUrlFor('/', new Headers(), 'http://localhost:3000/').toString(),
      'http://localhost:3000/',
    );
  });
});
