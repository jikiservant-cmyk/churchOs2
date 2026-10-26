/**
 * tests/najiki-contract.test.ts
 *
 * End-to-end contract tests for the church app → Na'jiki Finance integration.
 *
 * These are not unit tests of our own code in isolation: the church app's real
 * HTTP client (lib/najiki/client.ts) and its real payload builders are driven
 * over TCP against a mock that enforces Na'jiki's *own* validation schema
 * (vendored from najiki-finance2 in tests/fixtures/najiki). A payload either
 * passes Na'jiki's validator or is rejected with Na'jiki's error body — which is
 * exactly the "accepted without modification on Na'jiki's side" requirement.
 *
 * Run with:  npm test
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildChurchDonationPayment,
  buildChurchTopupPayment,
  createNajikiPayment,
  getNajikiConfig,
  getNajikiPayment,
  isNajikiConfigured,
  najikiApplicationCode,
  najikiPaymentTypeCode,
  NAJIKI_PLATFORM_PAYMENT_TYPE_CODES,
  NajikiApiError,
  NajikiConfigError,
  NAJIKI_DEFAULT_APPLICATION_CODE,
  NAJIKI_DEFAULT_BASE_URL,
} from '../lib/najiki/client.ts'
import {
  classifyNajikiWebhook,
  activationMerchantReference,
  activationProviderTransactionId,
  notificationChurchId,
  notificationTenantCode,
  parsePaymentNotification,
  parseSmsDeliveryNotification,
  buildSmsDeliveryLogPatch,
  planPaymentReceiptSms,
  transactionLookupCandidates,
  verifyNajikiWebhook,
  classifyWalletSettlementResult,
  validateWalletPaymentAmount,
} from '../lib/najiki/webhook.ts'
import { MockNajikiServer } from './helpers/mock-najiki-server.ts'
import {
  buildNotificationHeaders,
  verifyNotificationSignature,
} from './fixtures/najiki/notification-signature.ts'
import { toMinorUnits } from './fixtures/najiki/money.ts'
import { PLATFORM_FEE_TYPES } from './fixtures/najiki/constants.ts'

const CHURCH_ID = '11111111-2222-3333-4444-555555555555'
const TENANT_CODE = 'grace-church' // seeded in najiki-finance2 scripts/seed.ts
const PHONE_E164 = '+256772123456'
const PHONE_NAJIKI = '256772123456' // LivePay adapter strips the '+'

let server: MockNajikiServer
const originalEnv = { ...process.env }

before(async () => {
  server = new MockNajikiServer()
  const url = await server.start()

  process.env.NAJIKI_API_URL = url
  process.env.NAJIKI_API_KEY = server.apiKey
  process.env.NAJIKI_APPLICATION_CODE = 'church'
  process.env.NAJIKI_WEBHOOK_SECRET = server.webhookSecret
  delete process.env.NAJIKI_PAYMENT_TYPE_TOPUP
  delete process.env.NAJIKI_PAYMENT_TYPE_DONATION
  delete process.env.NAJIKI_PAYMENT_TYPE_ACTIVATION
  delete process.env.NAJIKI_TENANT_CODE
})

after(async () => {
  await server.stop()
  process.env = { ...originalEnv }
})

// Keep env-mutating contract tests serialized: they share process.env and one mock gateway.
describe('Na’jiki partner contract', { concurrency: false }, () => {
// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('configuration', () => {
  test('defaults to the deployed Na\u2019jiki origin and the seeded church application code', () => {
    assert.equal(NAJIKI_DEFAULT_BASE_URL, 'https://najiki.netlify.app')
    // scripts/seed.ts in najiki-finance2: { code: 'church', name: 'Church App' }
    assert.equal(NAJIKI_DEFAULT_APPLICATION_CODE, 'church')
  })

  test('strips trailing slashes so the URL is never doubled', () => {
    process.env.NAJIKI_API_URL = 'https://najiki.example.com///'
    assert.equal(getNajikiConfig().baseUrl, 'https://najiki.example.com')
    process.env.NAJIKI_API_URL = server.url
  })

  test('names every missing variable instead of failing opaquely', () => {
    delete process.env.NAJIKI_API_KEY
    assert.equal(isNajikiConfigured(), false)
    assert.throws(() => getNajikiConfig(), (err: unknown) => {
      assert.ok(err instanceof NajikiConfigError)
      assert.deepEqual(err.missing, ['NAJIKI_API_KEY'])
      assert.match(err.message, /NAJIKI_API_KEY/)
      return true
    })
    process.env.NAJIKI_API_KEY = server.apiKey
    assert.equal(isNajikiConfigured(), true)
  })

  test('application code is read from the environment, not hardcoded', () => {
    assert.equal(najikiApplicationCode(), 'church')
    process.env.NAJIKI_APPLICATION_CODE = 'church-ug'
    assert.equal(najikiApplicationCode(), 'church-ug')
    process.env.NAJIKI_APPLICATION_CODE = 'church'
  })

  test('defaults platform-fee products to Na’jiki routing codes and validates overrides', () => {
    assert.deepEqual([...PLATFORM_FEE_TYPES], [...NAJIKI_PLATFORM_PAYMENT_TYPE_CODES])
    assert.equal(najikiPaymentTypeCode('topup'), 'BUY_SMS')
    assert.equal(najikiPaymentTypeCode('activation'), 'ACCOUNT_ACTIVATION')
    assert.equal(najikiPaymentTypeCode('donation'), 'donation')

    process.env.NAJIKI_PAYMENT_TYPE_TOPUP = 'topup'
    assert.equal(najikiPaymentTypeCode('topup'), 'BUY_SMS')
    delete process.env.NAJIKI_PAYMENT_TYPE_TOPUP

    process.env.NAJIKI_PAYMENT_TYPE_ACTIVATION = 'church_activation'
    assert.equal(najikiPaymentTypeCode('activation'), 'ACCOUNT_ACTIVATION')
    delete process.env.NAJIKI_PAYMENT_TYPE_ACTIVATION

    process.env.NAJIKI_PAYMENT_TYPE_TOPUP = 'tenant_topup'
    assert.throws(() => najikiPaymentTypeCode('topup'), /must be a Na'jiki platform-fee payment type/)
    delete process.env.NAJIKI_PAYMENT_TYPE_TOPUP

    process.env.NAJIKI_PAYMENT_TYPE_DONATION = 'BUY_SMS'
    assert.throws(() => najikiPaymentTypeCode('donation'), /must be a tenant collection type/)
    delete process.env.NAJIKI_PAYMENT_TYPE_DONATION
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Payments — POST /api/payments
// ─────────────────────────────────────────────────────────────────────────────

describe('payments: POST /api/payments', () => {
  test('a church top-up payload is accepted unmodified', async () => {
    server.reset()

    const request = buildChurchTopupPayment({
      churchId: CHURCH_ID,
      tenantCode: TENANT_CODE,
      churchSlug: 'grace-community',
      reference: 'CHURCH-9f8e7d6c-5b4a',
      idempotencyKey: 'ik_church_9f8e7d6c',
      amount: 20_000,
      phoneNumber: PHONE_NAJIKI,
    })

    const result = await createNajikiPayment(request)

    assert.equal(result.status, 'processing')
    assert.match(result.paymentId, /^c[a-f0-9]{24}$/)
    assert.match(result.reference, /^CHURCH-BUY-/)

    // The intent Na'jiki stored, field by field, against its schema.
    const stored = server.payments.at(-1)!
    assert.equal(stored.body.applicationCode, 'church')
    assert.equal(stored.body.paymentTypeCode, 'BUY_SMS')
    assert.equal('providerCode' in stored.body, false)
    assert.equal(stored.body.externalEntityId, CHURCH_ID)
    assert.equal(stored.body.tenantCode, TENANT_CODE)
    assert.equal(stored.body.currency, 'UGX')
    assert.equal(stored.body.phoneNumber, PHONE_NAJIKI)
    assert.equal(stored.body.idempotencyKey, 'ik_church_9f8e7d6c')
    assert.equal(server.requests.at(-1)!.headers['idempotency-key'], undefined)
    assert.equal(stored.amount, 20_000)
    assert.equal(stored.body.metadata?.churchReference, 'CHURCH-9f8e7d6c-5b4a')
    assert.equal(stored.body.metadata?.churchId, CHURCH_ID)
  })

  test('amount is sent in major units — UGX 5000 stays 5000, not 500000', async () => {
    server.reset()
    // Na'jiki stores PaymentIntent.amount as Decimal(14,2) MAJOR units and only
    // converts to minor units internally (money.ts). UGX has exponent 0, so
    // there is no x100 anywhere on this path.
    assert.equal(toMinorUnits(5000, "UGX"), BigInt(5000))

    await createNajikiPayment(
      buildChurchTopupPayment({
        churchId: CHURCH_ID,
        tenantCode: TENANT_CODE,
        reference: 'CHURCH-amount-check',
        idempotencyKey: 'ik_church_amount_check',
        amount: 5000,
        phoneNumber: PHONE_NAJIKI,
      })
    )

    assert.equal(server.payments.at(-1)!.amount, 5000)
  })

  test('phone numbers are digits-only E.164 (the form LivePay normalises to)', async () => {
    server.reset()
    await createNajikiPayment(
      buildChurchTopupPayment({
        churchId: CHURCH_ID,
        tenantCode: TENANT_CODE,
        reference: 'CHURCH-phone-check',
        idempotencyKey: 'ik_church_phone_check',
        amount: 5000,
        phoneNumber: PHONE_NAJIKI,
      })
    )
    // Na'jiki's own boundary is z.string().min(9).max(15); LivePay strips any '+'.
    assert.match(server.payments.at(-1)!.phoneNumber, /^256\d{9}$/)
  })

  test('a donation payload carries the donor phone and our own reference', async () => {
    server.reset()
    const request = buildChurchDonationPayment({
      churchId: CHURCH_ID,
      tenantCode: TENANT_CODE,
      churchName: 'Grace Community Church',
      reference: 'DON-abc123',
      idempotencyKey: 'ik_don_abc123',
      amount: 50_000,
      phoneNumber: PHONE_NAJIKI,
      category: 'tithe',
    })

    await createNajikiPayment(request)

    const stored = server.payments.at(-1)!
    assert.equal(stored.body.paymentTypeCode, 'donation')
    assert.equal(stored.body.metadata?.donorPhone, PHONE_NAJIKI)
    assert.equal(stored.body.metadata?.churchReference, 'DON-abc123')
    assert.equal(stored.body.metadata?.category, 'tithe')
    assert.ok(server.paymentTypes.some((type) => type.applicationId === 'app_church' && type.code === 'donation'))
  })

  test('activation uses a platform-fee code and carries its ledger reference in metadata', async () => {
    server.reset()
    const merchantReference = 'ACT-contract-test-0001'
    await createNajikiPayment({
      applicationCode: 'church',
      tenantCode: TENANT_CODE,
      paymentTypeCode: najikiPaymentTypeCode('activation'),
      externalEntityId: CHURCH_ID,
      amount: 17_000,
      currency: 'UGX',
      phoneNumber: PHONE_NAJIKI,
      idempotencyKey: merchantReference,
      metadata: { type: 'church_activation', merchantReference, tenantCode: TENANT_CODE },
    })

    const payment = server.payments.at(-1)!
    assert.equal(payment.body.paymentTypeCode, 'ACCOUNT_ACTIVATION')
    assert.equal(payment.body.metadata?.type, 'church_activation')
    assert.equal(payment.body.metadata?.merchantReference, merchantReference)
    assert.ok(server.paymentTypes.some((type) => type.code === 'ACCOUNT_ACTIVATION'))
  })

  test('the idempotency key makes a retry return the same intent', async () => {
    server.reset()
    const request = buildChurchTopupPayment({
      churchId: CHURCH_ID,
      tenantCode: TENANT_CODE,
      reference: 'CHURCH-idem',
      idempotencyKey: 'ik_church_idem',
      amount: 10_000,
      phoneNumber: PHONE_NAJIKI,
    })

    const first = await createNajikiPayment(request)
    const second = await createNajikiPayment(request)

    assert.equal(second.paymentId, first.paymentId)
    assert.equal(second.reference, first.reference)
    assert.equal(server.payments.length, 1)
  })

  test('reports Na\u2019jiki\u2019s validation error with its field-level details', async () => {
    // Simulate a regression: a payload that drops idempotencyKey.
    const broken = {
      ...buildChurchTopupPayment({
        churchId: CHURCH_ID,
        tenantCode: TENANT_CODE,
        reference: 'CHURCH-broken',
        idempotencyKey: 'ik_church_broken',
        amount: 10_000,
        phoneNumber: PHONE_NAJIKI,
      }),
    } as Record<string, unknown>
    delete broken.idempotencyKey

    await assert.rejects(
      () => createNajikiPayment(broken as never),
      (err: unknown) => {
        assert.ok(err instanceof NajikiApiError)
        assert.equal(err.status, 400)
        assert.equal(err.error, 'Validation failed')
        assert.ok(err.details.length > 0, 'details must be surfaced')
        assert.ok(
          err.details.some((d) => d.includes('idempotencyKey')),
          `expected idempotencyKey in details, got ${JSON.stringify(err.details)}`
        )
        return true
      }
    )
  })

  test('is rejected when the application code does not match the API key', async () => {
    const body = buildChurchTopupPayment({
      churchId: CHURCH_ID,
      tenantCode: TENANT_CODE,
      reference: 'CHURCH-appcode',
      idempotencyKey: 'ik_church_appcode',
      amount: 10_000,
      phoneNumber: PHONE_NAJIKI,
    })
    const response = await fetch(`${server.url}/api/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, applicationCode: 'CHURCH' }),
    })
    assert.equal(response.status, 401)
    assert.match((await response.json() as { error: string }).error, /Invalid or inactive application/)
  })

  test('is rejected when authenticated with x-api-key instead of Bearer', async () => {
    // The old donation fallback sent `x-api-key: <key>`; Na'jiki's
    // POST /api/payments only reads `Authorization: Bearer`.
    const response = await fetch(`${server.url}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': server.apiKey },
      body: JSON.stringify({
        applicationCode: 'church',
        paymentTypeCode: 'donation',
        externalEntityId: CHURCH_ID,
        amount: 1000,
        currency: 'UGX',
        phoneNumber: PHONE_NAJIKI,
        idempotencyKey: 'ik_x_api_key_probe',
      }),
    })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), {
      error: 'Missing or invalid authorization header',
    })
  })

  test('is rejected when the tenant is not registered in Na\u2019jiki', async () => {
    await assert.rejects(
      () =>
        createNajikiPayment(
          buildChurchTopupPayment({
            churchId: CHURCH_ID,
            tenantCode: 'not-a-tenant',
            reference: 'CHURCH-tenant',
            idempotencyKey: 'ik_church_tenant',
            amount: 10_000,
            phoneNumber: PHONE_NAJIKI,
          })
        ),
      (err: unknown) => {
        assert.ok(err instanceof NajikiApiError)
        assert.equal(err.status, 404)
        assert.equal(err.error, 'Invalid or inactive tenant')
        return true
      }
    )
  })

  test('payment status can be read back', async () => {
    server.reset()
    const created = await createNajikiPayment(
      buildChurchTopupPayment({
        churchId: CHURCH_ID,
        tenantCode: TENANT_CODE,
        reference: 'CHURCH-status',
        idempotencyKey: 'ik_church_status',
        amount: 10_000,
        phoneNumber: PHONE_NAJIKI,
      })
    )

    const status = await getNajikiPayment(created.reference)
    assert.equal(status.reference, created.reference)
    assert.equal(status.status, 'processing')
    assert.equal(status.amount, 10_000)
    assert.equal(status.currency, 'UGX')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Inbound webhooks — Na'jiki → church app
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly what najiki-finance2's enqueueWebhookNotification() serialises. */
function buildNajikiPaymentNotification(input: {
  paymentIntentId: string
  reference: string
  status: string
  amount: number
  metadata: Record<string, unknown>
}) {
  return JSON.stringify({
    paymentIntentId: input.paymentIntentId,
    reference: input.reference,
    status: input.status,
    amount: input.amount,
    currency: 'UGX',
    providerPaymentId: 'prov_123',
    failureReason: null,
    externalEntityId: CHURCH_ID,
    tenantId: 'tenant_grace',
    tenantCode: TENANT_CODE,
    paymentType: 'BUY_SMS',
    paymentTypeCode: 'BUY_SMS',
    metadata: input.metadata,
  })
}

