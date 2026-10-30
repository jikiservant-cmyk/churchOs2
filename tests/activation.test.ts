import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_FEE_UGX,
  ACTIVATION_CURRENCY,
  ACTIVATION_FEE_IS_TEST_PRICING,
  ACTIVATION_PLAN_PRICES,
  ACTIVATION_PRICE_UGX,
  confirmActivationPayment,
  startActivationPayment,
} from '../lib/activation/index.ts';
import { resolveActivationFeeUgx } from '../lib/activation-fee.ts';

describe('Church Workspace Activation Flow Suite', () => {
  test('uses server-owned activation plan prices and UGX currency', () => {
    // Invariant, not a literal: the fee the module exposes must be the fee the
    // configured environment resolves to, and the single plan must carry it.
    // Pinning the literal here is what made a temporary test price a red CI run.
    const configured = resolveActivationFeeUgx(process.env.ACTIVATION_FEE_UGX);
    assert.equal(ACTIVATION_FEE_UGX, configured.amount);
    assert.deepEqual(ACTIVATION_PLAN_PRICES, { standard: ACTIVATION_FEE_UGX });
    assert.equal(ACTIVATION_PRICE_UGX, 17_000);
    assert.equal(ACTIVATION_FEE_IS_TEST_PRICING, configured.override);
    assert.equal(ACTIVATION_CURRENCY, 'UGX');
  });

  test('initiates through Na’jiki and settles with the downstream provider transaction ID', async () => {
    const originalFetch = globalThis.fetch;
    const envNames = [
      'NEXT_PUBLIC_SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'NAJIKI_API_URL',
      'NAJIKI_API_KEY',
      'NAJIKI_APPLICATION_CODE',
    ] as const;
    const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    const churchId = '11111111-1111-4111-8111-111111111111';
    const userId = '22222222-2222-4222-8222-222222222222';
    const tenantCode = 'grace-church';
    const providerPaymentId = 'livepay-internal-reference-456';
    let merchantReference = '';
    let initiatedLedgerBody: Record<string, unknown> | null = null;
    let storedProviderTransactionId: string | null = null;
    let rpcArguments: Record<string, unknown> | null = null;

    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      NAJIKI_API_URL: 'https://najiki.test',
      NAJIKI_API_KEY: 'test-najiki-api-key',
      NAJIKI_APPLICATION_CODE: 'church',
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = (init.method || 'GET').toUpperCase();
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;

      if (url.host === 'najiki.test' && url.pathname === '/api/payments' && method === 'POST') {
        assert.equal(body.applicationCode, 'church');
        assert.equal(body.paymentTypeCode, 'ACCOUNT_ACTIVATION');
        assert.equal(body.externalEntityId, churchId);
        assert.equal(body.amount, ACTIVATION_FEE_UGX);
        assert.equal(body.currency, 'UGX');
        assert.equal(body.phoneNumber, '256772123456');
        assert.equal(body.tenantCode, tenantCode);
        assert.equal(body.description, 'STANDARD plan activation for Grace Community Church');
        merchantReference = body.idempotencyKey;
        assert.match(merchantReference, /^ACT-/);
        assert.equal(body.metadata.merchantReference, merchantReference);
        assert.equal(body.metadata.type, 'church_activation');
        return Response.json({
          paymentId: 'najiki-intent-id',
          providerPaymentId,
          reference: 'CHURCH-ACT-123',
          status: 'processing',
        });
      }

      if (url.host === 'supabase.test' && url.pathname.startsWith('/auth/v1/admin/users/')) {
        return Response.json({ id: userId, email: 'synthetic@example.test' });
      }
      if (url.host === 'supabase.test' && url.pathname === '/rest/v1/churches' && method === 'GET') {
        return Response.json([{
          id: churchId,
          name: 'Grace Community Church',
          slug: tenantCode,
          activation_status: 'pending_payment',
        }]);
      }
      if (url.host === 'supabase.test' && url.pathname === '/rest/v1/tenants' && method === 'GET') {
        return Response.json([{ code: tenantCode }]);
      }
      if (url.host === 'supabase.test' && url.pathname === '/rest/v1/activation_payments' && method === 'POST') {
        initiatedLedgerBody = body;
        return Response.json({ id: '33333333-3333-4333-8333-333333333333', ...body }, { status: 201 });
      }
      if (url.host === 'supabase.test' && url.pathname === '/rest/v1/activation_payments' && method === 'PATCH') {
        storedProviderTransactionId = body.provider_transaction_id;
        return new Response(null, { status: 204 });
      }
      if (url.host === 'supabase.test' && url.pathname === '/rest/v1/rpc/activate_church_workspace_v2') {
        rpcArguments = body;
        return Response.json({
          success: true,
          church_id: churchId,
          already_processed: false,
          activated: true,
        });
      }

      throw new Error(`Unexpected mocked request: ${method} ${url.host}${url.pathname}`);
    }) as typeof fetch;

    try {
      const started = await startActivationPayment({
        churchId,
        userId,
        phoneNumber: '+256772123456',
        plan: 'standard',
      });
      assert.equal(started.success, true);
      assert.equal(started.providerTransactionId, providerPaymentId);
      const insertedLedger = initiatedLedgerBody as unknown as Record<string, unknown>;
      assert.equal(insertedLedger.church_id, churchId);
      assert.equal(insertedLedger.amount, ACTIVATION_FEE_UGX);
      assert.equal(insertedLedger.currency, 'UGX');
      assert.equal(insertedLedger.provider, 'najiki');
      assert.equal(insertedLedger.merchant_reference, merchantReference);
      assert.equal(insertedLedger.status, 'pending');
      assert.equal(storedProviderTransactionId, providerPaymentId);
      assert.notEqual(storedProviderTransactionId, 'najiki-intent-id');

      const settled = await confirmActivationPayment({
        merchantReference,
        providerTransactionId: providerPaymentId,
        paidAmount: ACTIVATION_FEE_UGX,
        currency: 'UGX',
        status: 'SUCCESS',
      });
      assert.deepEqual(settled, {
        success: true,
        churchId,
        alreadyProcessed: false,
        activated: true,
      });
      assert.deepEqual(rpcArguments, {
        p_merchant_reference: merchantReference,
        p_provider: 'najiki',
        p_provider_transaction_id: providerPaymentId,
        p_paid_amount: ACTIVATION_FEE_UGX,
        p_currency: 'UGX',
        p_provider_status: 'SUCCESS',
      });
    } finally {
      globalThis.fetch = originalFetch;
      for (const name of envNames) {
        const originalValue = originalEnv[name];
        if (originalValue === undefined) delete process.env[name];
        else process.env[name] = originalValue;
      }
    }
  });

  test('calls the atomic RPC for a failed payment and acknowledges it without activation', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const requests: Array<{ path: string; body: unknown }> = [];

    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ path: url.pathname, body });
      assert.equal(url.pathname, '/rest/v1/rpc/activate_church_workspace_v2');
      return Response.json({
        success: false,
        code: 'FAILED',
        error: 'Provider reported a non-success status',
      });
    }) as typeof fetch;

    try {
      const result = await confirmActivationPayment({
        merchantReference: 'ACT-failed-payment-test',
        paidAmount: ACTIVATION_FEE_UGX,
        currency: 'UGX',
        status: 'FAILED',
      });

      assert.equal(result.success, true);
      assert.equal(result.activated, false);
      assert.equal(result.alreadyProcessed, false);
      assert.deepEqual(requests, [{
        path: '/rest/v1/rpc/activate_church_workspace_v2',
        body: {
          p_merchant_reference: 'ACT-failed-payment-test',
          p_provider: 'najiki',
          p_provider_transaction_id: null,
          p_paid_amount: ACTIVATION_FEE_UGX,
          p_currency: 'UGX',
          p_provider_status: 'FAILED',
        },
      }]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
      if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    }
  });

  test('requires service-role credentials for settlement and never falls back to the anon key', async () => {
    const originalFetch = globalThis.fetch;
    const names = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
    const originalEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const requests: string[] = [];
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'synthetic-anon-key';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      requests.push(url.pathname);
      throw new Error('Settlement must not make a request without service-role credentials');
    }) as typeof fetch;

    try {
      const result = await confirmActivationPayment({
        merchantReference: 'ACT-service-role-required',
        providerTransactionId: 'provider-txn-1',
        paidAmount: ACTIVATION_FEE_UGX,
        currency: 'UGX',
        status: 'SUCCESS',
      });

      assert.equal(result.success, false);
      assert.equal(result.retryable, true);
      assert.match(result.error || '', /temporarily unavailable/i);
      assert.deepEqual(requests, []);
    } finally {
      globalThis.fetch = originalFetch;
      for (const name of names) {
        const value = originalEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('rejects confirmation when merchant reference is missing', async () => {
    const res = await confirmActivationPayment({
      merchantReference: '',
      paidAmount: ACTIVATION_FEE_UGX,
      currency: 'UGX',
      status: 'SUCCESS'
    });

    assert.equal(res.success, false);
    assert.match(res.error || '', /reference/i);
  });

  test('fails closed without a non-atomic fallback when the settlement RPC is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const requestedPaths: string[] = [];

    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      requestedPaths.push(url.pathname);

      // Simulate a missing atomic RPC. The handler must not run direct writes/reads as fallback.
      if (url.pathname.endsWith('/rpc/activate_church_workspace_v2')) {
        return new Response(JSON.stringify({ code: '42883', message: 'function does not exist' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected Supabase request: ${url.pathname}`);
    }) as typeof fetch;

    try {
      const res = await confirmActivationPayment({
        merchantReference: 'NON-EXISTENT-MERCHANT-REF',
        paidAmount: ACTIVATION_FEE_UGX,
        currency: 'UGX',
        status: 'SUCCESS'
      });

      assert.equal(res.success, false);
      assert.match(res.error || '', /atomic activation settlement/i);
      assert.deepEqual(requestedPaths, ['/rest/v1/rpc/activate_church_workspace_v2']);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
      if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    }
  });
});
