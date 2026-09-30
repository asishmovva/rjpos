// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGate } from '../app/admin/admin-gate.js';
import { adminHeaders, saveAdminSession } from '../app/admin/admin-auth.js';
import ImportExportPage from '../app/admin/import-export/page.js';
import LabelsPage from '../app/admin/labels/page.js';

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); saveAdminSession(null); window.sessionStorage.clear(); });

describe('Back-office sign-in gate', () => {
  it('passes through in development and never sends the owner header in production', () => {
    render(<AdminGate><p>Dashboard</p></AdminGate>);
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(adminHeaders()).toEqual({ 'x-rjpos-role': 'OWNER' });
    vi.stubEnv('NEXT_PUBLIC_RJPOS_AUTH_MODE', 'production');
    expect(adminHeaders()['x-rjpos-role']).toBeUndefined();
  });

  it('requires a Manager or Owner PIN in production, rejects cashiers, then sends the session token', async () => {
    vi.stubEnv('NEXT_PUBLIC_RJPOS_AUTH_MODE', 'production');
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const pin = (JSON.parse(String(init?.body)) as { pin: string }).pin;
      if (pin === '1111') return json({ token: 'cashier-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), employee: { id: 'e1', name: 'Casey' }, role: 'CASHIER' });
      if (pin === '1234') return json({ token: 'owner-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), employee: { id: 'e2', name: 'Olive Owner' }, role: 'OWNER' });
      return json({ error: { code: 'LOGIN_PIN_INVALID' } }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup(); render(<AdminGate><p>Dashboard</p></AdminGate>);
    expect(screen.queryByText('Dashboard')).toBeNull();
    await user.type(await screen.findByLabelText('PIN'), '1111'); await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Back office needs a Manager or Owner PIN.')).toBeTruthy();
    expect(screen.queryByText('Dashboard')).toBeNull();
    await user.clear(screen.getByLabelText('PIN')); await user.type(screen.getByLabelText('PIN'), '1234'); await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Dashboard')).toBeTruthy();
    expect(adminHeaders()).toMatchObject({ 'x-rjpos-session': 'owner-token' });
  });
});

describe('Import and export page', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/admin/stores')) return json([{ id: 's1', name: 'Downtown', status: 'ACTIVE', timezone: 'America/New_York', taxRateBasisPoints: 0, receiptFooter: null }]);
      if (url.endsWith('/csv/vendors/preview')) return json({ kind: 'vendors', total: 2, create: 1, update: 0, skip: 0, errors: 1, truncated: false, rows: [{ line: 3, action: 'ERROR', key: '', message: 'Name is required' }, { line: 2, action: 'CREATE', key: 'Acme' }] });
      if (url.endsWith('/csv/vendors/commit')) return json({ importId: 'i1', kind: 'vendors', total: 2, create: 1, update: 0, skip: 0, errors: 1, truncated: false, rows: [] });
      void init; return json([]);
    }));
  });

  it('previews first, blocks commit while rows have errors, and commits valid rows only when chosen', async () => {
    const user = userEvent.setup(); render(<ImportExportPage />);
    await user.click(await screen.findByRole('tab', { name: 'Vendors' }));
    await user.upload(screen.getByLabelText('CSV file'), new File(['name\nAcme\n,'], 'vendors.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: 'Check file' }));
    expect(await screen.findByText('Name is required')).toBeTruthy();
    const commit = screen.getByRole('button', { name: /^Import 1 row$/ }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    await user.click(screen.getByLabelText(/skip the 1 with errors/));
    expect(commit.disabled).toBe(false);
    await user.click(commit);
    expect(await screen.findByText(/Imported: 1 added, 0 updated, 0 unchanged, 1 rejected/)).toBeTruthy();
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/csv/vendors/commit'));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ skipInvalidRows: true });
  });
});

describe('Labels page', () => {
  it('prints through the register label printer and reports its honest result', async () => {
    const printLabels = vi.fn(async () => ({ ok: true, message: 'Label print was simulated; nothing was printed.' }));
    vi.stubGlobal('rjpos', { printLabels }); Object.defineProperty(window, 'rjpos', { value: { printLabels }, configurable: true });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/admin/stores')) return json([{ id: 's1', name: 'Downtown', status: 'ACTIVE', timezone: 'America/New_York', taxRateBasisPoints: 0, receiptFooter: null }]);
      if (url.includes('/admin/products?')) return json({ items: [{ id: 'p1', name: 'Cola', brand: null, active: true, category: { id: 'c1', name: 'Soda', active: true }, variants: [{ id: 'v1', name: 'Each', sku: 'COLA-1', active: true, lowStockThreshold: 0, barcodes: [{ barcodeValue: '012345678905' }] }] }], page: 1, pageSize: 8, total: 1 });
      if (url.includes('/variants/v1/prices')) return json([{ id: 'pr1', amountMinor: '199', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null }]);
      return json([]);
    }));
    const user = userEvent.setup(); render(<LabelsPage />);
    await user.type(await screen.findByLabelText('Search items'), 'cola');
    await user.click(await screen.findByRole('button', { name: 'Cola · Each' }));
    await waitFor(() => expect((screen.getByLabelText('Price Cola') as HTMLInputElement).value).toBe('1.99'));
    await user.click(screen.getByRole('button', { name: 'Print 1 label(s)' }));
    expect(await screen.findByText('Label print was simulated; nothing was printed.')).toBeTruthy();
    expect(printLabels).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SHELF', items: [expect.objectContaining({ name: 'Cola', barcode: '012345678905', priceMinor: '199', copies: 1 })] }));
    Reflect.deleteProperty(window, 'rjpos');
  });
});
