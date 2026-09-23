# Phase 1 Core POS — QA Handoff

Updated: 2026-09-23

## Prerequisites

Use the repository-local `.env` and dedicated `.env.test` templates. Start the development and test Docker Compose services, deploy migrations, and seed the fictional development tenant. No external account, credential, payment SDK, or POS hardware is required.

```powershell
docker compose -f docker/docker-compose.yml --profile test up -d --wait
pnpm --filter "@rjpos/database" db:deploy
pnpm --filter "@rjpos/database" db:seed
pnpm test
```

Tests mutate only `TEST_DATABASE_URL`, whose normalized identity must have a test-designated database name and differ from the development host/port/database tuple. Test preparation migrates and upserts fixtures only after that guard; it contains no reset or truncate operation and cannot select the development URL under the documented configuration.

## Behavioral coverage

- Calculation: integer money, fixed/percentage discounts, cap-at-zero behavior, taxable/exempt lines, half-up rounding boundaries, change due, and repeated scans.
- Catalog: UPC, SKU, name/brand, unknown UPC, inactive state, and tenant isolation.
- Inventory/register: opening balance, adjustment, negative protection, reservation lifecycle, open conflict, close conflict, expected cash/difference, refund-aware cash, and closed-session rejection.
- Checkout: atomic cash success, frozen totals, change, invalid product/price/tender/stock, age acknowledgment, idempotency, final-stock race, duplicate-submit race, and close-vs-sale serialization.
- Terminal: every simulated result, duplicate and late callback behavior, preserved unknown state, held reservation, reconciliation timestamp, and no automatic retry.
- Receipt/history/refund/void: receipt snapshots, search, full/partial refund, failed provider refund, duplicate refund, stock return, immutable sale quantities, void compensation, and idempotent action keys.
- Authorization: Owner/Manager sensitive permissions, restricted Cashier, and Owner-only settings.
- End-to-end: one real PostgreSQL-backed open → lookup → two-item cash sale → receipt → history → full refund → inventory restoration → close flow.

The database concurrency and end-to-end scenarios use real PostgreSQL, not mocks. The simulated terminal is intentionally a contract implementation, not a real processor.

## Manual register check

```powershell
# Terminal 1
pnpm --filter "@rjpos/api" dev

# Terminal 2
pnpm --filter "@rjpos/web" dev

# Terminal 3
pnpm --filter "@rjpos/register" dev
```

Open the register, scan `619947000020` twice, acknowledge age verification, complete cash checkout, print/view the receipt, open Orders, then close the register. Electron must display this same web UI with context isolation and sandbox enabled and Node integration disabled.

## Known limitations

- The terminal is simulated; no PAN, CVV, PIN, or track data is accepted or stored.
- Unknown terminal outcomes require explicit future reconciliation handling; Phase 1 correctly does not retry them.
- The UI exposes the essential register, receipt, inventory, and order-history paths. Rich back-office CRUD, split-tender UI, printer SDKs, offline synchronization, real providers, and all later-phase features are intentionally absent.
- Browser printing is the receipt implementation. A printer adapter can later sit behind the existing hardware boundary.

## Final evidence

All required checks passed on 2026-09-23 after the final code changes:

```text
pnpm typecheck       15/15 package tasks successful
pnpm lint            15/15 package tasks successful
pnpm build           15/15 package tasks successful
pnpm test            15/15 package tasks successful
git diff --check     exit 0
```

Behavioral test counts are:

| Package | Passed |
| --- | ---: |
| `@rjpos/api` | 13 |
| `@rjpos/api-contracts` | 3 |
| `@rjpos/auth` | 2 |
| `@rjpos/config` | 10 |
| `@rjpos/database` | 17 |
| `@rjpos/domain-types` | 7 |
| `@rjpos/events` | 2 |
| `@rjpos/logging` | 4 |
| `@rjpos/payment-contracts` | 12 |
| `@rjpos/register` | 6 |
| `@rjpos/ui` | 1 |
| `@rjpos/web` | 3 |
| `@rjpos/worker` | 1 |
| **Total** | **81** |

`@rjpos/api-client` and `@rjpos/hardware-contracts` remain declaration-only, compile-only packages with zero behavioral tests. They are excluded from the total; their successful task execution is not counted as behavioral validation. No required test was failed, blocked, or skipped.

The database suite was also run directly and uncached with file parallelism disabled: 17/17 passed. Its 14 Core POS cases include the real PostgreSQL race and end-to-end flows.

Fresh runtime processes bound the candidate code to ports 3000 and 3001. Liveness returned `200 {"status":"ok"}`; readiness returned `200 {"status":"ready","dependencies":{"postgres":"up","redis":"up"}}`; and UPC `619947000020` returned the active Tito's 750 ml variant at 1999 minor units. A live two-unit cash sale returned subtotal 3998, tax 265, total 4263, tender 5000, and change 737. Receipt/history both exposed the completed order; its full refund succeeded for 4263; inventory returned to its original quantity; and close returned expected/actual cash 10000 with zero difference.

Electron independently loaded the live Next.js register and reported:

```json
{"heading":"Downtown Register","hardwareStatus":"simulated","bounds":{"width":1440,"height":900},"minimumSize":[1024,700],"security":{"contextIsolation":true,"nodeIntegration":false,"sandbox":true}}
```

The Electron smoke process exited successfully. The host runner had `ELECTRON_RUN_AS_NODE=1`; it was removed only for the child smoke invocation so the actual Electron binary, rather than Node compatibility mode, executed.
