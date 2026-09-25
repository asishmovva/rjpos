// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Register from '../app/page.js';

const response = (body: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, json: async () => body }) as Response;

describe('Phase 3 register workflow', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('initializes clock status from the backend and updates button state after clock out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workforce/current')) return response({ id: 'shift-1', clockedOutAt: null });
      if (url.endsWith('/workforce/clock-out') && init?.method === 'POST') return response({ id: 'shift-1', clockedOutAt: new Date().toISOString() });
      return response({});
    }));

    const user = userEvent.setup();
    render(<Register />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clock out' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Clock out' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clock in' })).toBeTruthy());
  });

  it('allows cash split checkout when loyalty and gift benefits cover the total', async () => {
    let mixedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workforce/current')) return response(null);
      if (url.endsWith('/register-sessions/open') && init?.method === 'POST') return response({ id: 'session-1' });
      if (url.endsWith('/store/current')) return response({ taxRateBasisPoints: 0 });
      if (url.includes('/catalog/lookup?barcode=')) return response([{ variantId: 'variant-1', productName: 'Item', variantName: 'Each', sku: 'SKU1', barcode: '123', priceMinor: '1000', active: true, ageRestricted: false }]);
      if (url.endsWith('/checkout/mixed') && init?.method === 'POST') { mixedBody = JSON.parse(String(init.body)) as Record<string, unknown>; return response({ orderId: 'order-1' }); }
      if (url.endsWith('/orders/order-1/receipt')) return response({ orderNumber: 'RJP-1', subtotalMinor: '1000', discountMinor: '0', taxMinor: '0', totalMinor: '1000', items: [{ id: 'item-1', productNameSnapshot: 'Item', variantNameSnapshot: 'Each', quantity: 1, totalMinor: '1000' }] });
      return response([]);
    }));

    const user = userEvent.setup();
    render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Open register · $100.00' }));
    await user.type(screen.getByLabelText('Scan UPC, enter SKU, or search products'), 'SKU1{enter}');
    await user.type(screen.getByLabelText('Gift-card code'), 'RJ-TEST');
    await user.clear(screen.getByLabelText('Gift-card amount'));
    await user.type(screen.getByLabelText('Gift-card amount'), '1200');
    await user.click(screen.getByRole('button', { name: 'Split with cash' }));

    await waitFor(() => expect(mixedBody).toBeDefined());
    expect(mixedBody?.remainder).toEqual({ kind: 'CASH', tenderedMinor: '0' });
  });
});
