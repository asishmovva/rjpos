# Phase 3 Employees, Customers, Loyalty & Gift Cards â€” Implementation Summary

Updated: 2026-09-24

## Delivered

Phase 3 extends the existing employee and Core POS boundaries; it does not replace Phase 2 employee administration. Employees can clock in/out, read their current status, and retain shift history. Owner and Manager users can review shifts and correct completed punches with a required reason. PostgreSQL permits only one active shift per employee and preserves timekeeping history after employee deactivation.

Customers can be created, edited, searched, activated/deactivated, attached to or removed from a register cart, and viewed with order-derived purchase and payment history. Email and phone remain optional. When present, normalized values are unique per tenant. Existing order rows carry the customer relationship; no duplicate purchase-history store was introduced.

Configurable loyalty rules support enable/disable, points earned per minor-unit spend, redemption value, manual manager adjustments, and transaction history. Internal RJ POS gift cards support secure issue, reload, balance lookup, partial redemption, disable, transaction history, and refund/void compensation. Checkout supports gift card plus cash and gift card plus simulated terminal without bypassing the existing API/payment architecture.

## Integrity and security

- Employee, customer, loyalty, gift-card, order, refund, store, and register operations are tenant-scoped and permission checked by the API.
- A partial unique index enforces one open shift for each tenant employee; row locks and transactions cover clock-out/correction operations.
- Gift-card codes use cryptographic random bytes. PostgreSQL stores a SHA-256 hash and last four characters; the complete code is returned only at issuance and must be supplied for subsequent lookup/redemption.
- Loyalty and gift-card balances are sums of immutable ledger entries. Economic fields cannot be updated; pending entries can only become posted or cancelled.
- Checkout locks customer/card rows before balance use. Unique reference keys make checkout, refund, and void postings idempotent.
- Simulated-terminal split tender places loyalty/gift value in pending entries. Approval posts them, a known failure cancels them and restores inventory, and an unknown outcome remains pending for reconciliation.
- Refunds and voids append compensation entries. The final partial refund settles any integer-rounding remainder exactly across loyalty, gift-card, and terminal ledgers.
- Shift correction, customer management, loyalty configuration/adjustment, and gift-card issue/reload/disable actions create immutable audit records.

## API and UI

Phase 3 adds explicit `/api/v1/workforce`, `/api/v1/customers`, `/api/v1/loyalty`, `/api/v1/gift-cards`, and related `/api/v1/admin` operations. Owner and Manager roles receive management permissions. Cashier can clock in/out, manage/select customers, and redeem gift cards, but cannot correct shifts, configure/adjust loyalty, issue/reload/disable gift cards, or use other manager operations.

The register adds compact customer selection/removal, loyalty balance and projected earning, points redemption, gift-card redemption, and split cash/terminal controls. The back office adds Customers, Loyalty, and Gift Cards sections and augments Employees with shift history and correction. Browser code continues to call the NestJS API; Electron remains only the secure renderer host and hardware IPC boundary.

## Intentional limits

The loyalty program is organization-wide and deliberately basic: no tiers, campaigns, promotions, expiry, or marketing delivery. Gift cards are internal RJ POS value only, with no third-party/network processor. Phase 3 does not include payroll, scheduling/rosters, vendors, purchasing, receiving, transfers, real terminals, certified hardware, accounting, e-commerce, delivery, or Phase 4 work.
