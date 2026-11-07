# Denominations (Dioceses) — architecture & operations

Three-tier model: **Denomination (diocese) → Churches (independent tenants) →
Members**. A church keeps full data isolation; the diocese layer adds
governance telemetry and white-label branding only. Fully verified end-to-end
on production, 2026-11-07 — 17/17 checks green (invites, joins, guard rails,
exhaustion, revocation, detach, dashboards, routing, branding), then restored.

## The two membership relations

| Relation | Table | Meaning |
| --- | --- | --- |
| Church ↔ diocese | `church.churches.denomination_id` | NULL = Independent |
| Overseer ↔ diocese | `church.denomination_admins` | A *person* oversees a diocese |

"Promoting" a pastor to overseer adds one row to `denomination_admins`; the
church profile and data are untouched. A dual-role user lands on `/overseer`
at login (`private.my_login_context_impl`: overseer wins) and keeps full
church admin access — church pages authorise via `admin_profiles`
independently (see note in `app/overseer/page.tsx`).

## Joining flows (hashed invite codes)

- **Overseer invites**: super-admin calls `create_denomination_overseer_invite`
  → new user (or an existing pastor) redeems via `redeem_denomination_overseer_invite`
  → one `denomination_admins` row per user.
- **Church invites**: overseer calls `overseer_create_invite` (max_uses 1–1000,
  expiry 1–90 days) → pastor of an Independent church joins via Settings →
  "Denomination Network" card (`joinDenominationWithInvite` server action →
  `join_denomination_with_invite` RPC) or by entering the code at signup
  (`provision_church_v3`, live-managed).
- Codes are shown once; only `sha256(normalised code)` is stored
  (`private.hash_invite_code`). Enforced at redemption: unrevoked, unexpired,
  `used_count < max_uses`, `FOR UPDATE` row locks prevent double-spend.
- Overseer actions: `overseer_revoke_invite`, `overseer_detach_church` — both
  scoped to the caller's own diocese.

## What overseers see

`/overseer` dashboard (server actions in `lib/overseer-actions.ts`) calls:

- `overseer_denomination_totals()` — church/member/attendance/SMS 30-day
  totals and active churches
- `overseer_church_summary()` — per-church cards: member count, 30-day
  check-ins, last event, 30-day SMS, pastor email, last active, joined
- `overseer_list_invites()` — the invite ledger with status
  (active/used up/expired/revoked)

Every RPC resolves the caller's diocese via `private.my_denomination_id()`
and returns **aggregates only** — no member lists, message bodies, or wallets,
ever. Non-overseers get `42501 Not authorized`.

Branding: `church.denominations` carries logo/colors/login copy (white-label);
public pages read `public.denominations_public` (listed only) and
`get_denomination_branding(slug)`.

## Known issues (as of 7 Nov 2026)

1. **Totals/giving mismatch**: production `overseer_denomination_totals`
   returns five columns (no `giving_total`), but
   `buildOverseerDashboardSnapshot` (lib/overseer-dashboard-data.ts) treats a
   missing giving metric as an incomplete response and the dashboard renders
   its error card. Migration `027` mirrors production verbatim — fix either
   the RPC (add `giving_total`) or the builder before relying on `/overseer`.
2. **No UI to create a denomination** — creation is SQL-side (insert into
   `church.denominations`, then mint overseer invites).
3. **Overseer dashboard has no "back to my church" link** for dual-role users
   (bookmark `/c/<slug>/admin`).
4. **Ghost super-admin**: `admin_profiles` row `261d9539-…` has role
   super_admin but no `auth.users` row — invites minted as that identity fail
   the `created_by` FK. Delete the row.
5. `provision_church_v2/v3` (signup provisioning, incl. born-linked churches)
   are live-managed and not yet in repo migrations.

## RPC reference

| RPC (public) | Caller | Purpose |
| --- | --- | --- |
| `my_login_context()` | authenticated | Route logins (overseer → `/overseer`) |
| `join_denomination_with_invite(code)` | pastor | Link own church to a diocese |
| `overseer_create_invite(label,max_uses,days)` | overseer | Mint church-join code |
| `overseer_list_invites()` | overseer | Invite ledger |
| `overseer_revoke_invite(id)` | overseer | Revoke own diocese's invite |
| `overseer_detach_church(id)` | overseer | Set member church back to Independent |
| `overseer_denomination_totals()` | overseer | Aggregate stat cards |
| `overseer_church_summary()` | overseer | Per-church cards |
| `get_denomination_branding(slug)` | anon | White-label data for public pages |
| `create_denomination_overseer_invite(...)` | super_admin | Mint overseer code |
| `redeem_denomination_overseer_invite(code)` | authenticated | Become overseer |

Schema/migration: `migrations/027_denomination_layer.sql` (verbatim from
production; `provision_church_v2/v3` intentionally excluded).
