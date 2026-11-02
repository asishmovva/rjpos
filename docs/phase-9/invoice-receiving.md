# Invoice receiving: canonical model and completeness audit

Branch `feat/invoice-receiving-completeness`, migration `0018_invoice_receiving_canonical` (additive: new nullable columns with defaults, two new tables, five claim kinds).

## Principles
Original data, parsed data, product mapping, receiving quantities, stock posting, cost updates, discounts and claims are separate. Vendor-specific parsers map **into** the canonical fields through `normalizeVendorLabel` / `lineFromPrintedFields`; every printed label and value is kept in `evidence` (line) or `fieldEvidence` (header), and a manual correction adds `corrected` beside the original instead of replacing it. Nothing posts before **Final Confirmation**.

## 1. Canonical invoice fields
Header (all optional): document type (invoice, credit memo, delivery receipt, backorder notice, adjustment); vendor name/account/address/phone; bill to, ship to, customer account, store/license; invoice #, invoice date, order #, PO reference (+ optional link to an RJ POS PO), document #, ship/delivery/due dates, route, salesperson, customer terms, payment terms. Totals: gross merchandise, post-off total, discount, rebate/allowance, fees/delivery, tax, deposit, credit, subtotal, invoice net, invoice total, amount due. Kept-not-required: summary metadata (bottles, packages, gallons by class), remittance metadata (previous invoices, payments), vendor extras (unknown printed fields as label/value). Credit memo, adjustment and backorder notices are recorded but never post stock.

## 2. Quantity and pack model
Per line: cases ordered / invoiced (shipped) / received / backordered / rejected; loose bottles shipped/received; bonus bottles; damaged, broken, missing bottles; units per case; pack label; fulfillment (received, partial, backordered, out of stock, cancelled). `resolveQuantities` converts to base units (2 cases × 12 = 24), derives short/over/exact, and **sellable = received − rejected − damaged − broken**. Purchase packaging is independent of sellable formats; stock is added to the base variant.

## 3. Cost and discount model
Stored separately: unit list, list case, printed base case cost, gross line, post-off, quantity discount, case discount, promotional discount, other discount (all per case; per-bottle printed amounts are converted), whole-line discount, allowance and rebate (lower true cost, not the invoice), RIP code/value (kept as printed, never interpreted), net case, net unit, effective case/unit, extended amount, printed line total. The base cost is never overwritten by the net. Printed values that disagree with the math are flagged (`NET_CASE_MISMATCH`, `EXTENDED_MISMATCH`, ...). Temporary deal prices are flagged and never become the standard vendor cost: updating vendor cost uses the stated standard case cost, or does nothing.

## 4. Backorder, shortage, damage
Backordered cases keep the PO open (`PARTIALLY_RECEIVED`); the PO is never closed automatically. Shortages not explained by a backorder, damaged units marked *vendor claim / pending credit / reject to vendor*, and rejected cases draft vendor claims (never auto-submitted). Damaged or broken units require a disposition before confirmation.

## 5. PO matching
When a PO is linked: ordered vs invoiced vs received per line, flags for unexpected item, missing item, price differs from PO, over-shipment (blocks until fixed), shortage, backorder, plus PO lines the invoice omits. Without a PO, receiving works and creates one from the invoice.

## 6. Product matching
Order: vendor SKU / item number mapping, UPC, case UPC, alternate UPC, master catalog, manual match. A fuzzy description never matches. Unmatched lines: link existing, add master product, create new (pre-filled, staged for review), or ignore. Non-inventory lines (delivery, freight, service, fee, deposit, credit, rebate, other) and invoice-level charges never create products.

## 7. Reconciliation
Σ net lines + charges + tax + deposits − credits (− header discounts for gross lines) against the invoice total: **match / minor / material**. Any discrepancy needs an explicit acknowledgement; a material difference also needs a written note.

## 8. Inventory posting
On confirmation only: `PURCHASE_RECEIPT +received (not rejected)`, then `DAMAGE −damaged`, through the existing ledger, so net stock equals sellable units and damage is on the ledger. Example: 2 cases × 12, one broken → +24, −1, on hand +23. Raw invoice quantity is never added.

## 9. Historical cost
`ProductCostHistory` rows (append-only) store list, base, each discount component (`componentsJson`), net, effective case and unit, units received/damaged/rejected/short, temporary-deal flag, invoice line and receipt ids. Later vendor price changes never rewrite them; last/average/weighted-average cost can be computed later from these rows. The product's Receiving History tab and the receipt detail read these rows, not the vendor mapping.

## 10. Vendor claims and credits
Kinds: return, shortage, damage, price difference, wrong product, incorrect cost, missing discount, overcharge, other. Claims link to vendor, invoice, PO and invoice line; track expected vs credited amount, credit number and settlement date. Created automatically as drafts from receiving, or from any line.

## 11. OCR and manual review
OCR is an accelerator: a manual invoice (no file) accepts every header and line field, charges, pages and claims. Low-confidence lines are highlighted. More pages/photos attach to the same invoice (OCR'd when available); a draft with the same vendor and invoice number is offered as a merge, never merged silently.

## 12. Tests added
- `domain-types/tests/invoice-receiving.test.ts` (12): label normalization across layouts, economics (post-off, quantity discount, net case/unit, allowance), pack conversion, backorder/partial/over/short, damaged units, reconciliation, cost change and margin, PO comparison.
- `database/tests/invoice-receiving-completeness.integration.test.ts` (5, PostgreSQL): three distributor layouts through the adapter; partial receipt + backorder + broken bottle + claim + exact cost history + retail/standard cost untouched; manual entry, case-UPC match, freight/fee lines, reconciliation gating, exact duplicate block, credit memo; temporary deal vs standard cost, cost-change warning, audited correction with before/after; multi-page grouping, PO over-shipment/unexpected/missing, manual claim.
- `api/tests/phase-nine.test.ts`: cashier refused on every invoice route; manager passes the gate.
- `web/tests/receiving-ui.test.tsx` (5): money helpers, table columns and expansion, minor-unit edits, confirmation gating.
- Updated `phase-four` test for the new damage ledger movement.

## 13. Schema
0018: `InvoiceDocument` (header, totals, summary/remittance/extras/field evidence, page count), `InvoiceLine` (identification, quantities, discount components, RIP, temporary deal, evidence, corrections), `InvoiceDocumentPage`, `InvoiceCharge`, `ProductCostHistory` (receipt/line link, list, net, components, temporary flag), `VendorClaimLine.invoiceLineId`, claim kinds; five new enums. Four check constraints. Existing rows are unaffected (defaults).

## 14. Not represented or not complete
- **Page viewer**: additional pages/photos are stored but there is no in-app image viewer yet.
- **Header-level confidence**: header evidence and confidence are stored but only line-level low confidence is highlighted in the UI.
- **Image quality**: rotation/deskew/shadow handling belongs to the OCR provider; there is none in production yet (fixture only), so real photo accuracy is untested.
- **Line fields without UI**: line tax, bottles ordered, category hint, per-line deposit are stored and editable through the API only.
- **Vendor label overrides**: the label dictionary is built in; per-vendor overrides are supported in code but have no settings screen.
- **Credit memos** record credits but do not reduce stock (use a vendor-return claim) and do not auto-apply to open claims.
- **Over-shipment** against a PO is blocked rather than extending the PO; change the quantity or detach the PO.
- **Costing**: last/weighted-average cost is not computed yet (the inputs are preserved).
- **Real distributor PDFs** (e.g. multi-page Gallo) have not been run end to end; fixtures cover the layouts.
