import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildNotificationHeaders } from './fixtures/najiki/notification-signature.ts';

// Reuse Next's request stores so the real API handlers can be invoked directly
// while Supabase and Na'jiki remain deterministic HTTP mocks.
(globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;
const projectRequire = createRequire(new URL('../package.json', import.meta.url));
const { workAsyncStorage } = projectRequire('next/dist/server/app-render/work-async-storage.external');
const { workUnitAsyncStorage } = projectRequire('next/dist/server/app-render/work-unit-async-storage.external');


test('activation start API → signed Na\'jiki webhook → status API', async () => {
  const churchId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const ledgerId = '33333333-3333-4333-8333-333333333333';
  const tenantCode = 'grace-church';
  const paymentIntentId = 'najiki-intent-id-001';
  const providerPaymentId = 'mobile-money-provider-transaction-456';
  const apiKey = 'synthetic-najiki-api-key';
  const webhookSecret = 'synthetic-webhook-secret-for-tests';
  const accessToken = 'synthetic-user-access-token';
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let ledger: Record<string, any> | null = null;
  let churchStatus: 'pending_payment' | 'active' = 'pending_payment';
  let paidAt: string | null = null;
  let merchantReference = '';
  let providerRequest: Record<string, any> | null = null;
  let rpcCalls = 0;
  let rpcArguments: Record<string, unknown> | null = null;

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
  const requestStores = (callback: () => Promise<Response>) => workAsyncStorage.run(
    { route: '/synthetic-church-activation-test', forceStatic: false, dynamicShouldError: false },
    () => workUnitAsyncStorage.run(
      {
        type: 'request', phase: 'render', cookies: cookieStore,
        userspaceMutableCookies: cookieStore, mutableCookies: cookieStore,
      },
      callback,
    ),
  );

  Object.assign(process.env, {
    NODE_ENV: 'test',
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
      return json({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'pastor@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    }
    if (url.host === 'supabase.test' && url.pathname === '/auth/v1/admin/users/' + userId) {
      return json({ id: userId, email: 'pastor@example.test' });
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/admin_profiles') {
      return json([{ tenant_id: churchId, role: 'pastor' }]);
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/churches') {
      return json([{
        id: churchId,
        name: 'Grace Community Church',
        slug: tenantCode,
        activation_status: churchStatus,
        activation_paid_at: paidAt,
      }]);
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/tenants') {
      return url.searchParams.get('select') === 'id' ? json([{ id: churchId }]) : json([{ code: tenantCode }]);
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/activation_payments' && method === 'POST') {
      merchantReference = body.merchant_reference;
      ledger = { id: ledgerId, ...body, created_at: new Date().toISOString(), verified_at: null, failure_reason: null };
      return json([ledger], 201);
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/activation_payments' && method === 'PATCH') {
      assert.ok(ledger);
      Object.assign(ledger!, body);
      return new Response(null, { status: 204 });
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/activation_payments' && method === 'GET') {
      assert.ok(ledger);
      return json([ledger]);
    }
    if (url.host === 'najiki.test' && url.pathname === '/api/payments' && method === 'POST') {
      assert.equal(headers.get('authorization'), `Bearer ${apiKey}`);
      providerRequest = body;
      return json({ paymentId: paymentIntentId, providerPaymentId, reference: 'CHURCH-ACT-123', status: 'processing' });
    }
    if (url.host === 'najiki.test' && url.pathname === '/api/payments/CHURCH-ACT-123' && method === 'GET') {
      assert.equal(headers.get('authorization'), `Bearer ${apiKey}`);
      return json({
        id: paymentIntentId,
        reference: 'CHURCH-ACT-123',
        status: 'success',
        amount: 17_000,
        currency: 'UGX',
        externalEntityId: churchId,
        providerPaymentId,
      });
    }
    if (url.host === 'supabase.test' && url.pathname === '/rest/v1/rpc/activate_church_workspace_v2' && method === 'POST') {
      rpcCalls += 1;
      rpcArguments = body;
      if (!ledger || body.p_merchant_reference !== merchantReference) {
        return json({ success: false, code: 'PAYMENT_NOT_FOUND' });
      }
      if (ledger.status === 'paid') {
        return json({ success: true, already_processed: true, activated: churchStatus === 'active', church_id: churchId });
      }
      ledger.status = 'paid';
      ledger.provider_transaction_id = body.p_provider_transaction_id;
      ledger.verified_at = new Date().toISOString();
      churchStatus = 'active';
      paidAt = ledger.verified_at;
      return json({ success: true, already_processed: false, activated: true, church_id: churchId });
    }
    throw new Error(`Unexpected synthetic request: ${method} ${url.host}${url.pathname}${url.search}`);
  };

  try {
    const [{ NextRequest }, { POST: startActivation }, { POST: receiveWebhook }, { GET: getStatus }] = await Promise.all([
      import('next/server'),
      import('../app/api/church/activation/start/route.ts'),
      import('../app/api/najiki/webhook/route.ts'),
      import('../app/api/church/activation/status/route.ts'),
    ]);

    const startResponse = await requestStores(() => startActivation(new NextRequest(
      'https://church.test/api/church/activation/start',
      {
        method: 'POST',
        headers: { origin: 'https://church.test', 'content-type': 'application/json', cookie: `sb-supabase-auth-token=${cookieValue}`, 'x-real-ip': '192.0.2.10' },
        body: JSON.stringify({ churchId, phoneNumber: '+256772123456', plan: 'standard' }),
      },
    )));
    assert.equal(startResponse.status, 200, await startResponse.clone().text());
    const started = await startResponse.json();
    assert.equal(started.success, true);
    assert.equal(started.providerTransactionId, providerPaymentId);
    assert.match(started.merchantReference, /^ACT-/);
    assert.equal(merchantReference, started.merchantReference);
    const createdLedger = ledger as Record<string, any> | null;
    const sentProviderRequest = providerRequest as Record<string, any> | null;
    assert.ok(createdLedger, 'activation ledger row was inserted');
    assert.ok(sentProviderRequest, 'Na’jiki initiation request was sent');
    assert.equal(createdLedger.church_id, churchId);
    assert.equal(createdLedger.amount, 17_000);
    assert.equal(createdLedger.currency, 'UGX');
    assert.equal(createdLedger.status, 'pending');
    assert.equal(createdLedger.provider_transaction_id, providerPaymentId);
    assert.equal(sentProviderRequest.applicationCode, 'church');
    assert.equal(sentProviderRequest.tenantCode, tenantCode);
    assert.equal(sentProviderRequest.paymentTypeCode, 'ACCOUNT_ACTIVATION');
    assert.equal(sentProviderRequest.externalEntityId, churchId);
    assert.equal(sentProviderRequest.amount, 17_000);
    assert.equal(sentProviderRequest.currency, 'UGX');
    assert.equal(sentProviderRequest.phoneNumber, '256772123456');
    assert.equal(sentProviderRequest.description, 'STANDARD plan activation for Grace Community Church');
    assert.equal(sentProviderRequest.idempotencyKey, merchantReference);
    assert.deepEqual(sentProviderRequest.metadata, {
      churchId, tenantCode, merchantReference, plan: 'standard', type: 'church_activation',
    });

    const notification: Record<string, any> = {
      paymentIntentId,
      reference: 'CHURCH-ACT-123',
      status: 'success',
      amount: 17_000,
      currency: 'UGX',
      providerPaymentId,
      failureReason: null,
      externalEntityId: churchId,
      tenantId: churchId,
      tenantCode,
      paymentType: 'ACCOUNT_ACTIVATION',
      paymentTypeCode: 'ACCOUNT_ACTIVATION',
      metadata: { churchId, tenantCode, merchantReference, plan: 'standard', type: 'church_activation' },
    };
    const signedWebhook = () => {
      const raw = JSON.stringify(notification);
      return new Request('https://church.test/api/najiki/webhook', {
        method: 'POST', headers: buildNotificationHeaders(webhookSecret, raw), body: raw,
      });
    };

    const tampered = new Request('https://church.test/api/najiki/webhook', {
      method: 'POST',
      headers: buildNotificationHeaders(webhookSecret, JSON.stringify(notification)),
      body: JSON.stringify({ ...notification, amount: 1 }),
    });
    assert.equal((await receiveWebhook(tampered)).status, 403, 'invalid/tampered signature is rejected before settlement');
    assert.equal(rpcCalls, 0);

    const settled = await receiveWebhook(signedWebhook());
    assert.equal(settled.status, 200, await settled.clone().text());
    assert.deepEqual(await settled.json(), { received: true, type: 'church_activation' });
    assert.equal(rpcCalls, 1);
    assert.deepEqual(rpcArguments, {
      p_merchant_reference: merchantReference,
      p_provider: 'najiki',
      p_provider_transaction_id: providerPaymentId,
      p_paid_amount: 17_000,
      p_currency: 'UGX',
      p_provider_status: 'SUCCESS',
    });
    assert.equal((ledger as Record<string, any> | null)?.status, 'paid');
    assert.equal(churchStatus, 'active');

    // Omitted providerPaymentId is resolved against Na’jiki’s authenticated status API;
    // the API intent ID is never substituted for its canonical provider transaction ID.
    notification.providerPaymentId = null;
    const duplicate = await receiveWebhook(signedWebhook());
    assert.equal(duplicate.status, 200);
    assert.equal(rpcCalls, 2, 'reconciled duplicate notifications are delegated to the idempotent settlement RPC');
    assert.equal((rpcArguments as Record<string, unknown> | null)?.p_provider_transaction_id, providerPaymentId);
    assert.equal((ledger as Record<string, any> | null)?.status, 'paid');

    const statusResponse = await requestStores(() => getStatus(new NextRequest(
      'https://church.test/api/church/activation/status',
      { headers: { cookie: `sb-supabase-auth-token=${cookieValue}` } },
    )));
    assert.equal(statusResponse.status, 200, await statusResponse.clone().text());
    const finalStatus = await statusResponse.json();
    assert.equal(finalStatus.activationStatus, 'active');
    assert.equal(finalStatus.isActive, true);
    assert.equal(finalStatus.latestPayment.status, 'paid');
    assert.equal(finalStatus.latestPayment.provider, 'najiki');
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
