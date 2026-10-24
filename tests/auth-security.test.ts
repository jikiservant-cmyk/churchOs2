import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHURCH_ADMIN_ROLES, hasAllowedRole, isSameOriginRequest } from '../lib/auth-security.ts';

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
});
