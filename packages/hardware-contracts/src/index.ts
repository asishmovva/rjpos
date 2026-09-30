export type HardwareState = 'ready' | 'simulated' | 'unavailable' | 'error';
export type HardwareResult = { ok: true; status: HardwareState; message: string } | { ok: false; status: 'unavailable' | 'error'; code: string; message: string; retryable: boolean };
export type ReceiptDocument = { orderNumber: string; storeName: string; totalMinor: string; currency: string; lines: Array<{ label: string; quantity: number; totalMinor: string }> };
export interface BarcodeScanner { status(): Promise<HardwareState>; }
export interface ReceiptPrinter { status(): Promise<HardwareState>; print(receipt: ReceiptDocument): Promise<HardwareResult>; }
export interface CashDrawer { status(): Promise<HardwareState>; open(): Promise<HardwareResult>; }
export interface CustomerDisplay { status(): Promise<HardwareState>; show(message: string): Promise<HardwareResult>; }
export type HardwareStatus = { scanner: HardwareState; printer: HardwareState; drawer: HardwareState; terminal: HardwareState };
export * from './labels.js';
