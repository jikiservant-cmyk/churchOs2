# Na'jiki Finance — vendored contract fixtures

These five files are copied **verbatim** from the Na'jiki Finance repository so
the church app's contract tests validate against Na'jiki's real code rather than
a hand-written paraphrase of it.

| File | Upstream path | Upstream blob (git hash-object) |
| --- | --- | --- |
| `money.ts` | `src/lib/money.ts` | `7d6cebe8d1084459fd795a77bde24c82e2553a04` |
| `schemas.ts` | `src/lib/schemas.ts` | `34614895883b80e5664341ed8e87662c9c085e7e` |
| `notification-signature.ts` | `src/lib/notification-signature.ts` | `b9381b3e82a134e0ee159fe113a439392ce14b47` |
| `sms-policy.ts` | `src/lib/sms-policy.ts` | `252ef8c32e951b04107456807457f9e1e358fbae` |
| `constants.ts` | `src/lib/constants.ts` | `98e62dd6fd7170bc3ef3af5ec82ee51cc07911a2` |

- Repository: <https://github.com/jikiservant-cmyk/najiki-finance2>
- Pinned commit: `b73a82b9e4411dd27b559927a3b455f833cfb2a7`

**One intentional difference:** `schemas.ts` imports `./money.ts` with an
explicit extension. Upstream uses the extensionless `./money`, which Node's
type-stripping loader cannot resolve. No logic was changed.

## Keeping it in sync

These files are a *snapshot of Na'jiki's contract*, not a copy of Na'jiki's
implementation. When Na'jiki's schema changes:

```bash
git clone https://github.com/jikiservant-cmyk/najiki-finance2 /tmp/najiki
cd /tmp/najiki && git rev-parse HEAD
cp /tmp/najiki/src/lib/{money,schemas,notification-signature,sms-policy,constants}.ts \
   /home/user/churchOs2/tests/fixtures/najiki/
sed -i 's|from "./money"|from "./money.ts"|' /home/user/churchOs2/tests/fixtures/najiki/schemas.ts
```

Then update the pinned commit and blob hashes in the table above and run
`npm test`. A failing test after an upstream change means the church app's
payload has drifted from the contract — that is the point of this directory.
