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

> **2026-11-01 — the live database corrected this section.** The two bullets above were
> derived from `supabase-schema.sql`, and for a database built from that file they are
> true. A read-only audit of the production project's catalog (`pg_policy`,
> `information_schema.role_table_grants`) found something narrower: `church.churches`
> there carries **one** policy — `SELECT` for `authenticated`, scoped to the tenant *and*
> to `app_type` — and **no tenant write policy at all**. So the `PATCH` in bullet one is
> **not reachable on that database today**: RLS filters it to zero rows changed. The claim
> that it was live-exploitable is withdrawn; what is actually live is bullet three's
> counterpart, a privilege rather than a policy — `anon` and `authenticated` both hold
> `UPDATE`, `DELETE` and **`TRUNCATE`** on `church.churches`, and RLS does not apply to
> `TRUNCATE`. That is `migrations/021_close_excess_grants.sql`.
>
> The lesson recorded here rather than buried: **a repository proves what a fresh install
> does, not what a running project holds.** Every statement in this document about the
> production database is now labelled with which of the two it came from.

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
| P0-1 tenant can write its own billing/passkey columns | **Closed for a database built from this repository**; on the audited production database there was no tenant write policy to drop — plus a BEFORE UPDATE column guard that holds even if a wide policy returns | `FOR ALL` replaced by SELECT-only, plus a BEFORE UPDATE column guard that holds even if a wide policy returns | `supabase-schema.sql`, `migrations/020` |
| P1-7 RLS cannot hide a column: any member can read their own church's usher code | **Fixed** — the browser roles get column-level SELECT on `church.churches`, so the four credential columns are unreadable through REST while every service-role read the app makes is untouched | `migrations/022`, `supabase-schema.sql`, `app/c/…/messages/page.tsx` |
| P1-6 browser roles hold privileges RLS cannot reach (`TRUNCATE` on `church.churches`) | **Found live, closed by revoke** — TRUNCATE/REFERENCES/TRIGGER swept off every table in `church`/`public`/`business`, churches DML revoked behind a guard that refuses if a tenant write policy is still live, `SELECT` deliberately kept | `migrations/021` |
| P0-2 `createAdminClient()` could not fail loudly when the key is missing (the role claim in the heading is retracted — measured as `service_role`) | **Fixed** — sessionless service-role client, loud-once fallback when the key is absent, identity pinned by a test | `lib/supabase/service-client.ts`, `lib/supabase/server.ts`, `tests/admin-client-identity.test.ts` |
| P1-3 ledger has no security posture | **Closed** — RLS + service-role policy + guaranteed grants; refuses to finish if the app would lose access | `migrations/019` |
| P1-4 private HTML cached by the service worker | **Fixed** — default-deny allowlist, cache version bumped so the polluted cache is deleted | `public/sw.js` |
| P1-5 `SameSite=None` with no `frame-ancestors` | **Fixed** — production-only `frame-ancestors` with an `EMBED_HOSTS` allowlist; cookies left alone so live embeds keep working | `lib/security/frame-ancestors.ts`, `next.config.ts` |
| P2-7 webhook signs with the API key | **Reported, not refused** — see the note under P2-7 for why a hard failure was the worse option | `app/api/najiki/webhook/route.ts` |
| P2-8 tenant can delete its own SMS audit trail | **Closed for `sms_logs`** — every tenant write policy dropped by shape, tenant SELECT guaranteed; `members`/`new_converts`/`sms_queue` left as-is on purpose | `migrations/020` |
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
> **CORRECTION, measured 2026-11-01 — the heading is wrong and so was the
> alarm attached to it.** `node scripts/probe-admin-client-identity.mjs` builds the
> client exactly as `lib/supabase/server.ts:44` does on `main` and reads the outgoing
> header: it is `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`, i.e. PostgREST
> resolves the role to **`service_role`**, not `authenticated`. The reason is one line of
> the deployed code: the admin client passes `cookies: { getAll: () => [], setAll: () => {} }`
> — an *empty* store — so `_getAccessToken()` has no session to prefer and falls through
> to `this.supabaseKey`. The `_getAccessToken()` precedence quoted below is real, but it
> only bites a client whose auth storage can see a session, and no revision of this file
> ever passed one to the admin client (`git log --all -S"getAll: async () =>" --
> lib/supabase/server.ts` → nothing).
>
> What survives of the finding: (i) when `SUPABASE_SERVICE_ROLE_KEY` is *absent*, the
> placeholder client turns a privileged read into a silent empty result — the incident
> shape this section named, and what `service-client.ts` + the loud-once notice fix;
> (ii) paths built on `createClient()` genuinely do run under the caller's policies,
> which is the whole reason P0-1 was reachable from the browser; (iii) the design smell
> of an "admin" client whose identity depends on a cookie adapter is worth removing even
> when it happens to be correct today.
>
> What does **not** survive: the ordering rule in "What shipped" below. Narrowing
> `authenticated` policies and revoking `authenticated` privileges cannot interrupt the
> application's privileged writes, because those writes are not `authenticated`. See the
> dated production record at the end of this file.


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

