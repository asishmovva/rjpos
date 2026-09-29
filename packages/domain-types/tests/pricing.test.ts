import { describe, expect, it } from 'vitest';
import { applyVendorDeals, baseUnitsConsumed, calculateCartTotals, effectiveCost, priceMetrics, reviewInvoiceLine, reviewInvoiceTotals, suggestRetailPrice, unitCostFromCase } from '../src/index.js';

describe('case → unit costing', () => {
  it('turns a $180 case of 12 into $15.00 per unit and rounds odd splits to the cent', () => {
    expect(unitCostFromCase(18_000n, 12)).toBe(1_500n);
    expect(unitCostFromCase(17_000n, 12)).toBe(1_417n);
    expect(unitCostFromCase(1_000n, 3)).toBe(333n);
    expect(() => unitCostFromCase(1_000n, 0)).toThrow('UNITS_PER_CASE_INVALID');
    expect(() => unitCostFromCase(-1n, 6)).toThrow('CASE_COST_INVALID');
  });
});

describe('margin and markup are different calculations', () => {
  it('markup adds a percentage of cost; margin is a percentage of the resulting price', () => {
    expect(suggestRetailPrice(1_500n, 'MARKUP', 1_900)).toBe(1_785n); // $17.85
    expect(suggestRetailPrice(1_500n, 'MARGIN', 1_900)).toBe(1_852n); // $18.52
    const markup = priceMetrics(1_500n, suggestRetailPrice(1_500n, 'MARKUP', 3_333));
    expect(markup.markupBasisPoints).toBe(3_333);
    const margin = priceMetrics(1_500n, suggestRetailPrice(1_500n, 'MARGIN', 2_500));
    expect(margin.marginBasisPoints).toBe(2_500);
    expect(() => suggestRetailPrice(1_500n, 'MARGIN', 10_000)).toThrow('MARGIN_MUST_BE_BELOW_100');
  });
  it('recomputes profit, margin, and markup for a manual price', () => {
    expect(priceMetrics(1_500n, 1_999n)).toEqual({ profitMinor: 499n, marginBasisPoints: 2_496, markupBasisPoints: 3_327 });
    expect(priceMetrics(1_500n, 1_200n)).toEqual({ profitMinor: -300n, marginBasisPoints: -2_500, markupBasisPoints: -2_000 });
    expect(priceMetrics(0n, 500n).markupBasisPoints).toBeNull();
    expect(priceMetrics(500n, 0n).marginBasisPoints).toBeNull();
  });
});

describe('pack conversion', () => {
  it('computes base units consumed by a pack sale', () => {
    expect(baseUnitsConsumed(1, 1)).toBe(1);
    expect(baseUnitsConsumed(2, 6)).toBe(12);
    expect(baseUnitsConsumed(3, 24)).toBe(72);
    expect(() => baseUnitsConsumed(0, 6)).toThrow('QUANTITY_INVALID');
    expect(() => baseUnitsConsumed(1, 0)).toThrow('UNITS_PER_PACK_INVALID');
  });
});

describe('vendor deals and effective cost', () => {
  it('base − discount − rebate = effective case cost, then ÷ units for the unit cost', () => {
    const cost = effectiveCost({ baseCaseCostMinor: 18_000n, unitsPerCase: 12, discountPerCaseMinor: 1_000n, rebatePerCaseMinor: 0n });
    expect(cost).toMatchObject({ payableCaseCostMinor: 17_000n, effectiveCaseCostMinor: 17_000n, effectiveUnitCostMinor: 1_417n });
    const rebated = effectiveCost({ baseCaseCostMinor: 18_000n, unitsPerCase: 12, discountPerCaseMinor: 1_000n, rebatePerCaseMinor: 600n });
    expect(rebated).toMatchObject({ payableCaseCostMinor: 17_000n, effectiveCaseCostMinor: 16_400n, effectiveUnitCostMinor: 1_367n });
    expect(() => effectiveCost({ baseCaseCostMinor: 1_000n, unitsPerCase: 6, discountPerCaseMinor: 900n, rebatePerCaseMinor: 200n })).toThrow('DEALS_EXCEED_CASE_COST');
  });
  it('applies $ off per case, case-price deals, quantity breaks, and rebates without losing the original components', () => {
    const base = { baseCaseCostMinor: 18_000n, unitsPerCase: 12 };
    expect(applyVendorDeals({ ...base, cases: 1, deals: [{ kind: 'DISCOUNT_PER_CASE', amountMinor: 1_000n }] })).toMatchObject({ baseCaseCostMinor: 18_000n, discountPerCaseMinor: 1_000n, effectiveCaseCostMinor: 17_000n });
    expect(applyVendorDeals({ ...base, cases: 1, deals: [{ kind: 'DEAL_CASE_PRICE', dealCaseCostMinor: 16_500n }] })).toMatchObject({ discountPerCaseMinor: 1_500n, effectiveCaseCostMinor: 16_500n });
    expect(applyVendorDeals({ ...base, cases: 1, deals: [{ kind: 'DEAL_CASE_PRICE', dealCaseCostMinor: 19_000n }] })).toMatchObject({ discountPerCaseMinor: 0n });
    const qty = { kind: 'QUANTITY_BREAK' as const, amountMinor: 500n, minimumCases: 5 };
    expect(applyVendorDeals({ ...base, cases: 4, deals: [qty] }).discountPerCaseMinor).toBe(0n);
    expect(applyVendorDeals({ ...base, cases: 5, deals: [qty] }).discountPerCaseMinor).toBe(500n);
    expect(applyVendorDeals({ ...base, cases: 1, deals: [{ kind: 'DISCOUNT_PER_CASE', amountMinor: 1_000n }, { kind: 'REBATE', amountMinor: 400n }] })).toMatchObject({ payableCaseCostMinor: 17_000n, effectiveCaseCostMinor: 16_600n });
  });
});

