import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_FEE_UGX,
  ACTIVATION_CURRENCY,
  confirmActivationPayment,
} from '../lib/activation/index.ts';

describe('Church Workspace Activation Flow Suite', () => {
  test('enforces constant one-time fee of UGX 17,000', () => {
    assert.equal(ACTIVATION_FEE_UGX, 17000);
    assert.equal(ACTIVATION_CURRENCY, 'UGX');
  });

  test('rejects confirmation when merchant reference is missing', async () => {
    const res = await confirmActivationPayment({
      merchantReference: '',
      paidAmount: 17000,
      currency: 'UGX',
      status: 'SUCCESS'
    });

    assert.equal(res.success, false);
    assert.match(res.error || '', /reference/i);
  });

  test('fails closed when payment record is not found', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const requestedPaths: string[] = [];

    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      requestedPaths.push(url.pathname);

      // Simulate an older database without the atomic RPC, then an empty ledger lookup.
      if (url.pathname.endsWith('/rpc/activate_church_workspace_v2')) {
        return new Response(JSON.stringify({ code: '42883', message: 'function does not exist' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/activation_payments')) {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-range': '0-0/0' },
        });
      }
      throw new Error(`Unexpected Supabase request: ${url.pathname}`);
    }) as typeof fetch;

    try {
      const res = await confirmActivationPayment({
        merchantReference: 'NON-EXISTENT-MERCHANT-REF',
        paidAmount: 17000,
        currency: 'UGX',
        status: 'SUCCESS'
      });

      assert.equal(res.success, false);
      assert.match(res.error || '', /not found/i);
      assert.equal(requestedPaths.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
      if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    }
  });
});
