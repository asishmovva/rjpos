# Phase 2 Back-Office Management — Implementation Summary

Updated: 2026-09-24

## Delivered

Phase 2 adds a tenant-scoped administrative application at `/admin` with Dashboard, Products, Categories, Inventory, Orders, Refunds, Employees, Stores, Registers, and Settings areas. The register UI remains separate and unchanged in architecture: both browser and Electron renderers call the versioned NestJS API, which calls application services and Prisma/PostgreSQL.

The catalog workflow creates a category, product, independently identified variant, tenant-unique SKU/UPC, effective-dated store price, low-stock threshold, and ledger-backed opening balance without SQL or seed edits. Products, variants, categories, stores, registers, and employees use active/inactive lifecycle operations rather than destructive deletion.

## API and authorization

Explicit operations live under `/api/v1/admin`; there is no generic database CRUD endpoint. Owner has the complete administrative permission set. Manager can administer normal catalog, pricing, inventory, employees, registers, orders/refunds, dashboard, and audit operations. Store lifecycle and platform settings remain Owner-only. Cashier receives no administrative permission. Every admin request checks its permission and confirms that the employee is active, belongs to the tenant, and is assigned to the request store.

Search/filter/pagination execute server-side for growing catalog, inventory history, employee, order, refund, and audit datasets. Error responses retain the shared request-ID envelope. Prisma uniqueness and PostgreSQL effective-period exclusions remain the final conflict protection.

## Database changes

Migration `0004_phase2_back_office` adds:

- active/inactive store lifecycle, timezone, receipt footer, and age-restriction label;
- active/inactive category lifecycle;
- per-variant nonnegative low-stock thresholds;
- dedicated inventory movement reason and resulting-on-hand fields;
- administrative query indexes.

Existing price exclusion constraints, immutable audit trigger, inventory constraints, tenant compound foreign keys, active-register-session uniqueness, idempotency, and outbox structures are unchanged. The migration backfills dedicated reasons from the legacy Phase 1 reference value but does not rewrite quantities or transactional history.

## Operational behavior

- SKU and UPC conflicts are reported and backed by tenant-scoped unique indexes; concurrent identical UPC creation permits exactly one winner.
- Price schedules validate nonnegative minor-unit amounts and valid windows. Scheduling a new current/future price closes the single open prior period at the new start, preserves price history, and rejects any remaining overlap, including concurrent conflicting periods, through PostgreSQL.
- Opening balance and adjustment-in/out create immutable inventory movements and audit records. There is no quantity overwrite endpoint. Manual adjustments require a reason and serialize on the inventory row.
- Employee roles are limited to Owner, Manager, and Cashier, and assignments require active tenant stores. Deactivation retains all historical foreign-key attribution.
- Store/register deactivation and register reassignment are rejected while an active register session exists. Store/register lifecycle writes and register-session opening take compatible row locks so a concurrent race cannot deactivate an in-use location.
- Orders expose server-side operational filters and detailed items, payments, refunds, reservations, and related inventory movements. Refund management reads the existing Phase 1 authoritative refund state.
- Dashboard cards derive from orders, refunds, register sessions, and inventory levels; no separate analytics store exists.

## Intentional limits

Phase 2 does not add purchasing, vendors, receiving workflows, transfers, CSV import/export, loyalty, gift cards, advanced promotions, accounting, e-commerce, offline synchronization, real payment providers, or hardware SDKs. Address editing remains JSON-backed through the API. Refund creation continues to use the existing Phase 1 refund operation; the Phase 2 refund area focuses on retrieval and operational visibility.
