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
