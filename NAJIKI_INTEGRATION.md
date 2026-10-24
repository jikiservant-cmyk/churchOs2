# churchOs ↔ Na'jiki Finance integration

The contract Na'jiki Finance exposes to partner applications, and how churchOs
conforms to it.

- **Upstream:** <https://github.com/jikiservant-cmyk/najiki-finance2>
- **Verified against commit:** `b73a82b9e4411dd27b559927a3b455f833cfb2a7`
- ** churchOs implementation:** `lib/najiki/client.ts` (outbound), `lib/najiki/webhook.ts` (inbound)
- **Tests:** `tests/najiki-contract.test.ts`

Na'jiki is the source of truth. Everything below was read out of its source.
The application-side boundary is strict: churchOs sends every SMS and payment
initiation only to Na'jiki, and accepts payment settlements and SMS delivery
updates only through the signed Na'jiki webhook handler. Downstream carrier and
payment-provider integrations are Na'jiki's responsibility; churchOs does not
store their credentials or call their APIs.

---

## 1. Endpoints the church app calls

| Method | Path | Purpose | churchOs caller |
| --- | --- | --- | --- |
| `POST` | `/api/messaging/send` | Queue one SMS | `sendNajikiSms()` ← `lib/sms-actions.ts` |
| `POST` | `/api/payments` | Create a payment intent | `createNajikiPayment()` ← `lib/wallet-actions.ts` |
| `GET` | `/api/payments/:reference` | Read a payment's status | `getNajikiPayment()` (shared client helper; contract-tested) |

Two more endpoints exist but are **not** for partners: `/api/messaging/quick-send`
requires a super-admin Supabase session, and `/api/messaging/callback` is
Na'jiki's own provider callback.

### Authentication

`Authorization: Bearer <application api key>` — on **every** endpoint.

| Endpoint | Accepted schemes |
| --- | --- |
| `POST /api/payments` | `Authorization: Bearer` **only** |
| `GET /api/payments/:reference` | `Authorization: Bearer` only |
| `POST /api/messaging/send` | `Authorization: Bearer` (with or without the `Bearer ` prefix), or `x-api-key`, or an `apiKey` field in the body |

`/api/payments` reads nothing else: a request authenticated with `x-api-key` is
rejected with `401 {"error":"Missing or invalid authorization header"}`. This is
what the donation fallback used to do.

The key is looked up by SHA-256 hash against `applications.apiKeyHash` (with a
fallback to the legacy cleartext column for un-migrated rows), filtered on
`isActive: true`.

### `POST /api/messaging/send`

Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `to` | string | **yes** | Recipient. Na'jiki re-normalises this to E.164 before dispatching through its own SMS infrastructure. |
| `message` | string | **yes** | 1–918 characters, and no more than 6 SMS segments under Na'jiki's GSM/UCS-2 counting rules. |
| `applicationCode` | string | no | **Must equal the authenticated application's `code`** or Na'jiki answers `403 {"error":"Application code mismatch"}`. |
| `from` | string | no | Sender ID. `from \|\| senderId` wins; if supplied it must be 3–11 ASCII letters/digits. |
| `senderId` | string | no | Alias of `from`; same 3–11 alphanumeric constraint. |
| `apiKey` | string | no | Body-level auth fallback; not needed when the header is set. |
| `idempotencyKey` | string | no | Body fallback for the `Idempotency-Key` header. |

Headers: `Authorization`, `Content-Type: application/json`, and optionally
`Idempotency-Key` (≤255 chars, trimmed; the body field is the fallback).

Responses:

