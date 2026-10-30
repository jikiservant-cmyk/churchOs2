# Security review — 2026-10-30

Scope: the `arena/d950f78a-churchos2` branch at `a46e488`. Reviewed as an attacker
with (a) no account, (b) a low-privilege church account (staff/member), (c) a pastor
account, and (d) knowledge of the public anon key (every visitor has it —
`NEXT_PUBLIC_SUPABASE_ANON_KEY` is inlined into the browser bundle).

Method: read every API route, every `'use server'` action module, the middleware, the
service-worker, the shipped RLS policy set and the payment webhook; then **execute the
attacks against a real PostgreSQL (PGlite/PG16) with RLS enforced and the same JWT
claims PostgREST sets for a browser session**. That harness is now in the repo:
`tests/sql/rls_activation_bypass_poc.test.mjs` (`npm run test:sql`).

## Verdict

**Tenant isolation holds. Activation does not, and it is not a close call.**

* Anyone with *any* account in a church — pastor, staff, or member — can mark their
  church as having paid, without paying, using one `PATCH` from browser devtools.
  No server code, no token, no exploit chain. Proven below.
* The same statement rewrites the usher portal code and can delete the church row,
  which cascades to member records where table privileges allow it.
* What held up is the hard part and it held up completely: no cross-tenant read, no
  cross-tenant write, no forging a profile into another tenant, no anon read of the
  church table, no unsigned webhook settlement, no session forgery, no XSS sink, no
  SQL injection in any dynamic SQL, 0 dependency vulnerabilities.

Ready to hold church data: **not yet.** Both P0s are ~a day of work and neither
requires a schema redesign. Do them before onboarding congregations that pay.

---

## Fix status (same day, this branch)

Every finding below is implemented. The two database findings ship as
`migrations/019_activation_ledger_rls.sql` (safe to run at any time) and
`migrations/020_close_church_row_writes.sql` (**run only after this code is
deployed** — the ordering is the finding, not a footnote). `tests/sql/rls_church_row_guard.test.mjs`
applies both files to a real PostgreSQL and asserts the attacks are refused and that
the service role keeps every write the app needs.

| Finding | State | Where |
| --- | --- | --- |
| P0-1 tenant can write its own billing/passkey columns | **Closed** — `FOR ALL` replaced by SELECT-only, plus a BEFORE UPDATE column guard that holds even if a wide policy returns | `supabase-schema.sql`, `migrations/020` |
| P0-2 `createAdminClient()` was not the service role | **Fixed** — sessionless service-role client, loud-once fallback when the key is absent | `lib/supabase/service-client.ts`, `lib/supabase/server.ts` |
| P1-3 ledger has no security posture | **Closed** — RLS + service-role policy + guaranteed grants; refuses to finish if the app would lose access | `migrations/019` |
| P1-4 private HTML cached by the service worker | **Fixed** — default-deny allowlist, cache version bumped so the polluted cache is deleted | `public/sw.js` |
| P1-5 `SameSite=None` with no `frame-ancestors` | **Fixed** — production-only `frame-ancestors` with an `EMBED_HOSTS` allowlist; cookies left alone so live embeds keep working | `lib/security/frame-ancestors.ts`, `next.config.ts` |
| P2-7 webhook signs with the API key | **Reported, not refused** — see the note under P2-7 for why a hard failure was the worse option | `app/api/najiki/webhook/route.ts` |
| P2-8 tenant can delete its own SMS audit trail | **Closed** — `church.sms_logs` narrowed to SELECT for tenants | `migrations/020` |
| P2-6 `my_tenant_id()` nondeterminism | **Retracted** — see the correction under that heading | — |

---

## P0-1 · The activation gate is a column any tenant member can write

`supabase-schema.sql:391`

```sql
CREATE POLICY "Admins can manage their associated church"
  ON church.churches FOR ALL
  TO authenticated
  USING (id = church.my_tenant_id())
  WITH CHECK (id = church.my_tenant_id());
```

