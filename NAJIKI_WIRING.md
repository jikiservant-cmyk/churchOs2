# Na'jiki ↔ churchOs wiring

I read `najiki-finance2` and diffed it against what this repo sends and expects.
**The two codebases agree.** Every failure I can find is configuration in
Na'jiki's database, not code in either repository.

Verified against `jikiservant-cmyk/najiki-finance2` @
`b73a82b9e4411dd27b559927a3b455f833cfb2a7` (current `main`).

---

## 1. The wire contract is correct — evidence

| Concern | churchOs | Na'jiki | Match |
|---|---|---|---|
| Signing headers | `x-najiki-timestamp`, `x-najiki-signature: t=,v=`, `x-najiki-notification: true` | `buildNotificationHeaders()` emits exactly these | ✅ |
| Signing input | `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` | `.update(\`${timestamp}.${payloadString}\`)` | ✅ |
| Replay window | 5 min | 5 min (`maxSkewMs`) | ✅ |
| Create intent | `POST /api/payments` with `applicationCode, paymentTypeCode, externalEntityId, amount, currency, phoneNumber, idempotencyKey, metadata` | `CreatePaymentRequestSchema` — same fields, `idempotencyKey.min(8)` | ✅ |
| Create response | reads `{ paymentId, reference, status }` | `CreatePaymentResponseSchema` returns exactly that | ✅ |
| Status lookup | `GET /api/payments/:reference` → `{ id, reference, status, amount, ... }` | returns the full intent incl. `id` | ✅ |
| Notification body | parses `paymentIntentId, reference, status, amount, currency, providerPaymentId, failureReason, externalEntityId, tenantId, tenantCode, paymentType, paymentTypeCode, metadata` | `enqueueWebhookNotification()` sends all of them | ✅ |
| `amount` type | requires `typeof === 'number'` (else "missing amount", no credit) | `amount: Number(amount)` — a real number, not a Decimal string | ✅ |
| Amount units | integer UGX, major units | `Decimal(14,2)` major units → `amountMinor = ×100` | ✅ |
| SMS callback | parses `{ eventType: 'SMS_DELIVERY_UPDATE', smsId, reference, status, providerId, recipient, applicationCode }` | `sms-queue.ts` sends that exact object | ✅ |
| SMS limits | 500 chars / 4 segments (stricter) | 918 chars / 6 segments | ✅ |
| Platform-fee codes | `SMS, BUY_SMS, SMS_TOPUP, ACTIVATION, ACCOUNT_ACTIVATION, SUBSCRIPTION, MONTHLY_SUBSCRIPTION, PLATFORM_FEE` | `PLATFORM_FEE_TYPES` — identical list | ✅ |

The five vendored files in `tests/fixtures/najiki/` are **byte-identical** to
upstream at that commit (only the documented `./money.ts` import extension
differs). The contract tests were testing real Na'jiki, not a paraphrase.

---

## 2. What is actually broken

Three joins live in Na'jiki's database. Any one of them makes the integration
look "dead" from churchOs with no error surfaced to the user.

### 2.1 The `church` application points at a placeholder host — **blocking**

`scripts/seed.ts` creates:

```ts
{ code: 'church', baseUrl: 'https://church.yourdomain.com',
  webhookPath: '/api/internal/payment-completed', ... }
```

`yourdomain.com` is in `PLACEHOLDER_DOMAINS` (`src/lib/safe-fetch.ts`), so
`enqueueWebhookNotification()` throws **before any network call**:

```ts
await validateSafeUrl(data.webhookUrl)   // throws
→ recordNotificationFailure(..., { permanent: true })
```

The notification is marked `failed_exhausted` and **is never retried**. The
money is collected at LivePay; the churchOs wallet is never credited; nobody is
told. This single row explains "the payment went through but nothing happened".

`webhookPath` is also wrong: churchOs has no `/api/internal/payment-completed`.
The auto-heal to `/api/webhooks/najiki` only fires when `application.code ===
'sacco'` (`resolvePartnerWebhookUrl`) or after a 404/405 (`postSignedPartnerWebhook`) —
so for `church` it posts to the dead path first.

**Fix:**

```sql
UPDATE public.applications
SET    base_url     = 'https://<your-churchos-origin>',
       webhook_path = '/api/webhooks/najiki'
WHERE  code = 'church';
```

Prefer the Setup dashboard (`POST /api/setup` → `updateApplication`), which
validates the URL for you.

### 2.2 Every church needs a matching active tenant row — **blocking**

churchOs sends `tenantCode = public.tenants.code || church.slug`
(`lib/wallet-actions.ts`, `lib/activation/index.ts`). Na'jiki:

```ts
if (validatedBody.tenantCode && !tenant) {
  return 404 `Invalid or inactive tenant "<code>".`
}
```

The seed only creates `grace-church`. Any other church fails intent creation
outright. Resolution is exact → tenant id → case-insensitive → slug, so the code
must equal churchOs's tenant code, or the church slug.

**Fix — one row per church, codes must match churchOs:**