```jsonc
// 202 Accepted
{
  "success": true,
  "message": "SMS send job queued successfully",   // or "Duplicate request — the original SMS job was returned"
  "smsId": "sms_…",         // Na'jiki's opaque SMS id
  "reference": "SMS-…",     // Na'jiki's own SMS reference
  "status": "queued",       // 'queued' | 'pending' | 'delivered' | 'failed'
  "deduplicated": false,    // true when the idempotency key was already used
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

Errors: `400 {"error":"Invalid SMS payload or idempotency key"}`,
`401 {"error":"Invalid or missing API key"}`,
`403 {"error":"Application code mismatch"}`,
`409` when an idempotency key is reused for different SMS content,
`429` (rate/daily limit, with `Retry-After`), `500 {"error":"Internal server error"}`.

Rate limits (Upstash, per minute): 120 per client IP (`sms-ip`), 60 per API key
(`sms-key`).

Idempotency: `SmsMessage @@unique([applicationId, idempotencyKey])`. A repeat of
the same key returns the original job with `deduplicated: true` and does **not**
enqueue a second send. Delivery is asynchronous — the 202 only means "queued".

### `POST /api/payments`

Request body (`CreatePaymentRequestSchema`, validated before any DB write):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `applicationCode` | string | **yes** | Must match the authenticated application, else `401`. |
| `paymentTypeCode` | string | **yes** | Scoped to the application. An unknown code is auto-registered for that app. Codes in Na'jiki's `PLATFORM_FEE_TYPES` set (including `BUY_SMS` and `ACCOUNT_ACTIVATION`) route through platform credentials/wallet; ordinary collection codes route through the tenant. |
| `externalEntityId` | string | **yes** | Opaque; churchOs sends the church id. Echoed back in the webhook. |
| `amount` | number | **yes** | Finite, `> 0`, `≤ 999999999999.99`. **Major units.** UGX is zero-decimal, so `5000` means UGX 5,000 — never multiply by 100. |
| `currency` | string | no (default `UGX`) | Exactly three letters, upper-cased by Na'jiki. |
| `phoneNumber` | string | **yes** | 9–15 chars. Send digits-only E.164 (`2567…`) for the configured Na'jiki payment integration. |
| `idempotencyKey` | string | **yes** | Min 8 chars. Generated by the caller, once per attempt. |
| `tenantCode` | string | no | Resolved as `(applicationId, code, isActive)`. Unknown ⇒ `404 {"error":"Invalid or inactive tenant"}`. |
| `providerCode` | string | no | Optional in Na'jiki's schema. churchOs omits it so provider choice remains entirely configured in Na'jiki; the client type does not expose provider selection. |
| `metadata` | object | no (default `{}`) | Opaque caller metadata is echoed back alongside gateway-owned metadata such as `credentialSource` and `tenantCode`. |
| `description` | string | no | Read from the raw body (not in the schema) and used as the provider charge description. |

Response `200`:

```jsonc
{ "paymentId": "cm…", "reference": "CHURCH-BUY-…", "status": "processing" }
```

Na'jiki **generates its own reference** (`generateReference()`:
`<APP>-<TYPE>-<hex time>-<hex rand>`) and returns it as `reference`. There is no
`paymentIntentId` field in the response. `paymentId` is an opaque string: the
current Prisma `PaymentIntent` model uses CUID IDs even though an unused response
Zod schema declares UUID, so churchOs deliberately does not validate its format.

Errors: `400 {"error":"Validation failed","details":["amount: …", …]}` (Zod),
`401 {"error":"Missing or invalid authorization header"}` /
`{"error":"Invalid or inactive application, or invalid API key"}`,
`404 {"error":"Invalid or inactive tenant"}`,
`422` when Na'jiki's configured provider rejects the collection, and `503` when
no implemented provider is active.

Rate limits: 60/min per IP (`payments-ip`), 20/min per API key (`payments-key`).

Idempotency: the key is unique per `(applicationId, idempotencyKey)`. A repeat
returns the **original** intent (`paymentId`, `reference`, `status`) with no new
row — which is why the church app must not treat a repeat as a new payment.

Payment lifecycle: Na'jiki creates the intent and performs its configured
provider dispatch. The church app receives the Na'jiki intent response; terminal
results arrive only via the signed Na'jiki webhook. Downstream dispatch and
provider polling are internal to Na'jiki.

### `GET /api/payments/:reference`

`Authorization: Bearer`. Scoped to the calling application — another
application's payment is `404`, not `403`. Returns `id`, `reference`, `status`,
`amount`, `currency`, `phoneNumber`, `externalEntityId`, `provider`,
`providerPaymentId`, `failureReason`, `createdAt`, `updatedAt`, `completedAt`.
If the intent is `processing` and was last touched more than 15 s ago, Na'jiki
polls the provider and, on a terminal change, fires the settlement webhook.
Sliding window: 60/min per API key.

---

## 2. What Na'jiki sends back to the church app

Both notifications are signed identically by `buildNotificationHeaders()`
(`src/lib/notification-signature.ts`):

```
X-Najiki-Timestamp: <unix ms>
X-Najiki-Signature: t=<unix ms>,v=<hex hmac>
X-Najiki-Notification: true
Content-Type: application/json

