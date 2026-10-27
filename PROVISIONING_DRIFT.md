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

### Bind the capture to the deployed function

A live check confirmed the overload gate matches exactly one
`public.provision_church_v3`, that `p_invite_code` defaults to `NULL`, and that
`sha256(bytea)` is available — so the fingerprint comparison in 014 will run.

The sha256 of the deployed definition was observed on 2026-10-27:

```text
efcfe2af7b9690be07608c1399ef6e21ab91ddbb810ecd0ac81c249ba7e68b44
```

**This is a fingerprint, not a review.** It was computed without anyone reading
the body. Do not paste it into `v_expected_fingerprint` — that would let 014
pass while nobody has confirmed what the function does, which is precisely the
failure the pin exists to prevent.

What it is good for: proving the file you review is the function that is
actually deployed. Pass it to the capture:

```bash
node scripts/capture-rpc.mjs provision_church_v3.def.sql \
  --out migrations/013_provision_church_v3.sql \
  --expect efcfe2af7b9690be07608c1399ef6e21ab91ddbb810ecd0ac81c249ba7e68b44
```

The script refuses to write if the dump hashes to anything else, which catches
a stale dump, a wrong overload, or a definition edited by hand afterwards. A
match is recorded in the migration header as `matches the live database: yes`.

Sequence, and it is deliberately two people's work:

1. Capture with `--expect` — proves *which* function, not *what* it does.
2. Someone reads the body and confirms provisioning sets a passkey and enforces
   the invite code.
3. Only then pin the fingerprint into 014.

Any later change to the function changes its hash, and 014 refuses on the old
pin — so a re-deploy cannot silently inherit a review it never had.

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
| Exactly one **function** overload matches the call site | both `pg_proc` lookups filter `p.prokind = 'f'`; `pg_get_function_identity_arguments` equals `p_user_id uuid, p_name text, p_slug text, p_role text, p_invite_code text` | `…no function public.provision_church_v3 exists…` / `…no overload of provision_church_v3 accepts (…)` |
| The definition was reviewed | sha256 of `pg_get_functiondef` equals the pinned value | `…has changed since review. Pinned …, deployed …` |
| Nothing pinned yet | the constant is still `'UNREVIEWED'` | `…no reviewed definition pinned. Current deployed fingerprint is sha256:…` |
| Provisioning exists | `pg_proc` lookup | `…does not exist, so provisioning is already broken…` |

**On `p.prokind = 'f'`** (added after a live preflight): `pg_proc` holds
procedures, aggregates and window functions alongside functions, so both
lookups now count functions only. The measured effect is narrower than it looks,
and worth stating plainly rather than overselling:

* PostgreSQL **forbids** a procedure sharing both name and argument types with a
  function (`42723`), so the two-identical-signatures case cannot arise.
* `pg_get_function_identity_arguments` renders a procedure's arguments with
  `IN ` prefixes (`IN p_user_id uuid, …`), so the signature comparison could
  never have matched a procedure anyway.
* Therefore the filter does not change whether the gate passes. It changes the
  **diagnosis**: with only a procedure named `provision_church_v3` present, the
  unfiltered version reports *"no overload accepts (…)"* — pointing at the app
  call site, which is fine — instead of *"no function exists"*, pointing at the
  real problem. Both refuse; one sends you hunting a bug that isn't there.

It is still the right filter: the first lookup asks "does this function exist",
and relying on another function's argument-formatting quirk for safety is not a
contract. Both facts are pinned by tests that run the unfiltered variant and
assert its misleading message.

**The fingerprint row is the one that matters.** An earlier revision tested
`prosrc ILIKE '%passkey%'`, which proves only that the word appears somewhere —
in a comment, a variable name, or a dead branch — and would have passed for a
function that never assigns one. It also selected the function by name without
pinning the overload, so with two `provision_church_v3` overloads present it
could have checked the wrong one. PostgreSQL allows that: two overloads differing
only in arguments share the name.

Both are now closed. The gate resolves the overload by the exact argument list
the app sends, refuses if zero or several match, and then compares a sha256 of
`pg_get_functiondef` against a value you paste in after reading the body. A
keyword can be gamed by accident; a hash of reviewed text cannot.

This is also why nullability cannot precede the capture: if `provision_church_v3`
inserts a church without a passkey, `NOT NULL` turns that into a hard failure at
signup for every future church.

Rotation is the other write path and is verified in code, not SQL —
`updateChurchPasskey` writes `passkey: trimmedKey`.

Inside the `BEGIN…COMMIT`, so a refusal rolls back cleanly and changes nothing.

### Verified behaviour (`npm run test:sql`, 84 checks)