describe('inbound webhook verification', () => {
  const secret = 'njk_whsec_test_church_secret_0001'
  const body = buildNajikiPaymentNotification({
    paymentIntentId: 'pay_abc',
    reference: 'CHURCH-TOP-1234-ABCD',
    status: 'success',
    amount: 20_000,
    metadata: { churchId: CHURCH_ID, churchReference: 'CHURCH-9f8e7d6c-5b4a' },
  })

  test('accepts a notification signed by Na\u2019jiki\u2019s own signer', () => {
    const headers = buildNotificationHeaders(secret, body, 1_700_000_000_000)
    const result = verifyNajikiWebhook({
      rawBody: body,
      headers,
      secret,
      now: 1_700_000_000_000,
    })
    assert.equal(result.ok, true, result.reason)
    // Cross-check against Na'jiki's own verifier.
    assert.equal(
      verifyNotificationSignature({
        secret,
        payloadString: body,
        timestamp: headers['X-Najiki-Timestamp'],
        signature: headers['X-Najiki-Signature'],
        now: 1_700_000_000_000,
      }),
      true
    )
  })

  test('requires Na’jiki’s notification marker and timestamp inside the signature', () => {
    const headers = buildNotificationHeaders(secret, body, 1_700_000_000_000)
    const withoutMarker = { ...headers }
    delete withoutMarker['X-Najiki-Notification']
    assert.match(
      verifyNajikiWebhook({ rawBody: body, headers: withoutMarker, secret, now: 1_700_000_000_000 }).reason!,
      /x-najiki-notification/i
    )

    const withoutSignedTimestamp = {
      ...headers,
      'X-Najiki-Signature': `v=${headers['X-Najiki-Signature'].split('v=')[1]}`,
    }
    assert.match(
      verifyNajikiWebhook({ rawBody: body, headers: withoutSignedTimestamp, secret, now: 1_700_000_000_000 }).reason!,
      /signature|timestamp/i
    )
  })

  test('rejects non-canonical timestamps and duplicate signature fields', () => {
    const headers = buildNotificationHeaders(secret, body, 1_700_000_000_000)
    assert.equal(verifyNajikiWebhook({
      rawBody: body,
      headers: { ...headers, 'X-Najiki-Timestamp': '1.7e12' },
      secret,
      now: 1_700_000_000_000,
    }).ok, false)
    assert.equal(verifyNajikiWebhook({
      rawBody: body,
      headers: { ...headers, 'X-Najiki-Signature': `${headers['X-Najiki-Signature']},v=${headers['X-Najiki-Signature'].split('v=')[1]}` },
      secret,
      now: 1_700_000_000_000,
    }).ok, false)
  })

  test('rejects a tampered body', () => {
    const headers = buildNotificationHeaders(secret, body, 1_700_000_000_000)
    const result = verifyNajikiWebhook({
      rawBody: body.replace('20000', '20001'),
      headers,
      secret,
      now: 1_700_000_000_000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'Signature mismatch')
  })

  test('rejects a replayed notification outside the 5-minute window', () => {
    const headers = buildNotificationHeaders(secret, body, 1_700_000_000_000)
    const result = verifyNajikiWebhook({
      rawBody: body,
      headers,
      secret,
      now: 1_700_000_000_000 + 6 * 60 * 1000,
    })
    assert.equal(result.ok, false)
    assert.match(result.reason!, /replay window/)
  })

  test('rejects a wrong secret', () => {
    const headers = buildNotificationHeaders('njk_whsec_someone_else', body, 1_700_000_000_000)
    const result = verifyNajikiWebhook({ rawBody: body, headers, secret, now: 1_700_000_000_000 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'Signature mismatch')
  })

  test('rejects the legacy bare-HMAC scheme the church app used to expect', () => {
    // Regression guard: `x-najiki-signature: sha256=<hmac(rawBody)>` with no
    // timestamp is NOT what Na'jiki sends, and must not be accepted.
    const result = verifyNajikiWebhook({
      rawBody: body,
      headers: { 'x-najiki-signature': 'sha256=deadbeef' },
      secret,
      now: 1_700_000_000_000,
    })
    assert.equal(result.ok, false)
    assert.match(result.reason!, /Missing/)
  })

  test('fails closed when no secret is configured', () => {
    const headers = buildNotificationHeaders(secret, body, 1_700_000_000_000)
    assert.equal(verifyNajikiWebhook({ rawBody: body, headers, secret: '' }).ok, false)
  })
})

describe('inbound webhook payload handling', () => {
  test('classifies the two webhook families', () => {
    assert.equal(classifyNajikiWebhook({ eventType: 'SMS_DELIVERY_UPDATE', smsId: 'sms_1' }), 'sms_delivery')
    assert.equal(classifyNajikiWebhook({ paymentIntentId: 'pay_1', status: 'success' }), 'payment')
    assert.equal(classifyNajikiWebhook({ hello: 'world' }), 'unknown')
  })

  test('reconciles a payment to the church ledger row via metadata.churchReference', () => {
    const payload = buildNajikiPaymentNotification({
      paymentIntentId: 'pay_abc',
      reference: 'CHURCH-TOP-1234-ABCD',
      status: 'success',
      amount: 20_000,
      metadata: {
        churchId: CHURCH_ID,
        tenantCode: TENANT_CODE,
        churchReference: 'CHURCH-9f8e7d6c-5b4a',
        idempotencyKey: 'ik_church_9f8e7d6c',
      },
    })

    const notification = parsePaymentNotification(JSON.parse(payload))!
    assert.equal(notification.status, 'success')
    assert.equal(notification.amount, 20_000)
    assert.equal(notification.externalEntityId, CHURCH_ID)

    const candidates = transactionLookupCandidates(notification)
    assert.equal(candidates[0].column, 'reference_code')
    assert.equal(candidates[0].value, 'CHURCH-9f8e7d6c-5b4a')
    // Na'jiki's own reference is a secondary cross-check, never the primary key.
    assert.deepEqual(
      candidates.map((c) => c.column),
      ['reference_code', 'reference', 'idempotency_key']
    )

    assert.equal(notification.tenantId, 'tenant_grace')
    assert.equal(notification.tenantCode, TENANT_CODE)
    assert.equal(notification.paymentTypeCode, 'BUY_SMS')
    assert.equal(notificationTenantCode(notification), TENANT_CODE)
    assert.equal(notificationTenantCode({ ...notification, tenantCode: null }), TENANT_CODE)
    assert.equal(notificationChurchId(notification), CHURCH_ID)
    assert.equal(activationMerchantReference(notification), null)
  })

  test('only identifies activation settlements from Na\u2019jiki metadata with a merchant reference', () => {
    const payload = buildNajikiPaymentNotification({
      paymentIntentId: 'pay_activation',
      reference: 'CHURCH-ACT-1234',
      status: 'success',
      amount: 17_000,
      metadata: {
        type: 'church_activation',
        merchantReference: 'ACT-activation-merchant-ref',
      },
    })
    const notification = parsePaymentNotification(JSON.parse(payload))!
    assert.equal(activationMerchantReference(notification), 'ACT-activation-merchant-ref')

    const withCanonicalProviderId = parsePaymentNotification({
      paymentIntentId: 'pay_najiki_intent',
      providerPaymentId: ' livepay-txn-456 ',
      status: 'success',
      metadata: { type: 'church_activation', merchantReference: 'ACT-activation-merchant-ref' },
    })!
    assert.equal(activationProviderTransactionId(withCanonicalProviderId), 'livepay-txn-456')

    const withoutCanonicalProviderId = parsePaymentNotification({
      paymentIntentId: 'pay_najiki_intent',
      providerPaymentId: null,
      status: 'success',
      metadata: { type: 'church_activation', merchantReference: 'ACT-activation-merchant-ref' },
    })!
    // Never substitute the distinct Na’jiki paymentIntentId.
    assert.equal(activationProviderTransactionId(withoutCanonicalProviderId), null)

    const malformed = parsePaymentNotification({
      paymentIntentId: 'pay_activation',
      status: 'success',
      metadata: { type: 'church_activation' },
    })!
    assert.equal(activationMerchantReference(malformed), null)
  })

  test('parses SMS delivery updates', () => {
    const notification = parseSmsDeliveryNotification({
      eventType: 'SMS_DELIVERY_UPDATE',
      smsId: 'sms_abc',
      reference: 'SMS-1234',
      status: 'delivered',
      providerId: 'AT+123456789',
      recipient: PHONE_E164,
      applicationCode: 'church',
    })!
    assert.equal(notification.smsId, 'sms_abc')
    assert.equal(notification.status, 'delivered')
    assert.equal(notification.providerId, 'AT+123456789')

    const logPatch = buildSmsDeliveryLogPatch(notification, 'delivered', '2026-10-26T10:00:00.000Z')
    assert.equal(logPatch.najiki_sms_id, 'sms_abc')
    assert.equal(logPatch.provider_message_id, 'AT+123456789')
    assert.equal(logPatch.najiki_reference, 'SMS-1234')
    assert.equal(logPatch.status, 'delivered')
    assert.equal(logPatch.message_provider_status, 'delivered')
  })

  test('plans the receipt SMS only after the payment is confirmed', () => {
    const base = {
      paymentIntentId: 'pay_abc',
      reference: 'CHURCH-TOP-1234-ABCD',
      amount: 20_000,
      currency: 'UGX',
      externalEntityId: CHURCH_ID,
      providerPaymentId: null,
      failureReason: null,
      metadata: {
        churchId: CHURCH_ID,
        churchReference: 'DON-abc123',
        donorPhone: PHONE_NAJIKI,
      },
    }

    const onSuccess = planPaymentReceiptSms({
      notification: { ...base, status: 'success' } as never,
      transactionType: 'DONATION',
      churchName: 'Grace Community Church',
    })
    assert.ok(onSuccess, 'a confirmed donation must produce a receipt plan')
    assert.equal(onSuccess.to, PHONE_NAJIKI)
    // Keyed on Na'jiki's payment id so a webhook redelivery cannot re-bill.
    assert.equal(onSuccess.idempotencyKey, 'receipt_pay_abc')
    assert.match(onSuccess.message, /Grace Community Church/)
    assert.match(onSuccess.message, /UGX 20,000/)

    // Not confirmed → no SMS. This is the sequencing rule.
    for (const status of ['failed', 'expired', 'cancelled', 'pending', 'processing']) {
      assert.equal(
        planPaymentReceiptSms({
          notification: { ...base, status } as never,
          transactionType: 'DONATION',
        }),
        null,
        `status ${status} must not trigger a receipt`
      )
    }

    // Admin top-ups have no member-facing recipient.
    assert.equal(
      planPaymentReceiptSms({
        notification: { ...base, status: 'success' } as never,
        transactionType: 'TOPUP',
      }),
      null
    )

    // No donor phone recorded → nothing to send to.
    assert.equal(
      planPaymentReceiptSms({
        notification: { ...base, status: 'success', metadata: {} } as never,
        transactionType: 'DONATION',
      }),
      null
    )
  })
})
})

