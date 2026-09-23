import { describe, expect, expectTypeOf, it } from 'vitest';
import { eventTypes, type EventType } from '../src/index.js';

describe('event contract registry', () => {
  it('exposes the stable Phase 0 producer/consumer event names', () => {
    expect(eventTypes).toEqual([
      'SALE_COMPLETED',
      'SALE_VOIDED',
      'REFUND_COMPLETED',
      'REGISTER_OPENED',
      'REGISTER_CLOSED',
      'PRODUCT_CREATED',
      'INVENTORY_CHANGED',
    ]);
    expect(new Set(eventTypes).size).toBe(eventTypes.length);
  });

  it('round-trips event names through JSON without changing the contract', () => {
    expect(JSON.parse(JSON.stringify(eventTypes))).toEqual(eventTypes);
    expectTypeOf<EventType>().toEqualTypeOf<(typeof eventTypes)[number]>();
  });
});
