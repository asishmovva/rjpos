// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Register from '../app/page.js';
import { signInAs } from './session.js';
import { adjustmentToDiscount, parseDollarsToMinor, parsePercentToBasisPoints } from '../app/register-api.js';

const item = { variantId: 'variant-1', productName: 'Quick Whiskey', variantName: '750 ml', sku: 'QUICK-1', barcode: '012345678905', priceMinor: '3999', active: true, ageRestricted: false };
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;
type Call = { url: string; init?: RequestInit; body: Record<string, unknown> };
let calls: Call[] = [];
const bodyOf = (url: string) => calls.filter((call) => call.url.endsWith(url)).map((call) => call.body);
const headerOf = (call: Call, name: string) => (call.init?.headers as Record<string, string>)[name];
const quoteFor = (body: { lines: Array<{ quantity: number; discount?: { kind: string; amountMinor?: string; basisPoints?: number } }> }) => {
  const discount = body.lines[0]!.discount; const subtotal = 3999 * body.lines[0]!.quantity;
  const off = !discount ? 0 : discount.kind === 'FIXED' ? Number(discount.amountMinor) : Math.round(subtotal * discount.basisPoints! / 10000);
  return { subtotalMinor: String(subtotal), discountMinor: String(off), taxMinor: '0', totalMinor: String(subtotal - off), lines: [{ variantId: 'variant-1', unitPriceMinor: '3999', quantity: body.lines[0]!.quantity, subtotalMinor: String(subtotal), discountMinor: String(off), taxMinor: '0', totalMinor: String(subtotal - off), promotionName: null }] };
};