v = HMAC-SHA256(secret, "<timestamp>.<raw request body>")
```

- The secret is the application's `webhookSecret` — a **separate** credential
  from the API key. For applications provisioned before that column existed,
  Na'jiki signs with the API key.
- **Reject anything more than 5 minutes old.**
- Delivery is retried with exponential backoff (via QStash when configured),
  so the handler must be idempotent.

### Payment settlement

`InternalNotificationPayloadSchema` — terminal statuses only
(`success | failed | expired | cancelled`). Actual notifications also echo the resolved tenant and payment-type fields:

```jsonc
{
  "paymentIntentId": "clx…",
  "reference": "CHURCH-TOP-…",     // Na'jiki's reference, NOT ours
  "status": "success",
  "amount": 20000,
  "currency": "UGX",
  "providerPaymentId": "prov_…",
  "failureReason": null,
  "externalEntityId": "<church id>",
  "tenantId": "<resolved tenant id>",
  "tenantCode": "grace-church",
  "paymentType": "BUY_SMS",
  "paymentTypeCode": "BUY_SMS",
  "metadata": { … }                // echo of submitted metadata plus gateway-owned metadata
}
```

There is no `idempotencyKey` or `eventType` at the top level. `tenantCode` is
included at the top level by the current gateway and is also echoed in metadata.
For compatibility and reconciliation, churchOs prefers that top-level tenant
code and falls back to `metadata.tenantCode`. The payment builders stamp
`metadata.churchReference`, `metadata.tenantCode`, `metadata.churchId` and (for
donations) `metadata.donorPhone`. Activation intents also carry
`metadata.type: "church_activation"` and `metadata.merchantReference`, so the
unified webhook can settle them against the activation ledger.

### SMS delivery

```jsonc
{
  "eventType": "SMS_DELIVERY_UPDATE",
  "smsId": "clx…",
  "reference": "SMS-…",
  "status": "delivered",            // or "failed"
  "providerId": "provider-message-id", // opaque downstream id supplied by Na'jiki
  "recipient": "+256…",
  "applicationCode": "church"
}
```

This is the only thing that can move an SMS from `queued` to `delivered`/`failed`.

---

### SMS wallet settlement RPC contract

The Church `BUY_SMS` webhook calls the deployed
`public.process_topup_webhook(text, text, bigint, jsonb)` function with the
contract supplied by the database owner:

- `p_reference` is Na'jiki's payment-intent `reference` from the signed callback,
  not ChurchOS's `metadata.churchReference` / wallet `reference_code`.
- `p_tenant_id` is passed as text, matching the deployed function signature.
- `p_amount` comes from the persisted pending wallet transaction, after an exact
  amount/currency check against the signed callback.
- The initiation action links that pending row using the returned
  `paymentId` as `payment_intent_id`; the webhook confirms it matches the signed
  `paymentIntentId` before calling the RPC.
- The RPC validates the Church application and `BUY_SMS` intent, then atomically
  creates or settles the linked `sms_topup` row, credits the wallet once, and
  returns `{ success, already_processed, ... }`. The webhook acknowledges only
  `{ success: true, already_processed: false|true }`.

No wallet read/increment fallback is performed outside this RPC. Donations and
other payment types must not be sent through this SMS-top-up procedure.

---

## 3. Sequencing rules the church app respects

1. **Payment confirmed before the receipt SMS.** Na'jiki only notifies on
   terminal statuses, and the wallet credit must land first.
   `planPaymentReceiptSms()` returns `null` for anything other than
   `status === 'success'`, and `app/api/najiki/webhook/route.ts` calls
   `sendPaymentReceipt()` only after `process_topup_webhook` has succeeded.
   Activation payments are settled by that same signed handler using the
   activation merchant reference in Na'jiki metadata. A failed receipt is logged
   and never rolls back the confirmed payment.
2. **SMS receipt idempotency.** The receipt's idempotency key is
   `receipt_<paymentIntentId>`, so a webhook redelivery cannot bill the church
   twice.
3. **Send idempotency.** `lib/sms-actions.ts` forwards its own
   `idempotency_key` as Na'jiki's `Idempotency-Key`. When Na'jiki answers
   `deduplicated: true`, the wallet is **not** debited again.
4. **Payment idempotency.** One `idempotencyKey` per attempt
   (`ik_church_<uuid>` / `ik_don_<uuid>`), generated before the request and
   stored on the pending ledger row, so a retry returns the same intent.
5. **Na'jiki-only routing.** Every SMS send and payment initiation fails closed
   if Na'jiki is unavailable or rejects the request. There is no direct-provider
   fallback. Payment settlement and SMS delivery updates are processed only by
   `/api/webhooks/najiki` or its identical alias `/api/najiki/webhook` after
   Na'jiki signature and replay-window verification. This includes activation
   payments; no separate activation or downstream-provider callback can settle
   a payment.

---

## 4. Configuration checklist

| Na'jiki side | Value |
| --- | --- |
| Application `code` | `church` (must equal `NAJIKI_APPLICATION_CODE`) |
| Application `baseUrl` | the church app's public origin |
| Application `webhookPath` | `/api/webhooks/najiki` (or `/api/najiki/webhook`) |
| Application `webhookSecret` | copy into `NAJIKI_WEBHOOK_SECRET` |
| Tenant `code` | the church's `public.tenants.code` (or its slug) |
| Payment types | Unknown codes auto-register per application. Keep SMS-credit top-ups and activations on platform-fee codes (`BUY_SMS`, `ACCOUNT_ACTIVATION` by default); donations use an ordinary tenant collection code (`donation` by default). |

`ALLOWED_ORIGINS` on the Na'jiki side only affects browser CORS preflight; the
church app calls the API from the server, so it is not required for this
integration.

---

## 5. Mismatches found and fixed

Summary of integration fixes:

| # | Where | Was | Now |
| --- | --- | --- | --- |
| 1 | `app/api/najiki/webhook/route.ts` | Expected `x-najiki-signature: sha256=<hmac(rawBody)>` — a scheme Na'jiki has never sent. Every webhook was rejected 403, so no Na'jiki payment ever credited a wallet. | Verifies `X-Najiki-Timestamp` + `X-Najiki-Signature: t=,v=` over `<ts>.<rawBody>` with a 5-minute replay window, timing-safe compare, fail-closed. |
| 2 | `app/api/najiki/webhook/route.ts` | Reconciled on top-level `tenantCode` / `idempotencyKey` but the earlier gateway contract only carried those in metadata — the tenant guard silently never ran. | Reads the current top-level resolved `tenantCode` first, falls back to metadata for compatibility, and reconciles on `metadata.churchReference` first; idempotency remains metadata-only. |
| 3 | `lib/wallet-actions.ts` | Read `result.paymentIntentId` from the response; Na'jiki returns `paymentId`, so the provider response was never stored and the UI got `undefined`. | Reads `paymentId` / `reference`; persists Na'jiki's reference on the row. |
| 4 | `lib/wallet-actions.ts` (donation fallback) | Authenticated with `x-api-key`, which `POST /api/payments` rejects with 401. | `Authorization: Bearer` via the shared client. |
| 5 | `lib/wallet-actions.ts` | `.eq('reference', …)` on error paths — `wallet_transactions.reference` is never populated, so failed payments were never marked failed. | `.eq('reference_code', …)`. |
| 6 | `lib/sms-actions.ts` | Never sent an idempotency key to Na'jiki, so a retried broadcast was a second, separately billed SMS. | Sends `Idempotency-Key`; skips the wallet debit when `deduplicated: true`. |
| 7 | `lib/sms-actions.ts` | Swallowed every Na'jiki error and fell back to Africa's Talking — a 401/403/400 looked like a provider outage. | all failures are surfaced; no alternate provider is called. |
| 8 | `lib/sms-actions.ts` | Required `NAJIKI_API_URL`, which was not in `.env.example` — so in practice Na'jiki was always "unconfigured" and every SMS went out via the direct AT path. | `NAJIKI_API_URL` is optional and defaults to the deployed origin; missing configuration fails closed. |
| 9 | `.env.example` | `NAJIKI_APPLICATION_CODE="CHURCH"` — Na'jiki seeds the church application as lowercase `church`, so this value is rejected (403/401). | Defaults to `church`, with the reason documented. |
| 10 | `app/api/najiki/webhook/route.ts` | Only `status === 'failed'` was treated as a failure; `expired` / `cancelled` were logged as "still pending" and left the ledger row pending forever. | `failed`, `expired` and `cancelled` are terminal failures. |
| 11 | Giving portal | The confirmation SMS was never sent at all (the client-side comment said it should come from the webhook). | Sent from the webhook, after the payment is confirmed and the wallet credited. |

---

## Ambiguities and open questions

1. **Staging gateway access.** The contract mock validates request shapes and
   signatures, but cannot verify a real Na'jiki account or its configured
   downstream services. Credentialed staging checks must use a Na'jiki test or
   staging application; churchOs must not be configured with downstream
   provider credentials.
2. **`paymentTypeCode` semantics.** Na'jiki auto-registers unknown types per
   application, so manual setup is not required. The code still controls routing:
   SMS-credit purchases default to `BUY_SMS` and activations to
   `ACCOUNT_ACTIVATION`, both in Na'jiki's platform-fee set; donations default
   to the ordinary tenant collection type `donation`. Overrides for the first
   two must remain in Na'jiki's platform-fee set. Legacy defaults
   (`topup` / `church_activation`) are normalized to `BUY_SMS` /
   `ACCOUNT_ACTIVATION` with a warning, but update deployed environment values to
   remove the warning. Any other non-platform override fails before dispatch.
3. **`tenantCode` for each church.** Na'jiki resolves tenants per application.
   churchOs sends the matched `public.tenants.code` or that church's slug.
   A global tenant-code fallback is intentionally not used, because it can
   misroute one church's payment to another tenant. The selected code must exist
   as a tenant row in Na'jiki, otherwise the payment is rejected 404. This
   per-church mapping cannot be verified from here.
4. **Webhook secret vs API key.** Na'jiki signs with the application's
   `webhookSecret` when present and falls back to the API key. churchOs accepts
   either, in that order. If a church app row has a distinct `webhookSecret`,
   `NAJIKI_WEBHOOK_SECRET` must be set to it.
5. **Deployed Na'jiki unreachable from this environment.**
   `https://najiki.netlify.app` does not answer here (TLS handshake fails), so
   the live smoke test could not be run. Re-run it from a network that can reach
   the deployment.

