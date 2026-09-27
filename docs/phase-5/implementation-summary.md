# Phase 5 Implementation Summary

## Advanced inventory

- Inventory policy is now store-and-variant specific: on hand, reserved, computed available, low-stock threshold, reorder target, and status.
- Existing immutable inventory movements remain authoritative. Transfer, count, sale, return, purchase-receipt, opening-balance, and manual-adjustment activity all produces attributed ledger records.
- Movement history supports store, product, variant, employee, type, and date filters.

## Transfers and counts

- Transfers implement `DRAFT → SUBMITTED → IN_TRANSIT → RECEIVED`, with cancellation limited to draft/submitted transfers.
- Shipping serializes source inventory rows and rejects stock below available quantity. Shipping and receiving use request fingerprints for safe retry and reject changed payloads under reused idempotency keys.
- Partial receipts are supported; total receipts cannot exceed shipped quantity. Source and destination changes use `TRANSFER_OUT` and `TRANSFER_IN` movements.
- Cycle counts snapshot expected quantities, capture reviewed counts and variances, and finalize once. Finalization locks current inventory, posts only the adjustment needed from current stock to the counted stock, and preserves the original snapshot variance.

## Replenishment

- Suggestions use available stock, per-store threshold/target, preferred active vendor mapping, MOQ, and case-pack rounding.
- Suggestions never place orders automatically. Back office can turn an individual suggestion into a draft purchase order.

## Promotions and register

- Promotions support percentage, fixed-amount, and fixed-price multi-buy discounts; category, product, or variant scope; optional store scope; minimum quantity/spend; active window; active state; and priority.
- The highest-priority eligible promotion wins. Equal-priority rules choose the larger discount, then the stable database ID order. Discounts cannot produce negative totals.
- Checkout re-resolves prices and promotions on the server. The register sends only variant and quantity, obtains a server quote for display, and cannot submit promotion IDs or amounts.
- Cart and receipt views show original price, promotion name, savings, and final totals. Order items retain the promotion snapshot and paid amounts; refunds use the actual paid line total.

## Administration and authorization

- Back office adds Transfers, Stock Counts, Inventory Variances, Replenishment, and Promotions views.
- Owner and Manager receive transfer, count, replenishment, and promotion permissions. Cashier receives none of these administration permissions.
- Transfer lifecycle, count lifecycle, inventory policy/corrections, and promotion lifecycle changes are audited.

## Deliberate limits

- Suggestions are advisory and draft-only; there is no automatic ordering.
- Advanced BOGO, mix-and-match, promotion stacking, marketing campaigns, and unrestricted rules are out of scope.
- The Phase 5 forms prioritize the core operational path: one-line transfer/count creation, receive-remaining, per-suggestion draft PO creation, and variant-promotion creation. The API/data model supports multi-line transfers/counts and category/product promotions.
