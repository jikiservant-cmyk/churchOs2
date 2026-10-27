# Usher Portal — test report

**Target:** `/c/[church_slug]/usher` and `/c/[church_slug]/usher/dashboard`
**Date:** 2026-10-27 · Next.js 16.4.2, live dev server on port 3000
**Harness:** `tests/helpers/mock-postgrest.mjs` — a minimal PostgREST mock so the
usher flow executes without a Supabase instance. Login was exercised through the
real `validateUsherPasskey` Server Action (action id `60625a97…`), not a stub.

---

## Verdict

**Security: solid.** Every forged, tampered, expired, cross-tenant and
`alg: none` token is rejected. Tenant scoping is derived server-side and is
correct everywhere I could reach.

**One real defect found and fixed:** the Log Out button did not log anyone out.

---

## The bug: logout was a dead link

The dashboard header rendered the sign-out control as:

```tsx
<Link href={`/${church_slug}/usher`}><LogOut /></Link>
```

`logoutUsher()` existed in `lib/attendance-actions.ts` but was **called from
nowhere in the codebase**. Navigating to the entry page does not clear the
`usher_session_*` cookie, so the 24-hour session survived "logging out".

Proven live before the fix:

| Step | Result |
|---|---|
| Log in with the real passkey | `Set-Cookie: usher_session_grace-church=…; Max-Age=86400` |
| Click Log Out (`GET /grace-church/usher`) | `200`, **no `Set-Cookie`** |
| Open the dashboard again with the same cookie | **`200` — still signed in** |

**Why it matters here specifically:** an usher portal runs on one shared tablet
passed between volunteers. Whoever holds the tablet after a service inherits a
valid session — full member list, phone numbers, and the ability to mark
attendance — for up to 24 hours, with no way for the church to end it short of
rotating the passkey.

**Fix:** `POST /api/auth/usher-logout?church=<slug>` (`app/api/auth/usher-logout/route.ts`)
clears the cookie and 303s back to the entry page, wired to a plain HTML form so
it works before hydration or with JavaScript disabled. It enforces the same
origin check as the other mutations, and is exempted from the proxy's
Supabase-session fail-closed rule because usher auth is a JWT cookie, not a
Supabase session (without that exemption every usher logout returned 503).

Verified after the fix:

| Step | Result |
|---|---|
| `POST /api/auth/usher-logout?church=grace-church` | `303` + `Set-Cookie: usher_session_grace-church=; Expires=Thu, 01 Jan 1970` |
| Dashboard with no cookie afterwards | `307 → /grace-church/usher` |
| Cross-origin POST (`Origin: https://evil.com`) | `403` |
| POST with no `Origin` | `403` |
| `GET` | `405` |
| Empty slug | `400` |

---

## Token forgery matrix — all rejected

Tokens minted with the real secret, then tampered. Every case below redirects to
the entry page (`307`) instead of rendering the dashboard.

| Attempt | Result |
|---|---|
| Valid token | **200** (control) |
| Signed with a different secret | 307 |
| `role: "admin"` instead of `usher` | 307 |
| No `church_id` claim | 307 |
| `church_slug` for a different church | 307 |
| Expired (`exp` in the past) | 307 |
| `alg: "none"` (unsigned) | 307 |
| Garbage / non-JWT string | 307 |
| Correct token, wrong cookie name | 307 |
| Stale `passkey_version` (simulates rotation) | 307 |

`getUsherSession()` is the reason this holds: it verifies the signature, then
**re-binds to the database** — the church must still exist, its slug must equal
the requested slug, and `passkey_version` must match, so rotating a passkey
revokes every outstanding session immediately.

## Tenant isolation — verified in the request log

Every query the usher flow issues is scoped by `church_id`, taken from the
session or the event row — never from client input:

```
churches?select=id,name,passkey,passkey_hash,passkey_version&slug=eq.grace-church
churches?select=id,slug,passkey_version&id=eq.<session church_id>
events?church_id=eq.<id>&status=eq.active
members?church_id=eq.<id>
attendance_logs?church_id=eq.<id>&event_id=eq.<event id>
```

The passkey lookup uses `.eq` rather than `.ilike`, so `%` and `_` cannot act as
wildcards. `checkAuthorization()` resolves the church from the **event row** and
requires `session.church_id === event.church_id`, so an usher for church A
cannot mark attendance on church B's event even with a valid session.

A login attempt with a foreign slug (`other-church` + the correct passkey for
`grace-church`) fails — the passkey is per-church, not global.

## Login hardening

- HMAC-SHA256 passkey hash, compared with `timingSafeEqual`
- Rate limited per church (100 / 15 min) and per IP (20 / 15 min)
- Format-validated, and **fails closed**: any exception returns
  `success: false`, so a database outage cannot become an auth bypass
- Cookie: `HttpOnly; SameSite=lax; Max-Age=86400; Path=/`

---

## Findings not fixed (recommendations)

1. **PII over-fetch — Medium.** The dashboard runs `members.select('*')` and
   passes the full rows to the client component, which serialises them into the
   RSC payload. The browser receives every column of every member —
   `email`, `birthday`, `gender`, `code`, `phone_number` — though the UI only
   uses `id`, `full_name`, `phone_number`. On a 5,000-member church that is a
   multi-megabyte payload per load on a phone, and it hands every usher device
   more personal data than the screen needs. Fix: select only the three columns
   used, and reconsider rendering phone numbers at all.
2. **Unbounded member list — Medium.** No pagination: the whole roster ships on
   every dashboard load. Same root cause as the admin dashboard full-table scan.
3. **`Secure` cookie is hardcoded — Low, deployment risk.** Correct on HTTPS
   (including this preview), but browsers drop `Secure` cookies on plain
   `http://192.168.x.x`, so a church running the portal on a local-network
   tablet over HTTP could never log in. Either require HTTPS or make the flag
   protocol-aware.
4. **Cosmetic inconsistencies — Low.** The submit button is disabled below 6
   characters while the handler returns early below 4; the input caps at 12
   while the server accepts 32; `console.log` of the login attempt is left in
   the client component.
5. **Direct `/c/<slug>/…` URLs 404 — Low.** The real route works only through
   the `next.config.ts` rewrite (`/grace-church/usher`). The `/c/...` form
   resolves to the custom 404 page. Nothing links to it, so it is cosmetic, but
   it is surprising.

---

## Reproducing

```bash
# terminal 1 — mock data layer
MOCK_EVENT=1 USHER_JWT_SECRET="<32+ chars>" MOCK_PASSKEY=TEST1234 \
  node tests/helpers/mock-postgrest.mjs

# terminal 2 — app, pointed at the mock
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run dev

# terminal 3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/grace-church/usher
```

**Gate:** `tsc` 0 errors · `eslint` 0 problems · 115/115 tests · `next build` OK.
