# Deployment, upgrade, rollback and recovery

Verified on Windows 11 with the built installer on 2026-09-30 (see [qa.md](qa.md)).

## 1. Server (API + PostgreSQL)
1. Provision PostgreSQL 18 and Redis. Create the `rjpos` database and role.
2. Set the production environment (see `.env.example`). Required in production: `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `RJPOS_ELEVATION_SECRET` (32+ random characters), `RJPOS_ORGANIZATION_ID`, `RJPOS_STORE_ID`, `RJPOS_ALLOWED_ORIGINS` (exact origins, include `rjpos://app`). Optional: `RJPOS_REGISTER_ID`, `RJPOS_HELD_SALE_TTL_HOURS`, `RJPOS_BACKUP_DIR`. The API **will not start** if these are unsafe; the error lists every problem.
3. `pnpm install --frozen-lockfile`, `pnpm build`.
4. Apply migrations: `pnpm --filter @rjpos/database exec prisma migrate deploy`.
5. Start: `pnpm --filter @rjpos/api start` (keep it running under a service manager).
6. Check `GET /api/v1/health` returns `{"status":"ok"}`, and that `GET /api/v1/admin/sales-channels` **without** a session returns 403 (the header identity must not work).
7. Create real employees with PINs (back office → Employees). Remove or re-PIN the demo employees; demo PINs are development-only.

Payments: production has no payment provider until one is chosen. `RJPOS_TERMINAL_PROVIDER=simulated` is rejected; unset means card payments are unavailable (cash works).

## 2. Register (Windows installer)
Build: `pnpm --filter @rjpos/register package:win` (set `NEXT_PUBLIC_RJPOS_AUTH_MODE=production`, `NEXT_PUBLIC_RJPOS_API_URL` and `NEXT_PUBLIC_RJPOS_REGISTER_ID` for the web build first). Output: `apps/register/release/RJ-POS-Register-<version>-x64.exe` (not code-signed; Windows SmartScreen will warn).

- **Install**: run the installer (per-user, choose folder). Silent: `RJ-POS-Register-<version>-x64.exe /S /D=<folder>`.
- **Configure**: `RJPOS_API_URL` (API base URL) and `RJPOS_HARDWARE_MODE` (`simulated` or `unavailable`; real hardware adapters are not certified, see the release checklist) in the register's environment.
- **Upgrade**: run the newer installer over the existing install. Verified: user data in the app's user-data folder survives.
- **Uninstall**: Windows "Apps", or `"Uninstall RJ POS Register.exe" /S`. Verified: program files are removed and user data is left in place. There is no auto-update; upgrades are manual.
- **Smoke check**: `"RJ POS Register.exe" --smoke-test` with `RJPOS_SMOKE_RESULT_PATH=<file>` writes a JSON result and exits 0 only if the renderer loaded, the API is reachable, CSP is present and Electron security flags are on.

## 3. Backups
Schedule `scripts\backup-database.ps1` daily (Task Scheduler). It writes `backups\rjpos-<stamp>.dump` and `backups\status.json` (times and file name only, no secrets), keeps 14 days, and records failures. The back-office Backups page reads `status.json` (`RJPOS_BACKUP_DIR` to relocate) and warns when the last success is older than 36 hours.

**Check a backup** (safe, never touches live data): `scripts\restore-database.ps1 -BackupPath backups\<file>` restores into `rjpos_restore_test` and prints the migration count.

## 4. Recovery (replace live data)
1. Stop the API and close registers.
2. Take a fresh backup of the current (damaged) state if possible.
3. Restore into the live database (administrator, PostgreSQL client tools):
   `pg_restore --clean --if-exists --no-owner --no-acl -U rjpos -d rjpos backups\<file>`
4. Start the API. Sign in, run a test sale, and preview a day close before opening.

## 5. Rollback of a release
- **Register app**: install the previous installer over the current one.
- **API**: redeploy the previous build. Migrations are forward-only; if the release applied migration `0016` (or later) and you must go back, restore the pre-release backup (section 4) instead of reverse-migrating. **Always take a backup immediately before `prisma migrate deploy`.**
- Migration `0016` is additive (new tables/columns, one enum value); the previous API build runs against it, so an API-only rollback without restoring data is normally safe. Sales recorded with channels keep working; the older build simply ignores the channel columns.
