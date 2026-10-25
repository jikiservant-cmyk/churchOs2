import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentNotification } from '../lib/najiki/webhook.ts';
import { settleWalletPayment } from '../lib/najiki/settlement.ts';

const notification = parsePaymentNotification({
  paymentIntentId: '11111111-2222-4333-8444-555555555555',
  reference: 'CHURCH-TOP-1234-ABCD',
  status: 'success',
  amount: 12_000,
  currency: 'UGX',
  providerPaymentId: 'provider-tx-123',
  paymentTypeCode: 'BUY_SMS',
})!;
const transaction = {
  tenant_id: 'tenant-1',
  amount: 12_000,
  currency: 'UGX',
  payment_intent_id: notification.paymentIntentId,
};

function fakeDb(options: {
  rpcResult?: unknown;
  rpcError?: { message: string } | null;
} = {}) {
  const calls: Array<{ rpc: string; args?: Record<string, unknown> } | { table: string }> = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ rpc: name, args });
      return { data: options.rpcResult ?? { success: true, already_processed: false }, error: options.rpcError ?? null };
    },
  };
  return { db, calls };
}

describe('wallet webhook settlement against the deployed process_topup_webhook contract', () => {
  test('calls the exact four-argument RPC with Na’jiki intent reference and persisted payment data', async () => {
    const { db, calls } = fakeDb();
    const result = await settleWalletPayment({ db, notification, transaction, payload: { status: 'success' } });
    assert.deepEqual(result, { ok: true, settlement: 'credited' });
    assert.deepEqual(calls, [
      { rpc: 'process_topup_webhook', args: {
        p_reference: 'CHURCH-TOP-1234-ABCD',
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

  test('requires successful BUY_SMS status and canonical provider transaction ID before calling the RPC', async () => {
    const { db, calls } = fakeDb();
    const missingProviderId = await settleWalletPayment({
      db,
      notification: { ...notification, providerPaymentId: null },
      transaction,
      payload: {},
    });
    assert.deepEqual(missingProviderId, {
      ok: false,
      status: 422,
      error: 'Provider payment ID is required for wallet settlement',
    });

    const nonSuccess = await settleWalletPayment({
      db,
      notification: { ...notification, status: 'processing' },
      transaction,
      payload: {},
    });
    assert.deepEqual(nonSuccess, {
      ok: false,
      status: 422,
      error: 'Only successful payments can settle the SMS wallet',
    });

    const wrongType = await settleWalletPayment({
      db,
      notification: { ...notification, paymentTypeCode: 'donation' },
      transaction,
      payload: {},
    });
    assert.deepEqual(wrongType, {
      ok: false,
      status: 422,
      error: 'Only BUY_SMS payments can settle the SMS wallet',
    });

    assert.equal(calls.length, 0);
  });

  test('does not call the RPC if the provider intent differs from the ledger link', async () => {
    const { db, calls } = fakeDb();
    const result = await settleWalletPayment({
      db,
      notification,
      transaction: { ...transaction, payment_intent_id: '99999999-2222-4333-8444-555555555555' },
      payload: {},
    });
    assert.deepEqual(result, {
      ok: false,
      status: 409,
      error: 'Payment intent does not match the pending wallet transaction',
    });
    assert.equal(calls.length, 0);
  });

  test('does not fall back to a separate balance increment after RPC failure', async () => {
    const { db, calls } = fakeDb({ rpcError: { message: 'temporary database error' } });
    const result = await settleWalletPayment({ db, notification, transaction, payload: {} });
    assert.deepEqual(result, { ok: false, status: 500, error: 'Payment settlement is temporarily unavailable' });
    assert.deepEqual(calls.map((call) => 'rpc' in call ? call.rpc : call.table), ['process_topup_webhook']);
  });

  test('maps the exact RPC success/already-processed result and fails closed on legacy or unknown shapes', async () => {
    const duplicate = fakeDb({ rpcResult: { success: true, already_processed: true } });
    assert.deepEqual(await settleWalletPayment({ db: duplicate.db, notification, transaction, payload: {} }), {
      ok: true,
      settlement: 'already_credited',
    });

    const unknownShape = fakeDb({ rpcResult: { result: 'credited' } });
    assert.deepEqual(await settleWalletPayment({ db: unknownShape.db, notification, transaction, payload: {} }), {
      ok: false,
      status: 500,
      error: 'Payment settlement result is unknown',
    });
  });
});
