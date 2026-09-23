# Current State

Updated: 2026-09-22

## Phase

Phase 0 implementation is complete and handed to QA. Phase 1 has not started.

## Delivered

- pnpm/Turborepo monorepo with web, Electron register, NestJS API, and worker.
- PostgreSQL 18 Prisma schema and migrations, Redis local dependency, and fictional seed data.
- Organization, store, register tenant ownership with compound foreign keys and scoped repository access.
- Development authentication provider abstraction and permission-based RBAC foundation.
- Request IDs, standardized error envelopes, health/readiness checks, structured redacted logging, and validated environment configuration.
- Append-only audit records protected by a PostgreSQL trigger.
- Transactional outbox claiming, retry, stale-claim recovery, and at-least-once processing foundation.
- Concurrency-safe inventory reservations and race-condition test.
- Electron main/preload/renderer security boundary with context isolation, disabled node integration, sandbox, and narrow IPC.
- Shared RJ POS UI tokens and GitHub Actions CI.

## Local Endpoint

RJ POS Docker Compose maps PostgreSQL to `127.0.0.1:15432` and Redis to `127.0.0.1:6379`. Port 5432 is deliberately avoided because it may be owned by an unrelated Windows PostgreSQL installation.

## Verification

QA handoff is ready. The uncached commands and live evidence are recorded in `docs/phase-0/implementation-summary.md`. Real payment-provider integration is intentionally not implemented, and Phase 1 has not started.