`FOR ALL` covers `UPDATE` and `DELETE`. The predicate checks **tenancy only** — never
`role`, never **which column**. `activation_status` and `activation_paid_at` (added by
017) live on that row, and `church.churches.passkey` does too.

This is what the app then believes, because `lib/activation-gate.ts` trusts that row
and `lib/db.ts` reads it:

```js
// logged-in browser console, any church account, ~15 seconds to write
const s = window.__supabase ?? null;              // not even needed:
fetch(`${SUPABASE_URL}/rest/v1/churches?id=eq.${CHURCH_ID}`, {
  method: 'PATCH',
  headers: {
    apikey: ANON_KEY,                              // public, in the HTML
    Authorization: `Bearer ${SESSION_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    'Content-Profile': 'church',
  },
  body: JSON.stringify({ activation_status: 'active', activation_paid_at: new Date().toISOString() }),
});
```

Result in the harness (`npm run test:sql`, all four roles/paths asserted):

```
EXPLOIT: a logged-in pastor clears their own activation gate with one UPDATE   — rows affected: 1; status is now "active"
the write is committed and durable — the app then lets the church into the workspace
EXPLOIT (a staff account): can also write its own church row (FOR ALL, any column)
EXPLOIT (a member account): can also write its own church row (FOR ALL, any column)
EXPLOIT: the same UPDATE rewrites the usher portal code                        — passkey is now "ATTACK01"
EXPLOIT (granted): the FOR ALL policy lets a pastor DELETE the church row and cascade the flock away — members 3 → 0
```

Notes that matter for triage:

* **The gate decision is the only thing that would have made this a non-issue, and it
  was designed the other way round**: `lib/db.ts` stopped *inventing* `'active'` for a
  missing column (good), but the value it now reads is still attacker-writable.
* `passkey` writes do **not** bump `passkey_version`, because the app deliberately
  never bumps it on self-heal (`lib/usher-passkey.ts`) — so swapping the code does not
  log anyone out or alert anyone. Existing usher sessions keep working while the
  credential for *new* logins is the attacker's.
* The `DELETE` half depends on **table privileges**, not policies: it fails with
  `permission denied` where `authenticated` has only `SELECT, UPDATE` on
  `church.churches`, and it works where the project granted `ALL` (Supabase's default
  posture for tables in `public`). Check your project with the query below.
* Cross-tenant writes stay denied (0 rows affected), so this is a *privilege* bug, not
  an isolation bug.

## P0-2 · `createAdminClient()` is not the service role during a user request

`lib/supabase/server.ts:44` builds the "admin" client with `createServerClient(url,
SUPABASE_SERVICE_ROLE_KEY, { cookies: { getAll() … } })`, and supabase-js picks the
bearer token per request (`node_modules/@supabase/supabase-js/dist/index.cjs`):

```js
async _getAccessToken() {
  const { data } = await this.auth.getSession();
  return data.session?.access_token ?? this.supabaseKey;   // ← session wins
}
```

The cookie store *is* the session storage, so inside a logged-in request
`createAdminClient()` sends **the user's JWT** as `Authorization` and the service key
only as `apikey`. PostgREST takes the role from the JWT: **`authenticated`**, not
`service_role`. Consequences:

1. Every "privileged" read/write in a user-initiated path runs under the caller's RLS.
   Today that happens to work because P0-1 makes the caller's RLS as wide as the table.
   **The moment you tighten that policy, these paths break** — which is why the fix
   order below is not negotiable.
2. It also explains the earlier production symptom honestly: a service-role read of a
   table whose `authenticated` policies don't cover it returns **0 rows, no error**.
   `lib/wallet-read.ts` and `isServiceRoleConfigured()` are workarounds for the
   symptom; this is the mechanism.
3. Conversely, nothing here *escalates*: the app never grants more than the caller has.
   It is a correctness and maintenance trap rather than a second bypass — but it is the
   reason "the server checks it" is not currently a security control worth relying on.

## P1-3 · The payment ledger has no security posture in this repository

`church.activation_payments` is the record of who actually paid. No file here creates
it, enables RLS on it, or defines a policy for it — `migrations/008` only adds CHECK
constraints to a table it assumes exists. Whatever protects it today was configured by
hand in the dashboard, and it is invisible to review, CI and any new environment.

This is the single most important thing to close **before** considering the
"derive the gate from the ledger" refactor, because that refactor moves the trust from
a column to this table.

## P1-4 · Signed-in page HTML is cached by the service worker and survives logout

`public/sw.js:84-98` — navigations are network-first, and the successful response is
`cache.put(request, response.clone())` into `SHELL_CACHE`, then served as the offline
fallback. Admin, usher and overseer pages are navigations, and this app server-renders
member names and attendance into that HTML. `app/api/auth/logout/route.ts` deletes the
session cookie and nothing else.

On the shared church tablet a pastor used once: sign out, and the last dashboard
(a page full of member records) remains readable offline. Fix, small:

* skip `cache.put` when the request path matches `/admin`, `/usher`, `/overseer`, `/d/`
  or carries a session cookie, and
* clear the data caches on sign-out (`caches.delete` from the page, or bump
  `CACHE_VERSION` on logout).

## P1-5 · `SameSite=None` session cookies with no `frame-ancestors`

`lib/supabase/server.ts:29`, `lib/supabase/client.ts:20`, `proxy.ts:57` all force
`sameSite: 'none', secure: true`. That is deliberate (iframe embedding). Two things
follow:

* **CSRF is handled** — `proxy.ts:24-31` rejects cross-origin API mutations (missing
  and `null` Origin rejected, `Sec-Fetch-Site: cross-site` rejected),
  `next.config.ts` allowlists server-action origins, and `/api/sms/send|enqueue|logout`
  repeat the check locally. Verified in code; nothing found.
* **Clickjacking is not** — no `X-Frame-Options` and no `Content-Security-Policy:
  frame-ancestors` anywhere (`next.config.ts:56-68` explains CSP was deferred, but
  frame-ancestors alone costs nothing and is the one directive this app needs now).
  Any site can frame `/c/<slug>/admin/settings`. Add
  `Content-Security-Policy: frame-ancestors 'self' <the exact embedder hosts>`, or
  switch to `sameSite: 'lax'` if nothing actually embeds the app.

## P2-6 · ~~`church.my_tenant_id()` is nondeterministic and role-blind~~ — RETRACTED

**Correction, same day.** This finding is not reachable and no fix was made for it.
`public.admin_profiles.id` is the table's PRIMARY KEY (supabase-schema.sql), so a user
has exactly one profile row and an unordered `LIMIT 1` over `WHERE id = auth.uid()`
cannot resolve two tenants. The only live risk in that area was P0-1's `FOR ALL`, which
is closed. The rest of this section is kept as written, because the reasoning that
produced it — "an unordered `LIMIT 1` on a set the author assumed was one row" is worth
checking, and in this schema `admin_profiles` is exactly such a table — and because a
review that silently deletes its own mistakes is not a review.

*Originally written as:*

```sql
SELECT tenant_id::uuid FROM public.admin_profiles WHERE id = auth.uid() LIMIT 1
```

No `ORDER BY`, no role filter: if a user ever has two profile rows, *which* tenant
their session can touch is arbitrary (and P0-1's `FOR ALL` then applies to it). Today
nothing lets a user create a second row (see "what held up"), so this is latent, not
live. Make it explicit: `ORDER BY tenant_id LIMIT 1` plus a CHECK/unique index on
`admin_profiles (id)`, or return `SETOF uuid` and let policies ask "is one of".

## P2-7 · The webhook accepts two different signing secrets

`app/api/najiki/webhook/route.ts:104`
`const secret = process.env.NAJIKI_WEBHOOK_SECRET || process.env.NAJIKI_API_KEY`.
The compatibility fallback is documented (apps provisioned before `webhookSecret`), but
it means the credential used to *call* the payment API can also *authorise* a
settlement notification. Retire the fallback once every app has its own webhook secret.
Everything else about that path is genuinely good: `timingSafeEqual`, strict
`t=<ms>,v=<64 hex>` shape, 5-minute replay window, provider/church/tenant/amount/
currency binding, provider re-reconciliation, and settlement only through the atomic
RPC which requires `p_paid_amount` to equal the ledger row.

## P2-8 · Write policies from the RLS repair are wider than the UI needs

`migrations/016_rls_policy_repair.sql:140` (mine) creates `FOR ALL` policies for
`authenticated` on `church.sms_queue`, `church.sms_logs`, `church.members` and
`church.new_converts`. They restore what the drifted schema had dropped, so removing
them would re-break broadcasts — but `FOR ALL` also means a church user can delete the
SMS audit trail (`sms_logs`) and rewrite queue history. Narrow to the verbs + columns
each screen uses once P0-2 is fixed.

---

## What held up (all of it re-checked in code or proven in the harness)

| Control | Status |
|---|---|
| Cross-tenant `SELECT` on `church.churches` | denied — a pastor reads only their own row |
| Cross-tenant `UPDATE` | 0 rows affected, silently and correctly |
| Forging `admin_profiles` into another tenant | denied (no INSERT policy for `authenticated`) |
| Unauthenticated (`anon`) read of church/member tables | denied |
| Membership & convert tables, attendance, prayers, groups, donations | RLS on, tenant-predicated `USING` **and** `WITH CHECK` |
| Usher sessions | HS256 via `jose`, `exp` 24h, `role`+`church_slug`+`church_id` strictly matched, `passkey_version` revalidated against the row on every request, cookie `httpOnly`+`secure`+`lax` |
| Usher secret | fail-closed: unset, placeholder or `<32` bytes disables login (`lib/usher-passkey.ts:32-45`) — no fallback to the service key |
| Passkey brute force | 100 per 15 min per church + 20 per IP, canonicalised slug so `%`/case can't widen buckets |
| Payment webhook | see P2-7 — the binding checks are the right ones |
| Activation settlement | atomic RPC, `p_paid_amount` must equal the ledger amount, `EXPIRED` treated as failure |
| Rate limits | present on activation start (5/h account, 10/day tenant, 3/h number), SMS single (30/10 min), broadcast (10/min + 5/15 min + volume caps), usher login, missed-you SMS |
| Server-to-server queue | `x-queue-secret` with `timingSafeEqual`, 503 when unconfigured |
| Body/input validation | 500-char/4-segment SMS caps, 250-recipient cap, idempotency keys required, `bodySizeLimit: 1mb` |
| Open redirect | `?returnTo=` matched against `^/overseer/invite/[A-Za-z0-9_-]{1,128}$` |
| XSS | no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval` in `app/`, `components/`, `lib/` |
| SQL injection | every `EXECUTE`/`format()` in the schema and migrations uses `%I`/`%L` or constants; no `'\|\|` concatenation into dynamic SQL anywhere |
| Secrets | no key material committed; `poweredByHeader: false`; HSTS in production; `Referrer-Policy`, `X-Content-Type-Options`, `Permissions-Policy` set |
| Dependencies | `npm audit --omit=dev --audit-level=moderate` → 0 vulnerabilities |

