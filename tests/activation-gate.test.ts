import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activationPathFor,
  churchAdminPathFor,
  decideActivationGate,
  resolveActivationGate,
} from '../lib/activation-gate.ts';

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('Activation gate — one rule for "has this church paid?"', () => {
  test('settled statuses open the workspace', () => {
    for (const status of ['active', 'ACTIVE', '  active  ', 'activated', 'paid']) {
      const verdict = decideActivationGate({ activation_status: status, activation_paid_at: null });
      assert.equal(verdict.decision, 'allow', `${status} must not be gated`);
    }
  });

  test('suspended is its own state — the payment screen must not claim it can fix that', () => {
    const verdict = decideActivationGate({ activation_status: 'suspended', activation_paid_at: '2026-01-01T00:00:00Z' });
    assert.equal(verdict.decision, 'suspended');
    assert.equal(verdict.reason, 'status-suspended');
  });

  test('every explicit non-settled status bills, whatever it is spelled as', () => {
    for (const status of ['pending_payment', 'PENDING_PAYMENT ', 'awaiting_payment', 'unpaid', 'past_due', 'declined']) {
      const verdict = decideActivationGate({ activation_status: status, activation_paid_at: null });
      assert.equal(verdict.decision, 'pay', `${status} must require payment`);
    }
  });

  test('a blank status with a payment timestamp is honoured, under either policy', () => {
    for (const blank of [null, undefined, '', '   ']) {
      for (const nullPolicy of ['allow', 'pay'] as const) {
        const verdict = decideActivationGate(
          { activation_status: blank, activation_paid_at: '2026-02-02T00:00:00Z' },
          { nullPolicy },
        );
        assert.equal(verdict.decision, 'allow');
        assert.equal(verdict.reason, 'legacy-row-carries-paid-timestamp');
      }
    }
  });

  test('a blank status with no receipt is the policy switch, and defaults to grandfathered', () => {
    const row = { activation_status: null, activation_paid_at: null };
    assert.deepEqual(decideActivationGate(row, { nullPolicy: 'allow' }), {
      decision: 'allow',
      reason: 'status-missing-grandfathered',
    });
    assert.deepEqual(decideActivationGate(row, { nullPolicy: 'pay' }), {
      decision: 'pay',
      reason: 'status-missing',
    });
  });

  test('"no row" is never read as "paid" — that is what an RLS policy gap looks like', () => {
    for (const row of [null, undefined]) {
      const verdict = decideActivationGate(row);
      assert.equal(verdict.decision, 'pay');
      assert.equal(verdict.reason, 'church-row-unreadable');
    }
  });

  test('resolveActivationGate reads the policy from the environment, fail-safe', () => {
    const original = process.env.ACTIVATION_GATE_LEGACY_NULL;
    const row = { activation_status: '', activation_paid_at: null };
    try {
      process.env.ACTIVATION_GATE_LEGACY_NULL = 'pay';
      assert.equal(resolveActivationGate(row).decision, 'pay');
      process.env.ACTIVATION_GATE_LEGACY_NULL = ' PAY ';
      assert.equal(resolveActivationGate(row).decision, 'pay');

      // Anything else — including a typo — keeps the non-destructive default.
      for (const value of ['allow', 'strict', '', '1', 'PAYME']) {
        process.env.ACTIVATION_GATE_LEGACY_NULL = value;
        assert.equal(resolveActivationGate(row).decision, 'allow', `${JSON.stringify(value)} must not tighten the gate`);
      }
      delete process.env.ACTIVATION_GATE_LEGACY_NULL;
      assert.equal(resolveActivationGate(row).decision, 'allow');
    } finally {
      if (original === undefined) delete process.env.ACTIVATION_GATE_LEGACY_NULL;
      else process.env.ACTIVATION_GATE_LEGACY_NULL = original;
    }
  });

  test('destinations are the paths the next.config rewrites actually serve', () => {
    // /{slug}/admin/activation rewrites to /c/{slug}/admin/activation — a path
    // that does not match the rewrite would 404 the pastor on the one screen
    // they are required to see.
    assert.equal(activationPathFor('kasanga-hill'), '/kasanga-hill/admin/activation');
    assert.equal(churchAdminPathFor('kasanga-hill'), '/kasanga-hill/admin');

    // The slug-prefixed URLs only exist through these rewrites; if the
    // catch-all changed shape, every activation redirect would 404.
    const rewrites = source('../next.config.ts');
    assert.ok(rewrites.includes("destination: '/c/:church_slug'"), 'missing the /{slug} -> /c/{slug} rewrite');
    assert.ok(rewrites.includes("destination: '/c/:church_slug/:path*'"), 'missing the /{slug}/* -> /c/{slug}/* rewrite');
  });
});

