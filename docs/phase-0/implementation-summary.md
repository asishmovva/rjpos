# Phase 0 Implementation Summary

## Scope

Phase 0 only. No checkout UI, real payment provider, certified terminal, or Phase 1 workflow has been started.

## Architecture

The system is a modular monolith in a pnpm/Turborepo workspace. The API owns authentication context, tenant enforcement, RBAC, persistence, audit, and transaction boundaries. The worker claims PostgreSQL outbox rows with `FOR UPDATE SKIP LOCKED`. Delivery is at least once; handlers must be idempotent. Electron uses separate main, preload, and renderer processes.

## Tenant and Authorization Evidence

Organization IDs are present on tenant-owned records and compound foreign keys prevent cross-organization relationships. The tenant repository requires organization scope for reads and writes. Development authentication is isolated behind `AuthProvider`; permission checks use centralized `requirePermission`. Database integration tests cover cross-tenant reads, writes, and audit mutation rejection.

## Database Evidence

Migrations:

- `0000_initial`
- `0001_reviewed_constraints`
- `0002_rbac_and_audit`

The schema uses UUID identifiers, PostgreSQL `BIGINT` minor-unit money, organization/store effective price constraints, merchant payment accounts, terminal assignments, audit immutability, inventory reservations, and outbox processing indexes.

## Required Verification Commands

```powershell
pnpm install
$env:DATABASE_URL='postgresql://rjpos:rjpos@127.0.0.1:15432/rjpos'
$env:TEST_DATABASE_URL=$env:DATABASE_URL
$env:TEST_REDIS_URL='redis://127.0.0.1:6379'
pnpm --filter @rjpos/database db:deploy
pnpm --filter @rjpos/database db:seed
pnpm exec prisma --version
pnpm typecheck
pnpm lint
pnpm build
pnpm exec turbo run test --force
```

The live integration suites cover reservation concurrency, tenant isolation, audit immutability, outbox retry/recovery, Redis readiness, API request IDs/error envelopes, auth/RBAC, configuration validation, and UI token restrictions.

Verified on 2026-09-22 against PostgreSQL 18 and Redis 8:

- `pnpm install`: passed.
- `pnpm typecheck`: 15/15 workspace projects passed.
- `pnpm lint`: 15/15 workspace projects passed.
- `pnpm build`: 15/15 workspace projects passed.
- `pnpm exec turbo run test --force`: passed with no required tests skipped.
- Prisma `migrate deploy` on clean PostgreSQL 18: 3/3 migrations applied.
- Prisma `migrate status`: database schema up to date.
- Seed: passed and idempotent; fictional organization, Downtown store, Register 01, Demo Owner, Demo Manager, and Demo Cashier verified.
- Focused evidence: auth/RBAC 2 tests, config 2, UI tokens 1, API IDs/errors/health 4, Electron security 1, tenant/audit/reservation 3, outbox 1.

## Known Warnings

- Several non-database packages still have intentionally small foundation tests; Phase 1 behavior is not represented yet.
- Certified payment integration requires a provider account, documentation, credentials, and certified hardware and remains a stop condition.
- The Windows host may have an unrelated PostgreSQL listener on 5432; RJ POS uses 15432 in Docker Compose.
