import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseWholeUgxAmount, SMS_TOPUP_MAX_UGX, SMS_TOPUP_MIN_UGX } from '../lib/money.ts';

describe('UGX amount validation', () => {
  test('shares the SMS top-up minimum and maximum between client and server', () => {
    assert.equal(SMS_TOPUP_MIN_UGX, 1_000);
    assert.equal(SMS_TOPUP_MAX_UGX, 2_000_000);
    assert.equal(parseWholeUgxAmount('1000', SMS_TOPUP_MIN_UGX, SMS_TOPUP_MAX_UGX), 1_000);
    assert.equal(parseWholeUgxAmount('999', SMS_TOPUP_MIN_UGX, SMS_TOPUP_MAX_UGX), null);
  });

  test('accepts only positive whole amounts inside the server-owned bounds', () => {
    assert.equal(parseWholeUgxAmount('1,000', 1_000, 2_000_000), null);
    assert.equal(parseWholeUgxAmount('1000', 1_000, 2_000_000), 1_000);
    assert.equal(parseWholeUgxAmount(10_000, 500, 10_000_000), 10_000);
  });

  test('rejects numeric prefixes, fractions, non-finite values, and out-of-range inputs', () => {
    for (const value of ['1000xyz', '1000.5', '1e3', '', '  ', '-1000', '0', 1_000.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(parseWholeUgxAmount(value, 1_000, 2_000_000), null, `rejected ${String(value)}`);
    }
    assert.equal(parseWholeUgxAmount('999', 1_000, 2_000_000), null);
    assert.equal(parseWholeUgxAmount('2000001', 1_000, 2_000_000), null);
  });

  test('rejects invalid configured bounds', () => {
    assert.throws(() => parseWholeUgxAmount(100, 10.5, 200), RangeError);
    assert.throws(() => parseWholeUgxAmount(100, 200, 100), RangeError);
  });
});
