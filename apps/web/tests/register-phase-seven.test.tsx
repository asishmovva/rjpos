// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Register from '../app/page.js';
import { signInAs } from './session.js';

const item = { variantId: 'variant-1', productName: 'Quick Whiskey', variantName: '750 ml', sku: 'QUICK-1', barcode: '012345678905', priceMinor: '1000', active: true, ageRestricted: false };
const secondItem = { ...item, variantId: 'variant-2', productName: 'Quick Whiskey Reserve', sku: 'QUICK-2', barcode: '012345678912', priceMinor: '1400' };
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;
describe('Phase 7 touch register and HID scanning', () => {
  beforeEach(() => { signInAs(); vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/workforce/current')) return response(null);
    if (url.endsWith('/register-sessions/current')) return response({ id: 'session-1', status: 'OPEN' });
    if (url.endsWith('/store/current')) return response({ taxRateBasisPoints: 0 });
    if (url.endsWith('/quick-keys')) return response([{ ...item, id: 'key-1', label: 'Best seller', groupName: 'Popular', position: 0 }]);
    if (url.includes('/catalog/lookup?barcode=')) return response([item]);
    if (url.includes('/catalog/lookup?search=quick')) return response([item, secondItem]);
    if (url.includes('/inventory?')) return response({ total: 1, page: 1, pageSize: 25, categories: [{ id: 'cat-1', name: 'Whiskey' }], items: [{ id: 'stock-1', onHand: 8, reserved: 2, lowStockThreshold: 3, variant: { name: '750 ml', sku: 'QUICK-1', product: { name: 'Quick Whiskey', category: { name: 'Whiskey' } }, barcodes: [{ barcodeValue: '012345678905' }] } }] });
    if (url.endsWith('/workforce/clock-in') && init?.method === 'POST') return response({ id: 'shift-1', clockedOutAt: null });
    if (url.endsWith('/checkout/quote')) { const body = JSON.parse(String(init?.body)) as { lines: Array<{ quantity: number }> }; const amount = String(body.lines[0]!.quantity * 1000); return response({ subtotalMinor: amount, discountMinor: '0', taxMinor: '0', totalMinor: amount, lines: [{ variantId: 'variant-1', unitPriceMinor: '1000', quantity: body.lines[0]!.quantity, subtotalMinor: amount, discountMinor: '0', taxMinor: '0', totalMinor: amount, promotionName: null }] }); }
    if (url.endsWith('/held-transactions') && init?.method === 'POST') return response({ id: 'held-1' });
    if (url.endsWith('/held-transactions')) return response([{ id: 'held-9', label: 'Bob', note: 'wallet', heldAt: new Date(Date.now() - 12 * 60_000).toISOString(), ageVerified: true, lineCount: 2, cartJson: { lines: [] }, employee: { firstName: 'Casey', lastName: 'Cashier' }, customer: null, register: { name: 'Front' } }]);
    if (url.endsWith('/held-transactions/held-9/cancel') && init?.method === 'POST') return response({ id: 'held-9', status: 'CANCELLED' });
    if (url.endsWith('/sales-channels')) return response([{ id: 'ch-walk', name: 'Walk-In', isDefault: true }, { id: 'ch-dd', name: 'DoorDash', isDefault: false }]);
    if (url.endsWith('/orders')) return response([{ id: 'order-1', orderNumber: 'ORD-1', status: 'COMPLETED', totalMinor: '1000' }]);
    if (url.endsWith('/orders/order-1/receipt')) return response({ id: 'order-1', orderNumber: 'ORD-1', subtotalMinor: '1000', discountMinor: '0', taxMinor: '0', totalMinor: '1000', items: [{ id: 'item-1', productNameSnapshot: 'Quick Whiskey', variantNameSnapshot: '750 ml', quantity: 1, unitPriceMinor: '1000', subtotalMinor: '1000', discountMinor: '0', totalMinor: '1000', promotionNameSnapshot: null }], refunds: [] });
    if (url.endsWith('/orders/order-1/refund') && init?.method === 'POST') return response({ refundId: 'refund-1', status: 'SUCCEEDED' });
    if (url.endsWith('/auth/approvers')) return response([{ id: 'manager-1', name: 'Demo Manager', role: 'MANAGER' }]);
    if (url.endsWith('/auth/elevate') && init?.method === 'POST') return response({ token: 'elevation-token', expiresAt: new Date(Date.now() + 300_000).toISOString(), approver: { id: 'manager-1', name: 'Demo Manager', role: 'MANAGER' } });
    return response([]);
  })); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

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
    await user.type(await screen.findByLabelText('Hold name'), 'Bob'); await user.type(screen.getByLabelText('Hold note'), 'back soon'); await user.click(screen.getByRole('button', { name: 'Hold sale' }));
    expect(await screen.findByText('Sale held. You can resume it from this register.')).toBeTruthy();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith('/held-transactions') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ label: 'Bob', note: 'back soon', cart: { lines: [expect.objectContaining({ variantId: 'variant-1', quantity: 1 })] } });
  });

  it('lists held sales with age, register, note, and age state, and cancels one', async () => {
    const user = userEvent.setup(); render(<Register />); await screen.findByRole('button', { name: /Best seller/ });
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText(/12 min ago · Casey Cashier · Front/)).toBeTruthy();
    expect(screen.getByText(/2 lines · age verified · wallet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel held sale Bob' }));
    expect(await screen.findByText('Held sale cancelled. No sale was recorded.')).toBeTruthy();
    expect(screen.queryByText(/12 min ago/)).toBeNull();
  });

  it('prices the sale with the selected channel', async () => {
    const user = userEvent.setup(); render(<Register />);
    const channel = await screen.findByLabelText('Sales channel'); await user.selectOptions(channel, 'ch-dd');
    await user.click(await screen.findByRole('button', { name: /Best seller/ }));
    await waitFor(() => { const quote = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/checkout/quote')).at(-1); expect(JSON.parse(String(quote?.[1]?.body))).toMatchObject({ channelId: 'ch-dd' }); });
  });

  it('shows product search matches in a selectable dropdown', async () => {
    const user = userEvent.setup(); render(<Register />);
    const search = await screen.findByRole('combobox', { name: 'Scan UPC, enter SKU, or search products' });
    await user.type(search, 'quick');
    const results = await screen.findByRole('listbox', { name: 'Product search results' });
    expect(results.textContent).toContain('Quick Whiskey Reserve');
    await user.click(screen.getByRole('option', { name: /Quick Whiskey Reserve/ }));
    await waitFor(() => expect(screen.getByText('Quick Whiskey Reserve')).toBeTruthy());
  });

  it('supports keyboard navigation and Enter selection in product suggestions', async () => {
    const user = userEvent.setup(); render(<Register />);
    const search = await screen.findByRole('combobox', { name: 'Scan UPC, enter SKU, or search products' });
    await user.type(search, 'quick');
    await screen.findByRole('listbox', { name: 'Product search results' });
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(screen.getByText('Quick Whiskey Reserve')).toBeTruthy());
  });

  it('uses Price Check without adding the selected item to the cart', async () => {
    const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Price Check' }));
    await user.type(screen.getByRole('combobox', { name: /Scan UPC|Price check/ }), 'quick');
    await user.click((await within(await screen.findByRole('listbox', { name: 'Product search results' })).findAllByRole('option'))[0]!);
    expect(screen.queryByLabelText('Quantity')).toBeNull();
    expect(await screen.findByText('Quick Whiskey · 750 ml: $10.00.')).toBeTruthy();
  });

  it('removes a cart line with the Remove button and reveals a confirm action on swipe without removing', async () => {
    const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: /Best seller/ }));
    const line = await screen.findByTestId('cart-line');
    fireEvent.touchStart(line, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchMove(line, { touches: [{ clientX: 140, clientY: 12 }] });
    fireEvent.touchEnd(line);
    expect(screen.getByTestId('cart-line').getAttribute('style')).toContain('translateX(132px)');
    expect(screen.getByLabelText('Quantity')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm remove Quick Whiskey' }));
    await waitFor(() => expect(screen.queryByLabelText('Quantity')).toBeNull());
    await user.click(await screen.findByRole('button', { name: /Best seller/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove Quick Whiskey' }));
    await waitFor(() => expect(screen.queryByLabelText('Quantity')).toBeNull());
  });

  it('keeps clock and inventory controls wired to their API operations', async () => {
    const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Clock in' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clock out' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Inventory' }));
    expect(await screen.findByText('Quick Whiskey')).toBeTruthy();
    expect(screen.getByText('Showing 1–1 of 1')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/inventory?page=1&pageSize=25'))).toBe(true);
  });

  it('submits reviewed item-level returns through the refund API', async () => {
    const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Return' }));
    await user.type(await screen.findByLabelText('Manager PIN'), '2468');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(await screen.findByRole('button', { name: /ORD-1/ }));
    await user.clear(await screen.findByLabelText('Return quantity for Quick Whiskey'));
    await user.type(screen.getByLabelText('Return quantity for Quick Whiskey'), '1');
    await user.selectOptions(screen.getByLabelText('Disposition for Quick Whiskey'), 'DAMAGED');
    await user.type(screen.getByLabelText('Return reason'), 'Customer return');
    await user.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await waitFor(() => expect(screen.getByText(/Return completed/)).toBeTruthy());
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith('/orders/order-1/refund') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ reason: 'Customer return', items: [{ orderItemId: 'item-1', quantity: 1, disposition: 'DAMAGED' }] });
    expect((call?.[1]?.headers as Record<string, string>)['x-rjpos-elevation']).toBe('elevation-token');
  });
});
