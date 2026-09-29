// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewProductPage from '../app/admin/products/new/page.js';
import TaxSettingsPage from '../app/admin/taxes/page.js';
import { InvoiceReviewPanel } from '../app/admin/invoices/review-panel.js';

const response = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
type Call = { url: string; method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let lookupResult: unknown = { status: 'NEW', upc: '012345678905' };

const profiles = [
  { id: 'tp-std', name: 'Standard State Tax', kind: 'STANDARD', rateBasisPoints: null, description: null, active: true, isDefault: true, referenceCount: 0 },
  { id: 'tp-none', name: 'Non-Taxable', kind: 'NON_TAXABLE', rateBasisPoints: 0, description: null, active: true, isDefault: false, referenceCount: 2 },
  { id: 'tp-tob', name: 'Tobacco', kind: 'CUSTOM', rateBasisPoints: 3000, description: null, active: true, isDefault: false, referenceCount: 0 },
];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method, body });
    if (url.includes('/admin/stores') && method === 'GET') return response([{ id: 'store-1', name: 'Downtown', taxRateBasisPoints: 662 }]);
    if (url.includes('/admin/categories')) return response({ items: [{ id: 'cat-1', name: 'Beer', active: true }], page: 1, pageSize: 100, total: 1 });
    if (url.includes('/admin/vendors')) return response({ items: [{ id: 'vendor-1', name: 'Distributor' }], page: 1, pageSize: 100, total: 1 });
    if (url.endsWith('/admin/tax-profiles') && method === 'GET') return response({ profiles, stores: [{ id: 'store-1', name: 'Downtown', taxRateBasisPoints: 662 }] });
    if (url.endsWith('/admin/tax-profiles') && method === 'POST') return response({ id: 'tp-new', ...body });
    if (url.includes('/admin/tax-profiles/') && method === 'PATCH') return response({ id: 'tp-tob', ...body });
    if (url.endsWith('/admin/price-books')) return response([{ id: 'book-dd', name: 'DoorDash', active: true, sortOrder: 1, description: null }]);
    if (url.includes('/product-costing/upc-lookup')) return response(lookupResult);
    if (url.endsWith('/product-costing/purchased')) return response({ productId: 'product-1', baseVariantId: 'variant-1', draft: false, effectiveUnitCostMinor: '1500', variants: [] });
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function scan(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('UPC'), '012345678905');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByLabelText('Product name');
}
const cell = (group: HTMLElement, term: string) => within(group).getByText(term).nextElementSibling?.textContent;

