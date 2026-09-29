// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateBirthDate, latestEligibleBirthDate, todayInZone } from '../app/age.js';
import Register from '../app/page.js';
import { signInAs } from './session.js';

const item = { variantId: 'variant-1', productName: 'Merlot', variantName: '750 ml', sku: 'M-1', barcode: '111', priceMinor: '3199', active: true, ageRestricted: false };
const soda = { ...item, variantId: 'variant-2', productName: 'Soda', sku: 'S-1', barcode: '222', priceMinor: '199', ageRestricted: false };
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;
type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let quickKeys: unknown[] = [];
let lookup: typeof item = item;
const bodyOf = (path: string) => calls.filter((call) => call.url.endsWith(path)).map((call) => call.body);

describe('Cash tender, change due, Quick Add grid, and age check', () => {
  beforeEach(() => {
    signInAs(); calls = []; lookup = item;
    quickKeys = [{ ...item, id: 'key-1', label: 'Merlot', groupName: 'Wine', position: 0 }];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url, body });
      if (url.endsWith('/register-sessions/current')) return response({ id: 'session-1', status: 'OPEN' });
      if (url.endsWith('/workforce/current')) return response(null);
      if (url.endsWith('/store/current')) return response({ taxRateBasisPoints: 0, name: 'Downtown', timezone: 'America/New_York' });
      if (url.endsWith('/quick-keys')) return response(quickKeys);
      if (url.includes('/catalog/lookup?barcode=')) return response([lookup]);
      if (url.endsWith('/checkout/quote')) {
        const lines = (body as { lines: Array<{ variantId: string; quantity: number }> }).lines; const price = (id: string) => (id === 'variant-2' ? 199 : 3199);
        const total = lines.reduce((sum, line) => sum + price(line.variantId) * line.quantity, 0);
        return response({ subtotalMinor: String(total), discountMinor: '0', taxMinor: '0', totalMinor: String(total), lines: lines.map((line) => ({ variantId: line.variantId, unitPriceMinor: String(price(line.variantId)), quantity: line.quantity, subtotalMinor: String(price(line.variantId) * line.quantity), discountMinor: '0', taxMinor: '0', totalMinor: String(price(line.variantId) * line.quantity), promotionName: null })) });
      }
      if (url.endsWith('/checkout/cash')) { const tendered = BigInt(String(body.tenderedMinor)); return response({ orderId: 'order-1', totalMinor: '3199', tenderedMinor: tendered.toString(), changeDueMinor: (tendered - 3199n).toString() }); }
      if (url.endsWith('/checkout/mixed')) return response({ orderId: 'order-1', tenderedMinor: '1000', changeDueMinor: '0' });
      if (url.endsWith('/orders/order-1/receipt')) return response({ id: 'order-1', orderNumber: 'ORD-1', subtotalMinor: '3199', discountMinor: '0', taxMinor: '0', totalMinor: '3199', items: [] });
      return response([]);
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

  async function addMerlot(user: ReturnType<typeof userEvent.setup>) { await user.click(await screen.findByRole('button', { name: /Merlot/ })); await screen.findByLabelText('Quantity'); }
  const changePanel = () => within(screen.getByLabelText('Cash change'));

  it('previews $50 tendered on a $31.99 sale, then shows a large CHANGE DUE popup from the server result', async () => {
    const user = userEvent.setup(); render(<Register />); await addMerlot(user);
    await waitFor(() => expect(changePanel().getByText('Amount due').nextSibling?.textContent).toBe('$31.99'));
    expect(changePanel().getByText('Change due').nextSibling?.textContent).toBe('$0.00');
    await user.click(screen.getByRole('button', { name: '$50' }));
    expect(changePanel().getByText('Tendered').nextSibling?.textContent).toBe('$50.00');
    expect(changePanel().getByText('Change due').nextSibling?.textContent).toBe('$18.01');
    await user.click(screen.getByRole('button', { name: 'CASH' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sale complete' });
    expect(within(dialog).getByText('SALE COMPLETE')).toBeTruthy();
    expect(within(dialog).getByLabelText('Change due').textContent).toBe('$18.01');
    expect(within(dialog).getByText('Cash Tendered').nextSibling?.textContent).toBe('$50.00');
    expect(bodyOf('/checkout/cash')[0]).toMatchObject({ tenderedMinor: '5000' });
    await user.click(within(dialog).getByRole('button', { name: 'DONE / NEXT SALE' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sale complete' })).toBeNull());
    expect(screen.queryByLabelText('Quantity')).toBeNull();
    expect(changePanel().getByText('Tendered').nextSibling?.textContent).toBe('—');
  });

  it('EXACT sets tendered equal to the total; insufficient cash shows what is still due and blocks CASH', async () => {
    const user = userEvent.setup(); render(<Register />); await addMerlot(user);
    await user.click(screen.getByRole('button', { name: '$20' }));
    expect(changePanel().getByText('Still due').nextSibling?.textContent).toBe('$11.99');
    expect((screen.getByRole('button', { name: 'CASH' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'EXACT' }));
    expect(changePanel().getByText('Tendered').nextSibling?.textContent).toBe('$31.99');
    expect(changePanel().getByText('Change due').nextSibling?.textContent).toBe('$0.00');
    await user.click(screen.getByRole('button', { name: 'CASH' }));
    expect(within(await screen.findByRole('dialog', { name: 'Sale complete' })).getByLabelText('Change due').textContent).toBe('$0.00');
    expect(bodyOf('/checkout/cash')[0]).toMatchObject({ tenderedMinor: '3199' });
  });

  it('accepts a custom tender from the keypad with a live change preview', async () => {
    const user = userEvent.setup(); render(<Register />); await addMerlot(user);
    await user.click(screen.getByRole('button', { name: 'Other' }));
    const dialog = await screen.findByRole('dialog');
    for (const key of ['4', '0', '.', '5', '0']) await user.click(within(dialog).getByRole('button', { name: key }));
    expect(within(dialog).getByText('Change due').nextSibling?.textContent).toBe('$8.51');
    await user.click(within(dialog).getByRole('button', { name: 'Use this amount' }));
    expect(changePanel().getByText('Tendered').nextSibling?.textContent).toBe('$40.50');
    await user.click(screen.getByRole('button', { name: 'CASH' }));
    expect(within(await screen.findByRole('dialog', { name: 'Sale complete' })).getByLabelText('Change due').textContent).toBe('$8.51');
  });

  it('shows the cash remainder after gift-card value in split tender and completes with the server result', async () => {
    const user = userEvent.setup(); render(<Register />); await addMerlot(user);
    await user.click(screen.getByRole('button', { name: 'Gift Card' }));
    await user.type(screen.getByLabelText('Gift-card code'), 'RJ-1');
    await user.type(screen.getByLabelText('Gift-card amount'), '21.99');
    await user.click(screen.getByRole('button', { name: 'Apply gift card' }));
    expect(screen.getByRole('button', { name: /Gift card \$21\.99/ })).toBeTruthy();
    expect(changePanel().getByText('Amount due').nextSibling?.textContent).toBe('$10.00');
    await user.click(screen.getByRole('button', { name: 'Split with cash' }));
    expect(within(await screen.findByRole('dialog', { name: 'Sale complete' })).getByLabelText('Change due').textContent).toBe('$0.00');
    expect(bodyOf('/checkout/mixed')[0]).toMatchObject({ remainder: { kind: 'CASH', tenderedMinor: '1000' } });
  });

  it('pages Quick Add as a fixed 6 x 6 grid of 36 buttons', async () => {
    quickKeys = Array.from({ length: 40 }, (_, index) => ({ ...item, variantId: `v-${index}`, id: `key-${index}`, label: `Item ${index + 1}`, groupName: 'All items', position: index }));
    const user = userEvent.setup(); render(<Register />);
    const grid = await screen.findByLabelText('Quick Add'); await within(grid).findByRole('button', { name: /^Item 1\$/ });
    expect(grid.querySelectorAll('.qa-grid > button')).toHaveLength(36);
    expect(grid.querySelectorAll('.qa-grid > *')).toHaveLength(36);
    expect(within(grid).getByText('Page 1 of 2')).toBeTruthy();
    expect((within(grid).getByRole('button', { name: 'Previous Quick Add page' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(grid).getByRole('button', { name: 'Next Quick Add page' }));
    expect(within(grid).getByText('Page 2 of 2')).toBeTruthy();
    expect(grid.querySelectorAll('.qa-grid > button')).toHaveLength(4);
    expect(grid.querySelectorAll('.qa-grid > *')).toHaveLength(36);
    await user.click(within(grid).getByRole('button', { name: /^Item 37\$/ }));
    expect(await screen.findByLabelText('Quantity')).toBeTruthy();
  });

  it('Age Check tool calculates eligibility without storing the date of birth', async () => {
    const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Age Check' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Must be born on or before/).textContent).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    await user.type(within(dialog).getByLabelText('Month'), '01'); await user.type(within(dialog).getByLabelText('Day'), '15'); await user.type(within(dialog).getByLabelText('Year'), '1990');
    expect(within(dialog).getByRole('status').textContent).toBe('');
    await user.click(within(dialog).getByRole('button', { name: 'CHECK AGE' }));
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toMatch(/^ELIGIBLE — Age \d+$/));
    const recent = new Date().getFullYear() - 10;
    await user.clear(within(dialog).getByLabelText('Year')); await user.type(within(dialog).getByLabelText('Year'), String(recent));
    await user.click(within(dialog).getByRole('button', { name: 'CHECK AGE' }));
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toMatch(/^NOT ELIGIBLE — Age \d+$/));
    expect(within(dialog).queryByRole('button', { name: 'CONFIRM AGE CHECK' })).toBeNull();
    expect(calls.every((call) => !JSON.stringify(call.body).includes('1990'))).toBe(true);
  });

  it('asks for an age check only when the cart has age-restricted items, then satisfies checkout verification', async () => {
    quickKeys = [{ ...item, id: 'key-1', label: 'Merlot', groupName: 'Wine', position: 0, ageRestricted: true }, { ...soda, id: 'key-2', label: 'Soda', groupName: 'Mixers', position: 1 }];
    const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: /Soda/ })); await screen.findByLabelText('Quantity');
    expect(screen.queryByText(/21\+ items/)).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'CASH' }));
    await waitFor(() => expect(bodyOf('/checkout/cash')).toHaveLength(1));
    expect(bodyOf('/checkout/cash')[0]).toMatchObject({ ageVerified: false });
    await user.click(await screen.findByRole('button', { name: 'DONE / NEXT SALE' }));
    await user.click(screen.getByRole('button', { name: /Merlot/ })); await screen.findByLabelText('Quantity');
    expect(screen.getByText('21+ items · check age')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'CASH' }));
    const dialog = await screen.findByRole('dialog', { name: 'age utility' });
    await user.type(within(dialog).getByLabelText('Month'), '02'); await user.type(within(dialog).getByLabelText('Day'), '03'); await user.type(within(dialog).getByLabelText('Year'), '1985');
    await user.click(within(dialog).getByRole('button', { name: 'CHECK AGE' }));
    await user.click(await within(dialog).findByRole('button', { name: 'CONFIRM AGE CHECK' }));
    await waitFor(() => expect(bodyOf('/checkout/cash')).toHaveLength(2));
    expect(bodyOf('/checkout/cash')[1]).toMatchObject({ ageVerified: true });
  });
});

