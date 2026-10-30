import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SMS_RATE,
  readWalletWithColumnFallback,
  walletDerivedBalanceUgx,
  walletSmsRate,
} from '../lib/wallet-read.ts';

const MISSING_COLUMN = { code: '42703', message: "column wallets.sms_rate does not exist" };
const PERMISSION = { code: '42501', message: 'permission denied for table wallets' };

type FakeRow = { balance?: number | string | null; sms_rate?: number | null; tenant_id?: string } | null;
type FakeError = { code: string; message: string } | null;

function fakeWalletDb(options: { fullError?: FakeError; reducedError?: FakeError; row?: FakeRow } = {}) {
  const {
    fullError = null,
    reducedError = null,
    row = { balance: 1400, tenant_id: 'tenant-1' },
  } = options;
  const projections: string[] = [];
  return {
    projections,
    run: async (columns: string) => {
      projections.push(columns);
      if (columns.includes('sms_rate')) {
        return { data: fullError ? null : row, error: fullError };
      }
      return { data: reducedError ? null : row, error: reducedError };
    },
  };
}

describe('drift-tolerant wallet read', () => {
  it('uses the full projection when the deployed table has sms_rate', async () => {
    const db = fakeWalletDb({ row: { balance: 2100, sms_rate: 70, tenant_id: 'tenant-1' } });
    const result = await readWalletWithColumnFallback(db.run);
    assert.deepEqual(db.projections, ['balance, sms_rate, tenant_id']);
    assert.equal(result.error, null);
    assert.equal(result.degraded, false);
    assert.equal(result.wallet?.balance, 2100);
  });

  it('still returns the balance when the deployed table has no sms_rate column', async () => {
    // This is the shape that rendered `0 SMS` on a funded wallet: one missing
    // optional column poisoned the whole projection, and callers read "no data".
    const db = fakeWalletDb({ fullError: MISSING_COLUMN });
    const result = await readWalletWithColumnFallback(db.run);
    assert.deepEqual(db.projections, ['balance, sms_rate, tenant_id', 'balance, tenant_id']);
    assert.equal(result.error, null);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.missingColumns, ['sms_rate']);
    assert.equal(walletDerivedBalanceUgx(result.wallet), 1400);
    assert.equal(walletSmsRate(result.wallet), DEFAULT_SMS_RATE);
  });

  it('propagates a non-column error without retrying', async () => {
    const db = fakeWalletDb({ fullError: PERMISSION });
    const result = await readWalletWithColumnFallback(db.run);
    assert.deepEqual(db.projections, ['balance, sms_rate, tenant_id']);
    assert.equal(result.wallet, null);
    assert.equal(result.error?.code, '42501');
  });

  it('reports an error instead of a zero when even balance is unreadable', async () => {
    const db = fakeWalletDb({ fullError: MISSING_COLUMN, reducedError: PERMISSION });
    const result = await readWalletWithColumnFallback(db.run);
    assert.deepEqual(db.projections, ['balance, sms_rate, tenant_id', 'balance, tenant_id']);
    assert.equal(result.wallet, null);
    assert.equal(result.error?.code, '42501');
    assert.equal(result.degraded, false);
  });

  it('distinguishes "no wallet row" from "cannot read"', async () => {
    const db = fakeWalletDb({ row: null });
    const result = await readWalletWithColumnFallback(db.run);
    assert.equal(result.wallet, null);
    assert.equal(result.error, null);
  });

  it('coerces bigint balances and never divides by a zero rate', () => {
    // PostgREST hands bigint back as a string; a 0/null sms_rate would otherwise
    // produce Infinity or NaN in "SMS remaining".
    assert.equal(walletDerivedBalanceUgx({ balance: '350000' }), 350000);
    assert.equal(walletDerivedBalanceUgx({ balance: null }), 0);
    assert.equal(walletDerivedBalanceUgx(undefined), 0);
    assert.equal(walletSmsRate({ sms_rate: 0 }), DEFAULT_SMS_RATE);
    assert.equal(walletSmsRate({ sms_rate: null }), DEFAULT_SMS_RATE);
    assert.equal(walletSmsRate({ sms_rate: 105 }), 105);
    assert.equal(Math.floor(walletDerivedBalanceUgx({ balance: '350000' }) / walletSmsRate({ sms_rate: 0 })), 5000);
  });
});
