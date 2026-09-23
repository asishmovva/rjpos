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
Copy-Item .env.test.example .env.test
docker compose -f docker/docker-compose.yml --profile test up -d --wait postgres-test redis-test
pnpm --filter "@rjpos/api" test
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

`pnpm test` prepares only the dedicated test database before running the integration suites. The normalized isolation guard and the distinction between behavioral tests, compile-only packages, missing coverage, and separate Electron runtime evidence are recorded in [final-qa.md](./final-qa.md).

Verified on 2026-09-22 against PostgreSQL 18 and Redis 8:

- `pnpm install`: passed.
- `pnpm typecheck`: 15/15 workspace projects passed.
- `pnpm lint`: 15/15 workspace projects passed.
- `pnpm build`: 15/15 workspace projects passed.
- `pnpm test`: passed; 49 behavioral tests across 13 runtime packages. The two declaration-only packages are excluded from the behavioral total.
- Prisma `migrate deploy` on clean PostgreSQL 18: 3/3 migrations applied.
- Prisma `migrate status`: database schema up to date.
- Seed: passed and idempotent; fictional organization, Downtown store, Register 01, Demo Owner, Demo Manager, and Demo Cashier verified.
- PostgreSQL catalog proof: nine reviewed partial/lookup indexes, two exclusion constraints, one price validity check, `btree_gist`, the audit trigger, and 116/116 matching foreign-key column types.
- Reservation race: one final-unit winner, no negative availability or losing-transaction residue, active-order uniqueness enforced, and release/conversion/expiration idempotency verified with history retained.
- Outbox: concurrent claim exclusion, retry, stale recovery, processed state, and at-least-once attempt tracking passed against PostgreSQL.
- Live API: liveness `200`; readiness `200` with PostgreSQL/Redis up; readiness `503` with Redis confirmed down; readiness recovered to `200` after Redis restart.
- Focused evidence: API 10, API contracts 3, auth/RBAC 2, config/isolation 10, domain registries 2, event contracts 2, logging 4, payment contracts 2, web shell 3, UI tokens 1, Electron renderer/security behavior 6, tenant/audit/reservation 3, and outbox 1. A separate real Electron smoke launch proved the built entry point, live web rendering, preload bridge, and hardware IPC path.

## Closure Notes

- `@rjpos/api-client` and `@rjpos/hardware-contracts` are legitimately compile-only: they export only TypeScript types/interfaces and no runtime behavior.
- Logging coverage exposed and fixed automatic/nested sensitive-value redaction; API and worker regression tests passed after the fix.
- No required Phase 0 check is failed, blocked, or skipped. Phase 0 is complete.
- Electron unit tests are configuration evidence rather than launch evidence; the independent runtime smoke result is recorded separately in `final-qa.md`.
- Certified payment integration requires a provider account, documentation, credentials, and certified hardware and remains a stop condition.
- The Windows host may have an unrelated PostgreSQL listener on 5432; RJ POS uses 15432 in Docker Compose.