---

## What shipped, and the order to run it in

The order is the substance of this section. The policy tightening in P0-1 and the
client fix in P0-2 are the same bug seen from two sides: the reason the `FOR ALL`
policy was ever needed is that the application's own "admin" writes were running as
`authenticated`. Reversing the two steps locks live churches out of saving their
settings.

**Code (deploy first).**

* `lib/supabase/service-client.ts` — the privileged client: sessionless, `Authorization`
  pinned to the service key, with pure helpers so the failure modes are testable.
  `createServiceClient()` returns `null` rather than a lying client.
* `lib/supabase/server.ts` — `createAdminClient()` uses it. If
  `SUPABASE_SERVICE_ROLE_KEY` is absent it degrades to the caller's own RLS (the
  historical behaviour, which keeps a misconfigured preview readable) and logs
  `serviceClientFallbackNotice` once per process, naming SQLSTATE 42501 as the symptom
  to expect. It does not throw: a hard failure there 500s every page that reads it,
  which is a worse outage than the one being fixed.
* `supabase-schema.sql` — the churches policy is now SELECT-only and the guard trigger
  ships with it, so a new project is born with the closed shape.
* `public/sw.js` — `isPublicPage()` is a default-deny allowlist; a private navigation is
  never written to the shell cache *and* is deleted from it, and `VERSION` moved to `v3`
  so a cache that already holds someone's roster is dropped on activate.
