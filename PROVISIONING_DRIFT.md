# Provisioning drift — capture plan

Two separate pieces of work, in this order. **Capture first, nullability
second**, because the second depends on the first.

---

## What the repository can and cannot prove

You were right that a function existing in the database does not prove the app
calls it. That part is now settled from the code side:

| Claim | Evidence | Verdict |
|---|---|---|
| The app calls `provision_church_v3` | `lib/provision-actions.ts:133` — `.rpc('provision_church_v3', { p_user_id, p_name, p_slug, p_role, p_invite_code })` | **Established** |
| The repo defines it | only `provision_church_v2` exists, in `supabase-schema.sql:191` | **Absent** |
| v2 could stand in for v3 | v2's fifth parameter is `p_ip`; the app sends `p_invite_code` | **No** |

`v2` is not a rename of `v3`. Its fifth parameter is an *IP address*, used for
per-network registration blocking; the app's is an *invite code*, gated by
`validateProvisionV3Payload` in `lib/denomination.ts`, which explicitly rejects
`p_ip`. Substituting v2 would drop the invite-code check entirely while looking
like it worked.

**Why the drift was invisible:** `tests/provisioning-security.test.ts:21`
asserts the *call site* contains `.rpc('provision_church_v3'` — the half that
was never in doubt. Nothing asserted the function exists.

### Audit result: it is not only v3

Scanning every `.rpc('…')` in `app/` and `lib/` against every `CREATE FUNCTION`
in `supabase-schema.sql` and `migrations/*.sql`:

**12 RPCs the app calls have no definition anywhere in this repository.**

```
my_login_context                      ← on the login path
provision_church_v3                   ← church provisioning
create_denomination_overseer_invite
get_denomination_branding
join_denomination_with_invite
redeem_denomination_overseer_invite
overseer_church_summary
overseer_create_invite
overseer_denomination_totals
overseer_detach_church
overseer_list_invites
overseer_revoke_invite
```

A database rebuilt from this repo cannot log anyone in and cannot provision a
church. `tests/sql/rpc-contract.test.mjs` now pins this list: it fails if a new
unsourced RPC appears, and fails if one is fixed but not removed from the list.

`my_login_context` is arguably more urgent than `provision_church_v3` — it is
on every sign-in path.

---

## Step 1 — Capture `provision_church_v3`

I have no access to your database, so the definition has to come from you. The
pipeline is built so the body never passes through a chat window.

### Produce the dump

Run this yourself, in the Supabase SQL editor or via `psql`:

```sql
SELECT pg_get_functiondef(p.oid)
FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public' AND p.proname = 'provision_church_v3';
```

Save the result to a file — **not** into a ticket, a PR comment, or this
conversation. It may contain literal values.

### Let the script review and place it

```bash
node scripts/capture-rpc.mjs provision_church_v3.def.sql \
  --out migrations/013_provision_church_v3.sql
```

Before writing anything it:

1. **Extracts only that one function** from a multi-statement dump.
2. **Checks the signature** against what the app sends — five parameters,
   including `p_invite_code`, and no `p_ip`. A mismatch is a hard failure: the
   file is not written, because committing a definition that disagrees with the
   caller just replaces one silent drift with another.
3. **Checks the body assigns a passkey.** Without it, `passkey NOT NULL` cannot
   be enforced and every new church repeats the outage.
4. **Scans for credential material** — JWTs, `sk_`/`sbp_` keys, URLs with
   embedded credentials, `secret`/`token`/`password` literals, and long
   hex/base64 blobs flagged for review. It reports the **rule, line and length,
   never the value**.
5. **Refuses to write** if a credential is found, leaving a
   `013_….redacted.sql` beside it so you can inspect the shape. Rotate the
   credential, remove it from the function, then re-run.

If you want the file committed without the terminal ever showing the body, run
the capture on your own machine and open a PR from there — the output is a
normal migration file.

### Verify the committed copy

```bash
node scripts/capture-rpc.mjs --check migrations/013_provision_church_v3.sql
```

Suitable for CI: fails if the committed definition drifts from the call site or
contains credential material. Once 013 lands, delete `provision_church_v3` from
`NOT_IN_REPO` in `tests/sql/rpc-contract.test.mjs` — the test fails until you do,
so the allowance cannot quietly persist.

**Do not** hand-write a v3 to fill the gap. The deployed one may carry invite
validation, rate limiting or RLS behaviour that cannot be guessed, and a
plausible-looking approximation is worse than a known gap.

---

## Step 2 — Enforce `passkey NOT NULL`

Only after step 1 and the backfill. `migrations/014_passkey_not_null.sql` is
written so this ordering is enforced rather than remembered — it refuses to run
unless all of these hold:

| Precondition | Checked how | Failure message |
|---|---|---|
| 011 applied | `passkey_hash` column exists | `…Apply migrations/011…` |
| No NULL passkeys | `count(*) WHERE passkey IS NULL` | `…16 church(es) have a NULL passkey (church-0, …)` |
| No blank passkeys | `trim(passkey) = ''` | `…have a blank passkey…` |
| Provisioning writes one | the **deployed** `provision_church_v3` body mentions `passkey` | `…provision_church_v3 never sets a passkey…` |
| Provisioning exists | `pg_proc` lookup | `…does not exist, so provisioning is already broken…` |

The third row is the one that ties the two tracks together: nullability cannot
be declared safe while the function that creates new rows is unknown. Once 013
is committed and applied, that check passes on its own.

Rotation is the other write path and is verified in code, not SQL —
`updateChurchPasskey` writes `passkey: trimmedKey`.

Inside the `BEGIN…COMMIT`, so a refusal rolls back cleanly and changes nothing.

### Verified behaviour (`npm run test:sql`, 29 checks)

```
PASS  014 refuses before the backfill — Refusing NOT NULL: 16 church(es) have a NULL passkey
PASS  014 refusal leaves passkey nullable
PASS  014 applies after the backfill
PASS  014 makes passkey NOT NULL
PASS  014 is re-runnable
PASS  014 refuses without provision_church_v3
PASS  014 refuses when provisioning writes no passkey
PASS  014 refuses on blank (non-NULL) passkeys
PASS  014 refusal lists slugs, never passkeys
```

### Deploy order

```
011 → 012 → verify zero missing → (distribute codes) → 013 → 014
```

Nothing in this sequence prints a passkey. `012` writes codes to the table only;
read them deliberately with:

```sql
SELECT slug, passkey FROM church.churches ORDER BY slug;
```

---

## Also fixed while here

`supabase-schema.sql:77` defaulted `passkey` to
`lpad(floor(random() * 900000 + 100000)::text, 6, '0')` while a comment further
down claimed a "dynamic 6-digit CSPRNG". `random()` is a PRNG and is not
cryptographically secure. The default is now derived from `gen_random_uuid()`,
matching `provision_church_v2` and migration 012. 500 samples, all matching
`^[0-9A-F]{10}$`.

That is a defence-in-depth fix, not a live vulnerability: the passkey is a
shared code shown on the admin screen, not a per-user secret, and it is only one
factor alongside the per-church rate limits.
