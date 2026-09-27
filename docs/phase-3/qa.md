# Phase 3 Employees, Customers, Loyalty & Gift Cards — QA Handoff

Updated: 2026-09-24

## Database migrations

- `0005_phase3_workforce_customers_loyalty_gift_cards` adds shift, customer-contact/lifecycle, loyalty-program/ledger, gift-card/ledger, indexes, constraints, and payment kinds.
- `0006_phase3_ledger_trigger_fix` replaces the first migration's shared polymorphic trigger after real integration execution exposed PostgreSQL resolving table-specific `OLD` fields eagerly (`record "old" has no field "giftCardId"`). Separate loyalty and gift-card trigger functions now enforce immutable economic fields and the only allowed status transitions: `PENDING` to `POSTED` or `CANCELLED`.

Both migrations are forward-only and were applied to the isolated `rjpos_test` database and the development `rjpos` database. Test preparation still targets only normalized host `127.0.0.1`, port `15433`, database `rjpos_test`; it has no migrate, truncate, seed, or write path to the development database.

## Behavioral coverage

- Workforce: clock in/out/current state, duplicate and concurrent clock-in, duplicate clock-out, correction/duration, inactive employee, tenant isolation, and audit.
- Customers: create/edit/search, optional normalized contacts, duplicate contact rejection, active lifecycle, order attachment, purchase history, and tenant isolation.
- Loyalty: configure, earn, redeem, insufficient balance, manual adjustment, duplicate checkout, refund/void compensation, concurrent final balance, and history.
- Gift cards: secure issue, reload, lookup, partial use, insufficient balance, duplicate submission, disable, tenant isolation, concurrent final balance, compensation, and history.
- Split tender: gift plus cash, gift plus simulated terminal, known terminal failure rollback, full refund, and exact final settlement after repeated partial refunds.
- Real backend E2E: clock in, create/select customer, configure loyalty, issue gift card, earn on first sale, redeem loyalty/gift/cash on second sale, inspect history, refund compensation, and clock out through API controllers and Prisma/PostgreSQL.
- Regression: Phase 1 cash/terminal/register/order/refund/void/inventory races and Phase 2 catalog/pricing/inventory/employee/store/register/admin E2E remain in the full suite.

Browser tests mock only the API transport to verify UI interaction and request shapes. The primary Phase 3 E2E, ledger behavior, constraints, and races use real PostgreSQL. API database-backed test files run serially to prevent unrelated fixture suites from deadlocking one another; the explicit concurrent clock-in, loyalty, gift-card, inventory, price, UPC, and register/session assertions still race their operations inside each test.

## Verification record

Final verification completed on 2026-09-24:

```text
pnpm typecheck       30/30 dependency and typecheck tasks successful
pnpm lint            30/30 dependency and lint tasks successful
pnpm build           15/15 package builds successful
pnpm test            30/30 build/test tasks successful
git diff --check     exit 0 (line-ending notices only)
```

No required test failed, was disabled, or was skipped. Behavioral counts—not Turbo task counts—are:

| Package | Passed |
| --- | ---: |
| `@rjpos/api` | 20 |
| `@rjpos/api-contracts` | 3 |
| `@rjpos/auth` | 2 |
| `@rjpos/config` | 10 |
| `@rjpos/database` | 36 |
| `@rjpos/domain-types` | 7 |
| `@rjpos/events` | 2 |
| `@rjpos/logging` | 4 |
| `@rjpos/payment-contracts` | 12 |
| `@rjpos/register` | 6 |
| `@rjpos/ui` | 1 |
| `@rjpos/web` | 11 |
| `@rjpos/worker` | 1 |
| **Total** | **115** |

Exactly two packages have zero behavioral tests and their successful tasks are not counted as behavioral validation:

| Package | Classification | Rationale |
| --- | --- | --- |
| `@rjpos/api-client` | Compile-only | Declaration/client transport package; Phase 3 adds no runtime behavior there. |
| `@rjpos/hardware-contracts` | Compile-only | Declaration-only native boundary; hardware implementation remains outside Phase 3. |

