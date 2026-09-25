# Phase 4 Implementation Summary

## Scope

Phase 4 builds a shared UPC master catalog and tenant-scoped supplier purchasing workflows on top of the existing POS product, inventory, audit, and outbox foundations.

## Master catalog

- Added globally unique `MasterProduct` records with normalized UPC, name, brand, size/pack labels, category, reference cost/price, and optional description metadata.
- UPC lookup checks the tenant's sellable barcode catalog first, then the global master catalog.
- Add to Store creates a tenant product, variant, and barcode linked to the master identity. The caller must choose a store category and SKU. Price and store-specific cost are optional explicit inputs; inventory and pricing are never created implicitly.
- CSV import accepts both the generic `upc,name` format and the supplied export's `ITEMNAME,DEPNAME,MAINUPC,SIZENAME,PACKNAME,CURRENTCOST,PRICEPERUNIT` columns. `TOTALQTY` is ignored. Nonstandard 1–7 and 9–11 digit numeric `MAINUPC` values are zero-padded to UPC-A width; standard 8-, 12-, 13-, and 14-digit codes remain unchanged.
- Supplied costs and prices are stored as global reference-only cents values and displayed as references. They never prefill or configure tenant store cost, selling price, or inventory.
- Import rows are validated, duplicate UPCs within a file are reported, and rows are inserted in bounded batches for larger catalog support. The import returns added/updated/skipped/invalid/duplicate counts with row-level issues.
- Re-imports that match existing data are idempotent. A UPC associated with a different product name or a changed supplied size/pack identity is reported as a conflict and is not overwritten. Blank optional fields do not erase stored values.
- The user-provided `CategorizedItemList.csv` is included in development seeding; its 2,714 rows import as global master products, with no quantities copied into inventory.

## Vendors and purchasing

- Vendors are tenant scoped and can be created, edited, activated, or deactivated. They are retained rather than hard deleted.
- Vendor product mappings capture vendor SKU, current vendor cost, case-pack quantity, minimum quantity, preferred selection, and active state. Multiple suppliers can map to a product variant.
- Draft purchase orders snapshot product/variant names, SKU, vendor SKU, order quantity, and unit cost. Only drafts can be edited; submissions and cancellations enforce allowed states.
- Purchase orders can be seeded from low-stock inventory selection in the back office; creating a draft does not submit it.
- Receiving is available only for submitted or partially received orders. A receipt is idempotent, serializes concurrent receipts by locking the PO row, rejects invalid/over-ordered quantities, and records delivered, damaged, rejected, and actual unit cost data.
- Only accepted receipt quantities increase inventory. Updates use an atomic inventory-level increment and append `PURCHASE_RECEIPT` movements, audit records, and outbox events in the same PostgreSQL transaction. Damaged and rejected units fulfill ordered quantities but do not enter sellable stock.
- PO costs, actual receipt costs, current vendor costs, and optional store-specific product costs are stored separately. Receiving does not rewrite product/store cost or historical movements.

## Access control

- Owner can manage master-catalog imports, vendors, mappings, purchase orders, and receipts.
- Manager can view vendors/mappings and run operational PO/receiving workflows; vendor and master import administration remain owner-only.
- Cashier has no purchasing or supplier administration permission.
- Organization and store scope checks are applied at the API/data boundaries, with sensitive operations written to the audit log.

## Migration

`0007_phase4_purchasing_catalog` adds the global master catalog, tenant/store cost table, vendor/mapping tables, PO and receipt tables, cost/quantity checks, scoped foreign keys, idempotency constraints, the purchase-receipt movement type, and a unique preferred-vendor constraint per active variant.

## Known limits

- The import endpoint currently receives CSV as a JSON string, buffered in memory with a 10 MB request limit; larger catalogs should move to streaming or file-backed transport.
- The system records costs needed for later workflows but does not implement accounting, COGS, invoice reconciliation, or supplier payments.
- Multi-store transfers, EDI, and automatic replenishment/ordering are out of scope.
