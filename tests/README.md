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
| `activation.test.ts` | Activation fee/currency, missing references, and the fail-closed ledger lookup path against a mocked Supabase HTTP API. |
| `attendance-streaks.test.ts` | Consecutive attendance-miss calculations and attendance flag lifecycle rules. |
| `denomination.test.ts` | Invite code normalization, provisioning payload validation, login-context mapping, and denomination query helpers. |
| `najiki-contract.test.ts` | Church → Na'jiki payloads validated by Na'jiki's own Zod schemas; error forwarding; idempotency; signed webhook verification and replay/tamper rejection. |
| `najiki-settlement.test.ts` | Exact deployed top-up RPC argument names/reference/amount and its `{ success, already_processed }` return contract. |
| `sms-topup-e2e.ts` | Actual wallet initiation action → mocked Na'jiki request → signed webhook route → mocked settlement RPC; confirms one credit and duplicate acknowledgement. |
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