describe('invoice line and total review', () => {
  it('shows the worked example: 5 cases of 12 at $180 with $10 off → $170 case, $14.17 unit, 60 units', () => {
    const review = reviewInvoiceLine({ cases: 5, unitsPerCase: 12, baseCaseCostMinor: 18_000n, unitCostMinor: 1_500n, discountPerCaseMinor: 1_000n, lineTotalMinor: 85_000n });
    expect(review).toMatchObject({ cases: 5, unitsPerCase: 12, baseCaseCostMinor: 18_000n, discountPerCaseMinor: 1_000n, effectiveCaseCostMinor: 17_000n, effectiveUnitCostMinor: 1_417n, totalUnits: 60, calculatedLineTotalMinor: 85_000n });
    expect(review.discrepancies).toEqual([]);
    // A discounted invoice matches the vendor's list cost when its base case cost is unchanged.
    expect(reviewInvoiceLine({ cases: 5, unitsPerCase: 12, baseCaseCostMinor: 18_000n, unitCostMinor: 1_500n, discountPerCaseMinor: 1_000n, lineTotalMinor: 85_000n, mappingUnitCostMinor: 1_500n, mappingUnitsPerCase: 12, poUnitCostMinor: 1_417n }).discrepancies).toEqual([]);
  });
  it('flags line total, PO cost, vendor cost, received cases, and units-per-case disagreements', () => {
    const review = reviewInvoiceLine({ cases: 5, unitsPerCase: 12, baseCaseCostMinor: 18_000n, unitCostMinor: 1_500n, discountPerCaseMinor: 1_000n, lineTotalMinor: 90_000n, casesReceived: 4, poUnitCostMinor: 1_300n, mappingUnitCostMinor: 1_400n, mappingUnitsPerCase: 24 });
    expect(review.totalUnits).toBe(48);
    expect(review.discrepancies.map((item) => item.code).sort()).toEqual(['CASES_RECEIVED_DIFFER', 'LINE_TOTAL_MISMATCH', 'PO_COST_MISMATCH', 'UNITS_PER_CASE_MISMATCH', 'VENDOR_COST_MISMATCH']);
  });
  it('reconciles header subtotal and total (rebates are not part of the invoice amount)', () => {
    expect(reviewInvoiceTotals({ lineTotalsMinor: [85_000n, 12_000n], subtotalMinor: 97_000n, discountMinor: 2_000n, taxMinor: 500n, feesMinor: 300n, totalMinor: 95_800n }).discrepancies).toEqual([]);
    const bad = reviewInvoiceTotals({ lineTotalsMinor: [85_000n, 12_000n], subtotalMinor: 96_000n, taxMinor: 500n, totalMinor: 99_999n });
    expect(bad.discrepancies.map((item) => item.code)).toEqual(['SUBTOTAL_MISMATCH', 'TOTAL_MISMATCH']);
  });
});

describe('tax profile rates per cart line', () => {
  const lines = [
    { variantId: 'std', unitPriceMinor: 1_000n, quantity: 1, taxable: true, taxRateBasisPoints: 662 },
    { variantId: 'none', unitPriceMinor: 1_000n, quantity: 1, taxable: true, taxRateBasisPoints: 0 },
    { variantId: 'tobacco', unitPriceMinor: 1_000n, quantity: 2, taxable: true, taxRateBasisPoints: 3_000 },
  ];
  it('applies each line’s own profile rate in a mixed cart and records the rate on the line', () => {
    const totals = calculateCartTotals({ taxRateBasisPoints: 662, lines });
    expect(totals.lines.map((line) => [line.variantId, line.taxRateBasisPoints, line.taxMinor])).toEqual([['std', 662, 66n], ['none', 0, 0n], ['tobacco', 3_000, 600n]]);
    expect(totals.taxMinor).toBe(666n);
    expect(totals.totalMinor).toBe(4_000n + 666n);
  });
  it('taxes discounted amounts and falls back to the cart rate when no profile rate is given', () => {
    const totals = calculateCartTotals({ taxRateBasisPoints: 1_000, lines: [{ variantId: 'a', unitPriceMinor: 1_000n, quantity: 1, taxable: true, taxRateBasisPoints: 500, discount: { kind: 'FIXED', amountMinor: 200n } }, { variantId: 'b', unitPriceMinor: 1_000n, quantity: 1, taxable: true }, { variantId: 'c', unitPriceMinor: 1_000n, quantity: 1, taxable: false }] });
    expect(totals.lines.map((line) => [line.taxRateBasisPoints, line.taxMinor])).toEqual([[500, 40n], [1_000, 100n], [0, 0n]]);
    expect(() => calculateCartTotals({ taxRateBasisPoints: 100, lines: [{ variantId: 'x', unitPriceMinor: 1n, quantity: 1, taxable: true, taxRateBasisPoints: 10_001 }] })).toThrow('TAX_RATE_INVALID');
  });
});
