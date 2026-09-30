# Phase 9 security and release review

Scope: authentication and sessions, RBAC, Electron IPC, CSP, secrets, CORS, rate limits, log redaction, dependency health, and the install/update flow. Findings are what was found, what was fixed in this phase, and what remains.

## Fixed in Phase 9
| Area | Finding | Fix |
|---|---|---|
| Identity | The development header identity (`x-rjpos-role`, default OWNER) was accepted in any environment. | Ignored when `NODE_ENV=production`; unauthenticated requests carry only a device binding with zero permissions. Verified against a real production-mode API: `x-rjpos-role: OWNER` returns 403. |
| Sessions | A PIN session stayed valid for 12 h even after the employee was deactivated, changed role or had their PIN reset. | `sessionVersion` check (5 s cache); bumped on PIN set, update/deactivate, and explicit revoke. Verified live: a revoked cashier token returns `SESSION_REVOKED`; re-login works. |
| Login | Login trusted the register id from the request without checking it belonged to the store. | Register must exist for that organization and store. |
| Back office | Admin pages always sent the owner header and had no sign-in. | `AdminGate` requires a Manager/Owner PIN when built for production; cashiers are refused; the token lives in `sessionStorage`. |
| Startup | Production could start with a generated (per-process) signing secret, simulated payments, `*` CORS or the fixture OCR provider. | `productionConfigProblems` refuses to start and lists every problem. |
| Electron IPC | Hardware IPC handlers did not check who was calling. | Every handler requires the main frame of our own origin (packaged `rjpos://app`, or the configured dev server). |
| CSP | Packaged renderer had no Content-Security-Policy. | Policy set on the session and confirmed present in the installed app's smoke test. `script-src` keeps `'unsafe-inline'` because the Next.js static export injects inline bootstrap scripts; removing it needs hashed/nonce builds. |
| API headers | JSON responses were cacheable. | `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'`. |
| Rate limiter | The per-IP table never shrank. | Pruned when it exceeds 10,000 entries. |
| Dependencies | `multer` (5 advisories, high) via `@nestjs/platform-express`. The API accepts no multipart uploads (invoices are JSON/base64). | Overridden to `>=2.4.0`. |
| Exports | Spreadsheet formula injection in CSV exports. | Quoted cells, `'` prefix for `= + - @`. |
| Audit | Sensitive values could surface in the audit viewer. | Fields matching `pin|hash|secret|token|password|cvv|pan` render `[hidden]`. |

## Verified unchanged (good)
- Electron: `contextIsolation` on, `nodeIntegration` off, `sandbox` on, permission requests denied, navigation and `window.open` restricted, hardware only through the preload bridge. The smoke test asserts the three flags.
- No PAN/CVV is stored or logged; payment contracts are provider-neutral with unknown-payment handling and idempotency keys.
- Tenant isolation: every new model has `organizationId` with composite foreign keys; every new service filters by organization, and store-scoped actors cannot reach other stores.
- Money is integer minor units end to end; bulk, import and claim math use `BigInt`.
- CORS is an explicit allow-list; `rjpos://app` is always allowed, `*` is rejected in production.
- Logs redact secrets (existing redaction); the backup status file holds times and file names only.

## Remaining risks (accepted or for the pilot)
- **Single-instance assumptions**: the login lockout, the rate limiter and the session-check cache are in memory per API process. Running several API instances weakens lockouts (per instance) and delays revocation by up to 5 s plus cache. Put a shared limiter (Redis) in front before scaling out.
- **`deepmerge-ts` (Prisma CLI config, high)**: build-time tooling only; not loaded by the running API. Resolves with a Prisma upgrade.
- **Inline scripts in CSP** (above).
- **Installer is not code-signed**; there is no auto-update channel, so updates are manual reinstalls. A signing certificate is required before wide distribution.
- **PIN strength**: 4–8 digits with lockout. Acceptable for a counter; Owner PINs should be 6+ digits.
- **Session token in `sessionStorage`**: cleared when the window closes; readable by any script in the renderer, which is why CSP and the sandbox matter.
- **Backups are local files** in `backups\`. Copy them off the machine (cloud/NAS) and test a restore periodically.
- **Dependency scan** was run once (`pnpm audit --prod`, 2026-09-30); add it to CI.
