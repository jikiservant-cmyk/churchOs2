import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignupCredentials } from '../lib/signup-security.ts';

describe('signup credential validation', () => {
  it('normalizes email before signup', () => {
    assert.deepEqual(validateSignupCredentials('  Person@Example.COM  ', 'safe-password-123'), {
      ok: true,
      email: 'person@example.com',
      password: 'safe-password-123',
    });
  });

  it('rejects malformed or oversized emails and non-string form values', () => {
    assert.deepEqual(validateSignupCredentials('not-an-email', 'safe-password-123'), { ok: false, reason: 'email' });
    assert.deepEqual(validateSignupCredentials(`${'a'.repeat(250)}@x.io`, 'safe-password-123'), { ok: false, reason: 'email' });
    assert.deepEqual(validateSignupCredentials(new File([], 'email.txt'), 'safe-password-123'), { ok: false, reason: 'email' });
    assert.deepEqual(validateSignupCredentials('person@example.com', new File([], 'password.txt')), { ok: false, reason: 'password' });
  });

  it('bounds password length and encoded byte size', () => {
    assert.deepEqual(validateSignupCredentials('person@example.com', 'short'), { ok: false, reason: 'password' });
    assert.deepEqual(validateSignupCredentials('person@example.com', 'x'.repeat(73)), { ok: false, reason: 'password' });
    assert.deepEqual(validateSignupCredentials('person@example.com', '😀'.repeat(19)), { ok: false, reason: 'password' });
  });
});
