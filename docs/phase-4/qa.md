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
- Phase 4 API RBAC tests passed as part of the full API suite. UI typechecking/build and 12 web tests pass, including the searchable/paginated vendor-mapping picker interaction.
- The full test suite initially exposed an outbox timestamp comparison affected by non-UTC PostgreSQL session time zones. The claim query now compares against UTC wall-clock time, and the worker integration test passes.

## Test database

Validation used a fresh disposable PostgreSQL 18 container on `127.0.0.1:15434` and an isolated Redis test container on `127.0.0.1:6380`; neither the existing PostgreSQL test container on port 15433 nor the unrelated Windows PostgreSQL service was used.

## Migration comparison

The migration-to-schema comparison used a fresh PostgreSQL 18 database with migrations `0000`–`0007` applied. No historical migration was rewritten.

The first comparison exposed actual Prisma-model drift as well as harmless legacy naming differences:

- Phase 1–3 history/performance indexes were present in SQL but absent or differently represented in the Prisma model. The model now declares the existing Category, Store, inventory-admin, effective-price, employee-shift, gift-card-history, and loyalty-history indexes using their migration names and descending timestamp order where applicable. The comparison no longer proposes dropping/recreating these indexes.
- `Customer`, `EmployeeShift`, `GiftCard`, and `LoyaltyProgram` had database `updatedAt DEFAULT CURRENT_TIMESTAMP` defaults in their migrations, while the model declared only `@updatedAt`. The model now retains `@default(now()) @updatedAt`, preserving direct-SQL insert behavior as well as Prisma-managed timestamps. The comparison no longer proposes removing these defaults.
- Phase 2–3 foreign keys created without explicit actions use PostgreSQL `NO ACTION` for delete/update. Prisma's implicit `RESTRICT`/`CASCADE` defaults did not match that contract. The affected Role/Permission, EmployeeRole/RolePermission, EmployeeShift, Loyalty, and Gift Card relations now explicitly specify `NoAction`, matching the deployed migrations. The Phase 1 foreign keys that already specify `RESTRICT`/`CASCADE` remain unchanged.

The remaining comparison output is non-functional legacy representation drift:

- Existing foreign keys and indexes have older SQL names than Prisma's generated names. After referential actions were aligned, these are rename operations only; referenced columns and enforcement are unchanged.
- Prisma models an organization relation on `EmployeeRole` and `RolePermission`, so it proposes an additional direct `organizationId` foreign key on each join table. Their existing compound employee/role/permission foreign keys already imply a valid organization, making these additional `NO ACTION` constraints redundant rather than a change to accepted tenant relationships.
- Migration `0005` uses partial unique indexes on `LoyaltyTransaction` and `GiftCardTransaction` with `WHERE referenceKey IS NOT NULL`. PostgreSQL ordinary unique indexes also permit multiple NULLs, so the Prisma full unique declaration enforces the same uniqueness rule for non-NULL keys. Prisma cannot express this partial predicate and proposes a second, equivalent unique index under its generated name. The migration-owned partial indexes remain authoritative; no historical migration is changed.

No destructive or behavior-changing migration is needed for this cleanup. The remaining generated operations are renames or redundant equivalent constraints/indexes; do not apply the generated diff as a blanket migration. The Phase 4 migration still applies to a fresh database and its schema is covered by PostgreSQL integration, E2E, and seed-import runs.

The Phase 4 tests cover UPC normalization and lookup, CSV validation/deduplication/idempotency/conflict reporting, Add to Store without implicit inventory/pricing, supplier/mapping tenant isolation, PO lifecycle and cost snapshots, full/partial/cancelled receiving, duplicate idempotent requests, over-receipt rejection, concurrent receiving, accepted-stock ledger increments, and receipt-to-sale inventory behavior.

No required Phase 4 tests were skipped. The fresh PostgreSQL container and isolated Redis container were stopped after validation.

## Pre-merge cleanup verification

- The selector regression test navigates to product page 2, searches by product name, selects the matching variant, and verifies that the selected variant ID reaches the vendor-mapping API. Both vendor mappings and PO draft lines use the same picker.
- After the Prisma-model alignment above, migration diff no longer proposes dropping existing performance indexes or removing the four legacy `updatedAt` defaults. Remaining comparison operations are FK/index renames plus the documented redundant direct join-table FKs and equivalent partial-unique-index representation.
- Final cleanup gates: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (30 Turbo tasks successful; 48 database, 22 API, and 12 web tests passed), and `git diff --check` passed. The first full-suite attempt had one API readiness test fail because Redis was not running on its configured test port; after starting the isolated test Redis service, the complete suite passed.

## Post-merge runtime repair verification

- A clean production API start originally failed with `ERR_MODULE_NOT_FOUND: Cannot find package 'express' imported from apps/api/dist/main.js`. The API now declares its direct Express runtime dependency, and a foundation test verifies that the package resolves from the API workspace.
- The development database was missing migration `0007_phase4_purchasing_catalog`. `pnpm --filter @rjpos/database db:deploy` applied it without rewriting migration history, and the seed imported 2,714 master-catalog products.
- Successful opening-balance and adjustment mutations previously returned empty response bodies while the admin client unconditionally parsed JSON. Both mutations now return their inventory level and movement; the client also safely accepts an empty successful response for compatibility.
- Inventory failures now use controlled status codes: missing variants/levels return 404, invalid input returns 400, tenant access denial returns 403, duplicate opening balances and negative-stock attempts return 409.
- Live verification exercised master UPC lookup, Add to Store, opening balance, adjustment, and register inventory fetch. The resulting register inventory showed `onHand: 7` and `available: 7`; a repeated opening balance returned HTTP 409.
- Final gates passed: `pnpm test` (30 Turbo tasks; 132 behavioral tests, including 48 database, 23 API, and 13 web tests), `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check`.
