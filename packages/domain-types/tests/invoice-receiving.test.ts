import { describe, expect, it } from 'vitest';
import { assessCostChange, compareOrderInvoiceReceipt, normalizeVendorLabel, reconcileInvoice, resolveLineEconomics, resolveQuantities } from '../src/index.js';

describe('vendor label normalization', () => {
  it('maps different distributors\' printed labels to the same canonical fields and flags ambiguous ones', () => {
    expect(normalizeVendorLabel('BTL/COST')).toMatchObject({ field: 'netUnitCost', scope: 'unit' });
    expect(normalizeVendorLabel('Net Bottle Cost')).toMatchObject({ field: 'netUnitCost', scope: 'unit' });
    expect(normalizeVendorLabel('NET CASE COST')).toMatchObject({ field: 'netCaseCost', scope: 'case' });
    expect(normalizeVendorLabel('UNIT POST OFF')).toMatchObject({ field: 'postOff', scope: 'unit' });
    expect(normalizeVendorLabel('UNIT QTY DISCOUNT')).toMatchObject({ field: 'qtyDiscount', scope: 'unit' });
    expect(normalizeVendorLabel('GROSS AMT.')).toMatchObject({ field: 'grossLine' });
    expect(normalizeVendorLabel('PROD NO.')).toMatchObject({ field: 'vendorItem' });
    expect(normalizeVendorLabel('PRICE')).toMatchObject({ ambiguous: true });
    expect(normalizeVendorLabel('Unit Case Cost')).toMatchObject({ ambiguous: true });
    expect(normalizeVendorLabel('SOMETHING NEW')).toBeNull();
    expect(normalizeVendorLabel('SOMETHING NEW', { 'something new': { field: 'rebate', scope: 'case' } })).toMatchObject({ field: 'rebate' });
  });
});

describe('line economics (layouts differ, canonical result is the same)', () => {
  it('layout A: list case, post-off, no quantity discount → net case and net bottle cost, base never overwritten', () => {
    const line = resolveLineEconomics({ unitsPerCase: 12, cases: 2, listCaseMinor: 18_948n, postOffPerCaseMinor: 5_640n, qtyDiscountPerCaseMinor: 0n, netUnitMinor: 1_109n, printedExtendedMinor: 26_616n });
    expect(line).toMatchObject({ baseCaseMinor: 18_948n, discountPerCaseMinor: 5_640n, netCaseMinor: 13_308n, netUnitMinor: 1_109n, extendedMinor: 26_616n });
    expect(line.warnings).toEqual([]);
  });
  it('layout B: gross amount and a whole-line discount spread across cases', () => {
    const line = resolveLineEconomics({ unitsPerCase: 6, cases: 4, listCaseMinor: 12_000n, lineDiscountMinor: 8_000n, printedExtendedMinor: 40_000n });
    expect(line).toMatchObject({ discountPerCaseMinor: 2_000n, netCaseMinor: 10_000n, extendedMinor: 40_000n });
  });
  it('layout C: only bottle cost printed; unit-scope discounts convert to cases; allowance reduces effective but not net', () => {
    const line = resolveLineEconomics({ unitsPerCase: 24, cases: 1, unitListMinor: 1_000n, postOffPerCaseMinor: 24n * 100n, rebatePerCaseMinor: 480n });
    expect(line).toMatchObject({ baseCaseMinor: 24_000n, netCaseMinor: 21_600n, rebatePerCaseMinor: 480n, effectiveCaseMinor: 21_120n, netUnitMinor: 900n, effectiveUnitMinor: 880n });
  });
  it('derives the base from a printed net plus discount, and reports printed values that disagree', () => {
    expect(resolveLineEconomics({ unitsPerCase: 12, cases: 1, netCaseMinor: 13_308n, postOffPerCaseMinor: 5_640n }).baseCaseMinor).toBe(18_948n);
    const bad = resolveLineEconomics({ unitsPerCase: 12, cases: 2, listCaseMinor: 18_948n, postOffPerCaseMinor: 5_640n, netCaseMinor: 13_000n, netUnitMinor: 1_000n, printedExtendedMinor: 99n });
    expect(bad.warnings.map((warning) => warning.code)).toEqual(['NET_CASE_MISMATCH', 'NET_UNIT_MISMATCH', 'EXTENDED_MISMATCH']);
    expect(resolveLineEconomics({ unitsPerCase: 12, cases: 1 }).warnings[0]?.code).toBe('NO_BASE_COST');
  });
});