describe('wallet webhook settlement guards', () => {
  test('accepts only a new credit or a confirmed duplicate success from the atomic RPC', () => {
    assert.equal(classifyWalletSettlementResult({ success: true, already_processed: false }), 'credited')
    assert.equal(
      classifyWalletSettlementResult({ success: true, already_processed: true }),
      'already_credited',
    )
    assert.equal(classifyWalletSettlementResult({ result: 'credited' }), 'retry')
    assert.equal(classifyWalletSettlementResult({ success: false }), 'retry')
    assert.equal(classifyWalletSettlementResult(null), 'retry')
  })

  test('requires exact positive whole-UGX amount and explicit matching currency', () => {
    const expected = { receivedAmount: 20_000, receivedCurrency: 'UGX', expectedAmount: '20000', expectedCurrency: 'UGX' }
    assert.deepEqual(validateWalletPaymentAmount(expected), { ok: true })
    assert.deepEqual(validateWalletPaymentAmount({ ...expected, receivedAmount: null }), { ok: false, reason: 'missing_amount' })
    assert.deepEqual(validateWalletPaymentAmount({ ...expected, receivedAmount: 19_999 }), { ok: false, reason: 'amount_mismatch' })
    assert.deepEqual(validateWalletPaymentAmount({ ...expected, receivedAmount: 20_001 }), { ok: false, reason: 'amount_mismatch' })
    assert.deepEqual(validateWalletPaymentAmount({ ...expected, receivedAmount: 20_000.5 }), { ok: false, reason: 'invalid_amount' })
    assert.deepEqual(validateWalletPaymentAmount({ ...expected, receivedCurrency: null }), { ok: false, reason: 'missing_currency' })
    assert.deepEqual(validateWalletPaymentAmount({ ...expected, receivedCurrency: 'KES' }), { ok: false, reason: 'currency_mismatch' })
  })
})
