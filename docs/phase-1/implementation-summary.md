# Phase 1 Core POS — Implementation Summary

Updated: 2026-09-23

## Delivered workflow

Phase 1 connects one production-shaped vertical slice: open a register, find a product, build a deterministic cart, validate price/tax/discounts on the server, reserve stock, take cash or a simulated terminal payment, finalize inventory and the sale, render a receipt, search history, refund or void through compensating records, and close the register.

The Electron application still hosts the independent Next.js UI. It does not contain checkout, Prisma, or payment logic. PostgreSQL remains authoritative, and future native operations remain behind preload and IPC.

## Service boundaries

- `catalog.ts` resolves exact UPCs, SKUs, product names, and brands with store-price precedence and tenant scoping.
- `inventory.ts` posts one opening balance and reason-coded adjustments. Checkout, refunds, and voids add immutable ledger movements instead of overwriting history.
- `register-sessions.ts` enforces open/close transitions and computes expected cash from original captured cash less successful cash refunds. A partial unique index allows only one active session per register.
- `cart.ts` uses integer minor units and basis points for line/order fixed or percentage discounts, half-up tax rounding, caps discounts at the payable amount, and rejects invalid tender.
- `checkout.ts` owns product/price validation, age acknowledgment, session locking, totals, reservation, payment, order finalization, inventory conversion, audit, outbox, and idempotency. The browser cannot submit trusted totals.
- `orders.ts` supplies tenant-scoped receipts/history and idempotent void/refund compensation. Original order items are never rewritten.
- `core-pos.ts` exposes the application services and enforces Owner/Manager/Cashier permissions at the API boundary.

## Payment behavior

Cash checkout records amount due, tender, and change in the same serializable transaction as the completed order and stock conversion. The provider-neutral simulated terminal supports approved, declined, cancelled, timeout, unknown, network-lost, duplicate-callback, and late-callback outcomes. Timeout/network/unknown results remain `PENDING_PAYMENT`/`UNKNOWN`, hold the reservation for reconciliation, and are not retried automatically.

The schema retains an order-to-many-payments relationship. Phase 1 deliberately does not add split-tender UI.

## Data changes

Migration `0003_phase1_core_pos` adds store tax configuration; product tax/tracking flags; variant cost; register closer attribution; order completion, void, and age-verification evidence; cash tender/change; refund reason/employee/completion; refund line items; nonnegative constraints; active-session uniqueness; and opening-balance uniqueness.

The fictional seed now includes Owner/Manager/Cashier permission assignments and four independently priced Tito's variants with distinct SKUs, UPCs, costs, and opening inventory.

## UI and management boundary

The register UI supports keyboard/scanner input, repeated scan increments, quantity editing/removal, clear cart, projected configured tax, age acknowledgment, cash/simulated terminal checkout, printable receipt, live inventory, and recent order history. Inventory mutations, refunds, and voids are available through secured Phase 1 APIs; advanced back-office editing, richer product forms, and elaborate split tender remain outside this phase.

There is no offline database or synchronization engine. This avoids introducing a second source of truth before an explicit offline design is approved.
