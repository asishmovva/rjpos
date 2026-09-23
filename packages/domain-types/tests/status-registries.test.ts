import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  orderStatuses,
  paymentAttemptStatuses,
  type Money,
  type OrderStatus,
  type PaymentAttemptStatus,
} from '../src/index.js';

describe('domain status registries', () => {
  it('exposes the complete Phase 0 order lifecycle without duplicates', () => {
    expect(orderStatuses).toEqual([
      'DRAFT',
      'PENDING_PAYMENT',
      'COMPLETED',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'VOIDED',
    ]);
    expect(new Set(orderStatuses).size).toBe(orderStatuses.length);
    expectTypeOf<OrderStatus>().toEqualTypeOf<(typeof orderStatuses)[number]>();
  });

  it('exposes the complete payment-attempt lifecycle and money types', () => {
    expect(paymentAttemptStatuses).toEqual([
      'CREATED',
      'PROCESSING',
      'SUCCEEDED',
      'DECLINED',
      'CANCELLED',
      'UNKNOWN',
      'FAILED',
    ]);
    expect(new Set(paymentAttemptStatuses).size).toBe(
      paymentAttemptStatuses.length,
    );
    expectTypeOf<PaymentAttemptStatus>().toEqualTypeOf<
      (typeof paymentAttemptStatuses)[number]
    >();
    expectTypeOf<Money>().toEqualTypeOf<{
      amountMinor: bigint;
      currency: 'USD';
    }>();
  });
});
