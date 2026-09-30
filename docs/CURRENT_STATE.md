# Current State

Updated: 2026-09-30

## Phase

Phases 0-8 are merged into `main`. **Phase 9** (final operations, channels, bulk tools and release readiness) is implemented on `phase-9` for review: held-sale notes/expiry, sales channels with channel pricing and reporting, bulk changes, CSV import/export, labels, vendor claims, velocity purchase suggestions, alternate/case UPCs, audit viewer, backup status, session revocation, production auth mode and startup guard, Electron CSP and IPC sender checks, and deployment/release documentation. See `docs/phase-9/release-checklist.md` for working features, hardware and payment status (not certified / not integrated), limitations, deployment and rollback.

Earlier summary (Phases 0-7):

Phases 0-6 are merged into `main`. Phase 7 adds the touch-first register, Quick Keys, held transactions, cashier utilities, hardened Electron hardware IPC/adapters, a real-terminal adapter boundary, Windows packaging, outage/recovery UX, production security controls, and tested PostgreSQL backup/restore. Phase 7 is implemented on `phase-7` for review and is not merged.

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
- Store-specific low-stock/reorder policy, transfer lifecycle with fingerprinted idempotency and PostgreSQL row locking, partial destination receipts, and immutable transfer movements.
- Cycle counts with expected snapshots, review/finalization, positive/negative variance, current-stock-safe adjustment movements, and duplicate-finalization protection.
- Preferred-vendor replenishment suggestions with MOQ/case-pack rounding and explicit draft-PO creation only.
- Percentage, fixed, and multi-buy promotions across variant/product/category and optional store scope, with deterministic priority, active windows, minimums, paid-price refund behavior, and promotion snapshots on order lines.
- Server-authoritative register quotes and checkout recalculation; the cart and receipt display original/promotional/final amounts without accepting promotion values from the renderer.
- Phase 5 back-office views for transfers, counts, variances, replenishment, and promotions, with Owner/Manager access and Cashier denial.
- A single server-side reporting engine covering sales, products, inventory, purchasing, employees/register-sessions, customers/loyalty, gift cards, and promotions, with tenant/store-scoped, timezone-correct date filtering and historical order-item snapshots.
- CSV export for every report kind (with CSV formula-injection protection) and a provider-neutral accounting-export JSON boundary composing sales, inventory, and purchasing data.
- A period-aware dashboard upgrade (net sales, transactions, average sale, refunds, top products, outstanding purchase orders) built on the same reporting engine, and a dedicated `/admin/reports` workspace with report/date/store filters.
- `report:read`/`report:export` RBAC restricted to Owner/Manager, and a `RegisterSession` reporting-period index added only where a report query needed it.
- Touch-first register controls, grouped per-store/register Quick Keys, focus-independent USB HID scanner capture, cash denomination keys, and direct cashier utility actions.
- Idempotent PostgreSQL-held sales with cashier/register/customer attribution and authoritative pricing revalidation on resume.
- Audited manager price overrides and manual drawer opens; cash-sale drawer authorization is derived from authoritative receipt payment state.
- Allowlisted secure Electron printer/drawer IPC, controlled hardware availability/errors, and an authorized hardware settings workspace.
- Provider-neutral HTTPS terminal adapter with no automatic retry for uncertain payments and no production simulated-success fallback.
- Static packaged Next renderer, NSIS Windows installer, custom icon/metadata, restricted navigation/permissions, CORS allowlist, secure response headers, and practical rate limiting.
- Guarded PostgreSQL custom-format backup/restore scripts with retention and isolated restore-test validation.

## Local Endpoint

RJ POS Docker Compose maps PostgreSQL to `127.0.0.1:15432` and Redis to `127.0.0.1:6379`. Port 5432 is deliberately avoided because it may be owned by an unrelated Windows PostgreSQL installation.

## Verification

Phase 0 evidence remains in `docs/phase-0/final-qa.md`; later evidence remains under each phase directory. Phase 7 implementation and QA evidence is under `docs/phase-7/`. Physical printer/drawer/terminal certification and Windows code signing remain manual prerequisites because no devices, provider credentials, SDK, or signing certificate were supplied.
