export {};
declare global {
  interface Window {
    rjpos?: {
      hardwareStatus(): Promise<{ scanner: string; printer: string; drawer: string; terminal: string }>;
      printReceipt(orderId: string, sessionToken?: string): Promise<{ ok: boolean; message: string }>;
      testPrinter(): Promise<{ ok: boolean; message: string }>;
      openDrawer(request: { reason?: string; orderId?: string; elevationToken?: string; sessionToken?: string }): Promise<{ ok: boolean; message: string }>;
    };
  }
}
