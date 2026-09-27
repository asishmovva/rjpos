# Phase 2 Back-Office Management — QA Handoff

Updated: 2026-09-24

## Prerequisites

Use the existing isolated development/test services and repository-level environment discovery:

```powershell
Copy-Item .env.example .env
Copy-Item .env.test.example .env.test
docker compose -f docker/docker-compose.yml --profile test up -d --wait
pnpm --filter "@rjpos/database" db:deploy
pnpm --filter "@rjpos/database" db:seed
pnpm test
```

The preparation guard requires a test-designated database such as `rjpos_test`, compares normalized host/port/database identity against development, and applies migrations only to `TEST_DATABASE_URL`. It has no reset, truncate, or development-database mutation path.

## Behavioral coverage

- Categories/products/variants: create, edit, search, activate/deactivate, referenced-category protection, tenant isolation, duplicate SKU/UPC, and concurrent identical UPC.
- Pricing: active/future prices, history, invalid values/windows, overlap rejection, tenant ownership, and concurrent effective-period conflicts.
- Inventory: opening balance, adjustment in/out, required reason, resulting quantity, low-stock signal, negative protection, immutable ledger, and concurrent serialized adjustments.
- Employees/RBAC: role/store assignment, inactive lifecycle, invalid tenant store, Owner/Manager/Cashier permission matrix, inactive-request rejection, and retained employee row/history.
- Stores/registers: create/update/lifecycle, active-session safeguards for store deactivation, register deactivation, and reassignment, plus a real concurrent open-session/deactivation race.
- Orders/refunds/audit/dashboard: filtering, detail, tenant isolation, refund visibility, expected audit actions, database-level audit immutability, and authoritative dashboard aggregation.
- Frontend behavior: full sellable-item creation, edit product/variant request shape, price scheduling, ledger adjustment, employee role change, and server-side order/refund search.
- PostgreSQL-backed API E2E: Owner admin controller creates category/product/variant/UPC/price/opening inventory; Core POS finds and sells it; admin inventory, Orders, and audit show the result.

Mocks are used only for browser interaction/request-shape tests. The primary administrative flow and all constraint/race behavior use the real API controllers, application services, Prisma, and dedicated PostgreSQL database.

## Manual workflow

```powershell
# Terminal 1
pnpm --filter "@rjpos/api" dev

# Terminal 2
pnpm --filter "@rjpos/web" dev

# Terminal 3 (optional secure host)
pnpm --filter "@rjpos/register" dev
```

Open `http://localhost:3000/admin`, create a sellable product with category, variant, UPC, price, threshold, and opening stock. Return to `/`, scan the UPC, complete a sale, then confirm Orders and Inventory in `/admin`. Electron loads the same web application; its preload/IPC, context isolation, disabled Node integration, and sandbox settings are unchanged.

## Known limitations

- Development authentication remains the approved Phase 0 provider abstraction; production identity-provider integration is not part of Phase 2.
- The admin UI uses focused prompts for compact edit/adjust actions. API validation is authoritative.
- Refund execution retains the existing Phase 1 endpoint and semantics; the Refunds page is an operational ledger/search view.
- Dashboard “today” currently follows API-host local midnight. Per-store timezone reporting can be refined in a later approved analytics phase.
- No Phase 3 feature is included.

## Final evidence

Final verification completed on 2026-09-24:

```text
pnpm typecheck       30/30 dependency and typecheck tasks successful
pnpm lint            30/30 dependency and lint tasks successful
pnpm build           15/15 package builds successful
pnpm test            30/30 build/test tasks successful
git diff --check     exit 0 (line-ending notices only)
```

The first `pnpm typecheck` attempt failed because the Next.js production dependency build could not resolve the admin page's Node-style local `.js` import. The import was corrected, the focused Next build passed, and all five required gates then passed. No required test is failed, blocked, disabled, or skipped.

Behavioral counts—not task counts—are:

| Package | Passed |
| --- | ---: |
| `@rjpos/api` | 17 |
| `@rjpos/api-contracts` | 3 |
| `@rjpos/auth` | 2 |
| `@rjpos/config` | 10 |
| `@rjpos/database` | 28 |
| `@rjpos/domain-types` | 7 |
| `@rjpos/events` | 2 |
| `@rjpos/logging` | 4 |
| `@rjpos/payment-contracts` | 12 |
| `@rjpos/register` | 6 |
| `@rjpos/ui` | 1 |
| `@rjpos/web` | 7 |
| `@rjpos/worker` | 1 |
| **Total** | **100** |

Exactly two current packages have zero behavioral tests:

| Package | Classification | Rationale |
| --- | --- | --- |
| `@rjpos/api-client` | Compile-only | Declaration/client transport package; no runtime-specific Phase 2 behavior is implemented there. |
| `@rjpos/hardware-contracts` | Compile-only | Declaration-only native boundary; real hardware remains explicitly outside Phase 2. |

Their successful no-test tasks are not counted as behavioral validation. There are no mocked-only packages and no known missing required Phase 2 package coverage. The prior Phase 0 count of more zero-test packages no longer describes the current tree because Phase 1/2 added behavioral suites.

The dedicated database suite was also run directly with cache bypassed at the package level and file parallelism disabled: 28/28 passed. Its explicit `Promise.allSettled`/`Promise.all` cases still execute the required UPC, price-period, inventory, and register/session conflicts concurrently; serializing test files prevents unrelated fixture suites from deadlocking one another. One resumed verification attempt found the isolated test services stopped and failed on reachability; `docker compose -f docker/docker-compose.yml --profile test up -d --wait` restored those dedicated services, `pnpm test:prepare` revalidated `rjpos_test` on port 15433, and the unchanged tests then passed.

Fresh runtime evidence used PID 33316 (`node dist/main.js`) bound to port 3001 and PID 33924 (the repository Next.js server) bound to port 3000:

```http
GET /api/v1/health
HTTP/1.1 200 OK
x-request-id: 5018d110-e04e-404b-850d-3a2dd37ac0ee

{"status":"ok"}

GET /api/v1/health/ready
HTTP/1.1 200 OK
x-request-id: 911b06d8-e974-496c-b80e-059556a8f3d2

{"status":"ready","dependencies":{"postgres":"up","redis":"up"}}

GET /api/v1/admin/dashboard
HTTP/1.1 200 OK
x-request-id: 44b55f5b-142f-4e1c-8c33-60bec867d267

{"salesMinor":"4263","transactions":1,"refundMinor":"4263","openRegisters":1,"lowStockProducts":0,"asOf":"2026-09-24T00:15:02.968Z"}
```

`GET http://127.0.0.1:3000/admin` returned 200 and rendered “Back Office”. The real Electron binary then loaded the independent web server and returned:

```json
{"heading":"Downtown Register","hardwareStatus":"simulated","bounds":{"x":240,"y":66,"width":1440,"height":900},"minimumSize":[1024,700],"security":{"contextIsolation":true,"nodeIntegration":false,"sandbox":true}}
```

This runtime smoke result, not the register package's six unit tests, confirms application launch, the preload bridge, `hardware:status` IPC, and the preserved security settings. The temporary API/web verification processes were stopped cleanly afterward.
