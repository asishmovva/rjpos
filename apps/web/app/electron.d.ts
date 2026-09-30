export {};
declare global {
  interface Window {
    rjpos?: {
      hardwareStatus(): Promise<{ scanner: string; printer: string; drawer: string; terminal: string }>;
      printReceipt(orderId: string, sessionToken?: string): Promise<{ ok: boolean; message: string }>;
      toggleCustomerDisplay(): Promise<{ ok: boolean; open?: boolean; external?: boolean }>;
      printLabels(document: unknown): Promise<{ ok: boolean; message: string; code?: string }>;
      testPrinter(): Promise<{ ok: boolean; message: string }>;
      openDrawer(request: { reason?: string; orderId?: string; elevationToken?: string; sessionToken?: string }): Promise<{ ok: boolean; message: string }>;
    };
  }
}
