// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Register from '../app/page.js';

const item = { variantId: 'variant-1', productName: 'Quick Whiskey', variantName: '750 ml', sku: 'QUICK-1', barcode: '012345678905', priceMinor: '1000', active: true, ageRestricted: false };
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;
describe('Phase 7 touch register and HID scanning', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/workforce/current')) return response(null);
    if (url.endsWith('/register-sessions/current')) return response({ id: 'session-1', status: 'OPEN' });
    if (url.endsWith('/store/current')) return response({ taxRateBasisPoints: 0 });
    if (url.endsWith('/quick-keys')) return response([{ ...item, id: 'key-1', label: 'Best seller', groupName: 'Popular', position: 0 }]);
    if (url.includes('/catalog/lookup?barcode=')) return response([item]);
    if (url.endsWith('/checkout/quote')) { const body = JSON.parse(String(init?.body)) as { lines: Array<{ quantity: number }> }; const amount = String(body.lines[0]!.quantity * 1000); return response({ subtotalMinor: amount, discountMinor: '0', taxMinor: '0', totalMinor: amount, lines: [{ variantId: 'variant-1', unitPriceMinor: '1000', quantity: body.lines[0]!.quantity, subtotalMinor: amount, discountMinor: '0', taxMinor: '0', totalMinor: amount, promotionName: null }] }); }
    if (url.endsWith('/held-transactions') && init?.method === 'POST') return response({ id: 'held-1' });
    return response([]);
  })));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('adds Quick Keys with one touch and increments the same item', async () => {
    const user = userEvent.setup(); render(<Register />);
    const key = await screen.findByRole('button', { name: /Best seller/ }); await user.click(key); await user.click(key);
    await waitFor(() => expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('2'));
  });

  it('captures HID scanner input without focus, permits deliberate repeated scans, and suppresses duplicate Enter events', async () => {
    render(<Register />); await screen.findByRole('button', { name: /Best seller/ });
    const scan = () => { for (const key of '012345678905') fireEvent.keyDown(document.body, { key }); fireEvent.keyDown(document.body, { key: 'Enter' }); };
    scan(); fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('1'));
    await new Promise((resolve) => setTimeout(resolve, 40)); scan();
    await waitFor(() => expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('2'));
  });

  it('holds the active cart with cashier-safe feedback', async () => {
    const user = userEvent.setup(); render(<Register />); await user.click(await screen.findByRole('button', { name: /Best seller/ })); await user.click(screen.getByRole('button', { name: 'Hold' }));
    expect(await screen.findByText('Sale held. You can resume it from this register.')).toBeTruthy();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith('/held-transactions') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ cart: { lines: [expect.objectContaining({ variantId: 'variant-1', quantity: 1 })] } });
  });
});
