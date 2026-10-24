import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildNotificationHeaders } from './fixtures/najiki/notification-signature.ts';

// Next 16 uses globalThis.AsyncLocalStorage for its request stores. Node exposes
// the implementation from node:async_hooks, so install that implementation
// before importing Next's server-action and route modules in this isolated test.
(globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;
const projectRequire = createRequire(new URL('../package.json', import.meta.url));
const { workAsyncStorage } = projectRequire('next/dist/server/app-render/work-async-storage.external');
const { workUnitAsyncStorage } = projectRequire('next/dist/server/app-render/work-unit-async-storage.external');
// Direct route invocation is outside Next's cache revalidation context.
projectRequire('next/cache').revalidatePath = () => {};

test('SMS top-up action → signed webhook → exact process_topup_webhook contract', async () => {
  const churchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const walletId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const paymentIntentId = '11111111-2222-4333-8444-555555555555';
  const providerReference = 'CHURCH-BUY-1';
  const tenantCode = 'grace-church';
  const apiKey = 'synthetic-najiki-api-key';
  const webhookSecret = 'synthetic-webhook-secret-long-enough';
  const accessToken = 'synthetic-user-access-token';

  const session = {
    access_token: accessToken,
    refresh_token: 'synthetic-refresh-token',
    token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    user: { id: userId, email: 'pastor@example.test' },
  };
  const cookieValue = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const cookieStore = {
    getAll: () => [{ name: 'sb-supabase-auth-token', value: cookieValue }],
    get: () => undefined,
    set: () => {},
  };

  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  let ledger: Record<string, any> | null = null;
  let providerRequest: Record<string, any> | null = null;
  let creditedBalance = 0;
  let rpcCalls = 0;

  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role-key',
    NAJIKI_API_URL: 'https://najiki.test',
    NAJIKI_API_KEY: apiKey,
    NAJIKI_WEBHOOK_SECRET: webhookSecret,
    NAJIKI_APPLICATION_CODE: 'church',
  });

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = String(init?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers || (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;

    if (url.host === 'supabase.test' && url.pathname === '/auth/v1/user') {
      assert.equal(headers.get('authorization'), `Bearer ${accessToken}`);
      return json({
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'pastor@example.test',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      });
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/admin_profiles') {
      return json([{ tenant_id: churchId, role: 'pastor' }]);
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/tenants') {
      return url.searchParams.get('select') === 'id' ? json([{ id: churchId }]) : json([{ code: tenantCode }]);
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/churches') {
      return url.searchParams.get('select') === 'slug'
        ? json([{ slug: tenantCode }])
        : json([{ name: 'Grace Church', sender_id: null }]);
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/wallets') {
      return json([{ id: walletId }]);
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/wallet_transactions' && method === 'POST') {
      ledger = {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        ...body,
        reference: null,
        raw_provider_response: null,
      };
      return new Response(null, { status: 201 });
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/wallet_transactions' && method === 'PATCH') {
      assert.ok(ledger);
      Object.assign(ledger!, body);
      return new Response(null, { status: 204 });
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/wallet_transactions' && method === 'GET') {
      const reference = url.searchParams.get('reference_code')?.replace(/^eq\./, '');
      return json(ledger?.reference_code === reference ? [ledger] : []);
    }
    if (url.host === 'najiki.test' && url.pathname === '/api/payments' && method === 'POST') {
      assert.equal(headers.get('authorization'), `Bearer ${apiKey}`);
      providerRequest = body;
      return json({ paymentId: paymentIntentId, reference: providerReference, status: 'processing' });
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/rpc/process_topup_webhook' && method === 'POST') {
      rpcCalls += 1;
      assert.ok(ledger);
      assert.deepEqual(Object.keys(body).sort(), ['p_amount', 'p_payload', 'p_reference', 'p_tenant_id']);
      assert.equal(body.p_reference, providerReference);
      assert.equal(body.p_tenant_id, churchId);
      assert.equal(body.p_amount, 1_000);
      assert.equal(ledger!.payment_intent_id, paymentIntentId);

      if (ledger!.status === 'pending') {
        ledger!.status = 'success';
        ledger!.note = 'success';
        ledger!.type = 'sms_topup';
        ledger!.raw_provider_response = body.p_payload;
        creditedBalance += body.p_amount;
        return json({
          success: true,
          already_processed: false,
          reference: providerReference,
          payment_intent_id: paymentIntentId,
          tenant_id: churchId,
          wallet_id: walletId,
          new_balance: creditedBalance,
          currency: 'UGX',
        });
      }
      return json({
        success: true,
        already_processed: true,
        reference: providerReference,
        payment_intent_id: paymentIntentId,
        tenant_id: churchId,
        wallet_id: walletId,
        new_balance: creditedBalance,
        currency: 'UGX',
      });
    }

    throw new Error(`Unexpected external request: ${method} ${url.host}${url.pathname}${url.search}`);
  };

  try {
    const { initiateNajikiPayment } = await import('../lib/wallet-actions.ts');
    const { POST } = await import('../app/api/najiki/webhook/route.ts');

    const form = new FormData();
    form.set('churchId', churchId);
    form.set('amount', '1000');
    form.set('phoneNumber', '+256772123456');
    const initiated = await workAsyncStorage.run(
      { route: '/synthetic-sms-topup-test', forceStatic: false, dynamicShouldError: false },
      () => workUnitAsyncStorage.run(
        {
          type: 'request',
          phase: 'action',
          cookies: cookieStore,
          userspaceMutableCookies: cookieStore,
          mutableCookies: cookieStore,
        },
        () => initiateNajikiPayment(form),
      ),
    );

    assert.equal(initiated.success, true, JSON.stringify(initiated));
    const createdLedger = ledger as Record<string, any> | null;
    const sentPayment = providerRequest as Record<string, any> | null;
    assert.ok(createdLedger, 'mock ledger row was created');
    assert.ok(sentPayment, 'mock Na’jiki request was received');
    assert.equal(createdLedger.status, 'pending');
    assert.equal(createdLedger.type, 'sms_topup');
    assert.equal(createdLedger.payment_intent_id, paymentIntentId);
    assert.equal(sentPayment.paymentTypeCode, 'BUY_SMS');
    assert.equal(sentPayment.metadata.product, 'sms_topup');

    const payload = {
      paymentIntentId,
      reference: providerReference,
      status: 'success',
      amount: 1_000,
      currency: 'UGX',
      providerPaymentId: 'synthetic-provider-transaction',
      failureReason: null,
      externalEntityId: churchId,
      tenantId: churchId,
      tenantCode,
      paymentType: 'BUY_SMS',
      paymentTypeCode: 'BUY_SMS',
      metadata: {
        ...sentPayment.metadata,
        requestedTenantCode: tenantCode,
        credentialSource: 'platform-fee',
      },
    };
    const signedRequest = () => {
      const body = JSON.stringify(payload);
      return new Request('https://church.test/api/najiki/webhook', {
        method: 'POST',
        headers: buildNotificationHeaders(webhookSecret, body),
        body,
      });
    };

    const first = await POST(signedRequest());
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(await first.json(), { received: true, settlement: 'credited' });
    assert.equal(creditedBalance, 1_000);
    assert.equal(rpcCalls, 1);

    const duplicate = await POST(signedRequest());
    assert.equal(duplicate.status, 200, await duplicate.clone().text());
    assert.deepEqual(await duplicate.json(), { received: true, settlement: 'already_credited' });
    assert.equal(creditedBalance, 1_000);
    assert.equal(rpcCalls, 2);
  } finally {
    globalThis.fetch = oldFetch;
    process.env = oldEnv;
  }
});
