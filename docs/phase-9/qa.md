# Phase 9 QA record

Run on Windows 11 on 2026-09-30 against the `phase-9` working tree. Manual workflow testing is done by the owner; this is the automated and scripted verification.

## Automated
| Check | Result |
|---|---|
| `pnpm typecheck` (30 tasks) | pass |
| `pnpm lint` (30 tasks) | pass |
| `pnpm test` (full regression once at close) | pass: database 16 files / 81 tests, API 11 files / 38 tests, web 11 files, register 2 files / 9 tests, worker, hardware-contracts 7 tests, domain-types, config |
| `pnpm build` | pass (static export includes every new admin page) |
| `git diff --check` | clean |

New test coverage:
- **Database integration** (`phase-nine.integration.test.ts`): held-sale listing/expiry/resume refusal; channel pricing via price book, order snapshot, channel report, duplicate channel names; bulk price/category/active with stock untouched and audit count; vendor claims (stock only on submitted return, credit, invalid transitions), alternate/case UPC protection; velocity suggestions and parameter validation; CSV preview-before-commit, atomic rejection, draft-only product creation, one-time opening balance, pricing history, customers/vendors, formula-safe export; audit viewer names, old/new values and hidden fields.
- **API**: new permissions by role; session revocation (match, bumped, deactivated); production device binding ignores identity headers and grants nothing; production configuration guard lists every unsafe setting.
- **Web**: hold dialog with name/note, held list age/register/note/age state and cancel, channel selector sends `channelId` on the quote; admin gate (dev pass-through, production PIN, cashier refused, session header); CSV preview/commit gating; label printing through the register printer.
- **Hardware contracts**: Code 128 table integrity (106 unique 11-module symbols, 13-module stop), published checksum example, job validation limits, HTML escaping, ZPL control-character stripping, honest simulated results.

## Scripted against running software
- **Production-mode API** (`NODE_ENV=production`, built `dist`): health ok; `x-rjpos-role: OWNER` header returns 403 with CSP and `no-store` present; wrong PIN returns `LOGIN_PIN_INVALID`; owner session reads channels; cashier gets 403 on bulk and CSV import; manager gets 403 on backup status (owner only); revoking the cashier's sessions makes the old token return 401 `SESSION_REVOKED` within the cache window and a fresh login works.
- **Register UI** (Electron + dev server, CDP): hold with name and note, held list shows "just now · cashier · register · 1 line · note", cancel, channel selector; no page scroll and the header fits at 1024×768, 1366×768 and 1920×1080 (header overflow at 1024 found and fixed).
- **Windows installer** (`RJ-POS-Register-0.0.0-x64.exe`, unsigned): silent clean install (exit 0, program and renderer present); installed app smoke test exit 0 (packaged origin `rjpos://app`, API reachable, CSP present, `contextIsolation`/`sandbox` on, `nodeIntegration` off, simulated hardware); in-place upgrade exit 0 with user data preserved; silent uninstall exit 0 with program files removed and user data retained.
- **Backup/recovery**: `backup-database.ps1` produced a dump and `status.json`; the API's backup-status endpoint reported it; `restore-database.ps1` restored it into `rjpos_restore_test` (17 migrations).
- **Dependency scan**: `pnpm audit --prod` went from 6 findings to 1 (Prisma CLI tooling, not runtime).

## Not verified (honest gaps)
- Any real hardware (receipt/label printer, drawer, scanner) and any real payment provider.
- Packaged app with `NODE_ENV=production` end to end against a separate production-like host (the API was run in production mode locally; the installed register was smoke-tested against the development API).
- Behavior with multiple API instances, and upgrade from versions older than Phase 8 data.
- Code-signed installer and SmartScreen behavior.
