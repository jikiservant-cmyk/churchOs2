# SMS Queue + Supabase Edge Dispatch

All application SMS is persisted as one row in `church.sms_queue` and sent only by the `church-najiki-dispatch` Supabase Edge Function. The backend passes only `sms_id`; the function loads the row itself, claims it under a lease, performs the wallet debit exactly once, and calls Na'jiki. No route, browser, or database trigger calls an SMS carrier directly.

## 1. Apply the database migration

Apply `migrations/009_najiki_sms_edge_dispatch.sql` after the existing church/SMS schema. It:

- adds `locked_until` and a fencing `lock_token` so abandoned `PROCESSING` rows can be reclaimed safely;
- adds Na'jiki callback-correlation fields and backfills stable keys for older queue rows;
- installs single-row claim, lease-release, idempotent debit, completion, and refund RPCs;
- retires the former batch claim RPC.

The wallet mapping is confirmed by this repository's schema: the church creation trigger writes `NEW.id` into `public.tenants.id`, and `public.wallets.tenant_id` references that tenant ID. Thus `church.churches.id = public.tenants.id = public.wallets.tenant_id` is a direct UUID mapping. Validate legacy production data before deploying if those tables were populated outside the provided registration path.

## 2. Deploy the Edge Functions

Install the Supabase CLI if needed, link it to the existing project, and deploy:

```sh
supabase functions deploy church-najiki-dispatch
supabase functions deploy church-najiki-queue-worker
```

Both functions have `verify_jwt = false` in `supabase/config.toml`; they require the independent shared dispatch secret on every request. Do not expose that secret in browser code.

Set the following in Supabase Edge Function secrets (use the current Supabase **secret API key**, not a deprecated service-role key):

```sh
supabase secrets set \
  SUPABASE_SECRET_API_KEY='…' \
  DISPATCH_SECRET='…' \
  NAJIKI_API_KEY='…' \
  NAJIKI_API_URL='https://najiki.netlify.app' \
  NAJIKI_APPLICATION_CODE='church'
```

Use the same high-entropy `DISPATCH_SECRET` value as the app server's `SMS_DISPATCH_SECRET`. `NAJIKI_API_KEY` and the Supabase secret API key belong only in Edge Function secrets. The function uses Na'jiki's audited contract: `POST /api/messaging/send`, Bearer auth, `to`, `message`, optional `from`, `applicationCode: "church"`, and `Idempotency-Key`; it parses `smsId` and `reference` from the response.

## 3. Configure the app server

Set these on the Next.js server environment (for example, Vercel Project Settings):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable-key>
SMS_DISPATCH_SECRET=<same value as Edge DISPATCH_SECRET>
QUEUE_PROCESSOR_SECRET=<separate random secret for /api/sms/process-queue>
```

The publishable key is used only as the Edge Function gateway `apikey`; the shared secret authenticates the dispatch request. The Na'jiki key and Supabase secret key are not needed by the Next.js app server for dispatch.

## 4. Schedule recovery of due and abandoned rows

The enqueue/send backend invokes the worker immediately after it commits queue rows. A scheduled worker is still required for timeouts, transient Na'jiki errors, rate limiting, and expired leases. Enable `pg_cron`, `pg_net`, and Vault in the Supabase project, then store the worker URL, publishable key, and the shared dispatch secret in Vault (substitute secrets in the SQL Editor; do not commit them):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'churchos_sms_project_url');
select vault.create_secret('<publishable-key>', 'churchos_sms_publishable_key');
select vault.create_secret('<same-dispatch-secret>', 'churchos_sms_dispatch_secret');

select cron.schedule(
  'churchos-najiki-sms-queue-worker',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'churchos_sms_project_url')
        || '/functions/v1/church-najiki-queue-worker',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'churchos_sms_publishable_key'),
        'x-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'churchos_sms_dispatch_secret')
      ),
      body := '{}'::jsonb
    );
  $job$
);
```

If the project uses an existing cron/secret setup, adapt the call rather than creating duplicate schedules. The authenticated fallback endpoint `GET /api/sms/process-queue` (or `POST` with `x-queue-secret`) can also wake the Edge worker with `QUEUE_PROCESSOR_SECRET`.

## 5. Request and retry behavior

- `POST /api/sms/send`, `/api/sms/broadcast`, `/api/sms/enqueue`, attendance follow-ups, and payment receipt SMS now create/reuse a queue row before invoking the Edge Function.
- The Edge Function accepts only `{ "sms_id": "<queue UUID>" }`; it never trusts message, recipient, tenant, or price data from the invocation.
- Queue IDs and idempotency keys remain stable across timeouts. A duplicate idempotency key returns the existing queue ID rather than creating another SMS job. `POST /api/sms/send` requires a caller-supplied `idempotencyKey` (or `Idempotency-Key` header, 8–255 characters); callers must reuse it when retrying the HTTP request.
- `claim_sms_queue_item` atomically claims one due `PENDING` item or an expired `PROCESSING` lease. The `lock_token` fences off old workers after lease recovery.
- Wallet debit and ledger insertion are transactional and idempotent by queue ID. A definitive Na'jiki 4xx rejection marks the job failed and refunds once. Network timeouts, 5xx responses, and 429 rate limits are treated as ambiguous/transient and retried with the same key; they are not refunded while acceptance is unknown.
- `church.sms_logs` is created before dispatch and correlated to Na'jiki `smsId`/`reference`, preserving signed webhook delivery updates.
- Broadcast status is derived from the authoritative queue rows; the existing `GET /api/sms/broadcast-status/:broadcastId` endpoint remains available.

## Throughput note

The audited Na'jiki deployment rate-limits SMS requests to **60 per application API key per minute**. A 5,000-recipient broadcast therefore cannot complete in under two minutes under that gateway policy; the theoretical lower bound is about 84 minutes, before delivery and retry overhead. Increase the Na'jiki application/API-key rate limit and confirm carrier capacity there before promising a higher throughput. The Edge queue prevents request timeouts and duplicate sends; it cannot bypass the gateway's rate limit.
