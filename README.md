# RJ POS

RJ POS is a multi-tenant retail point-of-sale platform. Phase 0 established the runtime foundation; Phases 1â€“3 add the complete register and back-office workflows plus workforce, customer, loyalty, gift-card, and split-tender operations while retaining the NestJS API, secure Electron boundary, worker, PostgreSQL, Redis, and shared contracts.

## Local development

1. Copy the safe template exactly: `Copy-Item .env.example .env`. Keep `.env` local and Git-ignored; do not commit credentials. API and worker startup automatically load the repository-root `.env`, even when started through a package-specific command.
2. Start PostgreSQL and Redis with `docker compose -f docker/docker-compose.yml up -d`. RJ POS PostgreSQL is available at `127.0.0.1:15432`; this avoids colliding with an unrelated Windows PostgreSQL service on 5432.
3. Install dependencies with `pnpm install`.
4. Run migrations and seed data with `pnpm --filter @rjpos/database db:deploy` and `pnpm --filter @rjpos/database db:seed`.
5. Run checks with `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.

Run development from the repository root with `pnpm dev`. Package-specific API and worker commands also work from their workspace directories: `pnpm --filter @rjpos/api dev` and `pnpm --filter @rjpos/worker dev`.

To run the register UI independently, start the two development processes in order:

```powershell
# Terminal 1
pnpm --filter "@rjpos/web" dev

# Terminal 2
pnpm --filter "@rjpos/register" dev
```

The web application listens explicitly on port 3000. During development, Electron loads `RJPOS_RENDERER_URL` from the repository-root `.env`, falling back to `http://localhost:3000`. It performs a bounded availability check before loading the URL; if the web server remains unavailable, Electron shows a visible error page and logs the failure without entering an automatic reload loop. A packaged Electron application loads its copied local `renderer.html` instead. Renderer code remains sandboxed behind the preload bridge and `hardware:status` IPC; it does not access Prisma or PostgreSQL directly.

Payment provider credentials and certified hardware are intentionally not required for Phase 0. The first payment implementation is the simulated terminal contract.

## Phase 1 Core POS

After migrations and seed complete, start `pnpm dev`, open the register, and scan one of the fictional Tito's UPCs (`619947000013`, `619947000020`, `619947000037`, or `619947000044`). The development identity defaults to the seeded Owner, Downtown store, and Register 01. The UI talks only to `NEXT_PUBLIC_RJPOS_API_URL`; Electron remains a secure host for the same Next.js application.

The API is authoritative for current prices, tax, discounts, stock, register state, and payment state. Cash sales complete atomically. The simulated terminal supports approved, declined, cancelled, timeout, unknown, lost-network, duplicate-callback, and late-callback scenarios. Unknown financial outcomes remain pending reconciliation and are never automatically retried.

Core endpoints live below `/api/v1`: catalog lookup, inventory, current store configuration, register sessions, cash/terminal checkout, order history/receipts, voids, and refunds. Development role behavior can be exercised with `x-rjpos-role: OWNER`, `MANAGER`, or `CASHIER`; sensitive operations are enforced by the API.

No external account, payment credential, hardware SDK, or machine-level tool is needed for Phase 1. PostgreSQL remains authoritative; the project does not introduce a second local/offline source of truth. Real processors, certified terminals, scanners, printers, and drawers remain future integrations behind their existing boundaries.

## Phase 2 Back Office

After deploying migration `0004_phase2_back_office`, open `http://localhost:3000/admin`. Owner and Manager users can administer the catalog, variants, effective-dated store prices, ledger-backed inventory, employees, registers, orders/refunds, and audit history. Owner-only operations cover store lifecycle and settings. Cashiers do not receive admin API permissions.

The New product workflow can create a category, product, variant/SKU/UPC, current store price, low-stock threshold, and opening inventory in one guided operation. Each step calls an explicit `/api/v1/admin` operation; the browser never talks to Prisma or PostgreSQL. Return to `/` (or the secure Electron host), scan the new UPC, sell it, and use the admin Orders and Inventory areas to verify the authoritative result.

Manual inventory changes require a signed integer delta and reason and always create ledger/audit records. Price changes append effective-dated rows and retain history. Products, variants, categories, employees, stores, and registers use active/inactive lifecycle states; active register sessions prevent unsafe register/store changes.

## Phase 3 Workforce and Customer Value

The register now supports employee clock in/out, optional customer attachment, projected and redeemed loyalty points, internal gift-card redemption, and gift-card plus cash or simulated-terminal split tender. Walk-in checkout remains supported. The back office adds shift history/corrections, customer profiles and purchase history, loyalty configuration/manual adjustments, and gift-card issue, reload, lookup, history, and disable operations.

Loyalty and gift-card balances are derived from immutable transaction ledgers. Checkout, void, and refund operations create compensating entries; they do not rewrite economic history. Customer, shift, and card access remains tenant-scoped, sensitive management operations require Owner or Manager permissions, and concurrent balance use is serialized in PostgreSQL. Gift-card codes are generated from cryptographically secure random bytes and stored only as hashes; the plaintext code is returned only when issued.

Phase 3 remains internal-only: it does not add payroll, scheduling, marketing campaigns, loyalty tiers, network gift cards, or real payment terminals.

## Integration-test setup

Integration tests use dedicated PostgreSQL and Redis services; they must never target the normal development services. From a clean PowerShell session at the repository root, run:

```powershell
pnpm install
Copy-Item .env.test.example .env.test
docker compose -f docker/docker-compose.yml --profile test up -d --wait postgres-test redis-test
pnpm --filter "@rjpos/api" test
pnpm test
```

The test PostgreSQL service listens on `127.0.0.1:15433` and uses the `rjpos_test` database. The test Redis service listens on `127.0.0.1:6380`. Both are separate from development ports `15432` and `6379`. `.env.test` is Git-ignored, and each integration-test module loads it by discovering the repository root, so package-specific commands work regardless of their workspace working directory.

`pnpm test` runs `pnpm test:prepare` first. Preparation applies migrations and idempotently creates only dedicated test fixtures; it does not reset or connect to the development database. The API PostgreSQL check executes only `SELECT 1`, and the API Redis check opens only a connectivity probe, but they also use the isolated test services for consistency. Stateful database tests mutate only `TEST_DATABASE_URL`; future stateful Redis tests must use only `TEST_REDIS_URL`.

Required test variables, with safe local values in `.env.test.example` and `.env.example`, are:

- `TEST_DATABASE_URL`
- `TEST_REDIS_URL`
- `TEST_ORGANIZATION_ID`
- `TEST_STORE_ID`
- `TEST_VARIANT_ID`
- `TEST_ORDER_ID_ONE`
- `TEST_ORDER_ID_TWO`

Explicit process environment values may override `.env.test` in CI. The loader normalizes and compares the PostgreSQL host, port, and database name, requires an explicitly test-designated database such as `rjpos_test`, and rejects a normalized match with `DATABASE_URL`. It also rejects a test Redis URL that exactly matches `REDIS_URL`. See the [Phase 0 final QA status](docs/phase-0/final-qa.md) for behavioral-test counts, known coverage gaps, and separate Electron runtime evidence.
