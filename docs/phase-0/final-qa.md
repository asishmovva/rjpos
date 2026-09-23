# Phase 0 Final QA Status

Updated: 2026-09-22

## Validation categories

Test-task success, compilation, and behavioral validation are reported separately. A package whose `test` script only prints `no tests yet` or `web tests pending` contributes zero behavioral tests and is not counted as behavioral evidence.

## Infrastructure closure status

| Status      | Result |
| ----------- | ------ |
| **Passed**  | Docker engine and Compose; PostgreSQL 18 and Redis 8 development/test services; offline migration review; clean migration deployment; Prisma validate/generate/status; direct PostgreSQL constraint inspection; idempotent seed; reservation concurrency/lifecycle behavior; outbox claim/retry/recovery behavior; Redis connectivity and outage recovery; live API liveness/readiness; typecheck; lint; build; test; `git diff --check`. |
| **Failed**  | None. |
| **Blocked** | None. |
| **Skipped** | None of the required database-backed or runtime checks. |

### Migration and PostgreSQL evidence

- The initial migration was already checked in at `0000_initial`; it was reviewed rather than regenerated. Across the ordered chain, 32 Prisma models map to exactly 32 created tables and 17 enums map to exactly 17 PostgreSQL enum types.
- A newly created `rjpos_phase0_validation` database applied `0000_initial`, `0001_reviewed_constraints`, and `0002_rbac_and_audit` from zero. Prisma then reported the schema up to date. The normal development database was also recreated cleanly and successfully applied the same chain.
- PostgreSQL catalogs confirmed all nine reviewed partial/lookup indexes, both price-period exclusion constraints, the price-period validity check, the `btree_gist` extension, and the audit immutability trigger for both update and delete.
- Catalog comparison covered 116 foreign-key column pairs: 116 source/target types matched and zero differed.
- Development and test identities are separate: `127.0.0.1:15432/rjpos` and `127.0.0.1:15433/rjpos_test`.

### Seed and runtime evidence

- The Phase 0 seed completed twice on the clean development database. The stable result was one fictional organization, one Downtown store, one Register 01, three employees, and three employee/store links.
- The real PostgreSQL reservation race produced one winner and one loser for the final unit. Assertions also verified nonnegative availability, no losing-transaction residue, active-order uniqueness, and idempotent release, conversion, and expiration while retaining reservation history.
- The outbox integration test proved `FOR UPDATE SKIP LOCKED` claim exclusion between two workers, retryable failure, stale-claim recovery, three delivery attempts, processed state, and no post-processing reclaim.
- Both Redis instances returned `PONG`. During a confirmed development Redis outage, API liveness remained `200`, readiness returned controlled `503`, and readiness returned `200` after recovery.
- Live API responses were:

```text
GET /api/v1/health
200 {"status":"ok"}

GET /api/v1/health/ready
200 {"status":"ready","dependencies":{"postgres":"up","redis":"up"}}

GET /api/v1/health/ready  (Redis stopped and port confirmed closed)
503 {"error":{"code":"NOT_READY","message":"Required dependencies are unavailable.","requestId":"phase0-ready-redis-diagnostic","dependencies":{"postgres":"up","redis":"down"}}}
```

The corresponding outage log contained the same request ID:

```json
{"level":"warn","message":"Health readiness check failed","requestId":"phase0-ready-redis-diagnostic"}
```

The database/runtime infrastructure closure is passed. All packages with runtime behavior now have meaningful behavioral coverage, and the only zero-test packages are declaration-only. Phase 0 is complete; Phase 1 has not started.

### Packages with behavioral tests

| Package                       | Behavioral tests | Scope of evidence                                                                                                                                 |
| ----------------------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@rjpos/api`                  |               10 | Request IDs, sanitized error handling, liveness/readiness behavior, dependency failure behavior, and live isolated PostgreSQL/Redis connectivity. |
| `@rjpos/api-contracts`        |                3 | JSON-safe money parsing, invalid money rejection, and request-ID bounds.                                                                           |
| `@rjpos/auth`                 |                2 | Development identity and permission enforcement.                                                                                                  |
| `@rjpos/config`               |               10 | Application/test configuration validation, workspace discovery, normalized database identity, and test-database isolation guards.                 |
| `@rjpos/database`             |                3 | Tenant isolation, audit immutability, and concurrent inventory reservations against the dedicated test database.                                  |
| `@rjpos/domain-types`         |                2 | Exact, duplicate-free order/payment status registries and their derived TypeScript unions.                                                         |
| `@rjpos/events`               |                2 | Stable, unique, JSON-safe event names and their derived TypeScript union.                                                                           |
| `@rjpos/logging`              |                4 | Text, URL, key, and nested redaction; structured JSON output; request-ID inclusion; and timestamp validity.                                        |
| `@rjpos/payment-contracts`    |                2 | Provider-neutral status registry and compile-checked command/result/provider shapes.                                                               |
| `@rjpos/register`             |                6 | Electron security preferences, development/packaged renderer selection, URL validation, local fallback, and bounded availability checks.          |
| `@rjpos/ui`                   |                1 | Foundation token restrictions.                                                                                                                    |
| `@rjpos/web`                  |                3 | Existing shell identity, root layout/metadata, and server rendering without browser or Electron globals.                                           |
| `@rjpos/worker`               |                1 | Outbox claim, retry, stale-claim recovery, and completion against the dedicated test database.                                                    |

Total behavioral tests: 49. The two zero-test packages below are excluded from this total.

### Packages with zero behavioral tests

| Package                     | Classification | QA assessment                                                                                                                                                                             |
| --------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@rjpos/api-client`         | Compile-only   | It exports only the `ApiError` TypeScript type and emits no runtime value or helper. Compilation is the applicable evidence.                                                              |
| `@rjpos/hardware-contracts` | Compile-only   | It exports only TypeScript interfaces for scanners, printers, drawers, and displays. Certified hardware implementations are outside Phase 0; there is no runtime implementation to test. |