---

## Verification

`npm test` (72 tests, all passing) drives churchOs' real client over TCP
against a mock that enforces Na'jiki's **own** payment and SMS Zod schemas
(`tests/fixtures/najiki/schemas.ts` and `sms-policy.ts`, vendored from the pinned revision):

- SMS-credit top-ups use `BUY_SMS`, activations use `ACCOUNT_ACTIVATION`, and
  donations use a non-platform collection code; the local platform-fee set is
  asserted against Na'jiki's vendored `constants.ts`;
- top-up, donation and activation payment payloads are accepted and asserted
  field by field; unknown payment types auto-register per application;
- amount is major units (`toMinorUnits(5000,'UGX') === 5000n`, and the stored
  amount is `5000`);
- phone numbers are digits-only E.164 (`/^256\d{9}$/`);
- SMS request shape and sender/idempotency constraints are checked against
  Na'jiki's real `SmsInputSchema`;
- the same `Idempotency-Key` twice ⇒ one send, `deduplicated: true`;
- a dropped `idempotencyKey` ⇒ `400 Validation failed` with the field-level
  `details` surfaced through `NajikiApiError`;
- `NAJIKI_APPLICATION_CODE="CHURCH"` ⇒ 403 on SMS, 401 on payments;
- `x-api-key` auth ⇒ 401 on `/api/payments`;
- unknown tenant ⇒ 404; `GET /api/payments/:reference` round-trips;
- a notification signed by Na'jiki's own `buildNotificationHeaders()` verifies,
  and a tampered body, a stale timestamp, a wrong secret and the legacy
  `x-najiki-signature` scheme are all rejected;
