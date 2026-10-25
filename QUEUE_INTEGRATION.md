# SMS queue and Na'jiki Edge dispatch

This integration uses the **existing database tables and RPCs**. It does not require a new migration or SQL to run.

## Dispatch flow

1. The authenticated backend validates the church/recipient and inserts one row per recipient into `church.sms_queue` using the existing enqueue path.
2. Once the insert succeeds, the backend calls `church-najiki-dispatch` once for each row, with JSON containing only `sms_id`. Retries reuse that same queue row and idempotency key.
3. The Edge Function claims the row, prepares/verifies the corresponding `church.sms_logs` row, reserves the debit with the existing RPC, calls Na'jiki, then records or schedules the outcome through the existing RPCs.

The active `church-najiki-dispatch` function requires both a valid Supabase JWT (platform verification is enabled) and `x-dispatch-secret`. The request headers are:

```text
Authorization: Bearer <user access token, or server-only service-role JWT>
apikey: <Supabase publishable key>
x-dispatch-secret: <CHURCH_DISPATCH_SECRET>
Content-Type: application/json
```

The request body is exactly:

```json
{ "sms_id": "<sms_queue UUID>" }
```

The Edge Function loads phone, message, tenant, sender, attempts, and idempotency key from the existing queue row. It does not accept those fields from the caller and does not enqueue messages.

## Existing database RPCs used

- `claim_sms_queue_item(p_sms_id uuid, p_lock_token uuid, p_lease_seconds integer)` → `SETOF church.sms_queue`
- `reserve_sms_queue_debit(p_sms_id uuid, p_lock_token uuid)` → `jsonb`
- `release_sms_queue_item(p_sms_id uuid, p_lock_token uuid, p_retry_at timestamptz, p_error text, p_restore_attempt boolean)` → `boolean`
- `fail_sms_queue_item(p_sms_id uuid, p_lock_token uuid, p_error text)` → `jsonb`
- `complete_sms_queue_item(p_sms_id uuid, p_lock_token uuid, p_najiki_sms_id text, p_najiki_reference text, p_gateway_status text)` → `boolean`

The log upsert uses the existing unique conflict target `tenant_id,idempotency_key`. The debit results handled by the dispatcher are `debited`, `already_debited`, `insufficient_balance`, and `wallet_missing`.

## Runtime configuration

Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the Edge Function. The function uses the service-role key only inside the Edge runtime to access the database. Never expose it in browser code.

Required application-specific Edge secrets:

- `CHURCH_DISPATCH_SECRET` — at least 32 characters; set the same value as the Next.js server's `CHURCH_DISPATCH_SECRET`. Generate a strong value with `openssl rand -hex 32` (64 hex characters).
- `NAJIKI_API_KEY` — Na'jiki API credential.

Optional Edge variables:

- `NAJIKI_API_URL` — defaults to `https://najiki.netlify.app`; must use HTTPS.
- `NAJIKI_APPLICATION_CODE` — defaults to `church`.

The server-side caller also needs the Supabase project URL, a publishable key for the `apikey` header, and a JWT for the `Authorization` header. Prefer the initiating user's access token when available; a service-role JWT is acceptable only for a trusted server-to-server call. Never put `CHURCH_DISPATCH_SECRET` or the service-role JWT in browser code or chat.

## Responses and retry notes

- `sent`: Na'jiki accepted the SMS and the completion RPC succeeded.
- `pending`: retry later; includes transient provider errors and wallet/balance conditions.
- `failed`: terminal provider rejection was finalized.
- `skipped`: the item was not due or was already claimed.

The provider call has a 25-second timeout and retries reuse the same idempotency key. The handler receives `max_attempts` from the queue row but does not enforce that limit itself; confirm the existing database queue RPC or other queue process enforces it.