Neither package is mocked-only. No runtime package is classified as out of scope or missing required Phase 0 coverage.

## Behavioral coverage closure

Focused package results:

```text
@rjpos/api-contracts       3 passed
@rjpos/domain-types        2 passed
@rjpos/events              2 passed
@rjpos/logging             4 passed
@rjpos/payment-contracts   2 passed
@rjpos/web                 3 passed
```

The logging tests exposed one defect: `redact()` handled only top-level keys and `log()` emitted message/context strings without applying the exported sanitizers. The package-local fix recursively redacts supported sensitive keys, sanitizes credential URLs and inline secret assignments, and applies those protections inside `log()`. API and worker regression suites remained green.

Type-level assertions for domain and payment contracts are compiled through dedicated `tsconfig.test.json` files. Production builds continue to emit only `src` files.

## Test-data isolation

The committed `.env.test.example` targets dedicated services:

- PostgreSQL `127.0.0.1:15433`, database `rjpos_test`.
- Redis `127.0.0.1:6380`.

Before the test preparation script can start Prisma, the configuration boundary:

1. Parses PostgreSQL URLs and accepts only `postgres:` or `postgresql:`.
2. Normalizes the host, including common loopback aliases such as `localhost`, `localhost.localdomain`, `127.x.x.x`, and IPv6 loopback.
3. Normalizes an omitted PostgreSQL port to `5432`.
4. Percent-decodes the database name and ignores credentials and query-string differences for identity comparison.
5. Compares normalized host, port, and database name with the development `DATABASE_URL`.
6. Rejects a matching development identity.
7. Rejects any test database name that is not explicitly test-designated, such as the required `rjpos_test` suffix.

Only after these checks pass does `prepare-test-database.ts` pass `TEST_DATABASE_URL` to `prisma migrate deploy` and construct its Prisma client with the same test URL. The script has no reset or truncate operation. Its writes are idempotent fixture upserts against the test-designated database. Under the checked repository configuration it cannot migrate, seed, truncate, or otherwise modify the development database.

The database integration tests do mutate data and therefore use only `TEST_DATABASE_URL`. The API PostgreSQL connectivity test is read-only (`SELECT 1`) but uses the same isolated test database. Current Redis test-suite coverage is connectivity-only; it still uses the separate `TEST_REDIS_URL` so future stateful tests cannot contaminate development Redis. Live runtime validation separately stopped and restored only the development Redis container to prove readiness behavior.

## Reproducible verification

From a clean PowerShell session at the repository root:

```powershell
pnpm install
Copy-Item .env.test.example .env.test
docker compose -f docker/docker-compose.yml --profile test up -d --wait postgres-test redis-test
pnpm --filter "@rjpos/api" test
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Required test variables are `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_ORGANIZATION_ID`, `TEST_STORE_ID`, `TEST_VARIANT_ID`, `TEST_ORDER_ID_ONE`, and `TEST_ORDER_ID_TWO`.

## Electron register runtime validation

The six `@rjpos/register` tests validate configuration and security behavior, but they are not counted as proof that Electron launches. Runtime launch was verified separately against a live, independently started Next.js server with:

```powershell
pnpm --filter "@rjpos/web" dev
pnpm --filter "@rjpos/register" exec electron . --smoke-test
```

The Electron process created a `BrowserWindow`, loaded the web page whose heading was `RJ POS`, invoked the real preload bridge and `hardware:status` IPC handler, and reported `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Its measured bounds were `1440x900` with a `1024x700` minimum. An unavailable renderer URL was also tested: after exactly 20 attempts Electron logged the failure, displayed the packaged error page, preserved IPC/security behavior, and returned a nonzero smoke result without an automatic reload loop.

This runtime smoke evidence resolves the former register entry-point defect. It does not replace the six unit tests, and those tests alone must still not be described as launch validation.
