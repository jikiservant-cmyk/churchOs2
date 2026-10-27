# Usher portal: "the passkey from the database doesn't work"

You were not doing anything wrong. I reproduced both failure modes against the
running app. They are bugs in this repository.

---

## First: find out which one you have

Run this in the Supabase SQL editor.

```sql
-- 1. Do the columns the app reads actually exist?
SELECT column_name, data_type
FROM   information_schema.columns
WHERE  table_schema = 'church'
  AND  table_name   = 'churches'
  AND  column_name IN ('passkey', 'passkey_hash', 'passkey_version', 'passkey_updated_at');

-- 2. What does the portal see for your church?
SELECT slug,
       passkey                              AS readable_passkey,
       passkey_hash                         AS hash,
       passkey_version
FROM   church.churches
ORDER  BY slug;
```

| What you see | Cause | Fix |
|---|---|---|
| The first query returns **only `passkey`** | `passkey_hash` / `passkey_version` were never created | **A** |
| `readable_passkey` is a 6-digit code **and** `hash` is a 64-char hex string | the hash shadows your code | **B** |
| `readable_passkey` is **NULL** | the code was wiped by a rotation | **C** |

---

## A. Missing columns — "Church not found."

`lib/attendance-actions.ts` has always done:

```ts
.select('id, name, passkey, passkey_hash, passkey_version')
```

and `updateChurchPasskey` writes `passkey_updated_at` — but **no file in the repo
created those columns**. `README.md` tells you to run
`migrations/002_passkey_hashing.sql`, which **does not exist**.

On a database built from this repo the SELECT fails with `42703`, the result is
empty, and the portal answers **"Church not found."** for *every* passkey —
including the one displayed in the database.

Reproduced:

```
exact passkey from DB (483920)  →  {"success":false,"error":"Church not found."}
```

**Fix:** run the new migration, then reload the portal.

```
migrations/011_usher_passkey_columns.sql
```

It adds the three columns idempotently, defaults `passkey_version`, and prints
the resulting state of every church.

The error message now says so too, instead of blaming the URL:

> Usher login is misconfigured: this database is missing required columns. Ask an
> administrator to run migration 011.

---

## B. A hash nobody knows shadows your readable code

The provisioning function generates:

```sql
encode(digest(concat(v_canonical_slug, ':', gen_random_uuid()::text), 'sha256'), 'hex')
```

That is a hash of the slug plus a **random UUID** — a value no human was ever
shown, and it can never be reproduced. Meanwhile `passkey` still holds the
readable 6-digit default. Because the login path checked `passkey_hash` first
and only fell back to `passkey` when the hash was `NULL`, the readable code was
ignored.

Reproduced:

```
DB: passkey = '483920', passkey_hash = <random 64-hex>
exact passkey from DB (483920)  →  {"success":false,"error":"Invalid passkey. Please check and try again."}
```

**Fix:** two changes, both shipped.

1. `validateUsherPasskey` now accepts a match against **either** the hash or the
   readable `passkey` column, compares both in constant time, and rewrites
   `passkey_hash` to match whichever code worked (self-healing).
2. Migration 011 clears the unusable hash on rows that still have a readable
   passkey, and provisioning now creates a readable 8-character code.

After the fix, the same request:

```
exact passkey from DB (483920)  →  {"success":true,"churchName":"Grace Community Church"}  + session cookie
wrong passkey                  →  {"success":false,"error":"Invalid passkey…"}
```

> **Design note.** The passkey is a shared code a pastor reads off the admin
> screen and tells volunteers — not a per-user secret. Keeping a readable copy is
> deliberate: the admin UI and the copyable portal link both display it, and
> hashing it alone made it impossible to retrieve after rotation. If you later
> want hash-only storage, the management screen has to change to
> *reveal-once-then-discard* first.

---

## C. `passkey` is NULL

Rotation used to set `passkey = null`, so after a pastor generated a new code the
admin screen showed an empty field and the database had nothing to read. New
rotations keep the readable value.

If a church is already in this state, give it a new code (pick your own):

```sql
UPDATE church.churches
SET    passkey         = 'GRACE2026',   -- 6–32 chars: A-Z a-z 0-9 _ -
       passkey_hash    = NULL,          -- re-derived on first successful login
       passkey_version = passkey_version + 1   -- logs out existing usher sessions
WHERE  slug = 'your-church-slug';
```

Then sign in with `GRACE2026`.

---

## Also fixed while in here

The length rules disagreed with each other, so a code could be accepted by one
layer and rejected by the next:

| Layer | Before | Now |
|---|---|---|
| Portal input | submit disabled < 6, `maxLength` 12 | < 6, `maxLength` 32 |
| Portal handler | returns early < 4 | < 6 |
| Server validator | 6–32 | 6–32 |
| Passkey rotation | required **8**–32 | 6–32 |
| Schema default | 6 digits | 6 digits |

Rotation demanding 8 meant the admin screen rejected codes the portal itself
would happily accept. All layers now agree on **6–32 characters**, which matches
the 6-digit schema default.

---

## Verify

```bash
# after running migration 011
psql "$DATABASE_URL" -c "SELECT slug, passkey, passkey_hash IS NOT NULL AS hashed, passkey_version FROM church.churches;"
```

Then open `/<your-church-slug>/usher` and enter the value in the `passkey`
column. If it still fails, the error message now distinguishes the cases:

| Message | Meaning |
|---|---|
| `Church not found.` | wrong slug in the URL |
| `…missing required columns…` | run migration 011 |
| `Invalid passkey format.` | not 6–32 chars, or contains characters outside `A-Z a-z 0-9 _ -` |
| `Invalid passkey. Please check…` | the code genuinely does not match either column |
| `Usher login protection is temporarily unavailable` | rate limiter unreachable — set `UPSTASH_REDIS_*` or check `USHER_JWT_SECRET` |

`USHER_JWT_SECRET` must be set to a 32+ byte value, or every login fails with
*"An unexpected security or network error occurred"* because `getJwtSecret()`
throws before any comparison happens.
