// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportsPage from '../app/admin/reports/page.js';

const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;
describe('Phase 6 reports workspace', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/admin/stores')) return response([{ id: 'store-1', name: 'Downtown', timezone: 'America/New_York', status: 'ACTIVE', taxRateBasisPoints: 0, receiptFooter: null }]);
    return response({ kind: url.includes('/products?') ? 'products' : 'sales', filters: { from: '2026-09-01T04:00:00.000Z', toExclusive: '2026-09-28T04:00:00.000Z', timezone: 'America/New_York', storeId: null }, data: url.includes('/products?') ? { items: [{ label: 'Historical item', quantitySold: 3, revenueMinor: '1500' }], page: 1, pageSize: 50, total: 1 } : { summary: { grossSalesMinor: '1500', transactionCount: 1 }, breakdowns: {} } });
  })));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('loads server-calculated metrics, switches sections, applies filters, and exposes matching CSV export', async () => {
    const user = userEvent.setup(); render(<ReportsPage />);
    expect(await screen.findByText('$15.00')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Products' }));
    expect(await screen.findByText('Historical item')).toBeTruthy();
    const exportLink = screen.getByRole('link', { name: 'Export CSV' });
    expect(exportLink.getAttribute('href')).toContain('/admin/reports/products/export.csv?');
    await user.selectOptions(screen.getByLabelText('Store'), 'store-1');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('storeId=store-1'))).toBe(true);
  });
});
