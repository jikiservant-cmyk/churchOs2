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
| `sql/migration_style.test.mjs` | A lint for the two ways these hand-run files have actually broken: `RAISE EXCEPTION 'a' || 'b'` (plpgsql reads the format up to the first comma and stops, so concatenating inside a RAISE is a syntax error — both 023 and 024 shipped that bug in the messages written to explain a failure), and `NOT IN (subquery)` in a verification check, where one NULL silently turns a failing check into a passing one. Also asserts every explicit `BEGIN` in a migration has a terminating `COMMIT`/`ROLLBACK`, and that the newest files are inside the scan so the loop cannot become vacuous. |
| `sql/usher_session_guard.test.mjs` | (in `definer_hardening.test.mjs`) `migrations/024`'s report-first contract: with `v_apply` false it changes no privilege even when it finds something serious; it refuses to revoke while the session table has rows newer than the staleness window; it stops outright when a row policy calls the function; it revokes for the browser roles and preserves `service_role` once the table is provably stale; and it says so plainly when the functions are absent. |
| `sql/definer_hardening.test.mjs` | Applies `migrations/023` (and 024's privilege rules) for real. Starts by demonstrating the hazard instead of assuming it: an unpinned `SECURITY DEFINER` function reading `from widgets` returns the row count of a caller-created `TEMP TABLE widgets`, while its schema-qualified sibling returns the real count. Then: Part A pins only the path-independent bodies and defers the shadowable one *by name with the offending relation*; the pin never contains `pg_temp`; an already-pinned function keeps the pin it chose even when it is one this migration would never write; invoker functions are untouched; a second run is a no-op with an empty report; qualifying the body is what lets a later run pin it. Part B revokes the two passkey validators and the tenant deleter from `anon`/`authenticated`, keeps `service_role` working (proven by executing the no-match delete), refuses outright when a row-policy predicate calls one of them — and verifies that refusal rolled Part A back too. |
| `sql/grants_hardening.test.mjs` | Applies `migrations/021`: proves the grant/policy split directly — as `authenticated`, an `UPDATE` on another church's row is filtered to 0 rows while `TRUNCATE … CASCADE` by the same role **succeeds** — then that the revoke closes it, that `anon` can still execute `public.churches_public`, that the file refuses to run before 020, and that it is idempotent. |
| `sql/rls_activation_bypass_poc.test.mjs` | Reproduces the legacy `FOR ALL` policy and reports the exploit as OPEN/CLOSED rather than asserting red, so closing the hole never costs more than the bug. The defences that must hold either way (cross-tenant denial, anon denial, no profile forging) do assert. |
| `rpc-caller-identity.test.ts` | Pins which connection each security-relevant `.rpc()` travels on. The definer bodies these features rely on call `auth.uid()`, so moving one of them onto `createAdminClient()` would not skip the in-database guard, it would blind it — hence: every audited call site must stay on the session client, the mutating overseer actions must keep their membership re-check, and `isAuthorizedOverseer` must stay a caller-scoped read that fails closed. The count of audited sites is asserted too, so a call that moves out of the scanned files fails rather than quietly passing. |
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
