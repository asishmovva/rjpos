import { describe, expect, it } from 'vitest';
import { moneySchema, requestIdSchema } from '../src/index.js';

describe('API contracts', () => {
  it('accepts JSON-safe USD minor-unit amounts', () => {
    for (const amountMinor of ['0', '1', '9007199254740993']) {
      const money = moneySchema.parse({ amountMinor, currency: 'USD' });
      expect(JSON.parse(JSON.stringify(money))).toEqual({
        amountMinor,
        currency: 'USD',
      });
    }
  });

  it('rejects invalid money representations', () => {
    for (const money of [
      { amountMinor: -1, currency: 'USD' },
      { amountMinor: '-1', currency: 'USD' },
      { amountMinor: '1.00', currency: 'USD' },
      { amountMinor: '01', currency: 'USD' },
      { amountMinor: '100', currency: 'EUR' },
    ]) {
      expect(moneySchema.safeParse(money).success).toBe(false);
    }
  });

  it('enforces nonempty bounded request identifiers', () => {
    expect(requestIdSchema.parse('request-123')).toBe('request-123');
    expect(requestIdSchema.safeParse('').success).toBe(false);
    expect(requestIdSchema.safeParse('x'.repeat(129)).success).toBe(false);
  });
});
