# RJ POS

RJ POS is a multi-tenant retail point-of-sale platform. Phase 0 begins as a modular monorepo with a NestJS API, Electron register boundary, merchant web app, worker, PostgreSQL, Redis, and shared contracts.

## Local development

1. Copy `.env.example` to `.env`.
2. Start PostgreSQL and Redis with `docker compose -f docker/docker-compose.yml up -d`. RJ POS PostgreSQL is available at `127.0.0.1:15432`; this avoids colliding with an unrelated Windows PostgreSQL service on 5432.
3. Install dependencies with `pnpm install`.
4. Run migrations and seed data with `pnpm --filter @rjpos/database db:deploy` and `pnpm --filter @rjpos/database db:seed`.
5. Run checks with `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. Integration tests require `TEST_DATABASE_URL` and `TEST_REDIS_URL`.

Payment provider credentials and certified hardware are intentionally not required for Phase 0. The first payment implementation is the simulated terminal contract.
