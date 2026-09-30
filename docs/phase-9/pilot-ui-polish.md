# Pilot UI polish (branch `polish/pilot-ui`)

A polish pass on top of Phase 9. No architecture changes; one small additive migration (`0017`, promotions).

## Register
- Header is 58 px (was 72), with the RJ POS mark, compact Close/Clock buttons, **Help** and **Display** buttons; fits at 1024 px.
- Quick Add: 6x6 grid, group select on narrow screens (chips on wide), Prev / `1 / N` / Next always shown in the title row, Manage. Cells stay about 48 px tall.
- Totals show Subtotal, Discount, Tax, Total every time. The action bar is one row of 12 at 1024 px.
- CARD shows **Simulated** or **Unavailable** when no real provider is configured; cash is unaffected.
- Already in place from earlier phases and only verified: six full cart rows with internal scroll after six, swipe-to-remove, compact checkout (customer and gift-card fields live in modals), cash shortcuts and change-due flow, compact age modal, held sales.

## Admin
- One navigation list (`admin-links.ts`) drives a grouped sidebar on the home page and a top bar with a **Go to…** menu on every sub-page, plus Help and sign-out. Sections open from sub-pages by hash. Main content returns to the top when the section or page changes; the sidebar keeps its own scroll.
- Bulk changes show a 5-step progress bar and require an explicit "I reviewed the changes" confirmation before Apply, then a Result panel.
- CSV import shows Upload / Validate / Preview / Confirm, uses Create / Update / Skip / Error wording, and offers a template per data type.
- Audit log filters by employee, store, action, record type and dates.
- Backups page shows destination, file check (**Verify backup file** checks the dump exists and is non-empty; it does not restore), instructions, and states plainly that the restore script is a verification into a test database, not a production restore.
- Hardware page: Scanner (Test scan shows what arrived), Receipt printer, Label printer, Cash drawer, Payment terminal, each with honest status and a **Not certified** badge.

## Customer display
- `/customer-display/` (Display button opens it, fullscreen on a second monitor when present). Left: rotating promotions or a store welcome; right: live order, savings, tax, big total. States: idle, sale, age verification (neutral wording), payment processing, large change due, thank you.
- Settings → Customer display manages promotions (image up to 600 KB, title, message, order, on/off, optional dates). Not a CMS.
- It receives state from the register over a same-origin BroadcastChannel and never shows support details, staff names or approvals.

## Support
Help opens "RJ POS Support / 24/7 Support" with phone, email and website from `NEXT_PUBLIC_RJPOS_SUPPORT_PHONE`, `..._EMAIL`, `..._WEBSITE`. Unset values display "Not configured yet". There is no chat. Register, lock screen, sign-in and all admin pages have it; the customer display does not.

## Reviewed, not changed
Product creation (already sectioned: UPC, product, vendor and case, selling units, pricing with distinct markup and margin, special pricing, inventory, tax profile), product detail tabs, vendor pages, invoice review, purchasing/receiving, cash operations and shift/Z reports keep their earlier-phase designs. Specific polish found during pilot use goes through bug/fix branches.
