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

### Security regressions

These exist because `npm test` alone would let a policy or privilege change pass CI.
`npm run test:sql` applies the real migration files to an in-process PostgreSQL (PGlite,
no server needed) with Row Level Security enforced and the JWT claims PostgREST sets, and
CI runs it as its own step.

| File | What it covers |
| --- | --- |
| `sql/rls_church_row_guard.test.mjs` | Applies `migrations/019` and `020` for real: every tenant write path on `church.churches` is refused while `service_role` keeps each write the app makes, the column guard survives a database where 011/017 have not run, `sms_logs` keeps its read while losing its tenant writes, and 020 refuses to widen a stricter SELECT policy that already exists. |
| `sql/church_column_privileges.test.mjs` | Applies `migrations/022` for real: demonstrates the finding first (a tenant-scoped read policy still returns `passkey` to a member), then that both browser roles lose the four credential columns while `id/name/slug`, the public `security_invoker` view and the service-role passkey read/rotate all keep working; that the file aborts rather than half-applying next to a policy or a view that touches a hidden column; that it tolerates a database where 011/017 have not run; and the schema twin is *executed*, not grepped. |
| `sql/grants_hardening.test.mjs` | Applies `migrations/021`: proves the grant/policy split directly — as `authenticated`, an `UPDATE` on another church's row is filtered to 0 rows while `TRUNCATE … CASCADE` by the same role **succeeds** — then that the revoke closes it, that `anon` can still execute `public.churches_public`, that the file refuses to run before 020, and that it is idempotent. |
| `sql/rls_activation_bypass_poc.test.mjs` | Reproduces the legacy `FOR ALL` policy and reports the exploit as OPEN/CLOSED rather than asserting red, so closing the hole never costs more than the bug. The defences that must hold either way (cross-tenant denial, anon denial, no profile forging) do assert. |
| `admin-client-identity.test.ts` | Pins the identity of the privileged client: the bearer token on a real PostgREST request is the service key, the client cannot see a user session, and a missing/whitespace key yields `null` rather than a client that answers with a silent empty result. Re-run `npm run probe:admin-identity` after any `@supabase/*` bump — it re-measures the library rather than trusting this file's prose. |
| `deployment-hardening.test.ts` | The application-side findings: the sessionless service-role client and its fallback notice, `frame-ancestors` construction (production-only, malformed entries dropped, `EMBED_HOSTS=*` never inferred), and source-level guards that the webhook keeps warning rather than refusing on a shared signing secret. |

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