* `lib/security/frame-ancestors.ts` + `next.config.ts` — `Content-Security-Policy:
  frame-ancestors 'self' <app hosts> <EMBED_HOSTS>`, production only. A malformed entry
  is dropped rather than passed through, because one invalid source invalidates the whole
  header. `sameSite: 'none'` was deliberately left alone: it is what keeps a real
  embedded workspace logged in, and with `frame-ancestors` in place it is no longer
  unguarded.
* `app/api/najiki/webhook/route.ts` — reports once per process when
  `NAJIKI_WEBHOOK_SECRET` is unset, or identical to `NAJIKI_API_KEY`, or shorter than 32
  characters. The fallback stays: deployments signing live callbacks with the API key
  would stop activating churches, and a 500 on every callback is not a security win.

**SQL (in this order, one paste each).**

1. **Phase A — `migrations/019_activation_ledger_rls.sql`.** Additive only: enables RLS
   on `church.activation_payments`, installs the service-role policy, and guarantees the
   service role's own grants before it does. Safe before or after the deploy. It refuses
   to commit if the app would lose access to its own ledger.
2. **Phase B — `migrations/020_close_church_row_writes.sql`.** Drops the `FOR ALL`
   policy, installs the SELECT-only one and the column guard, narrows `sms_logs`, then
   verifies its own work and aborts if the hardening did not land. Both the policy
   deletion and the trigger install use `IF EXISTS` / `OR REPLACE`, so re-running it is
   a no-op.
