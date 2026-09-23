export interface BarcodeScanner {
  scan(): Promise<string>;
}
export interface ReceiptPrinter {
  print(receipt: unknown): Promise<void>;
}
export interface CashDrawer {
  open(): Promise<void>;
}
export interface CustomerDisplay {
  show(message: string): Promise<void>;
}
