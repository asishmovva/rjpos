# Phase 7 implementation summary

## Register UX and recovery

- The register is now touch-first: minimum 48–56px controls, a persistent scan/search area, large cart quantity controls, a large total, Quick Keys with group tabs, cash/card denomination buttons, and a fixed action bar for cashier utilities.
- USB HID keyboard scanners work without input focus. Enter suffixes commit scans, deliberate rapid repeats increment quantity, and duplicate Enter events do not create duplicate lines.
- Multiple held transactions are PostgreSQL-backed and tenant/store/register/cashier scoped. Hold is idempotent, stores no payment or inventory reservation, preserves the cart/customer/age state, and resume revalidates authoritative prices/promotions before returning the cart.
- Register startup restores the current server-side session. Network/payment uncertainty uses cashier-facing messages and never claims that an unknown payment completed.
- Manager price overrides use the existing server-side discount calculation, require `price:override` plus a reason, and produce a `PRICE_OVERRIDE_APPLIED` audit record after checkout.

## Hardware and payment boundaries

- `window.rjpos` remains the only renderer hardware boundary. Context isolation and sandbox stay enabled; Node integration stays disabled.
- IPC is allowlisted to status, receipt print/test, and drawer open. Receipt printing fetches the authoritative receipt by order ID in Electron main. Cash-sale drawer opens verify a captured cash payment; manual drawer opens call the server-side authorization/audit endpoint before touching the adapter.
- Printer/drawer adapters return controlled ready/simulated/unavailable/error results. No device SDK is fabricated. Physical cash-drawer support requires a device-specific adapter (normally an ESC/POS printer pulse).
- `HttpTerminalProvider` is a provider-neutral real-terminal adapter boundary. It requires HTTPS and a credential, preserves the existing result states, maps network uncertainty to `UNKNOWN`, and never retries automatically. Production without configuration uses an unavailable provider rather than simulated approval.

## Packaging and operations

- Next.js exports static production assets. Packaged Electron serves `resources/renderer/` through the privileged, standard `rjpos://app` scheme, never `RJPOS_RENDERER_URL`; the API explicitly allowlists that non-opaque production renderer origin.
- `electron-builder` creates a Windows NSIS installer with app metadata, a project-owned icon, selectable install directory, Start Menu/Desktop shortcuts, and standard uninstall support.
- Browser permissions are denied, navigation/popups remain restricted, API CORS is allowlisted, security headers are emitted, and a practical per-IP request limit is enabled.
- PowerShell backup/restore scripts create PostgreSQL custom-format backups, enforce repository-local backup paths, retain backups by age, and allow restore only to explicit `*_restore_test` databases.

## Intentional physical/manual boundaries

- USB HID scanning needs no vendor SDK and is covered by interaction tests; a named physical scanner was not attached to this environment.
- Printer and cash-drawer adapter behavior is tested. Production device commands still require the store's printer/drawer model and adapter configuration.
- A certified payment endpoint, SDK/device, merchant credentials, and certification are required before setting `RJPOS_TERMINAL_PROVIDER=http`.
- The installer is not code-signed because no Windows code-signing certificate was supplied.

## Runtime batch: register authorization, Quick Add, shift report, demo catalog

- **Root cause of dead buttons:** `assetPrefix: '.'` applied to `next dev`, so the Electron dev renderer never hydrated. It is now production-export only.
- **Register identity and elevation:** the register acts as the signed-in employee (see PIN sign-in below; the development `x-rjpos-role` header remains only for the admin app and non-register clients). Privileged actions (discounts/custom price, returns, manual drawer open, Quick Add management, detailed shift report) require a Manager/Owner PIN. `GET /auth/approvers` and `POST /auth/elevate` verify a scrypt-hashed `Employee.pinHash`, lock an approver for 60 s after 5 failures, audit grants/failures, and return an HMAC-signed 5-minute token bound to the org and register. The token travels in `x-rjpos-elevation`; the API middleware swaps in the approver's permissions and records `approvedByEmployeeId`. `RJPOS_ELEVATION_SECRET` is required in production (development uses a per-process secret). The seed sets development PINs only when unset (Owner 1234, Manager 2468); change them per store.
- **Discounts:** percent, dollars-off, and custom price (line level, never above the current price), plus percent/dollars-off for the whole sale. The UI accepts dollars; the server prices in integer minor units. `/checkout/quote` previews manual discounts (read-only); checkout still requires `discount:apply`/`price:override`. A reason is optional.
- **Customers:** Cashiers already hold `customer:manage`; the register has a New customer form that selects the customer immediately.
- **Open/close:** opening cash is an editable validated amount with an optional note (audited). Closing takes the counted cash (previously hard-coded). `register:close` was added to Cashier so cashiers can reconcile their own drawer.
- **Shift report:** `GET /register-sessions/:id/report` returns expected/counted/difference/duration to cashiers; holders of `report:read` (or an elevated request) also get tender totals, refunds, voids, discounts, transaction count, and per-channel buckets. Orders have no channel field yet, so only `IN_STORE` is reported; add a channel column before wiring external channels.
- **Quick Add management:** `/admin/register-settings` has product search, auto-positioning, edit label/group, enable/disable, reorder (`POST /admin/quick-keys/reorder`), and register/store scope. The register's Quick Add "Manage" button opens it after manager approval.
- **PIN sign-in:** the register opens on a PIN screen. `POST /auth/login` verifies the PIN against active employees of the store (scrypt hashes; PINs are unique per organization), locks the register for 60 s after 5 wrong PINs, audits success/failure, and returns a 12-hour signed session token (`x-rjpos-session`) carrying the real employee and role; the API derives permissions from it. Managers/Owners signed in this way need no second approval prompt; cashiers still use the elevation flow. End Shift closes the register, clocks out, shows the report, then signs out; a Lock button signs out without ending the shift. Development PINs: Owner 1234, Manager 2468, Cashier 1111 (seeded only when unset). Sessions are stateless: deactivating an employee blocks the next login and workforce/admin calls immediately, but a token already issued stays valid for other register calls until it expires.
- **Employee PINs:** `POST /admin/employees/:id/pin` (set/reset only; the hash is never returned, and the employee list now reports `hasPin` instead of the hash). Owner-only for Owner/Manager accounts. The admin Employees page has Manage (name, role, stores, PIN) and an optional PIN on create. Employees are deactivated, never deleted.
- **Inventory and search UI:** `/inventory?page=&pageSize=&search=&size=&categoryId=&status=` returns one bounded page (max 100) with categories; the register's Inventory screen has search, size, category, status filters (in stock / low / out of stock) and paging. Product suggestions are vertical rows with dark text (the earlier layout was inheriting `.scanbox div{display:flex}` and `.scanbox button{color:#fff}`). Cart rows reveal a Remove action on swipe right; nothing is removed until it is tapped, and each row also has a Remove button.
- **Demo catalog:** `pnpm --filter @rjpos/database db:seed-demo-store` adds every CSV master product to the Downtown store (PRICEPERUNIT → price, CURRENTCOST → cost, TOTALQTY → opening balance through `postOpeningBalance`). Idempotent; refuses to run under `NODE_ENV=production` unless `RJPOS_ALLOW_DEMO_SEED=1`. Negative/fractional TOTALQTY values open at zero and are reported. Departments other than Soda/Water are marked age restricted.
