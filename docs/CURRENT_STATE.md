# Current State

Updated: 2026-09-25

## Phase

Phases 0-3 remain implemented. Phase 4 delivers a global master product catalog and CSV import, tenant-scoped suppliers and vendor-product mappings, purchase orders, transactional receiving integrated with inventory movements, and back-office workflows. Vendor-mapping and purchase-order variant selectors use server-side search and pagination. Phase 1-3 Prisma drift findings and the safe legacy differences are documented in the Phase 4 QA record. Phase 4 is open for review in PR #6 against `phase-3`.

## Delivered

- pnpm/Turborepo monorepo with web, Electron register, NestJS API, and worker.
- PostgreSQL 18 Prisma schema and migrations, Redis local dependency, and fictional seed data.
- Organization, store, register tenant ownership with compound foreign keys and scoped repository access.
- Development authentication provider abstraction and permission-based RBAC foundation.
- Request IDs, standardized error envelopes, health/readiness checks, structured redacted logging, and validated environment configuration.
- Append-only audit records protected by a PostgreSQL trigger.
- Transactional outbox claiming, retry, stale-claim recovery, and at-least-once processing foundation.
- Concurrency-safe inventory reservations and race-condition test.
- Electron development loading of the independently running Next.js application, packaged/static renderer separation, bounded unavailable-server handling, context isolation, disabled node integration, sandbox, and narrow hardware IPC. A real Electron smoke launch verified the web heading and IPC response.
- Shared RJ POS UI tokens and GitHub Actions CI.
- Phase 1 product/variant catalog with store prices, SKU/UPC lookup, active, age-restricted, tax-category, cost, and inventory-tracking attributes.
- PostgreSQL-backed register open/close lifecycle, server-authoritative checkout, cash tender/change, simulated terminal uncertainty, receipts/history, full/partial refunds, and void compensation.
- Responsive Next.js register workflow with keyboard-scanner entry, repeated-scan quantity behavior, cart controls, age acknowledgment, cash/terminal checkout, printable receipt, inventory view, and order history.
- Tenant-scoped `/admin` application and `/api/v1/admin` boundary for products, variants, categories, prices, inventory history/adjustments, employees, stores, registers, orders, refunds, audit, settings, and dashboard.
- PostgreSQL-enforced concurrent UPC and effective-price conflict handling, active-session lifecycle safeguards, and a real API/controller-to-database catalog-to-sale-to-admin E2E flow.
- One-active-shift enforcement, clock in/out, current status, shift history, worked duration, manager corrections, and retained history for inactive employees.
- Tenant-scoped customer create/edit/search/lifecycle, optional register attachment, and order-derived purchase history.
- Configurable loyalty earn/redemption/manual adjustment with immutable transaction history and refund/void compensation.
- Secure hashed internal gift cards with issue/reload/lookup/disable, immutable balance history, concurrent final-balance protection, and gift-card plus cash/simulated-terminal split tender.
- Real PostgreSQL race coverage and a controller-to-database Phase 3 employee/customer/value/refund E2E flow.
- Global master products keyed by normalized UPC, including the seeded 2,714-row product export, CSV validation/deduplication/idempotent import, reference-only cost/price metadata, and explicit Add to Store setup without automatic price or inventory creation.
- Tenant-scoped vendors and vendor mappings with multiple suppliers, preferred vendor selection, current vendor cost, case packs, minimum order quantities, and historical PO/receipt cost snapshots.
- Draft/submitted/partially received/received/cancelled purchase orders; serialized and idempotent receiving with damaged/rejected quantities, inventory ledger posting, audit records, and transactional outbox events.
- Searchable, paginated product/variant selectors for vendor mappings and purchase-order drafts; selected variants remain available while navigating result pages and editing existing records.
- Time-zone-safe outbox event claiming so pending purchase-receipt events remain eligible when PostgreSQL runs outside UTC.
- Phase 4 integration and API E2E test cases authored for CSV behavior, supplier isolation, receipt races, inventory movement, register lookup, and sale-after-receipt.

## Local Endpoint

RJ POS Docker Compose maps PostgreSQL to `127.0.0.1:15432` and Redis to `127.0.0.1:6379`. Port 5432 is deliberately avoided because it may be owned by an unrelated Windows PostgreSQL installation.

## Verification

Phase 0 evidence remains in `docs/phase-0/final-qa.md`. Phase 1 evidence remains under `docs/phase-1/`; Phase 2 evidence is under `docs/phase-2/`; Phase 3 implementation and QA evidence is under `docs/phase-3/`. Phase 3 closure re-verification repeated its required gates and PostgreSQL-backed race/E2E coverage. Phase 4 implementation, cleanup, and QA evidence are under `docs/phase-4/`; the required typecheck, lint, build, test, and diff checks are rerun for the pre-merge updates. Real payment-provider, certified-hardware, payroll/scheduling, advanced loyalty/marketing, and advanced analytics work remain intentionally out of scope.
