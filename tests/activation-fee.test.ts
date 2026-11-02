import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTIVATION_FEE_MAX_UGX,
  ACTIVATION_FEE_MIN_UGX,
  ACTIVATION_STANDARD_FEE_UGX,
  resolveActivationFeeUgx,
} from '../lib/activation-fee.ts';

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const standard = () => ({
  amount: ACTIVATION_STANDARD_FEE_UGX,
  override: false,
  rejected: null,
});

describe('Activation fee — a test price must never become a broken or free activation', () => {
  test('unset means the standard price', () => {
    for (const value of [undefined, null, '', '   ', false]) {
      assert.deepEqual(resolveActivationFeeUgx(value), standard(), `${String(value)} must fall back`);
    }
  });

  test('a valid override is taken, and only flagged when it differs', () => {
    assert.deepEqual(resolveActivationFeeUgx('1000'), { amount: 1000, override: true, rejected: null });
    assert.deepEqual(resolveActivationFeeUgx(' 1000 '), { amount: 1000, override: true, rejected: null });
    assert.deepEqual(resolveActivationFeeUgx(1000), { amount: 1000, override: true, rejected: null });
    assert.deepEqual(resolveActivationFeeUgx('01000'), { amount: 1000, override: true, rejected: null });
    assert.deepEqual(resolveActivationFeeUgx(String(ACTIVATION_STANDARD_FEE_UGX)), {
      amount: ACTIVATION_STANDARD_FEE_UGX,
      override: false,
      rejected: null,
    });
  });

  test('anything that PostgREST or the settlement RPC could reject never becomes the fee', () => {
    // Whole UGX only: the webhook requires Number.isSafeInteger(amount) for a
    // success, and the RPC requires p_paid_amount = trunc(p_paid_amount).
    for (const value of ['17000.00', '1000.5', '1e3', '1_000', '1,000', '+500', '-500', 'UGX500', 'NaN', 'Infinity']) {
      const result = resolveActivationFeeUgx(value);
      assert.equal(result.amount, ACTIVATION_STANDARD_FEE_UGX, `${value} must never be charged`);
      assert.equal(result.override, false);
      assert.ok(result.rejected, `${value} must say why it was rejected`);
    }
  });

  test('zero and out-of-range values are refused, not truncated', () => {
    // A 0 fee would create a ledger row the RPC can never settle (amount > 0),
    // i.e. a pastor who pays nothing and activates nothing.
    assert.equal(resolveActivationFeeUgx('0').amount, ACTIVATION_STANDARD_FEE_UGX);
    assert.equal(resolveActivationFeeUgx('0').rejected, 'outside-allowed-range');
    assert.equal(resolveActivationFeeUgx(String(ACTIVATION_FEE_MIN_UGX - 1)).rejected, 'outside-allowed-range');
    assert.equal(resolveActivationFeeUgx(String(ACTIVATION_FEE_MAX_UGX + 1)).rejected, 'outside-allowed-range');
    // 20 digits is both unsafely large and out of range; either refusal is
    // correct, the point is that neither one becomes the charge.
    assert.ok(['not-safe-integer', 'outside-allowed-range'].includes(
      String(resolveActivationFeeUgx('99999999999999999999').rejected)));
    assert.equal(resolveActivationFeeUgx('99999999999999999999').amount, ACTIVATION_STANDARD_FEE_UGX);
    assert.equal(resolveActivationFeeUgx(String(ACTIVATION_FEE_MIN_UGX)).amount, ACTIVATION_FEE_MIN_UGX);
    assert.equal(resolveActivationFeeUgx(String(ACTIVATION_FEE_MAX_UGX)).amount, ACTIVATION_FEE_MAX_UGX);
  });

  test('the resolved fee is always a whole, safe, positive integer', () => {
    const probes = [
      undefined, '0', '1', '1000', '17000', '10000000', '1e10', '-1', {}, [], '  ', '9007199254740993',
      Number.MAX_SAFE_INTEGER, 'true', '0x10', '17 000',
    ];
    for (const probe of probes) {
      const { amount } = resolveActivationFeeUgx(probe);
      assert.ok(Number.isSafeInteger(amount) && amount > 0, `${String(probe)} produced ${amount}`);
      assert.equal(amount, Math.trunc(amount));
      assert.ok(amount >= ACTIVATION_FEE_MIN_UGX || amount === ACTIVATION_STANDARD_FEE_UGX);
    }
  });

  test('the standard price is the contracted one', () => {
    // This is the number a real parish is billed. Changing it is a pricing
    // decision, not a debugging convenience — that is what
    // ACTIVATION_FEE_UGX exists for.
    assert.equal(ACTIVATION_STANDARD_FEE_UGX, 17_000);
  });
});

describe('Activation fee — one value from the screen to the ledger', () => {
  test('the payment screen quotes the server-side fee instead of a copy of it', () => {
    const client = source('../components/activation/ActivationClient.tsx');
    assert.ok(!/17[\s_]*000/.test(client), 'ActivationClient still hardcodes a price; it can drift from the charge');
    assert.match(client, /activationFeeUgx/, 'ActivationClient must take the fee as a prop');
    assert.ok(!/process\.env/.test(client), 'a client component cannot read server env vars; pass the value down');
  });

  test('the server page supplies the fee, so the quote and the charge share a source', () => {
    const page = source('../app/c/[church_slug]/admin/activation/page.tsx');
    assert.match(page, /activationFeeUgx=\{ACTIVATION_FEE_UGX\}/);
    assert.match(page, /isTestPricing=\{ACTIVATION_FEE_IS_TEST_PRICING\}/);
    assert.match(page, /standardFeeUgx=\{ACTIVATION_PRICE_UGX\}/);
  });

  test('lib/activation reads the fee from the resolver and never re-declares it', () => {
    const lib = source('../lib/activation/index.ts');
    assert.match(lib, /resolveActivationFeeUgx\(process\.env\.ACTIVATION_FEE_UGX\)/);
    assert.ok(!/export const ACTIVATION_FEE_UGX = \d/.test(lib), 'the fee must not be hardcoded here again');
  });

  test('the amount the pastor is charged is the amount quoted to the provider', () => {
    const lib = source('../lib/activation/index.ts');
    const quoted = lib.match(/const chosenAmount = ([^;]+);/);
    assert.ok(quoted, 'the plan price must flow through one variable');
    assert.equal(quoted[1].trim(), 'ACTIVATION_PLAN_PRICES[selectedPlan]');
    assert.match(lib, /amount: chosenAmount,/, 'the provider request must use the same amount');
    // The instructions text quotes it too, so "Pay UGX X" cannot disagree.
    assert.match(lib, /Please approve the request of UGX \$\{chosenAmount\.toLocaleString\('en-US'\)\}/);
  });
});