describe('Register runtime workflows', () => {
  beforeEach(() => {
    signInAs();
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url, ...(init ? { init } : {}), body });
      if (url.endsWith('/workforce/current')) return response(null);
      if (url.endsWith('/register-sessions/current')) return response(null);
      if (url.endsWith('/register-sessions/open')) return response({ id: 'session-1' });
      if (url.endsWith('/store/current')) return response({ taxRateBasisPoints: 0 });
      if (url.endsWith('/quick-keys')) return response([{ ...item, id: 'key-1', label: 'Whiskey', groupName: 'Popular', position: 0 }]);
      if (url.endsWith('/checkout/quote')) return response(quoteFor(body as never));
      if (url.endsWith('/checkout/cash')) return response({ orderId: 'order-1' });
      if (url.endsWith('/orders/order-1/receipt')) return response({ id: 'order-1', orderNumber: 'ORD-1', subtotalMinor: '3999', discountMinor: '0', taxMinor: '0', totalMinor: '3999', items: [] });
      if (url.endsWith('/auth/approvers')) return response([{ id: 'manager-1', name: 'Demo Manager', role: 'MANAGER' }]);
      if (url.endsWith('/auth/elevate')) return response({ token: 'elevation-token', expiresAt: new Date(Date.now() + 300_000).toISOString(), approver: { id: 'manager-1', name: 'Demo Manager', role: 'MANAGER' } });
      if (url.endsWith('/customers') && init?.method === 'POST') return response({ id: 'customer-1', name: 'Sam Rivera', email: null, phone: '5551234' });
      if (url.endsWith('/customers/customer-1')) return response({ id: 'customer-1', name: 'Sam Rivera', email: null, phone: '5551234', pointsBalance: 0 });
      if (url.includes('/report')) return response({ sessionId: 'session-1', status: 'CLOSED', openedAt: new Date().toISOString(), closedAt: new Date().toISOString(), durationMinutes: 125, openingCashMinor: '10000', expectedCashMinor: '10000', countedCashMinor: '9900', differenceMinor: '-100' });
      if (url.includes('/register-sessions/session-1/close')) return response({ id: 'session-1', status: 'CLOSED' });
      return response([]);
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

  async function openRegister(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Open register' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Open register' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }
  async function approve(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText('Manager PIN'), '2468');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByLabelText('Manager PIN')).toBeNull());
  }

  it('opens the register with a validated amount and an optional note', async () => {
    const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Open register' }));
    const dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Opening cash')); await user.type(within(dialog).getByLabelText('Opening cash'), '150.50');
    await user.click(within(dialog).getByRole('button', { name: 'Open register' }));
    await waitFor(() => expect(bodyOf('/register-sessions/open')[0]).toEqual({ openingCashMinor: '15050' }));
    expect(headerOf(calls.find((call) => call.url.endsWith('/register-sessions/open'))!, 'x-rjpos-session')).toBe('session-token');
  });

  it('applies a percentage discount after manager approval and sends the elevation token at checkout', async () => {
    const user = userEvent.setup(); render(<Register />); await openRegister(user);
    await user.click(await screen.findByRole('button', { name: /Whiskey/ }));
    await user.click(screen.getByRole('button', { name: 'Discount / Price' })); await approve(user);
    await user.type(await screen.findByLabelText('Discount value'), '10');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(bodyOf('/checkout/quote').at(-1)).toMatchObject({ orderDiscount: { kind: 'PERCENTAGE', basisPoints: 1000 } }));
    await user.click(screen.getByRole('button', { name: 'CASH' }));
    await waitFor(() => expect(bodyOf('/checkout/cash')).toHaveLength(1));
    const checkout = calls.find((call) => call.url.endsWith('/checkout/cash'))!;
    expect(checkout.body).toMatchObject({ orderDiscount: { kind: 'PERCENTAGE', basisPoints: 1000 } });
    expect(checkout.body).not.toHaveProperty('overrideReason');
    expect(headerOf(checkout, 'x-rjpos-elevation')).toBe('elevation-token');
  });

  it('supports a dollar discount and a custom price, and rejects a custom price above the current price', async () => {
    const user = userEvent.setup(); render(<Register />); await openRegister(user);
    await user.click(await screen.findByRole('button', { name: /Whiskey/ }));
    await user.click(screen.getByRole('button', { name: 'Discount / Price' })); await approve(user);
    await user.click(await screen.findByRole('tab', { name: '$ off' }));
    await user.type(screen.getByLabelText('Discount value'), '3.25'); await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(bodyOf('/checkout/quote').at(-1)).toMatchObject({ orderDiscount: { kind: 'FIXED', amountMinor: '325' } }));
    await user.click(screen.getByRole('button', { name: 'Discount / Price' }));
    await user.selectOptions(await screen.findByLabelText('Discount target'), 'variant-1');
    await user.click(screen.getByRole('tab', { name: 'Custom price' }));
    await user.type(screen.getByLabelText('Discount value'), '45'); await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be higher');
    await user.clear(screen.getByLabelText('Discount value')); await user.type(screen.getByLabelText('Discount value'), '31.99'); await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(bodyOf('/checkout/quote').at(-1)).toMatchObject({ lines: [{ variantId: 'variant-1', quantity: 1, discount: { kind: 'FIXED', amountMinor: '800' } }] }));
  });

  it('creates a customer from the register and selects it immediately', async () => {
    const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Customer' }));
    await user.click(await screen.findByRole('button', { name: 'New customer' }));
    await user.type(screen.getByLabelText('Customer name'), 'Sam Rivera'); await user.type(screen.getByLabelText('Customer phone'), '5551234');
    await user.click(screen.getByRole('button', { name: 'Save and select customer' }));
    await waitFor(() => expect(bodyOf('/customers')[0]).toEqual({ name: 'Sam Rivera', phone: '5551234' }));
    expect(await screen.findByRole('button', { name: /Sam Rivera/ })).toBeTruthy();
  });

  it('closes the shift with counted cash and shows cashiers only the reconciliation summary', async () => {
    const user = userEvent.setup(); render(<Register />); await openRegister(user);
    await user.click(screen.getByRole('button', { name: 'End Shift' }));
    await user.type(await screen.findByLabelText('Counted cash'), '99.00');
    await user.click(screen.getByRole('button', { name: 'Close register and clock out' }));
    expect(await screen.findByText('Expected cash')).toBeTruthy();
    expect(bodyOf('/register-sessions/session-1/close')[0]).toEqual({ countedCashMinor: '9900' });
    expect(screen.queryByLabelText('Detailed shift report')).toBeNull();
    expect(screen.getByRole('button', { name: 'Manager: detailed report' })).toBeTruthy();
  });

  it('formats money and percentages without floating point', () => {
    expect(parseDollarsToMinor('3.25')).toBe(325n); expect(parseDollarsToMinor('$31.99')).toBe(3199n); expect(parseDollarsToMinor('.5')).toBe(50n);
    expect(parseDollarsToMinor('-1')).toBeNull(); expect(parseDollarsToMinor('1.999')).toBeNull(); expect(parseDollarsToMinor('')).toBeNull();
    expect(parsePercentToBasisPoints('10%')).toBe(1000); expect(parsePercentToBasisPoints('12.5')).toBe(1250); expect(parsePercentToBasisPoints('101')).toBeNull();
    expect(adjustmentToDiscount({ mode: 'price', priceMinor: 3199n }, 3999n, 2)).toEqual({ kind: 'FIXED', amountMinor: '1600' });
  });
});
