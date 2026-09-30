# Hardware validation

No physical devices were available during Phase 9, so **nothing below is certified**. Simulators and unit/integration tests cover the software paths; real devices must be validated at the pilot store. The app never reports a simulated action as a real success (simulated results say so).

| Device | Software path | Verified here | Needs a real device to certify |
|---|---|---|---|
| Barcode scanner (USB HID keyboard-wedge) | Global key capture with speed/Enter detection, duplicate-Enter suppression, repeated-scan quantity | Automated UI tests with synthetic key events | Scan real UPC-A/EAN-13, damaged codes, rapid scans, scanning while a dialog is open |
| Receipt printer | `hardware:print-receipt` renders receipt HTML and prints silently through the OS driver | Simulated mode; unavailable-state handling | Print on the real driver: width, cut, logo, reprint, out-of-paper behavior |
| Cash drawer | `hardware:open-drawer`, only for a real cash sale or a manager-approved manual open with a reason | Authorization rules and audit, simulated open | Drawer kick through the receipt printer or serial, both on sale and manual open |
| Label printer | `hardware:print-labels` renders Code 128 labels as HTML (exact page size) and prints via the OS driver; ZPL encoder available for raw/network printers | Encoder math (symbol widths sum to 11, checksum against a published example), job validation, HTML escaping, simulated mode | Print each size (50×30, 60×40, 40×25 mm) on the real printer, **scan the printed barcodes with the store scanner**, confirm the driver honors the page size and silent printing |
| Card terminal | Provider-neutral contract with unknown-payment handling and idempotency | Simulated provider; HTTP adapter boundary | **Everything**: see the payment section of the release checklist |
| Customer display | Contract only (`CustomerDisplay`) | none | Not wired into the register UI |

## Procedure at the pilot store
1. Set `RJPOS_HARDWARE_MODE` appropriately and open Register & hardware in the back office.
2. Use **Test printer** for the receipt printer, then print a real receipt and a reprint.
3. Open the drawer with a cash sale and with a manual open (reason required, manager approval for cashiers).
4. Print one label of each type, scan it, and confirm the scanned value equals the item's UPC.
5. Scan 20 real products including one with a damaged label and one scan during the age-check dialog.
6. Record results (device model, driver, pass/fail, notes) in the release checklist below; only then mark a device certified.