**What was actually done, and the two mistakes made on the way.** `migrations/020` now
drops every tenant-capable write policy on `church.sms_logs` by *shape* (cmd + roles,
never touching one that also names `service_role`), then guarantees a tenant SELECT
policy remains, resolving the tenancy column from `information_schema`. The first draft
instead dropped a policy named `sms_logs_churchos_service_write` — **a name invented here,
not one that exists** (the live names are 016's `churchos_tenant_write` and the schema's
`sms_logs_insert` / `sms_logs_rw_update` / `sms_logs_delete`) — and rebuilt the read
policy on `church_id`, a column this table does not have: `church.sms_logs` keys tenancy
on `tenant_id`. That would have aborted Phase B at step 3. It passed CI at first because
the harness had no `sms_logs` table, so the step took its own "does not exist, skipping"
branch: **a test that skips a code path is how a broken migration looks green.** The
fixture now carries both naming shapes and asserts delete/insert are refused, reads
still work, and the dispatcher can still log.

`members`, `new_converts` and `sms_queue` keep their `FOR ALL` policies on purpose: they
are what the roster screens and the broadcast queue write through, and each is scoped by
`USING`/`WITH CHECK` to the caller's own tenant (verified policy-by-policy, 37 write
policies checked for a tenant or owner predicate — all 37 are scoped). Narrowing them to
per-verb, per-column policies is a real improvement and a real chance of breaking a
screen; it is deliberately not part of this change.

---

## P1-7 · RLS hides rows, never columns — so the usher code was readable by any member

**Finding, and it is a different bug from P0-1.** `church.churches` is protected by a
tenant predicate, `id = church.my_tenant_id()`, and that predicate is *good*: no church
can read another church's row. It is also the only protection on the column that holds
`passkey` — the shared usher code, stored in plain text because the attendance screen has
to show it to a pastor so they can tell a volunteer what to type. So this succeeds for
**any signed-in account of that church**, pastor or member, from a browser:

```
GET /rest/v1/churches?id=eq.<that-church-uuid>&select=passkey
```

The row matches the policy, so the row is returned, and RLS has no notion of
"this column, not that one". `020` stopped tenants *writing* the credential (policy +
column guard) and `021` stopped them *truncating* the table; neither had anything to say
about reading it. The admin portal itself is role-gated — `layout.tsx` admits only
`pastor`/`admin` — but PostgREST does not consult the router, so the gate was a UI
convention, not a boundary.

**Fix: `migrations/022_hide_church_credential_columns.sql`.** Revoke the table-level
`SELECT` from `anon`/`authenticated` and grant back every column *except*
`passkey, passkey_hash, passkey_version, passkey_updated_at`. A browser-role query that
names a hidden column now gets 42501 rather than a code. Three properties made it safe
rather than merely strict:

* **the granted list is built from the catalog, never hard-coded** — the same lesson 020
  learned the hard way, so a database where 011/017 have not run still applies cleanly
  and only hides what exists (`tests/sql/church_column_privileges.test.mjs` asserts
  exactly that shape);
