# Phase 6 Implementation Summary

## Reporting foundation

- A single server-side reporting engine (`packages/database/src/reporting.ts`) computes every report from the existing authoritative data model — orders, order items, refunds, payments, register sessions, employee shifts, inventory levels/movements, purchase orders/receipts, customers, loyalty transactions, and gift-card transactions. No parallel ledger or duplicated calculation exists in the API or the browser.
- All filters normalize through `normalizeReportFilters`: tenant/store scoping (a store-scoped actor cannot request another store's data), a `from`/`to` day-range, and an IANA `timezone` (defaulting to the store's own timezone, then UTC). Day boundaries are computed with real timezone offsets, not server-local midnight, so a report for "today" is correct for a store in any timezone.
- Every report query caps at 5,000 rows (`MAX_ROWS`) and returns a `truncated` flag where relevant, keeping worst-case query and CSV size bounded.
- Report rows use historical order-item snapshots (`productNameSnapshot`, `variantNameSnapshot`, `skuSnapshot`, `promotionNameSnapshot`) so a later rename/reprice/deactivation never rewrites what already happened.

## Reports implemented

- **Sales** — gross sales, discounts, tax, net sales, refunds, voids, transaction count, and average transaction, broken down by day, store, register, cashier, and payment method.
- **Products** — units sold, revenue, discounts, refunded quantity/amount per variant, with top-seller and bottom-seller slices.
- **Inventory** — on-hand/reserved/available/low-stock levels and ledger-backed valuation (store cost history, falling back to variant cost) plus a movement history with running totals by movement type.
- **Purchasing** — purchase-order totals, outstanding/partially-received counts, and vendor rollups.
- **Employees** — register-session cash/sales/refund/void summaries and shift hours, both filterable by store and date range.
- **Customers** — order counts, purchase totals, and loyalty points earned/redeemed/adjusted/outstanding per customer.
- **Gift cards** — cards issued, reloaded, redeemed, refunded, and the resulting outstanding liability, all ledger-backed.
- **Promotions** — units affected, orders affected, and discount/revenue impact per promotion, historical-name-safe.

## Dashboard

- `getDashboard` in `packages/database/src/back-office.ts` now derives its headline metrics from the sales and product reports (`getReport`) instead of an ad-hoc same-day query, so the dashboard and the reports workspace never disagree. It adds `averageTransactionMinor`, a `topProducts` list, and `outstandingPurchaseOrders`, and accepts an optional `from`/`to` period.
- The dashboard remains backward compatible: existing callers that pass only a `storeId` still work, and open-register/low-stock counts are still computed directly (they are point-in-time, not period metrics).
- `apps/web/app/admin/page.tsx` shows the expanded metric set, a top-products table, and a link into the new `/admin/reports` workspace.

## CSV export and accounting boundary

- `reportCsv` renders any report kind to CSV with a metadata header line (`# report=<kind>`, `# from=…,toExclusive=…,timezone=…`), CSV-injection protection (a leading `-`, `=`, `+`, or `@` is neutralized) and correct quote-escaping.
- `accountingExport` composes the sales, inventory, and purchasing reports into one provider-neutral JSON payload (`schemaVersion`, `generatedAt`, `filters`, and each report's `data`) with no dependency on a specific accounting vendor. Building a QuickBooks/Xero/other adapter on top only requires mapping this payload; no core reporting logic changes.

## Web UI

- `/admin/reports` (`apps/web/app/admin/reports/page.tsx`) is a dedicated workspace: a section switcher for the eight report kinds, date-range/store/timezone filters, a metrics/summary grid, a detail table, and CSV-export and accounting-export links.

## Authorization

- Two new permissions, `report:read` and `report:export`, are granted to OWNER and MANAGER only; CASHIER has neither. Every reporting/CSV/accounting endpoint requires an active employee at the actor's organization (and store, when store-scoped) in addition to the permission check.

## Performance

- `RegisterSession` gained a new index, `RegisterSession_reporting_period_idx` on `(organizationId, storeId, openedAt)` (migration `0010_phase6_reporting_indexes`), to support the employee/register report's store+date-range query. All other report queries reuse existing indexes (`Order(organizationId, storeId, createdAt)`, etc.) that were already sufficient — no speculative indexes were added.

## Deliberate limits

- Reports are read-only and additive; no checkout, refund, inventory, purchasing, loyalty, or gift-card behavior changed.
- The accounting export is a schema, not a live sync — pushing data to a specific external ledger is out of scope for this phase.
- Report pagination caps at 250 rows per page and 5,000 rows per query; very large date ranges will see `truncated: true` rather than unbounded query cost.