- the receipt-SMS sequencing rule holds for every non-success status.

Live end-to-end against the deployed gateway was **not** possible from this
sandbox (see ambiguity 5) — the acceptance evidence above comes from Na'jiki's
own validator running on the exact bytes churchOs sends.

### Live smoke test of the webhook route

`next dev` was started with a webhook secret and no Supabase (so the route's
pre-database paths could be exercised), and real requests were posted to
`/api/najiki/webhook`, signed with Na'jiki's own `buildNotificationHeaders()`:

| Request | Result |
| --- | --- |
| signed, unrecognised shape | `200 {"received":true,"ignored":true}` |
| signed, payment notification with no `paymentIntentId` | `200 {"received":true}` |
| signed, full payment notification | `500` — reached the DB stage and failed on `supabaseUrl is required` (no Supabase in this sandbox), returned as a retryable 500 by the new guard |
| signed, SMS delivery update | `500` — same DB-stage failure |
| unsigned | `403 Missing x-najiki-timestamp / x-najiki-signature headers` |
| timestamp 6 minutes old | `403 Timestamp outside the 5-minute replay window` |
| signed body A, sent body B | `403 Signature mismatch` |
| legacy `x-najiki-signature` only | `403 Missing … headers` |

So signature verification, replay protection and the fail-closed guard are
confirmed working in the real Next.js runtime. What could not be exercised
without a database is the ledger write and the receipt SMS.
