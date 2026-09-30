# Phase 8 implementation summary

Phase 8 builds on the Phase 7 costing/pricing/tax work (migration `0014`, see `docs/phase-7/implementation-summary.md`) and adds the remaining cash, return, and closeout operations. Migration: `0015_phase8_cash_returns_dayclose`.

## Product economics (delivered in Phase 7, extended here)
- The purchased-product wizard (`/admin/products/new/`) now also captures an optional **case UPC**, **minimum order (whole cases)**, **preferred vendor**, **low-stock threshold**, and **reorder target**, plus custom pack sizes. Only Owner/Admin (`catalog:manage` + `vendor:manage`) can create products.
- `VendorProductMapping.caseUpc` is unique per organization; a scanned case UPC resolves to the existing product instead of creating a duplicate. MOQ must be a multiple of the case pack.
- Reorder settings are written to the base variant's `InventoryLevel` even when opening stock is zero.
- Product detail shows case UPC, minimum order, last received date, and units short in cost history. Receipts from confirmed invoices record units short (invoiced cases not received).
- Unchanged and covered by Phase 7 tests: case → unit cost, markup vs gross margin, pack variants on base-unit stock, tax profiles with historical snapshots, price books/special prices, vendor deals, invoice review.

## Returns and damaged stock
- `RefundItem.disposition`: `RETURN_TO_STOCK`, `DAMAGED`, `NON_RESELLABLE`, `VENDOR_RETURN` (legacy `returnToStock: false` maps to `NON_RESELLABLE`).
- Only `RETURN_TO_STOCK` increases sellable on-hand. Other dispositions write a `SALE_RETURN +q` and an explicit `DAMAGE` / `RETURN_NON_RESELLABLE` / `VENDOR_RETURN −q` movement with the refund as reference, so the ledger shows both the return and its outcome and on-hand stays correct. Pack variants move base units.
- The register Return dialog has a per-line disposition selector.

## Cash operations
- `CashMovement` (append-only, trigger-protected): `PAID_IN`, `PAID_OUT`, `SAFE_DROP`, `NO_SALE`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT` with amount, employee, optional approver, reason, timestamp, and an audit record. Reason is required for everything except paid in and safe drop; outflows cannot exceed the drawer's expected cash.
- Permissions: Cashier has `cash:paid-in` and `cash:safe-drop`; `cash:paid-out`, `cash:adjust`, and no-sale (`drawer:open`) need a Manager/Owner (signed in, or PIN elevation at the register). The existing manual drawer open now also records a no-sale movement.
- Expected cash = opening + cash sales − cash refunds + paid in + adjustments in − paid out − safe drops − adjustments out (`calculateCashTotals`, used by register close).
- Register: **Cash / Drawer** action (replaces Drawer) opens the cash dialog; `POST /register/cash-movements`.

## Shift and end-of-day reports
- Shift close (`GET /register-sessions/:id/report`): cashier still sees opening/expected/counted/difference/duration. Manager/Owner detail adds drawer cash reconciliation (paid in/out, safe drops, adjustments, drawer opens) alongside tenders, refunds, voids, discounts, transaction count.
- `DayClose` (Z report, `/admin/day-close/`, `dayclose:manage`: Owner/Manager): computed for a store and business date in the store's time zone (DST-safe day window): gross sales, discounts, refunds, net sales (gross − discounts − refunds, refunds include refunded tax), tax, transaction count, voids, cash/card/gift-card/other tenders, cash operations, register differences, per-session expected/counted/difference, and an open-register warning. Finalizing requires acknowledging open registers, cannot be repeated (unique store + date → `DAY_ALREADY_CLOSED`), rejects future dates, and stores an immutable snapshot (trigger blocks update/delete) with history.

## Admin
- Switching admin sections resets the main content scroll to the top; the sidebar scrolls independently.

## Known limitations
- Real OCR provider is still fixture-only; the contract and review UI carry the expanded header/line fields.
- No register UI yet for choosing a price book (API supports `priceBookId`).
- Net sales subtracts refunds as paid (tax included) rather than netting tax out per refund.
- Order `createdAt` (not a separate business-date column) decides which day a sale belongs to.
- Dev PINs and the dev header auth provider are unchanged.
