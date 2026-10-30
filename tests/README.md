# Tests and checks

Run the complete local application gate with:

```bash
npm ci
npm run check       # typecheck, lint, tests, production-dependency audit, and build
```

`npm test` runs the Node built-in tests plus a TSX-backed action/webhook integration
harness. The harness intercepts every provider and Supabase request; it uses no
live service credentials.

## Automated coverage

| File | What it covers |
| --- | --- |
| `activation.test.ts` | Activation fee/currency, missing references, and the fail-closed ledger lookup path against a mocked Supabase HTTP API. Amounts derive from `ACTIVATION_FEE_UGX`, so a temporary test price cannot turn the suite red or hide a real drift. |
| `activation-fee.test.ts` | `ACTIVATION_FEE_UGX` resolution: test overrides accepted, 0/fractional/out-of-range/garbage refused in favour of the standard price, and a single price shared by the payment screen, the ledger and the provider request. |
| `usher-passkey.test.ts` | The usher code the church is shown: charset, length, portal-accepted shape, the HMAC its login path compares, the `USHER_JWT_SECRET` preconditions, and `ensureChurchUsherPasskey` — issues once, never re-issues, guards the write against a concurrent issuer, and reports every failure instead of guessing. |
| `activation-gate.test.ts` | The one "has this church paid?" rule, every status shape it must answer (including NULL and an unreadable row), the legacy-NULL policy switch, and source guards that stop the gate, `lib/db.ts` and the three login screens from disagreeing again. |
| `attendance-streaks.test.ts` | Consecutive attendance-miss calculations and attendance flag lifecycle rules. |
| `denomination.test.ts` | Invite code normalization, provisioning payload validation, login-context mapping, and denomination query helpers. |
| `najiki-contract.test.ts` | Church → Na'jiki payloads validated by Na'jiki's own Zod schemas; error forwarding; idempotency; signed webhook verification and replay/tamper rejection. |
| `najiki-settlement.test.ts` | Exact deployed top-up RPC argument names/reference/amount and its `{ success, already_processed }` return contract; blocks settlement without a successful `BUY_SMS` notification and canonical provider transaction ID. |
| `sms-topup-e2e.ts` | Actual wallet initiation action → mocked Na'jiki request → signed webhook route → mocked settlement RPC; confirms one credit, duplicate acknowledgement, and status-API reconciliation when a signed callback omits the provider transaction ID. |
| `sql/attendance_streaks.test.sql` | Runs the real attendance migrations and PostgreSQL functions against a scratch database with behavior assertions. CI runs this against PostgreSQL 16. |

The Na'jiki contract suite uses `helpers/mock-najiki-server.ts` for partner
endpoints and verbatim validator/signature fixtures in `fixtures/najiki/`. See
the fixture README for provenance and refresh instructions.

## Deliberate test boundaries

The local top-up integration harness intercepts the database RPC and simulates
its documented JSON result; it does not execute the deployed PostgreSQL function
or prove its row locks/atomicity. Na'jiki rate limiting, downstream provider
dispatch, webhook fan-out, other Supabase-dependent routes/RLS policies, and live
SMS/payment behavior remain outside these tests and require staging verification.
Do not configure downstream provider credentials in churchOs. No live service
credentials are needed for this test suite.