describe('quantities and pack conversion', () => {
  it('converts cases × pack into base units and posts only sellable units (23 of 24 when one bottle breaks)', () => {
    const result = resolveQuantities({ unitsPerCase: 12, casesShipped: 2, unitsBroken: 1 });
    expect(result).toMatchObject({ invoicedUnits: 24, receivedUnits: 24, damagedUnits: 1, sellableUnits: 23, variance: 'EXACT', fulfillment: 'RECEIVED' });
  });
  it('handles partial receiving with a backorder, shortages, overages, rejected cases, loose and bonus bottles', () => {
    expect(resolveQuantities({ unitsPerCase: 12, casesOrdered: 2, casesShipped: 2, casesReceived: 1, casesBackordered: 1 })).toMatchObject({ receivedUnits: 12, shortUnits: 12, backorderedUnits: 12, variance: 'SHORT', fulfillment: 'PARTIAL', orderedUnits: 24 });
    expect(resolveQuantities({ unitsPerCase: 12, casesShipped: 1, casesReceived: 2 })).toMatchObject({ overUnits: 12, variance: 'OVER' });
    expect(resolveQuantities({ unitsPerCase: 6, casesShipped: 3, casesReceived: 3, casesRejected: 1 })).toMatchObject({ rejectedUnits: 6, sellableUnits: 12 });
    expect(resolveQuantities({ unitsPerCase: 12, casesShipped: 1, looseUnitsReceived: 3, bonusUnits: 2 })).toMatchObject({ receivedUnits: 17, sellableUnits: 17 });
    expect(resolveQuantities({ unitsPerCase: 12, casesShipped: 2, casesReceived: 0, casesBackordered: 2 }).fulfillment).toBe('BACKORDERED');
    expect(resolveQuantities({ unitsPerCase: 12, casesShipped: 2, casesReceived: 0 }).fulfillment).toBe('OUT_OF_STOCK');
  });
  it('flags impossible damage or rejection and rejects bad input', () => {
    expect(resolveQuantities({ unitsPerCase: 12, casesShipped: 1, unitsDamaged: 20 }).issues[0]?.code).toBe('DAMAGE_EXCEEDS_RECEIVED');
    expect(() => resolveQuantities({ unitsPerCase: 0, casesShipped: 1 })).toThrow('UNITS_PER_CASE_INVALID');
    expect(() => resolveQuantities({ unitsPerCase: 12, casesShipped: -1 })).toThrow('CASES_INVALID');
  });
});

describe('invoice reconciliation', () => {
  it('matches net lines + charges + tax + deposit − credit against the printed total', () => {
    const result = reconcileInvoice({ lineExtendedMinor: [26_616n, 10_000n], chargesMinor: 1_500n, taxMinor: 300n, depositMinor: 200n, creditMinor: 1_000n, invoiceTotalMinor: 37_616n });
    expect(result).toMatchObject({ calculatedTotalMinor: 37_616n, differenceMinor: 0n, status: 'MATCH' });
  });
  it('treats gross lines with header discounts, and classifies minor and material differences', () => {
    expect(reconcileInvoice({ lineExtendedMinor: [50_000n], linesBasis: 'GROSS', headerDiscountsMinor: 5_000n, invoiceTotalMinor: 45_000n }).status).toBe('MATCH');
    expect(reconcileInvoice({ lineExtendedMinor: [10_000n], invoiceTotalMinor: 10_050n }).status).toBe('MINOR_DIFFERENCE');
    expect(reconcileInvoice({ lineExtendedMinor: [10_000n], invoiceTotalMinor: 12_500n })).toMatchObject({ status: 'MATERIAL_DIFFERENCE', differenceMinor: 2_500n });
    expect(reconcileInvoice({ lineExtendedMinor: [10_000n] }).status).toBe('NO_TOTAL');
  });
});

describe('cost change and retail impact', () => {
  it('shows the change, flags significant moves, and computes margins without touching price', () => {
    const change = assessCostChange({ previousCaseMinor: 12_000n, invoiceCaseMinor: 13_300n, unitsPerCase: 12, retailMinor: 1_999n });
    expect(change).toMatchObject({ deltaMinor: 1_300n, deltaBasisPoints: 1083, direction: 'UP', significant: true, previousUnitMinor: 1_000n, newUnitMinor: 1_108n });
    expect(change.previousMarginBasisPoints).toBe(4997); expect(change.newMarginBasisPoints).toBe(4457); expect(change.marginDropBasisPoints).toBe(540);
    expect(assessCostChange({ invoiceCaseMinor: 5_000n, unitsPerCase: 5 }).direction).toBe('NEW');
    expect(assessCostChange({ previousCaseMinor: 5_000n, invoiceCaseMinor: 4_900n, unitsPerCase: 5 })).toMatchObject({ direction: 'DOWN', significant: false });
  });
});

describe('order / invoice / receipt comparison', () => {
  it('flags unexpected, missing, over, short, backordered, and re-priced lines, and exact matches', () => {
    expect(compareOrderInvoiceReceipt({ orderedUnits: null, invoicedUnits: 12, receivedUnits: 12 }).flags).toEqual(['UNEXPECTED_ITEM']);
    expect(compareOrderInvoiceReceipt({ orderedUnits: 24, invoicedUnits: 0, receivedUnits: 0 }).flags).toContain('MISSING_ITEM');
    expect(compareOrderInvoiceReceipt({ orderedUnits: 12, invoicedUnits: 24, receivedUnits: 24 }).flags).toEqual(['OVER_SHIPMENT']);
    expect(compareOrderInvoiceReceipt({ orderedUnits: 24, invoicedUnits: 24, receivedUnits: 12, backorderedUnits: 12, poUnitCostMinor: 1_000n, invoiceUnitCostMinor: 1_100n }).flags).toEqual(['SHORTAGE', 'BACKORDER', 'PRICE_CHANGED']);
    expect(compareOrderInvoiceReceipt({ orderedUnits: 24, invoicedUnits: 24, receivedUnits: 24 }).flags).toEqual(['EXACT']);
  });
});