3. Verify on a live church (the probes at the end of this file are the read-only half of
   this): a `PATCH /rest/v1/churches` from a signed-in member console must go from `204,
   1 row` to refused; then rotate a passkey and save meeting days, which are the
   service-role paths — if *those* fail, the deployed code is not this code.

**Deliberately not done.**

* No policy was narrowed anywhere the app has a legitimate `authenticated` writer:
  `members`, `new_converts`, `visitors`, `events`, `attendance_flags`, `sms_queue` keep
  their write policies. The audit that produced this list is what makes step 2 safe, and
  it should be re-run before any further tightening.
* `my_tenant_id()` was not changed (P2-6 retracted above).
* The gate is still read from `churches.activation_status`. Deriving it from the ledger is
  the right end state — it makes the display and the money record the same fact — but it
  is a behaviour change on a paid path and belongs after 019 and 020 have settled, not in
  the same window as them.

## Run these against the live project (read-only)

```sql
-- 1. Which roles can write the church row, and how?
select polname, polcmd, roles.rolname, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
left join pg_roles roles on roles.oid = any (p.polroles)
where n.nspname = 'church' and c.relname = 'churches';

-- 2. Does DELETE/INSERT privilege exist too ( decides the cascade risk )?
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'church' and table_name in ('churches','activation_payments') order by 1,2;

-- 3. Is the ledger protected at all?
select c.relname, c.relrowsecurity, c.relforcerowsecurity,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'church' and c.relname = 'activation_payments';
-- 0 policies + relrowsecurity = false is the bad row.

-- 4. Does anyone have two tenants? ( P2-6 is live if this returns rows )
select id, count(*) as tenants, array_agg(tenant_id) from public.admin_profiles
group by id having count(*) > 1;
```

Then the definitive client-side test, from a **staff or member** account's browser
console on staging: the `PATCH` in P0-1 should come back `204` with `0` rows changed
after the fix, and `403`/`401` from the RLS layer rather than a silent success today.
