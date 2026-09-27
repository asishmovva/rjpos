# Phase 5 QA

## Database and migrations

- `0008_phase5_inventory_promotions` adds store inventory policy, transfers/receipts, stock counts, promotions, promotion order-item snapshots, checks, indexes, and tenant-preserving compound foreign keys.
- `0009_phase5_transfer_idempotency_fingerprints` adds shipping and receipt request fingerprints. Existing receipt rows receive a non-secret legacy marker before the column becomes required.
- Migrations deployed successfully to the dedicated `rjpos_test` PostgreSQL database at loopback port 15433. No development database was migrated, reset, truncated, seeded, or otherwise modified by Phase 5 validation.

## Behavioral evidence

- Database Phase 5 integration: 5 passed using real PostgreSQL.
- API Phase 5 E2E: 1 passed using controllers plus real PostgreSQL; no persistence backend was mocked.
- Transfer coverage includes lifecycle, same-store rejection, insufficient/concurrent final stock, partial receipt, over-receipt, identical retry, changed-payload idempotency rejection, ledger entries, and tenant isolation.
- Count coverage includes expected snapshots, negative and positive variance, one-time finalization, current-stock-safe adjustment math, ledger consistency, and audit attribution.
- Replenishment covers threshold/target behavior, preferred vendor, MOQ, case-pack rounding, and confirmation that no PO is automatically placed.
- Promotion coverage includes percentage, fixed, category, product, variant, multi-buy, store isolation, expired rules, overlapping priority, rounding, duplicate checkout, receipt snapshots, nonnegative paid totals, and refund of the actual paid total.
- Primary E2E flow passed: PO receive → Store A ship → Store B receive → stock count variance → promotion quote → promoted sale → discounted receipt → refund → restored inventory. Cashier transfer/promotion access was rejected.

## Repository gates

The final gate results are recorded after the last regression run:

- `pnpm typecheck`: 30/30 Turbo tasks passed across 15 packages.
- `pnpm lint`: 30/30 Turbo tasks passed across 15 packages.
- `pnpm build`: 15/15 Turbo tasks passed.
- `pnpm test`: 141 behavioral tests passed, 0 failed, 0 skipped.
- `git diff --check`: passed.

Package behavioral counts: database 54, API 24, web 14, register 7, worker 1, config 10, domain-types 7, payment-contracts 12, logging 4, events 2, UI 1, auth 2, API contracts 3. API client and hardware contracts currently have zero tests; their successful Turbo tasks are not counted as behavioral validation.

## Closure decision

Phase 5 is functionally closed when the final branch/PR checks remain green. Phase 6 has not started. The Phase 5 PR must remain unmerged for review.
