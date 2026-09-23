export type Currency = 'USD';

export type Money = {
  amountMinor: bigint;
  currency: Currency;
};

export const orderStatuses = [
  'DRAFT',
  'PENDING_PAYMENT',
  'COMPLETED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'VOIDED',
] as const;
export type OrderStatus = (typeof orderStatuses)[number];

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

export {
  addScannedVariant,
  calculateCartTotals,
  calculateChangeDue,
  type CartDiscount,
  type CartLineInput,
  type CartTotals,
} from './cart.js';
