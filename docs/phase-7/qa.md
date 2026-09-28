# Phase 7 QA

Validated on Windows from the repository root on 2026-09-28.

## Required commands

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS — 30/30 Turbo tasks |
| `pnpm lint` | PASS — 30/30 Turbo tasks |
| `pnpm build` | PASS — 15/15 packages |
| `pnpm test` | PASS — 30/30 Turbo tasks, including test-database preparation |
| `git diff --check` | PASS |

## Behavioral test counts

Zero-test tasks are not counted as behavioral validation.

| Package | Tests | Phase 7 relevance |
| --- | ---: | --- |
| `@rjpos/api` | 27 | RBAC, health/error handling, and production-shaped API workflows |
| `@rjpos/database` | 57 | Quick Keys, idempotent hold/resume, price revalidation, tenant isolation, and audit attribution |
| `@rjpos/web` | 18 | Touch register, HID scanner, Quick Key, and hold feedback |
| `@rjpos/register` | 9 | Secure BrowserWindow/preload and printer/drawer adapters |
| `@rjpos/payment-contracts` | 14 | Terminal states, HTTPS/credential validation, and unknown/no-retry behavior |
| `@rjpos/config` | 10 | Environment and isolated test-database validation |
| `@rjpos/domain-types` | 7 | Cart and status behavior |
| `@rjpos/logging` | 4 | Structured redaction/logging behavior |
| `@rjpos/api-contracts` | 3 | API contract behavior |
| `@rjpos/auth` | 2 | Development-provider and permission boundary |
| `@rjpos/events` | 2 | Event contract behavior |
| `@rjpos/ui` | 1 | UI token behavior |
| `@rjpos/worker` | 1 | PostgreSQL outbox integration |
| `@rjpos/api-client` | 0 | Compile-only; no behavioral tests |
| `@rjpos/hardware-contracts` | 0 | Interface-only/compile-only; concrete adapters are tested in `@rjpos/register` |

## Windows package and clean launch

`pnpm --filter @rjpos/register package:win` produced `apps/register/release/RJ-POS-Register-0.0.0-x64.exe` and an unpacked production application. The packaged renderer uses relative `./_next/` assets through the allowlisted `rjpos://app` origin and never loads the development renderer URL.

A clean unpacked launch with `RJPOS_SMOKE_TEST=1` exited 0 and wrote:

```json
{"heading":"Downtown Register","rendererOrigin":"rjpos://app","serverStatus":"Server online","hardwareStatus":"unavailable","bounds":{"x":48,"y":5,"width":1440,"height":901},"minimumSize":[1024,700],"security":{"contextIsolation":true,"nodeIntegration":false,"sandbox":true}}
```

Production-mode API startup was exercised on port 3101. `/api/v1/health` returned 200 `{"status":"ok"}` and `/api/v1/health/ready` returned 200 `{"status":"ready","dependencies":{"postgres":"up","redis":"up"}}`, with matching request IDs in structured server logs.

## Backup/restore evidence

`pnpm backup:database` created a custom-format backup in the ignored repository-local `backups/` directory. The guarded restore restored it only into `rjpos_restore_test`, verified 13 rows in `_prisma_migrations`, and the temporary restore-test database was then dropped. The scripts do not embed a database URL or plaintext secret in the backup filename or arguments.

## Hardware and provider boundaries

- HID scanner handling was interaction-tested for suffix handling, deliberate repeated scans, same-item quantity increment, focus independence, and duplicate-Enter suppression.
- Printer and drawer simulated/unavailable/error paths were tested. Manual drawer authorization is server-side and audited.
- The HTTP terminal boundary rejects insecure/missing configuration, returns `UNKNOWN` on network uncertainty, and never retries automatically.
- No physical scanner, printer, drawer, certified terminal, merchant credential, device SDK, or Windows signing certificate was supplied. No physical-hardware or live-payment success is claimed.

## Production decision

The software/package boundary is suitable for a controlled pilot using the documented simulated/unavailable hardware configuration. Live-store deployment remains **NO-GO** until a production identity-provider adapter, certified terminal credentials/device, store-specific printer/drawer adapter, physical-device acceptance test, and Windows code-signing certificate are supplied and validated. Development-header authentication is not evidence of production identity integration.
