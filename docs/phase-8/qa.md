# Phase 8 QA checklist

Automated (run in CI): pricing math, tax profiles, special prices, pack conversion, vendor deals, invoice calculations, return disposition, cash operations, shift report, Z report, UPC uniqueness, scroll reset.

Manual:
1. New product wizard: scan an existing UPC and a case UPC (should open the existing product); create a product with case UPC, MOQ 2 cases, reorder settings, a custom pack; confirm the detail tabs.
2. Register Return: choose Damaged / Non-resellable / Vendor return and confirm sellable stock does not increase; Return to stock increases it.
3. Register Cash / Drawer: safe drop and paid in as cashier; paid out, adjust, and no-sale ask for manager approval; expected cash changes at close.
4. Close a shift as cashier (summary only) and as manager (drawer cash section).
5. /admin/day-close/: preview with an open register, acknowledge, finalize, try to finalize again, view closed days.
6. Admin: scroll down a long list, switch section (content at top), sidebar keeps position.
