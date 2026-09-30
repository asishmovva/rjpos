// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from '../app/admin/page.js';
import DayClosePage from '../app/admin/day-close/page.js';
import Register from '../app/page.js';
import { signInAs } from './session.js';

const response = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
type Call = { url: string; method: string; body: Record<string, unknown>; headers: Record<string, string> };
let calls: Call[] = [];

const totals = (overrides: Record<string, unknown> = {}) => ({ storeName: 'Downtown', businessDate: '2026-09-30', timezone: 'America/New_York', generatedAt: '2026-09-30T20:00:00Z', transactionCount: 7,
  grossSalesMinor: '30000', discountsMinor: '1000', refundsMinor: '2000', netSalesMinor: '27000', taxMinor: '1800', totalCollectedMinor: '30800', refundCount: 1, voids: { count: 1, totalMinor: '500' },
  tenders: { cashMinor: '12000', cardMinor: '18000', giftCardMinor: '800', otherMinor: '0' }, cash: { cashSalesMinor: '12000', cashRefundsMinor: '2000', paidInMinor: '500', paidOutMinor: '300', safeDropsMinor: '5000', adjustmentsNetMinor: '0', drawerOpens: 3 },
  registerDifferenceMinor: '-100', registerSessions: [{ registerName: 'Front', status: 'CLOSED', openedAt: '2026-09-30T13:00:00Z', closedAt: '2026-09-30T21:00:00Z', expectedCashMinor: '10000', countedCashMinor: '9900', differenceMinor: '-100' }],
  openRegisters: [] as unknown[], ...overrides });

function stub(handler: (url: string, method: string, body: Record<string, unknown>) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method, body, headers: (init?.headers ?? {}) as Record<string, string> });
    return response(handler(url, method, body) ?? {});
  }));
}
beforeEach(() => { calls = []; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('Register cash operations', () => {
  const registerApi = (url: string) => {
    if (url.endsWith('/register-sessions/current')) return { id: 'session-1', status: 'OPEN' };
    if (url.endsWith('/workforce/current')) return null;
    if (url.endsWith('/store/current')) return { taxRateBasisPoints: 0, name: 'Downtown' };
    if (url.endsWith('/auth/approvers')) return [{ id: 'manager-1', name: 'Demo Manager', role: 'MANAGER' }];
    if (url.endsWith('/auth/elevate')) return { token: 'elevation-token', expiresAt: new Date(Date.now() + 300_000).toISOString(), approver: { id: 'manager-1', name: 'Demo Manager', role: 'MANAGER' } };
    return [];
  };
  it('lets a cashier record a safe drop directly but needs manager approval for paid out', async () => {
    signInAs('CASHIER'); stub(registerApi); const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Cash / Drawer' }));
    await user.click(screen.getByRole('tab', { name: 'Safe drop' }));
    await user.type(screen.getByLabelText('Cash amount'), '50.00');
    await user.click(screen.getByRole('button', { name: 'Record safe drop' }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/register/cash-movements'))?.body).toEqual({ kind: 'SAFE_DROP', amountMinor: '5000' }));
    expect(calls.find((call) => call.url.endsWith('/register/cash-movements'))!.headers['x-rjpos-elevation']).toBeUndefined();
    await user.click(await screen.findByRole('button', { name: 'Cash / Drawer' }));
    await user.click(screen.getByRole('tab', { name: 'Paid out' }));
    expect((screen.getByRole('button', { name: 'Record paid out' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Cash amount'), '3.00'); await user.type(screen.getByLabelText('Cash reason'), 'Ice delivery');
    await user.click(screen.getByRole('button', { name: 'Record paid out' }));
    await user.type(await screen.findByLabelText('Manager PIN'), '2468'); await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/register/cash-movements'))).toHaveLength(2));
    const paidOut = calls.filter((call) => call.url.endsWith('/register/cash-movements'))[1]!;
    expect(paidOut.body).toEqual({ kind: 'PAID_OUT', amountMinor: '300', reason: 'Ice delivery' });
    expect(paidOut.headers['x-rjpos-elevation']).toBe('elevation-token');
  });
  it('does not ask a signed-in manager for a second approval', async () => {
    signInAs('MANAGER'); stub(registerApi); const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Cash / Drawer' })); await user.click(screen.getByRole('tab', { name: 'Adjust −' }));
    await user.type(screen.getByLabelText('Cash amount'), '1.00'); await user.type(screen.getByLabelText('Cash reason'), 'Count fix');
    await user.click(screen.getByRole('button', { name: 'Record adjust −' }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/register/cash-movements'))?.body).toEqual({ kind: 'ADJUSTMENT_OUT', amountMinor: '100', reason: 'Count fix' }));
    expect(screen.queryByLabelText('Manager PIN')).toBeNull();
  });
});

describe('End of day (Z report) page', () => {
  it('warns about open registers, requires acknowledgement, and finalizes once', async () => {
    let finalized = false;
    stub((url, method) => {
      if (url.endsWith('/admin/stores')) return [{ id: 'store-1', name: 'Downtown', taxRateBasisPoints: 662 }];
      if (url.includes('/day-close/preview')) return finalized ? { finalized: { id: 'close-1', closedAt: '2026-09-30T22:00:00Z' }, totals: totals() } : { finalized: null, totals: totals({ openRegisters: [{ registerName: 'Front', status: 'OPEN', openedAt: '2026-09-30T13:00:00Z' }] }) };
      if (url.includes('/admin/day-close') && method === 'POST') { finalized = true; return { id: 'close-1', businessDate: '2026-09-30', totals: totals() }; }
      if (url.includes('/admin/day-close')) return [];
      return {};
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    const user = userEvent.setup(); render(<DayClosePage />);
    const report = await screen.findByLabelText('Z report');
    expect(within(report).getByText('Net sales').nextElementSibling?.textContent).toBe('$270.00');
    expect(within(report).getByText('Register differences').nextElementSibling?.textContent).toBe('-$1.00');
    expect(screen.getByRole('alert').textContent).toContain('1 register is still open');
    const finalize = screen.getByRole('button', { name: 'Finalize day' }) as HTMLButtonElement;
    expect(finalize.disabled).toBe(true);
    await user.click(screen.getByRole('checkbox')); expect(finalize.disabled).toBe(false);
    await user.click(finalize);
    await waitFor(() => expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/admin/day-close'))?.body).toMatchObject({ storeId: 'store-1', acknowledgeOpenRegisters: true }));
    expect(await screen.findByText(/This stored report is read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finalize day' })).toBeNull();
  });
});

describe('Admin navigation', () => {
  it('resets the main content scroll to the top when switching sections', async () => {
    stub((url) => {
      if (url.endsWith('/admin/dashboard')) return { salesMinor: '0', transactions: 0, refundMinor: '0', averageTransactionMinor: '0', openRegisters: 0, lowStockProducts: 0, topProducts: [], outstandingPurchaseOrders: 0 };
      if (url.endsWith('/admin/stores')) return [];
      return { items: [], page: 1, pageSize: 25, total: 0 };
    });
    const user = userEvent.setup(); const { container } = render(<AdminPage />);
    await screen.findByText('Net sales');
    const main = container.querySelector('.admin-main') as HTMLElement; const nav = container.querySelector('.admin-nav') as HTMLElement;
    main.scrollTop = 600; nav.scrollTop = 120;
    await user.click(screen.getByRole('button', { name: 'Categories' }));
    await waitFor(() => expect(main.scrollTop).toBe(0));
    expect(nav.scrollTop).toBe(120);
  });
});
