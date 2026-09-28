# Phase 6 QA

## Database and migrations

- `0010_phase6_reporting_indexes` adds `RegisterSession_reporting_period_idx` on `RegisterSession(organizationId, storeId, openedAt)` to support the employee/register report's store+date-range query. No other index was added; every other report query reuses an existing index that was already sufficient for its access pattern.
- The migration was applied non-interactively with `prisma migrate deploy` against the dedicated development database (loopback port 15432) using the repository's existing hand-written-migration pattern (the same one used by `scripts/deploy-development-database.ts`). The dedicated `rjpos_test` PostgreSQL database (loopback port 15433) applies it automatically through `test:prepare` on every `pnpm test` run. Neither database was reset, truncated, or manually seeded.
- `prisma migrate dev` was intentionally not used: it detected pre-existing drift on an earlier migration and offered to reset the development database, which would have destroyed data; the hand-written SQL + `migrate deploy` path avoided that risk entirely.

## Behavioral evidence

- Database Phase 6 integration (`packages/database/tests/reporting.integration.test.ts`): timezone-correct day boundaries, tenant/store isolation, refund/discount/tax-aware sales totals, historical order-item snapshots surviving catalog renames, ledger-backed inventory valuation, gift-card/loyalty ledger totals, CSV formula-injection protection and quoting, and the accounting-export schema — all passing against real PostgreSQL.
- API Phase 6 E2E (`apps/api/tests/reporting.e2e.test.ts`): a single realistic, non-mocked flow spanning two stores — vendor purchase order created and received, a second purchase order left outstanding, a warehouse-to-retail transfer shipped and received, a stock count reviewed and finalized, a variant promotion, a customer with a loyalty program and an issued gift card, a mixed-tender checkout (promotion + gift-card + cash) against an open register session, a partial refund, and a register close — followed by calling every one of the eight reports plus the CSV export directly through `ReportingController` against real PostgreSQL and asserting each report's totals reconcile with the fixture (sales discount/refund totals, product quantities, outstanding purchase orders, customer loyalty points earned, gift-card issued/redeemed amounts, promotion units affected, and the closed register session). The same test also asserts a Cashier is forbidden (403) from both the report endpoint and the CSV endpoint.
- Existing Phase 0–5 database (`phase-one` through `phase-five` integration/E2E) and API/web suites were re-run unmodified except for the two dashboard-shape fixtures in `apps/web/tests/admin.test.tsx`, which were updated to match the new (additive) dashboard fields and the renamed "Net sales" label; no other Phase 0–5 assertion changed.

## Repository gates

The final gate results are recorded after the last regression run on the `phase-6` branch:

- `pnpm typecheck`: 30/30 Turbo tasks passed.
- `pnpm lint`: 30/30 Turbo tasks passed.
- `pnpm build`: 30/30 Turbo tasks passed (included as part of the typecheck/lint dependency graph).
- `pnpm test`: 30/30 Turbo tasks passed. The four packages touched or exercised by Phase 6 reported 98 behavioral tests passed, 0 failed, 0 skipped — web 15 (including the updated dashboard fixtures and the new `/admin/reports` UI test), database 56 (including the new Phase 6 reporting integration test), worker 1, and API 26 (including the new Phase 6 E2E test, `rbac.test.ts`'s Phase 6 permission assertions, and all Phase 0–5 API E2E tests unmodified). Packages untouched by Phase 6 (config, domain-types, payment-contracts, logging, events, ui, auth, api-contracts, api-client, hardware-contracts, register, electron-main) were unaffected and their Turbo tasks passed from cache.
- `git diff --check`: passed (no whitespace errors in the staged Phase 6 diff).

## Closure decision

Phase 6 is functionally closed: the reporting foundation, all eight reports, the dashboard upgrade, CSV export, the provider-neutral accounting-export boundary, RBAC, the one justified index, and a real-PostgreSQL E2E covering purchasing → transfer → count → promotion → loyalty/gift-card sale → refund → register close → reports → CSV are implemented and green. Phase 7 has not started. The Phase 6 PR must remain unmerged for review.
