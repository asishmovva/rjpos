# Phase 4 QA

## Implementation checks

- `pnpm typecheck`: passed across all 15 workspace packages.
- `pnpm lint`: passed across all 15 workspace packages.
- `pnpm build`: passed across all 15 workspace packages.
- `pnpm test`: passed; all 30 Turbo tasks succeeded, including 48 database tests, 22 API tests, 11 web tests, and the existing register, worker, and contract suites.
- `git diff --check`: passed.
- Fresh PostgreSQL 18 test container deployed all migrations through `0007_phase4_purchasing_catalog`.
- `pnpm --filter @rjpos/database db:seed` imported the supplied CSV: 2,714 added, 0 updated, 0 skipped, 0 invalid, 0 duplicate.
- The CSV's `TOTALQTY` values were ignored; imported cost/price values are reference-only master-catalog fields.
- Phase 4 database integration tests: 2 passed, including receipt concurrency, idempotency, over-receipt protection, and ledger assertions; Phase 4 unit tests: 10 passed.
- Purchasing-to-register PostgreSQL E2E: 1 passed, covering import, add-to-store, vendor assignment, PO submit, partial and final receipt, register lookup, sale, and ending inventory.
- Phase 4 API RBAC tests passed as part of the full API suite. UI typechecking/build and 11 existing web tests passed.
- The full test suite initially exposed an outbox timestamp comparison affected by non-UTC PostgreSQL session time zones. The claim query now compares against UTC wall-clock time, and the worker integration test passes.

## Test database

Validation used a fresh disposable PostgreSQL 18 container on `127.0.0.1:15434` and an isolated Redis test container on `127.0.0.1:6380`; neither the existing PostgreSQL test container on port 15433 nor the unrelated Windows PostgreSQL service was used.

## Migration comparison

The Prisma migration-to-schema comparison reported pre-existing Phase 1–3 schema differences (including older FK/index naming and timestamp defaults). Those legacy migrations were left unchanged. The finalized Phase 4 migration applied successfully to a fresh database and the resulting schema was exercised by the PostgreSQL integration, E2E, and seed-import runs.

The Phase 4 tests cover UPC normalization and lookup, CSV validation/deduplication/idempotency/conflict reporting, Add to Store without implicit inventory/pricing, supplier/mapping tenant isolation, PO lifecycle and cost snapshots, full/partial/cancelled receiving, duplicate idempotent requests, over-receipt rejection, concurrent receiving, accepted-stock ledger increments, and receipt-to-sale inventory behavior.

No required Phase 4 tests were skipped. The fresh PostgreSQL container and isolated Redis container were stopped after validation.
