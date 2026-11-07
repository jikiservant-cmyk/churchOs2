import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('signup consent gate — no account without accepting the terms', () => {
  const page = source('../app/signup/page.tsx');
  const action = source('../lib/auth-actions.ts');

  test('the signup form renders a required accept_terms checkbox', () => {
    assert.match(page, /type="checkbox"/);
    assert.match(page, /name="accept_terms"/);
    assert.match(page, /required/);
  });

  test('the checkbox links the Terms and the Privacy Policy', () => {
    assert.match(page, /href="\/terms"/);
    assert.match(page, /href="\/privacy"/);
  });

  test('the label names the prohibited-content rule', () => {
    assert.match(page, /political/i);
    assert.match(page, /abusive/i);
  });

  test('the server action rejects a missing consent before touching auth', () => {
    assert.match(action, /formData\.get\('accept_terms'\) !== 'on'/);
    const consentGate = action.indexOf("formData.get('accept_terms') !== 'on'");
    const providerCall = action.indexOf('supabase.auth.signUp(');
    assert.ok(consentGate > -1, 'consent check must exist in signup action');
    assert.ok(providerCall > -1, 'signup provider call must exist');
    assert.ok(consentGate < providerCall, 'consent must be enforced before any auth provider call');
  });

  test('the consent error message tells the applicant what to do', () => {
    assert.match(action, /accept the Terms & Conditions and Privacy Policy/i);
  });
});

describe('legal pages exist and carry the messaging rules', () => {
  const terms = source('../app/terms/page.tsx');
  const privacy = source('../app/privacy/page.tsx');

  test('terms prohibit political messaging', () => {
    assert.match(terms, /Political messages/i);
  });

  test('terms prohibit abusive content', () => {
    assert.match(terms, /Abusive messages/i);
  });

  test('terms prohibit spam, illegal and obscene content', () => {
    assert.match(terms, /Spam and deception/i);
    assert.match(terms, /Illegal content/i);
    assert.match(terms, /Sexual or obscene content/i);
  });

  test('terms forbid messaging purchased or harvested phone lists', () => {
    assert.match(terms, /purchased or harvested phone lists/i);
  });

  test('privacy policy discloses month/day-only birthdays', () => {
    assert.match(privacy, /month and day/i);
    assert.match(privacy, /never the year/i);
  });

  test('privacy policy names the data flows (messaging provider, hosting)', () => {
    assert.match(privacy, /Africa\u2019s Talking/);
    assert.match(privacy, /Supabase/);
  });

  test('privacy policy commits to no selling of personal data', () => {
    assert.match(privacy, /do not sell personal data/i);
  });
});