* **it refuses to run beside a policy that reads a hidden column** (policy expressions are
  evaluated under the querying role's column privileges, so that combination would have
  turned every member's admin screen into an error) **or a view that walks around the
  grant** — including the `security_invoker` case, whose semantics live in
  `pg_class.reloptions` and *not* in a `relsecurity` column, which does not exist in any
  released Postgres; the first draft used `c2.relsecurity` and the harness caught it;
* **it proves the outcome by running the queries as the roles**, inside its own
  transaction: the granted columns readable, `public.churches_public` still executable,
  the hidden column refused, `service_role` intact — and it will not commit on a promise.

**What had to change in the application:** one query.
`app/c/[church_slug]/admin/(authenticated)/messages/page.tsx` read
`.from('churches').select('*')` on the *caller's* client and used five fields of it. With
column-level grants, `select=*` is a permission error, so it now names those five. It was
also the repository's only such read: every other access to the four hidden columns
(`attendance/page.tsx:30,36`, `lib/attendance-actions.ts:61,229,432`,
`lib/usher-passkey.ts:126,164,171`, `lib/tenant.ts:38-40`) goes through
`createAdminClient()` or `scopedDb.admin`, and `service_role` keeps the table-level
privilege. No browser component queries this table at all. The over-fetch was worth
removing on its own terms: a page that selects `*` from a table is a page that silently
starts shipping whatever column is added next.

**What this deliberately does not do.** There is **no hashing requirement and no re-issue**
of existing codes: the code has to stay readable by a human, so it stays stored as a
value on the row. Consequences, stated rather than buried —

* anyone holding the service key, the table owner's connection, or the Supabase dashboard
  still sees every church's usher code in plain text. 022 hardens *tenant against tenant*,
  which is the boundary RLS is meant to enforce; it is not a defence against an operator
  or a stolen service key. `passkey_hash` already exists and the login path prefers it
  (`attendance-actions.ts` compares the HMAC when present), so a future change to
  hash-only storage is available, but it is a product decision about whether the pastor
  should still be able to read the code back, not a security fix I can make unilaterally;
* `sender_id` and the billing columns stay readable by the tenant: they are configuration
  and status the tenant's own screens display, and hiding them would break the SMS enqueue
  route and the activation screen for no secret gained;
* no policy is created, dropped or edited here — `020` and `021` own that surface.

`migrations/022` is in `supabase-schema.sql` too (marked `BEGIN/END 022-CONVERGED`, with a
test that extracts the schema's own block and *runs* it), so a new project is not born with
the hole. One behaviour change to know about: a browser-role `select=*` on this table now
fails loudly instead of returning everything — nothing in the repository does one, and the
rollback is a single statement at the foot of the file.

---

## P1-8 · The application calls database functions this repository has never seen

Triggered by the 2026-11-01 preflight, which surfaced a missing `public.churches_public`
and sent me looking for other divergence. I enumerated every RPC the application calls and
asked the repository where each one is created:

```
grep -rhoE "\.rpc\('[a-z_0-9]+'" app lib components     →  17 distinct functions
grep -rl "FUNCTION [a-z_.]*<name>(" --include="*.sql" .   →  7 found, 10 not defined here
```

| Called by the app | Defined in this repository |
| --- | --- |
| `my_login_context` — three login screens (`app/admin/login/page.tsx`, `app/admin/page.tsx`, `app/applet/app/admin/login/page.tsx`) | **no** |
| `provision_church_v3` — every new church signup (`lib/provision-actions.ts`, `lib/denomination.ts`, `lib/usher-passkey.ts`) | **no** — and `migrations/014_passkey_not_null.sql:9-10` *describes* it as an invoker-mode wrapper delegating to `private.provision_church_v3_impl` (SECURITY DEFINER), which is also **not defined here**. A migration documents a function the repository does not contain. |
| `overseer_church_summary`, `overseer_create_invite`, `overseer_list_invites`, `overseer_revoke_invite`, `overseer_detach_church`, `overseer_denomination_totals`, `create_denomination_overseer_invite`, `redeem_denomination_overseer_invite` — the platform-overseer and denomination-admin surface (`lib/overseer-actions.ts`, `lib/super-admin-overseer-actions.ts`) | **no**, all eight |
| `get_denomination_branding` | **no** |
| `increment_event_attendance`, `decrement_event_attendance`, `refresh_inactive_30_days`, `process_topup_webhook` | `supabase-schema.sql` |
| `activate_church_workspace_v2` | `migrations/008` |
| `refresh_consecutive_event_flags` | `migrations/005` |

Why this is a security finding and not housekeeping: the money and identity paths that
were *not* covered by this review's source reading are exactly these ten. `provision_church_v3`
creates tenants and credentials; the eight overseer functions read and write across
churches by design, which is the one place in the product where cross-tenant access is
legitimate — so their internal guards are load-bearing, and I cannot see them. Concretely,
for each one it is unknown to version control: whether it is `SECURITY DEFINER`, whether
`search_path` is pinned (an unpinned path in a definer function is a search_path hijack),
who owns it, and whether `EXECUTE` is granted to `anon` or `authenticated`. Two of the
hardening items in this file turn on that last fact: `supabase-schema.sql:338` revokes
`EXECUTE` on `provision_church_v2`, a function the app no longer even calls, while the v3
that it does call has never passed through this repository.

This also explains the drift pattern the preflight showed — the ledger's policy, the
`app_type` scoping on `church.churches`, the missing `churches_public` view: this project
has a second, undocumented deployment channel, the dashboard.

**Remediation, in order, and none of it needs a deploy:**

1. Inventory and dump the ten (queries at the foot of this section), paste them here.
2. I audit them against the same bar as the rest of the review — definer mode, pinned
   `search_path`, `EXECUTE` grantees, and for the overseer set, whether each one checks
   the caller's identity against the church it is about to touch.
3. They land as `migrations/023_trusted_database_functions.sql` with
   `CREATE OR REPLACE FUNCTION` from the dumped definitions, so the next environment is
   reproducible and the next review can actually read them. The dump is the source of
   truth; nothing is rewritten silently, because a "cleanup" of a function nobody has
   reviewed is how a live app loses a guard it did not know it had.

```sql
-- (1) metadata for everything the app calls but this repository does not define
select n.nspname||'.'||p.proname as function,
       p.prosecdef                       as security_definer,
       pg_get_userbyid(p.proowner)       as owner,
       coalesce(array_to_string(p.proconfig, ', '), '(search_path NOT pinned)') as settings,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as member_can_execute,
       pg_get_function_identity_arguments(p.oid) as arguments
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where p.proname in ('my_login_context','provision_church_v3','provision_church_v3_impl',
                     'get_denomination_branding','overseer_church_summary','overseer_create_invite',
                     'overseer_list_invites','overseer_revoke_invite','overseer_detach_church',
                     'overseer_denomination_totals','create_denomination_overseer_invite',
                     'redeem_denomination_overseer_invite')
 order by 1;

-- (2) the definitions, overloads included — paste the two that matter most first
select p.proname, pg_get_functiondef(p.oid) as definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public','church','private')
   and p.proname in ('provision_church_v3','provision_church_v3_impl','my_login_context')
 order by 1;
```

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

The order in this section was written around a claim that turned out to be wrong —
read the correction under P0-2 first. The original reasoning: `FOR ALL` existed because
the app's own "admin" writes ran as `authenticated`, so deploying the client fix had to
precede the policy narrowing or live churches would lose their settings. Measured
behaviour: those writes already run as `service_role` (`Bearer <service key>` on the
wire, verified by `scripts/probe-admin-client-identity.mjs`), and `service_role` bypasses
RLS and keeps every grant these files revoke. So **019, 020 and 021 are safe before or
after the deploy**, and that is now how they were in fact applied on 2026-11-01 — with
nothing in the application redeployed — with the results recorded at the end of this
file.

The order still worth keeping, for a different reason, is **020 before 021**: 021's step 3
refuses to revoke `church.churches` DML while a tenant write policy is live, so that a
cleanup can never double as a behaviour change. On a database with no tenant write
policy — the audited production one — 021 runs standalone and 020 only installs the
column guard. Deploying this branch is still what closes P0-1 for *new* installs and
makes the missing-key case loud; it is simply no longer a precondition for the SQL.

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
   this). The expected PASS is **`HTTP 204` with `[]` / zero rows changed** and a re-read
   showing the old status — *not* a 403. With no UPDATE policy, PostgREST filters the row
   away silently, so "0 rows" is the success signal and a 204 on its own proves nothing;
   the `42501` text from the column guard only appears once a write policy exists again,
   i.e. as a regression alarm. On the audited production database this probe already
   returned 0 rows before Phase B — which is how the discrepancy in the Verdict box was
   found. Then rotate a passkey and save meeting days, which are the service-role paths —
   if *those* fail, the deployed code is not this code. (And on a database that has no
   tenant write policy at all, those service-role writes are the ones that were silently
   doing nothing, so 020 plus this PR's client fix is what makes them work again.)
4. **Phase C — `migrations/021_close_excess_grants.sql`.** Privileges, not policies: the
   `TRUNCATE`/`REFERENCES`/`TRIGGER` sweep, the churches DML revoke, and the ledger's write
   grants. Run it **after** 020 on any database where tenant write policies exist — its
   step 3 counts them and aborts rather than pulling a grant out from under a live policy,
   so on such a database it refuses; on the audited production database it changes
   behaviour in exactly one place, and it is a privilege no code path holds.

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

-- 4. Sanity only, expected to return NOTHING by construction: admin_profiles.id is the
-- PRIMARY KEY, which is why P2-6 was retracted. Rows here would mean the PK was dropped
-- by hand at some point, and then the live schema has drifted from this repository.
select id, count(*) as tenants, array_agg(tenant_id) from public.admin_profiles
group by id having count(*) > 1;
```

Then the definitive client-side test, from a **staff or member** account's browser
console: replay the `PATCH` in P0-1 with `Prefer: return=representation`. After 020 the
correct outcome is **`204` with `[]`, i.e. zero rows changed, and the re-read still shows
`pending_payment`** — not a 403. PostgREST does not raise when RLS filters every row out of
an UPDATE; it reports success over an empty set. (A `400` carrying
`billing and credential column … service role` is what the *trigger* returns, and it only
appears on a path that still has a write policy — i.e. after a regression.) Judging this
fix by "did it 403?" would have told you the opposite of the truth.

---

## 2026-11-01 · reconciliation with the live catalog

Read-only queries run against production, and what they changed in this repository.

| Claim in this document | Production catalog said | What was done |
| --- | --- | --- |
| P0-1: a tenant `PATCH` marks the church paid today | No tenant write policy on `church.churches`, so zero rows change | Verdict annotated above; the finding stands for any DB built from `supabase-schema.sql`, which is what 020 and the schema edit fix |
| P1-3: the ledger has no posture in the repo (RLS off, no policies) | RLS **enabled**, one policy present, `authenticated` holds SELECT only | 019 stays — it is what a fresh DB needs, and it is idempotent — but its `RAISE` on "RLS off" would not fire here, and the deferred revoke at 019:128 became 021's step 4 |
| (nothing in this document) | `anon` + `authenticated` hold UPDATE/DELETE/**TRUNCATE** on `church.churches` | New finding **P1-6** and `migrations/021_close_excess_grants.sql` |
| (nothing in this document) | the churches read policy also filters on `app_type` | **No `app_type`-scoped churches policy exists anywhere in this repository** — 020 as first written would have *added* a looser SELECT policy beside it. Permissive policies OR together, so that would have widened read access on a database that is currently stricter. 020 now counts existing tenant SELECT policies and skips-and-reports instead of adding |

Two defects in my own hardening scripts, both found by taking the live evidence
seriously rather than re-reading the repo:

1. **020 widened reads.** Step 1b created its SELECT policy unconditionally. Fixed:
   `migrations/020_close_church_row_writes.sql` step 1b now runs the `CREATE POLICY`
   only when no `authenticated` select-capable policy exists, and reports the skip.
   `tests/sql/rls_church_row_guard.test.mjs` · *"020 never widens a stricter SELECT
   policy that is already live"* builds the app_type-scoped shape and asserts the strict
   predicate is the one still in force.
2. **Both catalog checks were blind, in two different ways.** 021's guard looked for
   write policies with `polcmd IN ('w','i','d','a')` and 020's new 1b check used
   `('r','a')`. Two mistakes each time:

   * `pg_policy.polcmd` is a single char and **`FOR ALL` is stored as `*`**; `INSERT` is
     `'a'` and there is no `'i'` at all. So a database whose tenant policy is `FOR ALL` —
     every database this repository ships — was counted as having no write policy, and
     021 would have revoked the grant out from under it, the exact behaviour change the
     guard exists to refuse. (`migrations/016` and `scripts/fix-sms-wallet-rls.sql` already
     used the right set, `('r','*')`; the harness caught this only because a test asserted
     the abort.)
   * A policy created **without a `TO` clause** applies to PUBLIC, and `pg_policy` stores
     that as `polroles = {0}` — which is not `'{}'` (so `= '{}'` never matches) and casts
     through `regrole` to `{-}` (so a role-name `LIKE` misses it too). Both files had a
     branch written for that case that could not fire.

   Fixed by dropping `pg_policy` in both places and reading **`pg_policies`**, where `cmd`
   is `'ALL'/'UPDATE'/'INSERT'/'DELETE'/'SELECT'` and `roles` renders `{public}`. Three
   tests now hold the line: *"021 refuses to revoke DML while a tenant write policy is
   still live"* (`FOR ALL TO authenticated`), *"the same guard fires for a PUBLIC write
   policy, which pg_policy hides"* (no `TO` clause, and it asserts the raw catalog really
   is invisible first, so the test cannot silently stop proving anything), and *"020 also
   defers to a PUBLIC read policy"*.

`tests/sql/grants_hardening.test.mjs` is also the first test in this repository that
proves the grant/policy distinction directly: as `authenticated`, an `UPDATE` on another
church's row is filtered to **0 rows** by RLS, while `TRUNCATE church.churches CASCADE`
on the same table by the same role **succeeds and empties it** — every church, plus the
member rows that hang off it. After 021 the first still returns 0 rows (nothing about
policies changed) and the second is `permission denied for table churches`, while
`service_role` keeps every write the application makes and `anon` keeps the SELECT that
`public.churches_public` — declared `WITH (security_invoker = true)`, so it reads the base
table as the visitor — needs in order to stay executable at all.

**Still open after all of this**, unchanged and stated plainly: intra-tenant
authorization — 0 of 79 policies are role-aware and there is no `is_church_admin()` SQL
helper, so any signed-in member can still write the tenant-scoped tables that carry
`authenticated` write policies (members, new converts, sms_queue, attendance flags).
That is a design decision recorded in `lib/auth-security.ts`, not an oversight, and no
migration in this branch changes it.

---

## 2026-11-01 · Phase B and Phase C applied to the live project

Run against production **before** this branch was merged or deployed, which the
correction above is what made safe. Reported results:

* **020 (Phase B).** Step 1b's new guard found the existing tenant SELECT policy on
  `church.churches` and **declined to add a second one** — the behaviour that would
  otherwise have widened reads on a database stricter than the repository. Nothing else
  in 020 had anything to drop (no tenant write policies existed), so what actually landed
  there is the `guard_church_privileged_columns` trigger and the `sms_logs` narrowing.
* **021 (Phase C).** Committed with its own validation checks passing. Post-change:
  `authenticated` TRUNCATE on `church.churches` **false**, `anon` TRUNCATE **false**,
  `anon` SELECT **true** (public view path intact), `service_role` UPDATE **true** (admin
  write path intact). Browser-role `TRUNCATE`/`REFERENCES`/`TRIGGER` revoked across
  `church`/`public`/`business`; `INSERT`/`UPDATE`/`DELETE` revoked on `church.churches`;
  ledger write privileges revoked. The ledger's `SELECT` grant and policy were left
  alone, as the script specifies.

Why no application path could have been broken by the revokes, stated as a check rather
than a promise — every writer of the two narrowed tables on `main`:

| Path | Client on the wire | Affected by 020/021? |
| --- | --- | --- |
| `lib/church-settings-actions.ts:24` (meeting days) | `createAdminClient()` → `service_role` | no |
| `lib/attendance-actions.ts:87,257,459` (passkey rotation, attendance) | `createAdminClient()` → `service_role` | no |
| `app/c/…/settings/page.tsx:27,33` (churches reads) | `adminDb` → `service_role` | no |
| `lib/activation/index.ts` (ledger + gate) | `getAdminClient()` → `service_role` | no |
| `app/api/najiki/webhook/route.ts:197,248,288` (`sms_logs`, ledger, activation) | service client | no |
| `supabase/functions/church-najiki-dispatch` (`sms_logs` upsert/update) | service key from function secrets | no |
| `app/c/…/messages/page.tsx:227` (`sms_logs` **read**) | caller's session | no — 020 guarantees a tenant SELECT policy remains |
| new-church signup | `public.provision_church_v2`, `SECURITY DEFINER` | no — runs as the owner, not the caller |

**2026-11-01 · `migrations/022` preflight, read-only (file NOT applied yet).** Live
`church.churches` carries all four credential columns; **both `anon` and `authenticated`
can currently read every column of it**, so the P1-7 exposure is confirmed present, not
inferred; no browser-role policy on that table references any hidden column (so 022's
step-1 guard will not fire); and **`public.churches_public` does not exist in the live
database at all**, which is why 022's view loop will find nothing — expected, not a
failure, and the reason 021's header note about that view was corrected. The 022 apply is
held until PR #22 is deployed, because the version of `messages/page.tsx` running on
`main` still does `.from('churches').select('*')` on the caller's client and would start
raising 42501 on the SMS page. That search for divergence is what produced **P1-8**,
which is the bigger finding.

The last two rows are the ones to watch at runtime, because they *are* the caller's
identity: a member opening SMS send history must still see their own rows, and a new
church must still provision end to end. Both are unaffected by privilege changes for the
reasons in the table, but they are the two assertions worth doing in a browser.

**Optional follow-up, deliberately not run.** `authenticated` and `anon` still hold
`SELECT` on `church.activation_payments`. The table has no browser-role reader anywhere
in `app/` or `lib/` (the webhook and `lib/activation` both use the service role), so the
grant is wider than any code path needs:

```sql
-- read-only first: does anything grant a policy that depends on it?
select polname, polcmd, pg_get_expr(polqual, polrelid)
  from pg_policy p join pg_class c on c.oid = p.polrelid
 where c.relname = 'activation_payments';
-- if the only reader is service_role, this is the last of it:
-- revoke select on church.activation_payments from anon, authenticated;
```

It is left as a decision because the production ledger policy was created outside this
repository, so unlike the TRUNCATE case I cannot prove from code what depends on that
grant being there — and a revoke whose justification is a grep is a worse trade than a
grant sitting under a policy that already denies the rows.

---

## Closing status · 2026-11-01

Read this section first if you are picking the work up later. It is the only part that
describes what is *actually where*, as opposed to what the audit found.

### Applied to the live database (2026-11-01, before any deploy — and that was safe, see the P0-2 correction)

| File | Landed on production | Evidence |
| --- | --- | --- |
| `migrations/020_close_church_row_writes.sql` | **Partly by design.** Step 1b detected the existing tenant SELECT policy and declined to add another; there were no tenant write policies to drop; the `guard_church_privileged_columns` trigger and the `sms_logs` narrowing are what actually changed | Reported notices, plus the `pg_policies` probe in "Run these against the live project" |
| `migrations/021_close_excess_grants.sql` | **Yes, committed with its own assertions passing** | `authenticated`/`anon` TRUNCATE on `church.churches` → false; `anon` SELECT → true; `service_role` UPDATE → true |
| `migrations/019_activation_ledger_rls.sql` | **Unconfirmed.** The audit found RLS enabled on `church.activation_payments` with one policy whose role/command was never reported back — which could be 019, or hand-set dashboard config. Do not assume either way | Run the query below |

```sql
-- Did 019 land, or is the ledger protected by hand-configured policy alone?
select p.polname,
       case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                     when 'd' then 'DELETE' when '*' then 'ALL' end            as cmd,
       r.rolname                                                               as for_role,
       c.relrowsecurity, c.relforcerowsecurity
  from pg_policy p
  join pg_class c     on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_roles r on r.oid = any (p.polroles)
 where n.nspname = 'church' and c.relname = 'activation_payments';
```

`019` is idempotent and additive, so if that comes back with a `service_role` policy and
`relforcerowsecurity = false`, re-running it is a no-op; if the only policy is for
`authenticated`, re-running it is what gives the application its ledger access.

### In the repository, waiting on a merge

PR #22, head `1fe58cc`+ (`022` follows in the same branch), into `main` — CI green on every step (`typecheck`, `lint`, `test`
253/253, `test:sql` 63/63, `security:audit`, `build`; the SQL suite now runs in CI so the
policy and privilege proofs cannot rot silently). **`main` is still `7523871`, so none of
the application-side fixes are live**: the fee/test-pricing source, the gate that an unpaid
church cannot slip through, the usher passkey for new churches, the default-deny service
worker, `frame-ancestors`, the sessionless service-role client with its loud-once
fallback, and the schema's closed-by-default churches policy for *new* installs.

### Set these when you deploy (all three are documented in `.env.example`, +37 lines on this branch)

* `SUPABASE_SERVICE_ROLE_KEY` — the admin path depends on it; without it the deployed
  build answers privileged reads with a silent empty result. `npm run probe:admin-identity`
  shows what the client presents, and should be re-run after any `@supabase/*` bump.
* `NAJIKI_WEBHOOK_SECRET` — give it its own value of 32+ characters, different from
  `NAJIKI_API_KEY`. The app now warns once per process instead of refusing, because
  deployments that sign with the API key must keep activating churches.
* `EMBED_HOSTS` — leave unset unless the workspace is genuinely framed by another origin;
  `frame-ancestors` is production-only and a malformed entry is dropped rather than
  passed through.

### Deliberately not done, so it does not look overlooked

* **Intra-tenant authorization.** 0 of 79 policies are role-aware and there is no
  `is_church_admin()` SQL helper, so any signed-in member can still write the
  tenant-scoped tables that carry `authenticated` write policies (`members`,
  `new_converts`, `sms_queue`, attendance flags). Recorded in `lib/auth-security.ts`;
  changing it is a product decision with lockout risk, not a patch.
* **Do not copy production's `app_type` predicate into the repo's policies.** It looked
  like the stricter shape and 020 now defers to it, but `app_type` is a live discriminator
  across `public.wallets` and provisioning (`app_type: 'church'` upserts,
  `lib/provisioning-security.ts`), and `church.churches.app_type` has no CHECK
  constraint — hard-coding `'church'` into the churches read policy would deny a non-church
  tenant its own row. If that scoping is wanted, it has to compare the caller's profile
  `app_type`, not a literal, and that is a migration of its own with its own tests.
* **No hashing of the stored usher code, on instruction.** `022` removes the *read*
  path for the browser roles and leaves the storage as it is, because the pastor must be
  able to read the code aloud. `passkey_hash` and the HMAC comparison already exist, so
  hash-only storage is a later decision, not a blocker here. See P1-7 for the consequence.
* **Ledger `SELECT` for `anon`/`authenticated`** left in place (see the table above for the
  preflight); and the gate still reads `churches.activation_status` rather than being
  derived from `activation_payments`, which is the right end state but a paid-path
  behaviour change that belongs after this settles.
* Backups, PII retention and the Supabase dashboard's own exposure are out of scope for a
  code review and were not touched.

### One-line summary

Cross-tenant isolation holds, the church row is now write-protected at both the policy and
the privilege layer on the live database, and the remaining risk is *inside* a tenant
rather than between tenants. What is left is a deploy decision and one query.
