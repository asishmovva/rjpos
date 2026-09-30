/** Single source of truth for back-office navigation, shared by the home sidebar and the sub-page chrome. */
export type AdminLink = { label: string; href?: string; area?: string };
export type AdminGroup = { title: string; items: AdminLink[] };

export const ADMIN_GROUPS: AdminGroup[] = [
  { title: 'Overview', items: [{ label: 'Dashboard', area: 'Dashboard' }] },
  { title: 'Catalog & pricing', items: [
    { label: 'Products', area: 'Products' }, { label: 'New purchased product', href: '/admin/products/new/' }, { label: 'Categories', area: 'Categories' }, { label: 'Promotions', area: 'Promotions' },
    { label: 'Price books', href: '/admin/price-books/' }, { label: 'Taxes', href: '/admin/taxes/' }, { label: 'Sales channels', href: '/admin/channels/' }, { label: 'Master catalog', area: 'Master Catalog' },
    { label: 'Bulk changes', href: '/admin/bulk/' }, { label: 'Import & export', href: '/admin/import-export/' }, { label: 'Labels', href: '/admin/labels/' },
  ] },
  { title: 'Inventory', items: [
    { label: 'Inventory', area: 'Inventory' }, { label: 'Transfers', area: 'Transfers' }, { label: 'Stock counts', area: 'Stock Counts' }, { label: 'Variances', area: 'Inventory Variances' }, { label: 'Replenishment', area: 'Replenishment' },
  ] },
  { title: 'Purchasing', items: [
    { label: 'Vendors', area: 'Vendors' }, { label: 'Vendor mappings', area: 'Vendor Mappings' }, { label: 'Purchase orders', area: 'Purchase Orders' }, { label: 'Receiving history', area: 'Receiving History' },
    { label: 'Invoice receiving', href: '/admin/invoices/' }, { label: 'Claims & suggestions', href: '/admin/claims/' },
  ] },
  { title: 'Sales & cash', items: [
    { label: 'Orders', area: 'Orders' }, { label: 'Refunds', area: 'Refunds' }, { label: 'Reports & exports', href: '/admin/reports/' }, { label: 'End of day (Z report)', href: '/admin/day-close/' },
  ] },
  { title: 'People', items: [
    { label: 'Employees', area: 'Employees' }, { label: 'Customers', area: 'Customers' }, { label: 'Loyalty', area: 'Loyalty' }, { label: 'Gift cards', area: 'Gift Cards' },
  ] },
  { title: 'Settings & system', items: [
    { label: 'Stores', area: 'Stores' }, { label: 'Registers', area: 'Registers' }, { label: 'Store settings', area: 'Settings' }, { label: 'Register & hardware', href: '/admin/register-settings/' },
    { label: 'Customer display', href: '/admin/customer-display/' }, { label: 'Audit log', href: '/admin/audit/' }, { label: 'Backups', href: '/admin/system/' },
  ] },
];

/** Where a link goes from a sub-page: sections live on the home page and are opened with a hash. */
export const linkHref = (item: AdminLink): string => item.href ?? `/admin/#${encodeURIComponent(item.area ?? '')}`;
