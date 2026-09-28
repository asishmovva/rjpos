import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  HttpTerminalProvider,
  paymentAttemptStatuses,
  SimulatedTerminalProvider,
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

describe('real terminal HTTP adapter boundary', () => {
  it('maps network uncertainty to UNKNOWN without retrying or exposing credentials', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const provider = new HttpTerminalProvider({ endpoint: 'https://terminal.example.test', token: 'secret-token', timeoutMilliseconds: 10 }, fetcher);
    await expect(provider.authorize({ attemptId: 'a1', amountMinor: '100', currency: 'USD', idempotencyKey: 'k1' })).resolves.toEqual({ status: 'UNKNOWN', failureCode: 'PROVIDER_UNREACHABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires HTTPS and credentials', () => {
    expect(() => new HttpTerminalProvider({ endpoint: 'http://terminal.example.test', token: 'x' })).toThrow('TERMINAL_ENDPOINT_HTTPS_REQUIRED');
    expect(() => new HttpTerminalProvider({ endpoint: 'https://terminal.example.test', token: '' })).toThrow('TERMINAL_CREDENTIAL_REQUIRED');
  });
});

describe('simulated terminal provider', () => {
  const expected = {
    APPROVED: 'SUCCEEDED',
    DECLINED: 'DECLINED',
    CANCELLED: 'CANCELLED',
    TIMEOUT: 'UNKNOWN',
    UNKNOWN: 'UNKNOWN',
    NETWORK_LOST: 'UNKNOWN',
    DUPLICATE_CALLBACK: 'SUCCEEDED',
    LATE_CALLBACK: 'UNKNOWN',
  } as const;

  it.each(Object.entries(expected))(
    'models %s without provider-specific fields',
    async (outcome, status) => {
      const provider = new SimulatedTerminalProvider(
        outcome as keyof typeof expected,
      );
      const result = await provider.authorize({
        attemptId: 'attempt-1',
        amountMinor: '1299',
        currency: 'USD',
        idempotencyKey: `key-${outcome}`,
      });
      expect(result.status).toBe(status);
      expect(provider.authorizeCallCount).toBe(1);
    },
  );

  it('deduplicates submissions and exposes duplicate callbacks safely', async () => {
    const provider = new SimulatedTerminalProvider('DUPLICATE_CALLBACK');
    const command = {
      attemptId: 'attempt-duplicate',
      amountMinor: '500',
      currency: 'USD' as const,
      idempotencyKey: 'same-key',
    };
    const first = await provider.authorize(command);
    const second = await provider.authorize(command);
    expect(second).toEqual(first);
    expect(provider.authorizeCallCount).toBe(1);
    expect(provider.callbackResults).toEqual([first, first]);
  });

  it('does not retry uncertain outcomes and supports explicit late callback', async () => {
    const provider = new SimulatedTerminalProvider('LATE_CALLBACK');
    const initial = await provider.authorize({
      attemptId: 'attempt-late',
      amountMinor: '500',
      currency: 'USD',
      idempotencyKey: 'late-key',
    });
    expect(initial).toEqual({ status: 'UNKNOWN', failureCode: 'LATE_CALLBACK' });
    expect(provider.authorizeCallCount).toBe(1);
    expect(provider.callbackResults).toHaveLength(0);
    expect(provider.deliverLateCallback('attempt-late')).toEqual({
      status: 'SUCCEEDED',
      providerTransactionId: 'sim-attempt-late',
    });
  });
});
