export const paymentAttemptStatuses = [
  'CREATED',
  'PROCESSING',
  'SUCCEEDED',
  'DECLINED',
  'CANCELLED',
  'UNKNOWN',
  'FAILED',
] as const;
export type PaymentAttemptStatus = (typeof paymentAttemptStatuses)[number];

export type TerminalPaymentCommand = {
  attemptId: string;
  amountMinor: string;
  currency: 'USD';
  idempotencyKey: string;
};

export type TerminalPaymentResult = {
  status: 'SUCCEEDED' | 'DECLINED' | 'CANCELLED' | 'UNKNOWN' | 'FAILED';
  providerTransactionId?: string;
  failureCode?: string;
};

export interface TerminalPaymentProvider {
  authorize(command: TerminalPaymentCommand): Promise<TerminalPaymentResult>;
  cancel(
    attemptId: string,
    idempotencyKey: string,
  ): Promise<TerminalPaymentResult>;
  getStatus(
    attemptId: string,
    providerTransactionId?: string,
  ): Promise<TerminalPaymentResult>;
  refund(
    providerTransactionId: string,
    amountMinor: string,
    idempotencyKey: string,
  ): Promise<TerminalPaymentResult>;
}
