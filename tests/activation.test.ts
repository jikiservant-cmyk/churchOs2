import { test, describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_FEE_UGX,
  ACTIVATION_CURRENCY,
  confirmActivationPayment,
} from '../lib/activation/index.ts';

// Point the admin client at a closed port: the RPC is unavailable AND the
// ledger lookup cannot connect, so confirmActivationPayment must report the
// record as not found (fail closed, never a free activation).
before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
});

describe('Church Workspace Activation Flow Suite', () => {
  it('enforces constant one-time fee of UGX 17,000', () => {
    assert.equal(ACTIVATION_FEE_UGX, 17000);
    assert.equal(ACTIVATION_CURRENCY, 'UGX');
  });

  it('rejects confirmation when merchant reference is missing', async () => {
    const res = await confirmActivationPayment({
      merchantReference: '',
      paidAmount: 17000,
      currency: 'UGX',
      status: 'SUCCESS'
    });

    assert.equal(res.success, false);
    assert.match(res.error || '', /reference/i);
  });

  it('fails closed when payment record is not found', async () => {
    const res = await confirmActivationPayment({
      merchantReference: 'NON-EXISTENT-MERCHANT-REF',
      paidAmount: 17000,
      currency: 'UGX',
      status: 'SUCCESS'
    });

    assert.equal(res.success, false);
    assert.match(res.error || '', /not found/i);
  });
});
