# Current State

Updated: 2026-09-22

## Phase

Phase 0 is complete. Database/runtime validation and behavioral coverage closure passed with no required checks failed, blocked, or skipped. The only zero-test packages are declaration-only and explicitly classified as compile-only. Phase 1 has not started.

## Delivered

- pnpm/Turborepo monorepo with web, Electron register, NestJS API, and worker.
- PostgreSQL 18 Prisma schema and migrations, Redis local dependency, and fictional seed data.
- Organization, store, register tenant ownership with compound foreign keys and scoped repository access.
- Development authentication provider abstraction and permission-based RBAC foundation.
- Request IDs, standardized error envelopes, health/readiness checks, structured redacted logging, and validated environment configuration.
- Append-only audit records protected by a PostgreSQL trigger.
- Transactional outbox claiming, retry, stale-claim recovery, and at-least-once processing foundation.
- Concurrency-safe inventory reservations and race-condition test.
- Electron development loading of the independently running Next.js application, packaged/static renderer separation, bounded unavailable-server handling, context isolation, disabled node integration, sandbox, and narrow hardware IPC. A real Electron smoke launch verified the web heading and IPC response.
- Shared RJ POS UI tokens and GitHub Actions CI.

## Local Endpoint

RJ POS Docker Compose maps PostgreSQL to `127.0.0.1:15432` and Redis to `127.0.0.1:6379`. Port 5432 is deliberately avoided because it may be owned by an unrelated Windows PostgreSQL installation.

## Verification

QA status, package-by-package behavioral-test counts, known coverage gaps, and Electron runtime evidence are recorded in `docs/phase-0/final-qa.md`. Phase 0 has 49 behavioral tests. Real payment-provider integration is intentionally not implemented, and Phase 1 has not started.
