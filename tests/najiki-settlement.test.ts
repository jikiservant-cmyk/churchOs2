import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentNotification } from '../lib/najiki/webhook.ts';
import { settleWalletPayment } from '../lib/najiki/settlement.ts';

const notification = parsePaymentNotification({
  paymentIntentId: 'pay_abc',
  reference: 'provider-ref-1',
  status: 'success',
  amount: 12_000,
  currency: 'UGX',
})!;
const transaction = {
  tenant_id: 'tenant-1',
  amount: 12_000,
  currency: 'UGX',
  reference_code: 'CHURCH-ref-1',
  reference: 'provider-ref-1',
};

function fakeDb(options: {
  wallet?: { id: string } | null;
  walletError?: { message: string } | null;
  rpcResult?: unknown;
  rpcError?: { message: string } | null;
} = {}) {
  const calls: Array<{ rpc: string; args?: Record<string, unknown> } | { table: string }> = [];
  const db = {
    from(table: string) {
      calls.push({ table });
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: options.wallet === undefined ? { id: 'wallet-1' } : options.wallet, error: options.walletError ?? null }),
      };
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ rpc: name, args });
      return { data: options.rpcResult ?? { result: 'credited' }, error: options.rpcError ?? null };
    },
  };
  return { db, calls };
}

describe('wallet webhook settlement', () => {
  test('credits only through the atomic procedure with the persisted ledger amount and tenant', async () => {
    const { db, calls } = fakeDb();
    const result = await settleWalletPayment({ db, notification, transaction, payload: { status: 'success' } });
    assert.deepEqual(result, { ok: true, settlement: 'credited' });
    assert.deepEqual(calls, [
      { table: 'wallets' },
      { rpc: 'process_topup_webhook', args: {
        p_reference: 'CHURCH-ref-1',
        p_tenant_id: 'tenant-1',
        p_amount: 12_000,
        p_payload: { status: 'success' },
      } },
    ]);
  });

  test('does not call the RPC when amount or currency is missing/mismatched', async () => {
    const { db, calls } = fakeDb();
    const missingAmount = await settleWalletPayment({
      db,
      notification: { ...notification, amount: null },
      transaction,
      payload: {},
    });
    assert.deepEqual(missingAmount, { ok: false, status: 422, error: 'Amount or currency mismatch' });
    const otherCurrency = await settleWalletPayment({
      db,
      notification: { ...notification, currency: 'KES' },
      transaction,
      payload: {},
    });
    assert.deepEqual(otherCurrency, { ok: false, status: 422, error: 'Amount or currency mismatch' });
    assert.equal(calls.length, 0);
  });

  test('fails retryably if the tenant wallet is unavailable', async () => {
    const { db, calls } = fakeDb({ wallet: null });
    const result = await settleWalletPayment({ db, notification, transaction, payload: {} });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });

  test('does not fall back to a separate balance increment after RPC failure', async () => {
    const { db, calls } = fakeDb({ rpcError: { message: 'temporary database error' } });
    const result = await settleWalletPayment({ db, notification, transaction, payload: {} });
    assert.deepEqual(result, { ok: false, status: 500, error: 'Payment settlement is temporarily unavailable' });
    assert.deepEqual(calls.map((call) => 'rpc' in call ? call.rpc : call.table), ['wallets', 'process_topup_webhook']);
  });

  test('only acknowledges duplicate success; missing or failed transactions do not receive receipts', async () => {
    const duplicate = fakeDb({ rpcResult: { result: 'duplicate', previous_status: 'success' } });
    assert.deepEqual(await settleWalletPayment({ db: duplicate.db, notification, transaction, payload: {} }), {
      ok: true,
      settlement: 'already_credited',
    });

    const failed = fakeDb({ rpcResult: { result: 'duplicate', previous_status: 'failed' } });
    assert.deepEqual(await settleWalletPayment({ db: failed.db, notification, transaction, payload: {} }), {
      ok: false,
      status: 409,
      error: 'Payment transaction is in a conflicting state',
    });

    const missing = fakeDb({ rpcResult: { result: 'not_found' } });
    const missingResult = await settleWalletPayment({ db: missing.db, notification, transaction, payload: {} });
    assert.equal(missingResult.ok, false);
    assert.equal(missingResult.status, 500);
  });
});
