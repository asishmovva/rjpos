export {};
declare global {
  interface Window {
    rjpos?: {
      hardwareStatus(): Promise<{ scanner: string; printer: string; drawer: string; terminal: string }>;
      printReceipt(orderId: string): Promise<{ ok: boolean; message: string }>;
      testPrinter(): Promise<{ ok: boolean; message: string }>;
      openDrawer(request: { reason?: string; orderId?: string }): Promise<{ ok: boolean; message: string }>;
    };
  }
}
