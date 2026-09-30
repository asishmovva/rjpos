# Phase 9: Final Operations, Channels, Bulk Tools & Release Readiness

Branch `phase-9`. Migration `0016_phase9_channels_claims_sessions`. No further major phase is planned unless the real-world pilot finds release blockers.

## What was built

### Register
- **Held sales**: Hold opens a dialog for a name/label and an optional note. The held list shows age ("12 min ago"), cashier, register, line count, customer, age-verified state and note, with Resume and Cancel. Holds older than `RJPOS_HELD_SALE_TTL_HOURS` (default 24) are marked `EXPIRED` the next time the list is opened (and on demand through `POST /admin/held-transactions/cleanup`); an expired hold cannot be resumed. Expiry and cancellation are audited. Held sales are per register.
- **Sales channels** (Walk-In, DoorDash, Uber Eats, Web, Phone, Custom): a selector appears in the cart header when more than one channel is active. The channel's optional price book prices the whole sale server-side; the order stores the channel id and a name snapshot, so renaming a channel never rewrites history. There is no marketplace API integration.
- Header fits at the 1024 px minimum window (verified at 1024, 1366 and 1920 with no page scroll).

### Back office (all under `/admin`)
| Page | What it does |
|---|---|
| Sales channels | Add/deactivate channels, attach a price book. The default channel cannot be deactivated. |
| Bulk changes | Select up to 500 products, choose price (percent/amount/set), tax profile, category, vendor, active, or stock thresholds; preview every change; apply in one Serializable transaction with one audit record. Never changes on-hand stock. Skips scheduled-future-price, negative-result and no-change rows and says why. |
| Import & export | CSV export and import for products, pricing, vendors, inventory, customers. Validate, preview, then commit. Any error blocks the file unless "skip invalid rows" is chosen. |
| Labels | Barcode, shelf-tag and price labels (50×30, 60×40, 40×25 mm). |
| Vendor claims & suggestions | Returns, shortages, damage, price differences with expected vs actual credit; velocity-based purchase suggestions. |
| Audit log | Who, action, record, old/new values, time, store/register. Sensitive fields (`pin`, `hash`, `secret`, `token`, `password`, `cvv`, `pan`) show `[hidden]`. |
| Backups | Last attempt/success, result, file, stale warning, restore instructions. |
| Product page | Alternate UPCs per variant and vendor case UPCs. |
| Reports | New **Sales by channel** report (orders, gross, discounts, tax, revenue, refunds, net, cash/card/gift/other) with the existing CSV export. |

### Data rules
- **CSV import**: max 5,000 rows, 2 MB in the UI. Products: new items are created as **inactive drafts** (finish cost/price on the product page); existing items update name, brand, category, tax profile, active only; categories are created only with the explicit option; activating a draft is refused. Pricing: closes the current price and starts the new one (or upserts a special price by price-book name); refuses when a future price is scheduled. Inventory: a quantity is accepted **once** as the opening balance (an `INITIAL` movement); a second attempt is an error pointing to adjustments/counts. Thresholds can be updated freely. Customers match by email, then phone, then name; vendors by name. Exports quote every cell and prefix `'` to cells starting `= + - @` so spreadsheets cannot execute them.
- **Vendor claims**: only `RETURN` claims move stock, and only when submitted (a `VENDOR_RETURN` ledger movement; cannot go negative). Credits are recorded when the vendor actually issues them and may differ from the expected amount. No automatic accounting posting.
- **Alternate / case UPCs**: a code can exist only once across item barcodes and vendor case UPCs. Only `ALTERNATE` codes can be removed.
- **Velocity suggestions**: sold units (pack sales count as base bottles, stock-returns netted out) over the look-back window, covering lead time + cover days, less available and on-order stock, never below the reorder target, rounded up to MOQ and case pack. Nothing is ordered automatically.

### Security and release
- **Session revocation**: `Employee.sessionVersion` is embedded in PIN session tokens and checked (cached 5 s). It increments on PIN change, deactivation, role/store change, and `POST /admin/employees/:id/revoke-sessions`. A revoked session gets `SESSION_REVOKED` and the register/back office return to sign-in.
- **Production auth mode**: with `NODE_ENV=production` the development header identity is ignored. Without a session a request carries only the device binding (organization and store from `RJPOS_ORGANIZATION_ID`/`RJPOS_STORE_ID`, register from the device) and **no permissions**. Back office requires a Manager/Owner PIN when built with `NEXT_PUBLIC_RJPOS_AUTH_MODE=production`. PIN login verifies the register belongs to the store.
- **Startup guard**: a production API refuses to start with a missing/short signing secret, unset tenant binding, `*` CORS, simulated payments or the fixture OCR provider; all problems are reported together.
- **Electron**: CSP on the packaged renderer (`default-src 'self'`, same-origin plus the configured API, `object-src 'none'`, `frame-ancestors 'none'`); every hardware IPC handler checks the sender is the main frame of our own origin.
- **API**: `Content-Security-Policy: default-src 'none'`, `Cache-Control: no-store`, rate-limit table pruning. `multer` (unused; invoices upload as JSON) is pinned to `>=2.4.0`.
- New permissions: `bulk:manage` (Owner, Manager), `import:manage` and `system:read` (Owner only).

### Hardware abstraction
`@rjpos/hardware-contracts` gained `LabelPrinter`, a validated `LabelDocument`, a Code 128 encoder (SVG), an HTML renderer for OS-driver printing, a ZPL encoder for raw/network printers, and `CallbackLabelPrinter`/`UnavailableLabelPrinter`. Electron prints through the OS driver via `hardware:print-labels`; simulated mode validates and reports honestly that nothing was printed.

## Not in this phase (by design)
Payment provider integration (no provider decided), physical hardware certification, code signing, and auto-update. See [release-checklist.md](release-checklist.md).