describe('New purchased product wizard', () => {
  it('shows unit cost immediately, keeps markup and margin distinct, and recalculates profit for a manual price', async () => {
    const user = userEvent.setup(); render(<NewProductPage />); await scan(user);
    await user.type(screen.getByLabelText('Case cost'), '180'); await user.clear(screen.getByLabelText('Units per case')); await user.type(screen.getByLabelText('Units per case'), '12');
    const unitCost = screen.getByLabelText('Unit cost');
    expect(cell(unitCost, 'Unit cost')).toBe('$15.00');
    await user.type(screen.getByLabelText('Desired percent'), '19');
    expect((screen.getByLabelText('Retail price Single') as HTMLInputElement).value).toBe('17.85'); // markup on cost
    await user.click(screen.getByRole('radio', { name: /Gross margin/ }));
    expect((screen.getByLabelText('Retail price Single') as HTMLInputElement).value).toBe('18.52'); // gross margin of price
    await user.clear(screen.getByLabelText('Retail price Single')); await user.type(screen.getByLabelText('Retail price Single'), '19.99');
    const profit = screen.getByLabelText('Profit Single');
    expect(cell(profit, 'Cost')).toBe('$15.00'); expect(cell(profit, 'Retail')).toBe('$19.99'); expect(cell(profit, 'Profit')).toBe('$4.99'); expect(cell(profit, 'Margin')).toBe('24.96%'); expect(cell(profit, 'Markup')).toBe('33.27%');
    // deals reduce the effective cost
    await user.type(screen.getByLabelText('Discount per case'), '10');
    expect(cell(screen.getByLabelText('Unit cost'), 'Unit cost')).toBe('$14.17');
  });

  it('creates pack variants from one case, sends integer minor units, and blocks an existing UPC', async () => {
    const user = userEvent.setup(); render(<NewProductPage />); await scan(user);
    await user.type(screen.getByLabelText('Product name'), 'Corona Extra'); await user.type(screen.getByLabelText('Brand'), 'Corona'); await user.type(screen.getByLabelText('Size'), '12 oz');
    await user.selectOptions(screen.getByLabelText('Category'), 'cat-1'); await user.selectOptions(screen.getByLabelText('Vendor'), 'vendor-1');
    await user.type(screen.getByLabelText('Case cost'), '36'); await user.clear(screen.getByLabelText('Units per case')); await user.type(screen.getByLabelText('Units per case'), '24');
    await user.click(screen.getByRole('button', { name: '+ 6-Pack' }));
    await user.type(screen.getByLabelText('Desired percent'), '40');
    expect((screen.getByLabelText('Retail price 6-Pack') as HTMLInputElement).value).toBe('12.60'); // 6 × $1.50 = $9.00 cost × 1.40
    await user.type(screen.getByLabelText('Opening inventory'), '48');
    await user.click(screen.getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/product-costing/purchased'))).toBeTruthy());
    expect(calls.find((call) => call.url.endsWith('/product-costing/purchased'))!.body).toMatchObject({
      storeId: 'store-1', draft: false, product: { name: 'Corona Extra', brand: 'Corona', categoryId: 'cat-1' }, identity: { upc: '012345678905', sizeLabel: '12 oz' },
      vendor: { vendorId: 'vendor-1', caseCostMinor: '3600', unitsPerCase: 24, discountPerCaseMinor: '0', rebatePerCaseMinor: '0' },
      sellingUnits: [{ name: 'Single', unitsPerPack: 1, priceMinor: '210' }, { name: '6-Pack', unitsPerPack: 6, priceMinor: '1260' }], inventory: { openingQuantity: 48 } });
    expect(await screen.findByText('Product created')).toBeTruthy();
  });

  it('does not offer creation for a UPC that already exists', async () => {
    lookupResult = { status: 'IN_STORE', upc: '012345678905', variant: { id: 'v1', name: '12 oz', sku: 'CORONA-1', productId: 'product-9', productName: 'Corona Extra', brand: 'Corona', category: 'Beer' } };
    const user = userEvent.setup(); render(<NewProductPage />);
    await user.type(await screen.findByLabelText('UPC'), '012345678905'); await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Already in this catalog/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the existing product' }).getAttribute('href')).toBe('/admin/product/?id=product-9');
    expect(screen.queryByLabelText('Product name')).toBeNull(); expect(screen.queryByRole('button', { name: 'Create product' })).toBeNull();
    lookupResult = { status: 'NEW', upc: '012345678905' };
  });
});

describe('Settings → Taxes', () => {
  it('lists profiles, saves a custom rate, and adds a configurable profile', async () => {
    const user = userEvent.setup(); render(<TaxSettingsPage />);
    expect(await screen.findByText('Tobacco')).toBeTruthy(); expect(screen.getByText('DEFAULT')).toBeTruthy();
    await user.clear(screen.getByLabelText('Rate Tobacco')); await user.type(screen.getByLabelText('Rate Tobacco'), '45.5');
    await user.click(screen.getByRole('button', { name: 'Save rate' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/tax-profiles/tp-tob'))?.body).toEqual({ rateBasisPoints: 4550 }));
    await user.type(screen.getByLabelText('Profile name'), 'Tax 2'); await user.type(screen.getByLabelText('Profile rate'), '6.625');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/tax-profiles'))?.body).toEqual({ name: 'Tax 2', rateBasisPoints: 663 }));
    // a profile still used by products cannot be deleted from the UI
    expect(within(screen.getByText('Non-Taxable').closest('tr')!).queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('Invoice cost review panel', () => {
  it('shows case economics and highlights disagreements without changing anything', async () => {
    const toggles: Array<[string, boolean]> = [];
    const document = { id: 'inv-1', subtotalMinor: '85000', totalMinor: '85500', feesMinor: '500', poReference: 'PO-1', lines: [{ id: 'line-1', lineNumber: 1, description: 'Vodka', quantity: 5, casesReceived: 4, updateVendorCost: false }] };
    const review = { invoiceId: 'inv-1', hasDiscrepancies: true, totals: { linesSubtotalMinor: '85000', expectedTotalMinor: '85500', discrepancies: [{ code: 'TOTAL_MISMATCH', message: 'Subtotal − discounts + tax + fees does not equal the printed total.', expectedMinor: '85500', actualMinor: '86000' }] },
      lines: [{ lineId: 'line-1', ignored: false, error: null, availableDeals: [], dealPreview: null, review: { cases: 5, unitsPerCase: 12, baseCaseCostMinor: '18000', discountPerCaseMinor: '1000', rebatePerCaseMinor: '0', payableCaseCostMinor: '17000', effectiveCaseCostMinor: '17000', effectiveUnitCostMinor: '1417', totalUnits: 48, calculatedLineTotalMinor: '85000',
        discrepancies: [{ code: 'CASES_RECEIVED_DIFFER', message: 'Ordered 5 cases but 4 received.' }, { code: 'VENDOR_COST_MISMATCH', message: 'Invoice case cost (before discounts) differs from the current vendor cost.', expectedMinor: '1400', actualMinor: '1500' }] } }] };
    render(<InvoiceReviewPanel document={document as never} review={review} disabled={false} onToggleVendorCost={(lineId, value) => toggles.push([lineId, value])} />);
    expect(screen.getByRole('alert').textContent).toContain('does not equal the printed total');
    const row = screen.getByText('Vodka').closest('tr')!;
    expect(within(row).getByText('$180.00')).toBeTruthy(); expect(within(row).getByText('$10.00')).toBeTruthy(); expect(within(row).getByText('$170.00')).toBeTruthy(); expect(within(row).getByText('$14.17')).toBeTruthy(); expect(within(row).getByText('48')).toBeTruthy();
    expect(within(row).getByText(/Ordered 5 cases but 4 received/)).toBeTruthy();
    const box = screen.getByLabelText('Update vendor cost line 1') as HTMLInputElement; expect(box.checked).toBe(false);
    await userEvent.setup().click(box);
    expect(toggles).toEqual([['line-1', true]]);
  });
});