```
PASS  014 refuses before the backfill — 16 church(es) have a NULL passkey
PASS  014 refusal leaves passkey nullable
PASS  014 applies after backfill with a pinned definition
PASS  014 makes passkey NOT NULL
PASS  014 is re-runnable
PASS  014 refuses while the definition is unpinned
PASS  014 tells you the deployed fingerprint to pin
PASS  014 refuses without provision_church_v3
PASS  014 refuses when no overload matches the call site
PASS  014 refuses when the reviewed body never mentions passkey
PASS  014 detects a definition changed after review
PASS  014 refuses on blank (non-NULL) passkeys
PASS  014 refusal lists slugs, never passkeys
```

Migration 012's own output is tested the same way: it must report the rows it
actually generated, and the post-check must catch a deliberately corrupted code
(`valid_for_portal` 3 → 2) rather than always reporting success.

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

### CORRECTION — my "signup is broken" conclusion was wrong

I claimed that `prosecdef = false` on `public.provision_church_v3` meant church
signup was failing at RLS. **That was wrong, and the analysis behind it was
incomplete.**

The deployed routine is a thin **invoker wrapper**. It delegates to
`private.provision_church_v3_impl`, which is **SECURITY DEFINER**, which calls
`public.provision_church_v2`, also **SECURITY DEFINER**. Both are owned by
`postgres`, which holds **BYPASSRLS**. The insert therefore runs with the
owner's privileges and RLS is never consulted.

The mistake was methodological: I read one routine's attribute and reasoned
about the whole path. `prosecdef` on a wrapper says nothing about what the
wrapper calls. `tests/sql/provisioning-invariant.test.mjs` still models what
would happen *if* the chain were flattened to invoker-only — that remains a
useful refactor guard — but it is explicitly labelled hypothetical now, and it
is not a statement about the deployment.

Signup is not known to be broken. The live end-to-end test could not be run
either: there are **zero existing auth users without an admin profile**, so
there is no first-time signup case to exercise.

### What the ACL still tells us

| Property | Observed | Reading |
|---|---|---|
| `public.provision_church_v3` `prosecdef` | false | fine — it is a wrapper; the DEFINER hop is one level down |
| `private.provision_church_v3_impl` | SECURITY DEFINER, owned by `postgres` | this is where privilege actually changes |
| `public.provision_church_v2` | SECURITY DEFINER, owned by `postgres` | performs the insert |
| owner `postgres` | `BYPASSRLS` | RLS is not a barrier on this path |
| `anon` EXECUTE | no | correct |
| `authenticated` EXECUTE | yes | correct — the app calls with the user's token |
| `service_role` EXECUTE | no | inconsistent with the repo's declared grants; breaks admin tooling, not signup |

So the grants are in reasonable shape. The remaining oddity is `service_role`,
which nothing on the signup path needs.

### The finding that actually blocks 014

**`public.provision_church_v2` inserts into `church.churches` without setting
`passkey` or `passkey_hash`, and no trigger fills them.**

Measured on PostgreSQL 16:

```
passkey NOT NULL + DEFAULT, insert (name, slug)  ->  33D5C1F52E   (succeeds)
passkey NOT NULL, no DEFAULT, same insert        ->  23502: null value in column "passkey" violates not-null constraint
```

So the naive 014 would have converted every future signup into a `23502`. That
is now handled structurally rather than by asking the body to change:

**014 installs the column DEFAULT before setting NOT NULL.** With
`DEFAULT upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))` in place,
an insert that omits `passkey` — including v2's — gets a fresh random code.
`supabase-schema.sql` already declares exactly this default; the live column
simply does not have it yet.

**A default is not a NULL guard.** It applies to an omitted column, not to a
`NULL` written explicitly. Measured on PG 16:

| Insert | Result |
|---|---|
| `INSERT (id)` | default applied |
| `INSERT (id, p) VALUES (id, DEFAULT)` | default applied |
| `INSERT (id, p) VALUES (id, 'MINE')` | value kept |
| `INSERT (id, p) VALUES (id, NULL)` | `23502` — default **not** applied |
| `INSERT (id, p) VALUES (id, NULL::text)` | `23502` |

The deployed v2 was reported to set neither column, which is the omission case
and is covered. But "the column has a default" must not be read as "no write
path can fail": a chain that later writes `passkey = NULL` — which is exactly
what `updateChurchPasskey` did before it was fixed — hits `23502` instead of
silently blanking the field. That is a better failure than the one this whole
investigation started from, but still a failure. 014 emits an advisory NOTICE
when a pinned body appears to write NULL to `passkey`, and the distinction is
covered by tests rather than left to the comment.