describe('Activation gate — the disagreement that let unpaid churches through', () => {
  test('getChurchBySlug no longer invents "active" for a missing status', () => {
    const db = source('../lib/db.ts');
    assert.ok(!/activation_status:\s*\(data as any\)\.activation_status \|\| 'active'/.test(db),
      'lib/db.ts is coercing a NULL status to active again');
    assert.ok(db.includes("activation_status:"), 'lib/db.ts must still surface the column');
    assert.ok(db.includes(": null,"), 'a blank status must be passed through as null');
  });

  test('the gate is imported by every surface that routes on it', () => {
    const surfaces = [
      '../app/c/[church_slug]/admin/(authenticated)/layout.tsx',
      '../app/c/[church_slug]/admin/activation/page.tsx',
      '../lib/activation/index.ts',
      '../lib/auth-destination.ts',
    ];
    for (const surface of surfaces) {
      const text = source(surface);
      assert.match(text, /activation-gate/, `${surface} must use the shared gate`);
      assert.ok(/resolveActivationGate|decideActivationGate/.test(text), `${surface} never calls the gate`);
    }
  });

  test('no route compares the raw column any more', () => {
    const offenders: string[] = [];
    for (const [file, text] of [
      ['app/c/[church_slug]/admin/(authenticated)/layout.tsx', source('../app/c/[church_slug]/admin/(authenticated)/layout.tsx')],
      ['app/c/[church_slug]/admin/activation/page.tsx', source('../app/c/[church_slug]/admin/activation/page.tsx')],
    ]) {
      if (/activation_status\s*===\s*'/.test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'raw status comparisons drift apart; use the gate');
  });

  test('signing in sends an unpaid pastor to the payment screen, not to a dashboard that bounces', () => {
    const actions = source('../lib/auth-actions.ts');
    assert.match(actions, /activation-gate/, 'the login action routes around the gate');
    // Every church destination must come from the shared helper. A literal
    // `/${slug}/admin` return is what made a pastor re-trace login -> dashboard
    // -> activation by hand.
    const literalAdminRedirects = actions
      .split('\n')
      .filter((line) => line.includes('redirectTo: `/${') && line.includes('}/admin`'));
    assert.deepEqual(literalAdminRedirects, [], 'login still hardcodes the portal path');
    assert.equal((actions.match(/churchHomeHref\(/g) ?? []).length >= 4, true,
      'each church branch must resolve its destination through the gate');
  });

  test('the settlement path refuses to double-charge a church the gate already accepts', () => {
    assert.match(source('../lib/activation/index.ts'), /resolveActivationGate\(church\)\.decision === 'allow'/);
  });
});

describe('Login entry points — one destination, no parked pastors', () => {
  const entries = [
    ['/', '../app/page.tsx'],
    ['/login', '../app/login/page.tsx'],
    ['/{slug}/admin/login', '../app/c/[church_slug]/admin/login/page.tsx'],
  ] as const;

  test('every login screen resolves the destination through the shared helper', () => {
    for (const [, file] of entries) {
      assert.match(source(file), /resolveLoginDestination/, `${file} duplicates the routing decision`);
    }
  });

  test('a live session is never stranded by an ?error= query string', () => {
    for (const [name, file] of entries.slice(0, 2)) {
      const text = source(file);
      assert.ok(!text.includes('if (!loginError) {'), `${name} still skips routing when an error param is present`);
    }
  });

  test('the login screens read privileged tables with the service-role client', () => {
    for (const [, file] of entries) {
      assert.match(source(file), /createAdminClient/, `${file} reads admin_profiles under the caller's RLS`);
    }
  });

  test('the church login page never shows a form the middleware would have bounced', () => {
    // The proxy exempts /admin/login so that signing in stays possible; that is
    // also why this page used to render the form to a fully authenticated
    // pastor forever. It must redirect a resolved destination before rendering.
    const text = source('../app/c/[church_slug]/admin/login/page.tsx');
    assert.match(text, /if \(destination\.href\) redirect\(destination\.href\)/);
  });
});
