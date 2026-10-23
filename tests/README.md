# Tests and checks

Run the complete local application gate with:

```bash
npm ci
npm run check       # typecheck, lint, tests, production-dependency audit, and build
```

`npm test` uses Node's built-in test runner and type stripping. No separate test
framework is required.

## Automated coverage

| File | What it covers |
| --- | --- |
| `activation.test.ts` | Activation fee/currency, missing references, and the fail-closed ledger lookup path against a mocked Supabase HTTP API. |
| `attendance-streaks.test.ts` | Consecutive attendance-miss calculations and attendance flag lifecycle rules. |
| `denomination.test.ts` | Invite code normalization, provisioning payload validation, login-context mapping, and denomination query helpers. |
| `najiki-contract.test.ts` | Church → Na'jiki payloads validated by Na'jiki's own Zod schemas; error forwarding; idempotency; signed webhook verification and replay/tamper rejection. |
| `sql/attendance_streaks.test.sql` | Runs the real attendance migrations and PostgreSQL functions against a scratch database with behavior assertions. CI runs this against PostgreSQL 16. |

The Na'jiki contract suite uses `helpers/mock-najiki-server.ts` for partner
endpoints and verbatim validator/signature fixtures in `fixtures/najiki/`. See
the fixture README for provenance and refresh instructions.

## Deliberate test boundaries

The Na'jiki mock does not implement its rate limiting, downstream provider
dispatch, wallet crediting, or webhook fan-out. Supabase-dependent payment settlement,
RLS policies, the full set of server actions/API routes, and live SMS/payment
behavior still require staging integration tests with a non-production database
and Na'jiki staging credentials. Do not configure downstream provider
credentials in churchOs. No live service credentials are needed for the
unit/contract suite.