There are no mocked-only packages and no known package missing required Phase 3 coverage. The database package passed 36/36, including eight Phase 3 integration/race tests. The API package passed 20/20, including the real Phase 2 and Phase 3 controller-to-PostgreSQL E2E tests. The first full monorepo attempt exposed a deadlock/write conflict between independent API E2E files sharing the same isolated test database. The API package now runs files with `--no-file-parallelism`; explicit race assertions remain concurrent. The subsequent focused API run and final full run passed.

The earlier integration session also found the dedicated test services stopped. `docker compose -f docker/docker-compose.yml --profile test up -d --wait postgres-test redis-test` restored only the isolated services. Test preparation revalidated `127.0.0.1:15433/rjpos_test`, found all seven migrations applied, and did not connect to or modify the development database.

Closure re-verification was repeated on 2026-09-24 against the current `copilot/phase-3` branch state with the same required gates and behavioral totals:

```text
pnpm typecheck       30/30 dependency and typecheck tasks successful
pnpm lint            30/30 dependency and lint tasks successful
pnpm build           15/15 package builds successful
pnpm test            30/30 build/test tasks successful
git diff --check     exit 0
```

The rerun again passed the Phase 3 database race/integration assertions (`@rjpos/database` 36/36) and the backend-backed API E2E suites (`@rjpos/api` 20/20, including `phase-three.e2e.test.ts` and query-validation coverage for malformed Phase 3 list parameters).

## Runtime evidence

A clean built API process (PID 3656, `node dist/main.js`) owned port 3001 and the repository Next.js process (PID 22552) owned port 3000. The built API startup log mapped `PhaseThreeController`, `/api/v1/checkout/mixed`, and all workforce/customer/loyalty/gift-card routes before reporting application startup.

```http
GET /api/v1/health
HTTP/1.1 200 OK
x-request-id: ce094e3d-abbd-4436-80ac-05b751308255

{"status":"ok"}

GET /api/v1/health/ready
HTTP/1.1 200 OK
x-request-id: b05c11ec-bf9d-4efc-8b54-b6f7e4d8722f

{"status":"ready","dependencies":{"postgres":"up","redis":"up"}}

GET /api/v1/customers?search=
HTTP/1.1 200 OK
x-request-id: 3fafb5df-d4e4-4dc9-a778-af584e01bc78

{"items":[],"total":0,"page":1,"pageSize":25}

GET http://127.0.0.1:3000/
HTTP/1.1 200 OK
```

Corresponding structured API logs used the same request IDs for both health checks:

```json
{"level":"info","message":"Health liveness check passed","requestId":"ce094e3d-abbd-4436-80ac-05b751308255","timestamp":"2026-09-24T20:05:15.524Z"}
{"level":"info","message":"Health readiness check passed","requestId":"b05c11ec-bf9d-4efc-8b54-b6f7e4d8722f","timestamp":"2026-09-24T20:05:15.788Z"}
```

The real Electron binary then loaded the independent web server and emitted:

```json
{"heading":"Downtown Register","hardwareStatus":"simulated","bounds":{"x":240,"y":66,"width":1440,"height":900},"minimumSize":[1024,700],"security":{"contextIsolation":true,"nodeIntegration":false,"sandbox":true}}
```

The Electron process exited 0. This smoke, rather than the six register unit tests, proves the built entry point launched, the live RJ POS UI rendered, the preload bridge and `hardware:status` IPC worked, and the security boundary remained enabled. The temporary API and web processes were stopped afterward; ports 3000 and 3001 had no listeners.

In this closure sandbox, a repeated Electron smoke attempt could not complete because Linux SUID sandbox permissions for the packaged Electron helper are unavailable in this environment (`chrome-sandbox ... not configured correctly`). Register security boundary assertions still passed in `apps/register/tests/security.test.ts` as part of the required `pnpm test` gate.

## Known limitations

- Development authentication remains the approved provider abstraction; production identity-provider integration is not part of Phase 3.
- Loyalty configuration is organization-wide and uses integer minor-unit/point rules. There are no tiers, campaigns, expiry, or promotion stacking.
- Gift-card codes cannot be recovered from storage; loss requires an authorized operational replacement process not included in this phase.
- Terminal behavior remains simulated. Unknown financial outcomes retain pending ledger reservations and require the existing reconciliation boundary; they are not retried automatically.
- The compact admin UI uses prompt-based edit/correction operations in places; the API and database remain authoritative.
- Electron package tests validate its code boundary, while a separate real-process smoke is required to prove application launch and IPC.
