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

## P2-6 · `church.my_tenant_id()` is nondeterministic and role-blind

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

## Fix in this order (skipping step 1 is how the tightening breaks production)

1. **Make the admin client actually be the service role.** Build it with
   `createClient` from `@supabase/supabase-js` (or `createServerClient` with
   `global.headers.Authorization = 'Bearer ' + SERVICE_KEY` and **no** cookie storage),
   and assert it in a test that the bearer used for an admin read is the service key.
   Nothing else can move safely until this is true.
2. **Confirm every legit write to `church.churches` is server-side.** Known writers:
   `updateChurchPasskey` (pastor-only, role-checked), `updateChurchMeetingDays`
   (`assertChurchAdminAuth` → pastor), provisioning + `ensureChurchUsherPasskey`, the
   008 settlement RPC. Anything in the browser that PATCHes `churches` is a feature
   that must move to an action first, or it breaks in step 3.
3. **Replace the policy** — `SELECT` for tenancy, and an explicit
   `FOR UPDATE … (pastor role) WITH CHECK (only benign columns)`. Draft, to ship as
   `migrations/019_tighten_church_row_rls.sql`, for review rather than blind apply:

   ```sql
   DROP POLICY "Admins can manage their associated church" ON church.churches;

   CREATE POLICY "Members can read their own church"
     ON church.churches FOR SELECT TO authenticated
     USING (id = church.my_tenant_id());

   -- The columns the settings screen legitimately edits. activation_*, passkey*,
   -- is_active and the identity columns are NOT in this list, so a policy-compliant
   -- PATCH cannot reach them. WITH CHECK alone is not enough — pair it with the
   -- guard trigger below so "I did not change it" cannot be bypassed by writing the
   -- same value another way.
   CREATE POLICY "Pastors can edit their church presentation"
     ON church.churches FOR UPDATE TO authenticated
     USING (id = church.my_tenant_id() AND church.is_church_admin())
     WITH CHECK (id = church.my_tenant_id());

   CREATE OR REPLACE FUNCTION church.guard_church_privileged_columns()
   RETURNS trigger AS $$
   DECLARE v_role text;
   BEGIN
     -- No JWT means a trusted server/edge connection (or a human in the SQL editor).
     v_role := coalesce(
       nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
       'service_role');
     IF v_role <> 'service_role' THEN
       IF NEW.activation_status   IS DISTINCT FROM OLD.activation_status
         OR NEW.activation_paid_at IS DISTINCT FROM OLD.activation_paid_at
         OR NEW.passkey           IS DISTINCT FROM OLD.passkey
         OR NEW.passkey_hash      IS DISTINCT FROM OLD.passkey_hash
         OR NEW.passkey_version   IS DISTINCT FROM OLD.passkey_version
         OR NEW.is_active         IS DISTINCT FROM OLD.is_active THEN
         RAISE EXCEPTION
           'church.churches: billing and credential columns are written only by the application service role'
           USING ERRCODE = '42501';
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, church;

   DROP TRIGGER IF EXISTS guard_church_privileged_columns ON church.churches;
   CREATE TRIGGER guard_church_privileged_columns
     BEFORE UPDATE ON church.churches
     FOR EACH ROW EXECUTE FUNCTION church.guard_church_privileged_columns();
   ```

   (`church.is_church_admin()` does not exist yet — it is the same shape as
   `my_tenant_id()`: `SECURITY DEFINER`, pinned `search_path`, returns the caller's
   role. Add it in the same migration or drop it from the policy and rely on the
   application's own role check plus the trigger.)
4. **Give the ledger a declared posture.** `migrations/020_activation_ledger_rls.sql`:
   `ENABLE ROW LEVEL SECURITY`, `FOR ALL TO service_role USING (true)` and **no**
   authenticated policy — reads for the pastor's own billing history go through an RPC
   that binds `tenant_id = church.my_tenant_id()`. Also fold `GRANT`/`REVOKE` in, since
   privileges are a separate gate (that distinction is what produced two past
   incidents in this repo).
5. **Then consider deriving the gate** from `exists (select 1 from
   church.activation_payments where church_id = … and status = 'paid')` instead of a
   stored column. At that point the bypass stops being a column and becomes a row that
   only a signed provider settlement can create.
6. Small, independent, ship any time: SW cache scoping + clear-on-logout (P1-4),
   `frame-ancestors` (P1-5), `my_tenant_id()` determinism (P2-6).

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
