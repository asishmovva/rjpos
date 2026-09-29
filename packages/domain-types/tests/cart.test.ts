import { describe, expect, it } from 'vitest';
import {
  addScannedVariant,
  calculateCartTotals,
  calculateChangeDue,
} from '../src/index.js';

describe('cart calculations', () => {
  it('increments an existing line when the same variant is scanned again', () => {
    const once = addScannedVariant([], { variantId: 'v1', name: 'Bottle' });
    const twice = addScannedVariant(once, { variantId: 'v1', name: 'Bottle' });
    expect(twice).toEqual([
      { variantId: 'v1', name: 'Bottle', quantity: 2 },
    ]);
  });
  it('calculates integer subtotals, discounts, tax, and totals', () => {
    expect(
      calculateCartTotals({
        taxRateBasisPoints: 625,
        lines: [
          {
            variantId: 'taxable',
            unitPriceMinor: 1_099n,
            quantity: 2,
            taxable: true,
            discount: { kind: 'PERCENTAGE', basisPoints: 1_000 },
          },
          {
            variantId: 'exempt',
            unitPriceMinor: 500n,
            quantity: 1,
            taxable: false,
          },
        ],
        orderDiscount: { kind: 'FIXED', amountMinor: 100n },
      }),
    ).toEqual({
      lines: [
        {
          variantId: 'taxable',
          quantity: 2,
          unitPriceMinor: 1_099n,
          subtotalMinor: 2_198n,
          discountMinor: 299n,
          taxRateBasisPoints: 625,
          taxMinor: 119n,
          totalMinor: 2_018n,
        },
        {
          variantId: 'exempt',
          quantity: 1,
          unitPriceMinor: 500n,
          subtotalMinor: 500n,
          discountMinor: 21n,
          taxRateBasisPoints: 0,
          taxMinor: 0n,
          totalMinor: 479n,
        },
      ],
      subtotalMinor: 2_698n,
      discountMinor: 320n,
      taxMinor: 119n,
      totalMinor: 2_497n,
    });
  });

  it('rounds half-up at minor-unit tax boundaries', () => {
    expect(
      calculateCartTotals({
        taxRateBasisPoints: 500,
        lines: [
          {
            variantId: 'round-down',
            unitPriceMinor: 9n,
            quantity: 1,
            taxable: true,
          },
          {
            variantId: 'round-up',
            unitPriceMinor: 10n,
            quantity: 1,
            taxable: true,
          },
        ],
      }).lines.map((line) => line.taxMinor),
    ).toEqual([0n, 1n]);
  });

  it('caps discounts at zero payable and rejects invalid inputs', () => {
    expect(
      calculateCartTotals({
        taxRateBasisPoints: 625,
        lines: [
          {
            variantId: 'item',
            unitPriceMinor: 100n,
            quantity: 1,
            taxable: true,
          },
        ],
        orderDiscount: { kind: 'FIXED', amountMinor: 500n },
      }).totalMinor,
    ).toBe(0n);
    expect(() =>
      calculateCartTotals({
        taxRateBasisPoints: 625,
        lines: [
          {
            variantId: 'item',
            unitPriceMinor: 100n,
            quantity: 0,
            taxable: true,
          },
        ],
      }),
    ).toThrow('QUANTITY_INVALID');
  });

  it('calculates change and rejects insufficient or negative tender', () => {
    expect(calculateChangeDue(1_299n, 2_000n)).toBe(701n);
    expect(() => calculateChangeDue(1_299n, 1_000n)).toThrow(
      'INSUFFICIENT_TENDER',
    );
    expect(() => calculateChangeDue(1_299n, -1n)).toThrow(
      'TENDERED_MUST_BE_NONNEGATIVE',
    );
  });
});
