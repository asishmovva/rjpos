// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from '../app/admin/page.js';
import { adminApi, createCatalogFlow } from '../app/admin/admin-client.js';

const response = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 400, json: async () => body }) as Response;
const emptyPage = { items: [], page: 1, pageSize: 25, total: 0 };

describe('Phase 2 back-office interactions', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (url.endsWith('/admin/dashboard')) return response({ salesMinor: '0', transactions: 0, refundMinor: '0', openRegisters: 0, lowStockProducts: 0, asOf: new Date().toISOString() });
    if (url.includes('/admin/categories') && method === 'POST') return response({ id: 'category-1', name: 'Spirits', active: true });
    if (url.endsWith('/admin/products') && method === 'POST') return response({ id: 'product-1', name: 'Vodka', active: true });
    if (url.includes('/admin/products/product-1/variants') && method === 'POST') return response({ id: 'variant-1', name: '750 ml', sku: 'VODKA-750', active: true, lowStockThreshold: 2, barcodes: [{ barcodeValue: '012345678905' }] });
    if (url.endsWith('/admin/prices') || url.endsWith('/admin/inventory/opening-balance')) return response({});
    if (url.includes('/admin/products?')) return response(emptyPage);
    if (url.includes('/admin/categories?')) return response({ ...emptyPage, pageSize: 100 });
    if (url.endsWith('/admin/stores')) return response([{ id: 'store-1', name: 'Downtown', status: 'ACTIVE', timezone: 'America/New_York', taxRateBasisPoints: 625, receiptFooter: null }]);
    if (url.includes('/customers?')) return response({ ...emptyPage, pageSize: 100 });
    if (url.endsWith('/customers') && method === 'POST') return response({ id: 'customer-1', name: 'Jamie', email: 'jamie@example.test', phone: null, notes: null, active: true });
    if (url.endsWith('/loyalty/program')) return response({ enabled: true, pointsEarned: 1, spendMinor: '100', redeemMinorPerPoint: '10' });
    if (url.endsWith('/admin/gift-cards') && method === 'POST') return response({ id: 'gift-1', code: 'RJ-ABCDEF0123456789ABCDEF0123456789', balanceMinor: '2500' });
    if (url.includes('/gift-cards/lookup')) return response({ id: 'gift-1', lastFour: '6789', status: 'ACTIVE', balanceMinor: '2500', availableMinor: '2500', history: [] });
    return response(emptyPage);
  })); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('creates a complete sellable catalog item from the Products interaction', async () => {
    const user = userEvent.setup(); render(<AdminPage/>);
    await screen.findByText('Today’s sales');
    await user.click(screen.getByRole('button', { name: 'Products' }));
    await screen.findByText('No products match this search.');
    await user.click(screen.getByRole('button', { name: 'New product' }));
    await user.type(screen.getByLabelText('New category'), 'Spirits');
    await user.type(screen.getByLabelText('Product name'), 'Vodka');
    await user.type(screen.getByLabelText('Variant'), '750 ml');
    await user.type(screen.getByLabelText('SKU'), 'VODKA-750');
    await user.type(screen.getByLabelText('UPC / barcode'), '012345678905');
    await user.selectOptions(screen.getByLabelText('Store'), 'store-1');
    await user.type(screen.getByLabelText('Price, cents'), '1999');
    await user.type(screen.getByLabelText('Opening quantity'), '12');
    fireEvent.change(screen.getByLabelText('Low-stock threshold'), { target: { value: '2' } });
    await user.click(screen.getByRole('button', { name: 'Create sellable item' }));
    expect((await screen.findByRole('status')).textContent).toContain('Product, variant, price, and opening inventory created.');
    const calls = vi.mocked(fetch).mock.calls.map(([url, init]) => [String(url), init?.method, init?.body]);
    expect(calls.some(([url, method]) => String(url).endsWith('/admin/categories') && method === 'POST')).toBe(true);
    expect(calls.some(([url, method]) => String(url).endsWith('/admin/prices') && method === 'POST')).toBe(true);
    expect(calls.some(([url, method]) => String(url).endsWith('/admin/inventory/opening-balance') && method === 'POST')).toBe(true);
  });

  it('orchestrates category → product → variant → price → opening inventory in order', async () => {
    await createCatalogFlow({ categoryName: 'Wine', productName: 'Cabernet', variantName: '750 ml', sku: 'CAB-750', barcode: '123456789012', storeId: 'store-1', priceMinor: '2499', openingQuantity: 6, reason: 'Initial shelf count', lowStockThreshold: 2 });
    const paths = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url).split('/admin')[1]);
    expect(paths).toEqual(['/categories', '/products', '/products/product-1/variants', '/prices', '/inventory/opening-balance']);
  });

  it('sends authoritative edit, variant, inventory, price, and employee-role operations', async () => {
    await adminApi.updateProduct('p1', { name: 'Edited' });
    await adminApi.updateVariant('v1', { name: '1 L' });
    await adminApi.adjustInventory({ storeId: 's1', variantId: 'v1', quantityDelta: -2, reason: 'Damage' });
    await adminApi.schedulePrice({ variantId: 'v1', storeId: 's1', amountMinor: '2199', effectiveFrom: '2026-11-01T00:00:00.000Z' });
    await adminApi.updateEmployee('e1', { roleNames: ['MANAGER'] });
    const operations = vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined }));
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('/admin/products/p1'), method: 'PATCH', body: { name: 'Edited' } }),
      expect.objectContaining({ url: expect.stringContaining('/admin/variants/v1'), method: 'PATCH', body: { name: '1 L' } }),
      expect.objectContaining({ url: expect.stringContaining('/admin/inventory/adjust'), body: expect.objectContaining({ quantityDelta: -2, reason: 'Damage' }) }),
      expect.objectContaining({ url: expect.stringContaining('/admin/prices'), body: expect.objectContaining({ amountMinor: '2199' }) }),
      expect.objectContaining({ url: expect.stringContaining('/admin/employees/e1'), body: { roleNames: ['MANAGER'] } }),
    ]));
  });

  it('uses server-side order and refund lookups rather than browser-side full-history filtering', async () => {
    await Promise.all([adminApi.orders('RJP-100'), adminApi.refunds('RJP-100')]);
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(expect.arrayContaining([expect.stringContaining('/admin/orders?search=RJP-100'), expect.stringContaining('/admin/refunds?search=RJP-100')]));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('creates customers through the Phase 3 profile workflow', async () => {
    const user = userEvent.setup(); render(<AdminPage/>);
    await screen.findByText('Transactions');
    await user.click(screen.getByRole('button', { name: 'Customers' }));
    await screen.findByText('No customers match this search.');
    await user.type(screen.getByLabelText('Name'), 'Jamie');
    await user.type(screen.getByLabelText('Email'), 'jamie@example.test');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));
    expect((await screen.findByRole('status')).textContent).toContain('Customer created.');
    expect(vi.mocked(fetch).mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining([expect.stringContaining('/customers'), expect.objectContaining({ method: 'POST' })]),
    ]));
  });

  it('issues and immediately looks up a gift card without exposing an internal identifier as the code', async () => {
    const user = userEvent.setup(); render(<AdminPage/>);
    await screen.findByText('Transactions');
    await user.click(screen.getByRole('button', { name: 'Gift Cards' }));
    await user.type(screen.getByLabelText('Issue amount, cents'), '2500');
    await user.click(screen.getByRole('button', { name: 'Issue gift card' }));
    expect((await screen.findByRole('status')).textContent).toContain('RJ-ABCDEF0123456789ABCDEF0123456789');
    expect(await screen.findByText('$25.00')).toBeTruthy();
  });
});
