import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  paymentAttemptStatuses,
  type PaymentAttemptStatus,
  type TerminalPaymentCommand,
  type TerminalPaymentProvider,
  type TerminalPaymentResult,
} from '../src/index.js';

describe('provider-neutral payment contracts', () => {
  it('exposes the complete Phase 0 payment-attempt state registry', () => {
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
  });

  it('keeps commands, results, and provider operations provider-neutral', () => {
    expectTypeOf<TerminalPaymentCommand>().toEqualTypeOf<{
      attemptId: string;
      amountMinor: string;
      currency: 'USD';
      idempotencyKey: string;
    }>();
    expectTypeOf<TerminalPaymentResult['status']>().toEqualTypeOf<
      'SUCCEEDED' | 'DECLINED' | 'CANCELLED' | 'UNKNOWN' | 'FAILED'
    >();
    expectTypeOf<keyof TerminalPaymentProvider>().toEqualTypeOf<
      'authorize' | 'cancel' | 'getStatus' | 'refund'
    >();
    expectTypeOf<'provider' extends keyof TerminalPaymentCommand ? true : false>().toEqualTypeOf<false>();
  });
});
