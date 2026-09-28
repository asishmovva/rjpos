import type { CashDrawer, HardwareResult, HardwareState, ReceiptDocument, ReceiptPrinter } from '@rjpos/hardware-contracts';

export class UnavailableCashDrawer implements CashDrawer {
  async status(): Promise<HardwareState> { return 'unavailable'; }
  async open(): Promise<HardwareResult> { return { ok: false, status: 'unavailable', code: 'DRAWER_UNAVAILABLE', message: 'Cash drawer is not configured.', retryable: false }; }
}
export class SimulatedCashDrawer implements CashDrawer {
  opens = 0;
  async status(): Promise<HardwareState> { return 'simulated'; }
  async open(): Promise<HardwareResult> { this.opens += 1; return { ok: true, status: 'simulated', message: 'Cash drawer open was simulated.' }; }
}
export class CallbackReceiptPrinter implements ReceiptPrinter {
  constructor(private readonly mode: HardwareState, private readonly operation: (receipt: ReceiptDocument) => Promise<void>) {}
  async status(): Promise<HardwareState> { return this.mode; }
  async print(receipt: ReceiptDocument): Promise<HardwareResult> {
    try { await this.operation(receipt); return { ok: true, status: this.mode, message: this.mode === 'simulated' ? 'Receipt print was simulated.' : 'Receipt sent to printer.' }; }
    catch (error) { return { ok: false, status: 'error', code: 'PRINTER_FAILED', message: error instanceof Error ? error.message : 'Receipt printing failed.', retryable: true }; }
  }
}
