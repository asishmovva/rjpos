# RJ POS release checklist (Phase 9)

Status legend: **Working** = implemented and verified by automated/scripted checks; **Not certified** = implemented but needs the real device or environment; **Not implemented** = deliberately absent.

## 1. Working features
- Register: PIN sign-in, open/close register and shifts, scan/search/Quick Add, discounts and custom prices with manager approval, age check, cash (with change due) and simulated card tender, split tender, gift cards, loyalty, customers, price check, hold/resume/cancel with notes and expiry, returns with dispositions, reprint, cash in/out/safe drop/adjustments, end-of-shift report, sales channels with channel pricing.
- Catalog and costing: products with variants and pack units, alternate and case UPCs, vendor cost and deals, tax profiles, price books and special prices, margin calculator, invoice OCR review (development fixture provider only), purchase orders and receiving, transfers, counts, replenishment and velocity suggestions.
- Back office: reports with CSV export (incl. sales by channel), day close (Z report), audit log viewer, employee/PIN management with session revocation, bulk changes, CSV import/export, labels, vendor claims, channels, backup status.
- Data integrity: server-authoritative checkout, integer money, idempotency keys, append-only ledgers, tenant isolation with composite foreign keys, Serializable transactions for stock-moving operations.

## 2. Hardware status
| Device | Status |
|---|---|
| USB HID barcode scanner | Not certified (software path tested with synthetic events) |
| Receipt printer | Not certified |
| Cash drawer | Not certified |
| Label printer | Not certified |
| Customer display | Not implemented in the register UI (contract only) |

Procedure and expectations: [hardware-validation.md](hardware-validation.md). Sign-off table (fill at the pilot):

| Device | Model / driver | Tested by | Date | Result |
|---|---|---|---|---|
| Scanner | | | | |
| Receipt printer | | | | |
| Cash drawer | | | | |
| Label printer | | | | |

## 3. Payment status
**No payment provider is integrated.** Cash works. Card payments are available only through the simulated provider in development; production rejects `simulated` and otherwise reports payments unavailable. Preserved for the future integration: provider-neutral terminal contract, unknown-payment handling (a card result that cannot be confirmed is never treated as paid and is never retried blindly), checkout idempotency keys, no PAN/CVV storage. Integration starts only after a provider decision and credentials; it needs the provider's certification, refund/void mapping, and a settlement/reconciliation report.

## 4. Known limitations
- Installer is unsigned; updates are manual reinstalls (user data is preserved).
- Held sales are per register; expiry is lazy (on list) plus a manager cleanup action.
- Vendor credits are recorded but not posted to an accounting ledger.
- CSV import never creates active products or overwrites stock; opening balances can be imported once per item/store.
- No DoorDash/Uber Eats API integration; channels are labels plus optional price books.
- Login lockout, rate limiting and the session-check cache are in memory (single API instance).
- Invoice OCR has no production provider (upload works; extraction is unavailable in production).
- Dependency note: one build-time advisory (Prisma CLI `deepmerge-ts`).
- Customer display and multi-store administration UX are not built.

## 5. Manual deployment steps
Follow [deployment.md](deployment.md): provision PostgreSQL/Redis, set production environment, migrate, start the API, verify header identity is rejected, create real employees, build and install the register, schedule backups, and verify a restore.

## 6. Rollback steps
1. Take a backup immediately before any release.
2. Register: install the previous installer over the current one.
3. API: redeploy the previous build; migration `0016` is additive so the previous build runs against it.
4. If data must go back, stop the API and restore the pre-release backup with `pg_restore --clean` ([deployment.md](deployment.md) section 4), then start the previous API build.

## 7. Production readiness
| Gate | Status |
|---|---|
| Automated regression (typecheck, lint, test, build) | Pass |
| Production-mode API startup and auth verification | Pass (local) |
| Installer clean install / upgrade / uninstall / smoke | Pass (unsigned) |
| Backup, status reporting, restore verification | Pass |
| Security review | Done; residual risks in [security-review.md](security-review.md) |
| Real hardware certification | **Open** |
| Payment provider | **Open** (cash-only launch) |
| Code signing | **Open** |
| Owner manual workflow testing | Owner |

**Recommendation**: suitable for a supervised cash-only pilot at one store once the hardware sign-off table is completed on the pilot devices and backups are scheduled and copied off the machine. Do not take card payments until a provider is integrated and certified. Sign the installer before distributing beyond the pilot.