### The chain is confirmed from the database side

Live inspection agreed with the repository read:

```
public.provision_church_v3            (wrapper, invoker)  -> delegates
  private.provision_church_v3_impl    (SECURITY DEFINER)  -> delegates
    public.provision_church_v2        (SECURITY DEFINER)  -> INSERT, names no passkey column
```

v2 inserts the church without naming `passkey` or `passkey_hash`, which is the
**omitted-column** case the default covers — not the explicit-NULL case it
doesn't. So the `DEFAULT` installed by 014 is load-bearing for every future
church, and rotation is the path that must never write `null`
(`updateChurchPasskey` writes `passkey: trimmedKey`).

That is now enforced rather than documented: `tests/passkey-write-invariants.test.ts`
fails the build if any application code writes `passkey: null` or
`passkey = null`. Verified by injecting exactly that change — two assertions
fire — so the guard is not vacuous.

### The pin now covers the chain

The earlier pin attested to `public.provision_church_v3` — a wrapper that
contains no insert at all. A change to the private helper or to v2 would not
have changed it. 014 now:

* takes a `v_pins` array of `{schema, name, args, fingerprint}` entries and
  verifies each one against `pg_get_functiondef`;
* **walks the chain transitively**: if a pinned body references a routine that
  is not pinned, it refuses and names every reachable routine that still needs
  review. Pinning only the wrapper fails with both
  `private.provision_church_v3_impl` and `public.provision_church_v2` listed.

```
PASS  014 refuses a wrapper-only pin
PASS  014 names the unreviewed helper
PASS  014 names the unreviewed v2
PASS  014 detects a changed routine deep in the chain
```

`scripts/capture-rpc.mjs --rpc private.provision_church_v3_impl` captures a
non-`public` routine and prints a ready-to-paste `v_pins` entry, with `args`
normalised to `pg_get_function_identity_arguments` form so the pin matches.

### Known limitation — the fingerprint does not cover grants### Known limitation — the fingerprint does not cover grants

`pg_get_functiondef` covers `SECURITY DEFINER` and `SET search_path`, because
both are part of the definition text. It does **not** cover the ACL. Re-granting
`EXECUTE` to `anon` leaves the fingerprint unchanged and 014 would still pass.

Review the grants separately. Read-only, no body retrieved:

```sql
SELECT p.oid::regprocedure::text                                   AS routine,
       pg_get_userbyid(p.proowner)                                 AS owner,
       p.prosecdef                                                 AS security_definer,
       p.proconfig                                                 AS proconfig,
       coalesce(array_to_string(p.proacl, ' | '),
                '<default: EXECUTE to PUBLIC>')                    AS raw_acl,
       has_function_privilege('anon',          p.oid, 'EXECUTE')  AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE')  AS authenticated_can_execute,
       has_function_privilege('service_role',  p.oid, 'EXECUTE')  AS service_role_can_execute
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'provision_church_v3' AND p.prokind = 'f';
```

**Why `has_function_privilege` and not just `proacl`:** a raw ACL of
`<default: EXECUTE to PUBLIC>` means every role — including `anon` — can call
the function. Verified against PostgreSQL 16:

| State | `raw_acl` | `anon_can_execute` |
|---|---|---|
| Default (no REVOKE run) | `<default: EXECUTE to PUBLIC>` | **true** |
| `REVOKE … FROM PUBLIC, anon` + `GRANT … TO authenticated, service_role` | `authenticated=X \| service_role=X` | false |

**The trap:** revoking from `anon` alone does nothing here. The privilege does
not come from a grant to `anon`; it is inherited from `PUBLIC`. A partial fix
that only targets `anon` leaves the function world-callable while looking like
it was locked down.

`supabase-schema.sql:338` states the intended posture for provisioning —
`REVOKE EXECUTE … FROM PUBLIC, anon` then `GRANT … TO authenticated,
service_role` — but that block applies to `v2`. The deployed `v3` may predate
it.

A `SECURITY DEFINER` provisioning function executable by `anon` is a different
class of problem from whether it assigns a passkey, which is exactly why it
cannot be folded into the fingerprint. **Expected good state:** `security_definer
= true`, `proconfig` pins `search_path`, `anon_can_execute = false`,
`authenticated_can_execute = true`.

## Current live state (as reported)

* **011 applied.** All three columns present; no NULL `passkey_version`.
* **012 applied.** 16 codes generated, 0 invalid formats; 18 churches total,
  0 missing. The format check in 012 was rewritten as described above before it
  ran — the version in this repo is the corrected one.
* **014 not applied**, correctly: the definition is not pinned yet, so it would
  refuse. That is the gate doing its job.

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
