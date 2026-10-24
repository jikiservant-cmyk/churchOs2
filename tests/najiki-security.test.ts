import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWalletSettlementResult,
  validateWalletPaymentAmount,
  verifyNajikiWebhook,
} from '../lib/najiki/webhook.ts';
import { buildNotificationHeaders } from './fixtures/najiki/notification-signature.ts';

const secret = 'njk_whsec_security_test';
const rawBody = JSON.stringify({ paymentIntentId: 'pay_1', status: 'success', amount: 2_000 });
const timestamp = 1_700_000_000_000;

describe('Na\'jiki webhook security and settlement rules', () => {
  test('accepts the canonical signed timestamp and rejects normalized or duplicated signature data', () => {
    const headers = buildNotificationHeaders(secret, rawBody, timestamp);
    assert.equal(verifyNajikiWebhook({ rawBody, headers, secret, now: timestamp }).ok, true);
    assert.equal(verifyNajikiWebhook({
      rawBody,
      headers: { ...headers, 'X-Najiki-Timestamp': '1.7e12' },
      secret,
      now: timestamp,
    }).ok, false);
    assert.equal(verifyNajikiWebhook({
      rawBody,
      headers: { ...headers, 'X-Najiki-Signature': `${headers['X-Najiki-Signature']},v=${headers['X-Najiki-Signature'].split('v=')[1]}` },
      secret,
      now: timestamp,
    }).ok, false);
  });

  test('settlement only acknowledges credited transactions or duplicates already successful', () => {
    assert.equal(classifyWalletSettlementResult({ success: true, already_processed: false }), 'credited');
    assert.equal(classifyWalletSettlementResult({ success: true, already_processed: true }), 'already_credited');
    assert.equal(classifyWalletSettlementResult({ result: 'credited' }), 'retry');
    assert.equal(classifyWalletSettlementResult({ success: false }), 'retry');
    assert.equal(classifyWalletSettlementResult(null), 'retry');
  });

  test('requires exact positive whole-UGX amount and explicit matching currency', () => {
    const exact = { receivedAmount: 2_000, receivedCurrency: 'UGX', expectedAmount: '2000', expectedCurrency: 'UGX' };
    assert.deepEqual(validateWalletPaymentAmount(exact), { ok: true });
    assert.deepEqual(validateWalletPaymentAmount({ ...exact, receivedAmount: null }), { ok: false, reason: 'missing_amount' });
    assert.deepEqual(validateWalletPaymentAmount({ ...exact, receivedAmount: 1_999 }), { ok: false, reason: 'amount_mismatch' });
    assert.deepEqual(validateWalletPaymentAmount({ ...exact, receivedAmount: 2_001 }), { ok: false, reason: 'amount_mismatch' });
    assert.deepEqual(validateWalletPaymentAmount({ ...exact, receivedAmount: 2_000.5 }), { ok: false, reason: 'invalid_amount' });
    assert.deepEqual(validateWalletPaymentAmount({ ...exact, receivedCurrency: null }), { ok: false, reason: 'missing_currency' });
    assert.deepEqual(validateWalletPaymentAmount({ ...exact, receivedCurrency: 'KES' }), { ok: false, reason: 'currency_mismatch' });
  });
});
