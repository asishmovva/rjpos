// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Register from '../app/page.js';
import { signInAs } from './session.js';

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as Response;
type Call = { url: string; init?: RequestInit; body: Record<string, unknown> };
let calls: Call[] = [];
const sessionHeader = (call: Call) => (call.init?.headers as Record<string, string>)['x-rjpos-session'];

describe('PIN sign-in and sign-out', () => {
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url, ...(init ? { init } : {}), body });
      if (url.endsWith('/auth/login')) return body.pin === '4321'
        ? json({ token: 'signed-session', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), employee: { id: 'employee-7', name: 'Riley Reed' }, role: 'MANAGER' })
        : json({ error: { code: 'LOGIN_PIN_INVALID' } }, 401);
      if (url.endsWith('/register-sessions/current')) return json({ id: 'session-1', status: 'OPEN' });
      if (url.endsWith('/workforce/current')) return json({ id: 'shift-1', clockedOutAt: null });
      if (url.endsWith('/store/current')) return json({ taxRateBasisPoints: 0, name: 'Downtown' });
      if (url.includes('/register-sessions/session-1/close')) return json({ id: 'session-1', status: 'CLOSED' });
      if (url.includes('/report')) return json({ sessionId: 'session-1', status: 'CLOSED', openedAt: new Date().toISOString(), closedAt: new Date().toISOString(), durationMinutes: 60, openingCashMinor: '10000', expectedCashMinor: '10000', countedCashMinor: '10000', differenceMinor: '0' });
      if (url.endsWith('/workforce/clock-out')) return json({ id: 'shift-1', clockedOutAt: new Date().toISOString() });
      return json([]);
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

  it('starts on the PIN screen, rejects a wrong PIN, and signs in through the API with the employee name and role', async () => {
    const user = userEvent.setup(); render(<Register />);
    expect(await screen.findByLabelText('Employee PIN')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open register' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '9' })); await user.click(screen.getByRole('button', { name: '9' })); await user.click(screen.getByRole('button', { name: '9' })); await user.click(screen.getByRole('button', { name: '9' }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not correct');
    await user.type(screen.getByLabelText('Employee PIN'), '4321'); await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Riley Reed')).toBeTruthy();
    expect(screen.getByText(/Manager ·/)).toBeTruthy();
    const login = calls.filter((call) => call.url.endsWith('/auth/login'));
    expect(login.map((call) => call.body.pin)).toEqual(['9999', '4321']);
    expect(login.every((call) => sessionHeader(call) === undefined)).toBe(true);
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/quick-keys') && sessionHeader(call) === 'signed-session')).toBe(true));
  });

  it('lets a signed-in manager use privileged actions without a second PIN prompt', async () => {
    signInAs('MANAGER'); const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Return' }));
    expect(await screen.findByText('Return items')).toBeTruthy();
    expect(screen.queryByLabelText('Manager PIN')).toBeNull();
  });

  it('ends the shift, shows the report, then returns to the PIN screen', async () => {
    signInAs('CASHIER'); const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'End Shift' }));
    await user.type(await screen.findByLabelText('Counted cash'), '100.00');
    await user.click(screen.getByRole('button', { name: 'Close register and clock out' }));
    expect(await screen.findByText('Expected cash')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByLabelText('Employee PIN')).toBeTruthy();
    expect(window.sessionStorage.getItem('rjpos.session')).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/workforce/clock-out'))).toBe(true);
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/auth/logout'))).toBe(true));
  });

  it('locks without ending the shift and needs a PIN to return', async () => {
    signInAs('CASHIER'); const user = userEvent.setup(); render(<Register />);
    await user.click(await screen.findByRole('button', { name: 'Lock' }));
    expect(await screen.findByLabelText('Employee PIN')).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/workforce/clock-out'))).toBe(false);
  });
});