```sql
INSERT INTO public.tenants (id, application_id, code, name, is_active, created_at, updated_at)
SELECT 'tn_' || substr(md5(random()::text), 1, 20), a.id, :churchos_tenant_code,
       :church_name, true, now(), now()
FROM   public.applications a
WHERE  a.code = 'church'
ON CONFLICT (application_id, code) DO UPDATE SET is_active = true;
```

Check what churchOs will send:

```sql
-- run in the churchOs database
SELECT c.slug, t.code AS tenant_code_that_will_be_sent
FROM   church.churches c
LEFT JOIN public.tenants t ON t.id = c.id;
```

Also set `default_provider_id` on each new tenant (a usable LivePay provider).
Without it Na'jiki falls back to **platform** credentials, so the cash lands in
the platform collection account rather than the church's own — churchOs still
credits the church wallet from its own ledger, and the two books disagree.

### 2.3 The webhook signing secret must exist and be shared — **blocking if wrong**

`webhookSecretFromRow()` uses `webhookSecretEncrypted` (decrypted), and only
falls back to the legacy **plaintext** `api_key` column. That column is being
cleared in favour of `api_key_hash`, which cannot be used for signing.

If no secret resolves, `buildNotificationHeaders(null, …)` omits the signature
headers entirely. churchOs then answers **403** "Missing x-najiki-timestamp /
x-najiki-signature", and Na'jiki retries the chain:

1. `webhookSecret` (primary)
2. `application.apiKey` — null once hashed, so skipped
3. `internalSecretRef`'s env value (`CHURCH_INTERNAL_SECRET`) and the ref string

| Na'jiki church app | Headers sent | churchOs must verify with |
|---|---|---|
| `webhook_secret_encrypted` set | signed with that secret | `NAJIKI_WEBHOOK_SECRET` = same plaintext |
| unset, `api_key` null | **unsigned** → 403 | — (broken) |
| unset, `internalSecretRef` env set | fallback-signed with that env value | `NAJIKI_WEBHOOK_SECRET` = same value |

The webhook secret plaintext is shown **once**, at creation or rotation. If it
was lost, rotate it in Setup and copy the new value immediately.

> ⚠️ Also set at least `NAJIKI_API_KEY` in churchOs. When no secret is
> configured churchOs returns **500**, not 401/403 — so Na'jiki's fallback
> chain never triggers and it burns all 5 attempts before exhausting.

---

## 3. churchOs environment

```bash
NAJIKI_API_URL="https://<the real Na'jiki origin>"   # default https://najiki.netlify.app
NAJIKI_API_KEY="<church app API key>"
NAJIKI_APPLICATION_CODE="church"
NAJIKI_WEBHOOK_SECRET="<the church app's webhook secret>"
```

Register the callback URL in Setup as `<churchOs origin>/api/webhooks/najiki`.
`/api/najiki/webhook` is a duplicate of that route and can be retired.

---

## 4. Prove it, one hop at a time

```bash
set -a; . ./.env.local; set +a

# Hop 1 — can churchOs even create an intent? (catches 2.1/2.2 before money moves)
curl -sS -X POST "$NAJIKI_API_URL/api/payments" \
  -H "Authorization: Bearer $NAJIKI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"applicationCode":"church","tenantCode":"grace-church",
       "paymentTypeCode":"donation","externalEntityId":"probe-church-id",
       "amount":1000,"currency":"UGX","phoneNumber":"256772123456",
       "idempotencyKey":"probe-'$(date +%s)'","metadata":{"churchReference":"probe"}}'
# expect 200 {paymentId, reference, status}
# 404 invalid/inactive tenant → §2.2
# 401 Invalid API key       → NAJIKI_API_KEY or applicationCode mismatch
# 503 no provider           → no implemented provider active in Na'jiki

# Hop 2 — is the webhook target reachable and not a placeholder?
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "https://<your-churchos-origin>/api/webhooks/najiki"
# expect 403 (unconfigured/unverified) — NOT 404. 404 means the path is wrong.
```

Then pay a real 1,000 UGX in sandbox and watch Na'jiki's webhook log for a
2xx — that is the only proof the whole chain works.

---

## 5. Remaining code-level notes

- `amount` is echoed as `providerPaymentId: ''` (empty string) when LivePay gives
  none. churchOs's `str()` maps that to `null` and falls back to the status API —
  correct, just slower.
- Na'jiki's `senderId` regex is `^[A-Za-z0-9]{3,11}$`. A `church.sender_id` with
  spaces or dashes makes the SMS call 400 before it ever reaches the carrier.
- Unknown `paymentTypeCode`s are auto-registered (`db.paymentType.upsert`), so
  `donation` / `ACCOUNT_ACTIVATION` / `BUY_SMS` need no pre-seeding.
  `BUY_SMS` and `ACCOUNT_ACTIVATION` are platform-fee types → platform wallet;
  `donation` is not → tenant collection. That is the split churchOs intends.
- `GET /api/payments/:reference` answers 404 (not 403) for another application's
  payment, so churchOs's reconciliation probe cannot be used to enumerate.
