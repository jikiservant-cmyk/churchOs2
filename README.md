# churchOs — 10k Scalability Fixes

This folder contains all the files needed to harden churchOs for 10,000 clients.
Drop each file into the correct path in your repo and follow the steps below.

---

## File map

```
churchOs-fixes/
├── .env.example                              → repo root (replace existing)
├── middleware.ts                             → repo root (replace existing)
├── next.config.ts                            → repo root (replace existing)
├── lib/
│   ├── cache.ts                              → lib/cache.ts (NEW)
│   ├── rate-limit.ts                         → lib/rate-limit.ts (NEW)
│   ├── sms-queue.ts                          → lib/sms-queue.ts (NEW)
│   └── db/
│       └── members.ts                        → lib/db/members.ts (NEW)
├── migrations/
│   ├── 005…010                               → In the repo's migrations/ folder
│   ├── 011_usher_passkey_columns.sql         → Run in Supabase SQL Editor
│   ├── 012_usher_passkey_backfill.sql        → Run in Supabase SQL Editor
│   └── 014_passkey_not_null.sql              → Gated; run last (see PROVISIONING_DRIFT.md)
└── supabase/
    └── functions/
        ├── church-najiki-dispatch/index.ts   → Single queue-row Na'jiki dispatcher
        └── church-najiki-queue-worker/index.ts → Due/expired-row recovery worker
```

---

## Step-by-step

### 1 — Install new dependencies
```bash
npm install @upstash/redis @upstash/ratelimit
```

### 2 — Copy the code files into your repo
Drop the files from this zip into the matching paths listed above.
The two root files (`middleware.ts`, `next.config.ts`) replace existing files.
All `lib/` files are new additions.

### 3 — Update environment variables
Add the new variables from `.env.example` to your `.env.local`:
- `SUPABASE_JWT_SECRET`   — from Supabase Dashboard → Settings → API
- `DATABASE_URL`          — Transaction Pooler URL (port 6543) from Supabase Dashboard
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — from upstash.com

### 4 — Run SQL migrations (in order)
Open Supabase Dashboard → SQL Editor and run each file in order:

```
005…010 (already in migrations/)  ← Apply in order
011_usher_passkey_columns.sql     ← Adds the usher passkey columns (additive)
012_usher_passkey_backfill.sql    ← Issues a passkey where none exists
014_passkey_not_null.sql          ← Enforces NOT NULL; refuses until the data is ready
015_missing_schema_columns.sql    ← Adds the columns the app reads but no migration created
016_rls_policy_repair.sql         ← Restores the RLS policies a re-run of the schema left behind
017_activation_billing_columns.sql ← Declares the activation billing state + a default that gates new churches
018_usher_passkey_default.sql       ← Gives churches.churches.passkey its DEFAULT (the usher portal needs a code)
```

018 issues no credential of its own — it only stops an insert that omits `passkey`
from creating a church with no usher code. Existing blank rows are filled by
`012_usher_passkey_backfill.sql`, which is idempotent, never touches a row that
already has a code, never bumps `passkey_version` (live usher sessions survive)
and deliberately never prints the codes it writes.

One file, if you would rather paste once: `scripts/apply-activation-and-passkey.sql`
runs 017 + 018 + 012 in order and then prints its own verification. It embeds those
files verbatim — `npm run test:sql` fails if the copy in the paste ever drifts from
the file in `migrations/`, so edit the migration and re-generate, never hand-edit the
paste. Read-only after the last write, so it doubles as a health check you can re-run
while the app is live.

Before 017, read the gate audit (it writes nothing) to see which congregations any
later tightening would affect:

```
psql "$DATABASE_URL" -f scripts/activation-gate-audit.sql   # or paste it in the SQL editor
```

`activation_status` was read in four places and declared nowhere — `supabase-schema.sql`
has no such column, so a church could be reported as paid because the value was
missing. `lib/activation-gate.ts` is now the only place that answers the question.

The activation screen also announces how long the wait is: it gives the pastor
`ACTIVATION_PROMPT_WINDOW_MS` (5 minutes by default) to approve the prompt on the
handset, then says so plainly and offers to send it again. That is a promise about
the wait, not a switch on the money — the status poll keeps running, a payment that
arrives late still activates the church, and while the first request is still
ambiguous with the provider the retry button is not offered at all, because a second
prompt then would be a second charge.

**Before running 002:** Check no passkeys are already hashed:
```sql
SELECT id, slug, passkey FROM church.churches LIMIT 10;
```
If any passkeys start with `$2`, they're already hashed — skip 002.

**Before running 004:** Enable pg_cron in Supabase Dashboard → Database → Extensions.

### 5 — Configure Na'jiki
Set `NAJIKI_API_KEY`, `NAJIKI_APPLICATION_CODE`, and the signed webhook path
in the app environment and Na'jiki Setup. All SMS and payment initiation goes
through Na'jiki; do not add downstream carrier or payment-provider credentials
to churchOs. See `NAJIKI_INTEGRATION.md` for the full contract.

### 6 — Route all application SMS through the Supabase Edge queue
Application code persists a row in `church.sms_queue`; the `church-najiki-dispatch`
Supabase Edge Function sends it through Na'jiki using the stable queue ID and
idempotency key. Do not add synchronous provider calls or downstream-provider
fallbacks. Deploy/configure the functions and apply
`migrations/009_najiki_sms_edge_dispatch.sql` and then `migrations/010_sms_queue_status_normalization.sql` as described in `QUEUE_INTEGRATION.md`.
See `NAJIKI_INTEGRATION.md` for the Na'jiki contract and signed webhook setup.

### 7 — Replace unbounded member queries with paginated ones
```typescript
// Before:
const { data } = await supabase.from('members').select('*').eq('church_id', id);

// After:
import { getMembers } from '@/lib/db/members';
const { data, total, hasMore } = await getMembers(supabase, churchId, page);
```

### 8 — Add rate limiting to sensitive API routes
```typescript
import { checkRateLimit } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, 'sms', tenantId);
  if (limited) return limited; // 429 response
  // ... rest of handler
}
```

---

## What each fix does

| Fix | Impact |
|-----|--------|
| `middleware.ts` — `getSession()` instead of `getUser()` | Eliminates network call on every page load |
| `001_performance_indexes.sql` | Faster RLS policy evaluation under load |
| `lib/cache.ts` + `lib/db/members.ts` | Absorbs read spikes — DB only hit once per 60s |
| `003_sms_queue_table.sql` + Edge Function | SMS sends no longer block HTTP responses |
| `004_cron_jobs.sql` | `refresh_inactive_30_days` no longer full-table scans |
| `lib/rate-limit.ts` | Prevents one bad client from starving the others |
| `011_usher_passkey_columns.sql` | Usher portal can look up a passkey at all |
| `next.config.ts` | ESLint errors caught at build time, not in production |

---

## After applying
Run a load test with k6 to validate:
```bash
npm install -g k6
# Write a k6 script that simulates login → dashboard → member list → check-in
# k6 run --vus 100 --duration 30s your-test-script.js
```
Start at 100 VUs, then 500, then 1000. Watch for p95 > 300ms on admin routes.