describe('age helpers', () => {
  it('computes the latest eligible birth date and ages in the store calendar day', () => {
    expect(latestEligibleBirthDate('2026-09-29')).toBe('2005-09-29');
    expect(latestEligibleBirthDate('2028-02-29')).toBe('2007-02-28');
    expect(evaluateBirthDate({ month: '09', day: '29', year: '2005' }, '2026-09-29')).toEqual({ status: 'ok', age: 21, eligible: true });
    expect(evaluateBirthDate({ month: '09', day: '30', year: '2005' }, '2026-09-29')).toEqual({ status: 'ok', age: 20, eligible: false });
    expect(evaluateBirthDate({ month: '02', day: '30', year: '2000' }, '2026-09-29')).toMatchObject({ status: 'invalid' });
    expect(evaluateBirthDate({ month: '01', day: '01', year: '2030' }, '2026-09-29')).toMatchObject({ status: 'invalid' });
    expect(evaluateBirthDate({ month: '01', day: '', year: '2000' }, '2026-09-29')).toEqual({ status: 'incomplete' });
    expect(todayInZone('Pacific/Kiritimati', new Date('2026-09-29T20:00:00Z'))).toBe('2026-09-30');
    expect(todayInZone('Pacific/Pago_Pago', new Date('2026-09-29T03:00:00Z'))).toBe('2026-09-28');
  });
});
