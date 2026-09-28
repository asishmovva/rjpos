import { describe, expect, it, vi } from 'vitest';
import { CallbackReceiptPrinter, SimulatedCashDrawer, UnavailableCashDrawer } from '../src/hardware-adapters.js';

const receipt = { orderNumber: 'R-1', storeName: 'Store', totalMinor: '100', currency: 'USD', lines: [{ label: 'Item', quantity: 1, totalMinor: '100' }] };
describe('Electron hardware adapters', () => {
  it('reports simulated printer/drawer operations without exposing Node to the renderer', async () => {
    const operation = vi.fn(async () => undefined); const printer = new CallbackReceiptPrinter('simulated', operation); const drawer = new SimulatedCashDrawer();
    await expect(printer.print(receipt)).resolves.toMatchObject({ ok: true, status: 'simulated' }); expect(operation).toHaveBeenCalledWith(receipt);
    await expect(drawer.open()).resolves.toMatchObject({ ok: true }); expect(drawer.opens).toBe(1);
  });
  it('returns controlled unavailable and retryable printer failures', async () => {
    await expect(new UnavailableCashDrawer().open()).resolves.toMatchObject({ ok: false, code: 'DRAWER_UNAVAILABLE' });
    await expect(new CallbackReceiptPrinter('ready', async () => { throw new Error('offline'); }).print(receipt)).resolves.toMatchObject({ ok: false, code: 'PRINTER_FAILED', retryable: true });
  });
});
