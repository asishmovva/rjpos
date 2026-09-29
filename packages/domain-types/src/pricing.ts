/**
 * Purchasing, costing, and pricing arithmetic. Everything is integer minor units (cents) or integer basis points
 * (1 bp = 0.01%). Rounding is half-up on non-negative values. Purchase cost, standard retail price, and special
 * (channel) prices are separate concepts and are never derived from each other implicitly.
 */

export type PricingMode = 'MARKUP' | 'MARGIN';

const BASIS = 10_000n;

function assertMinor(value: bigint, code: string): void {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(code);
}
function assertPositiveInt(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}
/** Half-up division for a non-negative numerator and positive denominator. */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('DIVISOR_INVALID');
  return (numerator * 2n + denominator) / (2n * denominator);
}

/** $180.00 per case of 12 → $15.00 per unit. Unit costs are rounded to the cent; the case cost stays the source of truth. */
export function unitCostFromCase(caseCostMinor: bigint, unitsPerCase: number): bigint {
  assertMinor(caseCostMinor, 'CASE_COST_INVALID');
  assertPositiveInt(unitsPerCase, 'UNITS_PER_CASE_INVALID');
  return divideRounded(caseCostMinor, BigInt(unitsPerCase));
}

export type CostBreakdown = {
  baseCaseCostMinor: bigint;
  /** Invoice/deal discount off the case price (reduces what is paid). */
  discountPerCaseMinor: bigint;
  /** Rebate or allowance received afterwards (reduces effective cost but not the invoice amount). */
  rebatePerCaseMinor: bigint;
  /** base − discount: what the invoice charges per case. */
  payableCaseCostMinor: bigint;
  /** base − discount − rebate: the true cost per case. */
  effectiveCaseCostMinor: bigint;
  unitsPerCase: number;
  effectiveUnitCostMinor: bigint;
};

export function effectiveCost(input: { baseCaseCostMinor: bigint; unitsPerCase: number; discountPerCaseMinor?: bigint; rebatePerCaseMinor?: bigint }): CostBreakdown {
  const discountPerCaseMinor = input.discountPerCaseMinor ?? 0n;
  const rebatePerCaseMinor = input.rebatePerCaseMinor ?? 0n;
  assertMinor(input.baseCaseCostMinor, 'CASE_COST_INVALID');
  assertMinor(discountPerCaseMinor, 'DISCOUNT_INVALID');
  assertMinor(rebatePerCaseMinor, 'REBATE_INVALID');
  assertPositiveInt(input.unitsPerCase, 'UNITS_PER_CASE_INVALID');
  if (discountPerCaseMinor + rebatePerCaseMinor > input.baseCaseCostMinor) throw new Error('DEALS_EXCEED_CASE_COST');
  const payableCaseCostMinor = input.baseCaseCostMinor - discountPerCaseMinor;
  const effectiveCaseCostMinor = payableCaseCostMinor - rebatePerCaseMinor;
  return { baseCaseCostMinor: input.baseCaseCostMinor, discountPerCaseMinor, rebatePerCaseMinor, payableCaseCostMinor, effectiveCaseCostMinor,
    unitsPerCase: input.unitsPerCase, effectiveUnitCostMinor: unitCostFromCase(effectiveCaseCostMinor, input.unitsPerCase) };
}

/**
 * Suggested retail price for a desired percentage.
 * MARKUP: percent of COST added on top (price = cost × (1 + p)).
 * MARGIN: gross margin percent of PRICE (price = cost ÷ (1 − p)); must be below 100%.
 */
export function suggestRetailPrice(unitCostMinor: bigint, mode: PricingMode, percentBasisPoints: number): bigint {
  assertMinor(unitCostMinor, 'UNIT_COST_INVALID');
  if (!Number.isSafeInteger(percentBasisPoints) || percentBasisPoints < 0) throw new Error('PERCENT_INVALID');
  const bp = BigInt(percentBasisPoints);
  if (mode === 'MARKUP') return divideRounded(unitCostMinor * (BASIS + bp), BASIS);
  if (bp >= BASIS) throw new Error('MARGIN_MUST_BE_BELOW_100');
  return divideRounded(unitCostMinor * BASIS, BASIS - bp);
}

export type PriceMetrics = {
  profitMinor: bigint;
  /** Gross margin: profit ÷ price, in basis points (null when price is 0). */
  marginBasisPoints: number | null;
  /** Markup: profit ÷ cost, in basis points (null when cost is 0). */
  markupBasisPoints: number | null;
};

/** Cost $15.00, price $19.99 → profit $4.99, margin 24.96%, markup 33.27%. Profit may be negative when selling below cost. */
export function priceMetrics(unitCostMinor: bigint, priceMinor: bigint): PriceMetrics {
  assertMinor(unitCostMinor, 'UNIT_COST_INVALID');
  assertMinor(priceMinor, 'PRICE_INVALID');
  const profitMinor = priceMinor - unitCostMinor;
  const ratio = (numerator: bigint, denominator: bigint): number | null => {
    if (denominator === 0n) return null;
    const magnitude = divideRounded((numerator < 0n ? -numerator : numerator) * BASIS, denominator);
    return Number(numerator < 0n ? -magnitude : magnitude);
  };
  return { profitMinor, marginBasisPoints: ratio(profitMinor, priceMinor), markupBasisPoints: ratio(profitMinor, unitCostMinor) };
}

/** Base units taken out of inventory when selling `quantity` of a pack (a 6-pack of a single bottle consumes 6). */
export function baseUnitsConsumed(quantity: number, unitsPerPack: number): number {
  assertPositiveInt(quantity, 'QUANTITY_INVALID');
  assertPositiveInt(unitsPerPack, 'UNITS_PER_PACK_INVALID');
  const total = quantity * unitsPerPack;
  if (!Number.isSafeInteger(total)) throw new Error('QUANTITY_INVALID');
  return total;
}

export type InvoiceDiscrepancy = {
  code: 'LINE_TOTAL_MISMATCH' | 'PO_COST_MISMATCH' | 'VENDOR_COST_MISMATCH' | 'CASES_RECEIVED_DIFFER' | 'UNITS_PER_CASE_MISMATCH';
  message: string;
  expectedMinor?: bigint;
  actualMinor?: bigint;
};

export type InvoiceLineReview = CostBreakdown & {
  cases: number;
  totalUnits: number;
  calculatedLineTotalMinor: bigint;
  discrepancies: InvoiceDiscrepancy[];
};

/** Recomputes an invoice line from its case economics and flags anything that disagrees with the document, PO, or vendor mapping. */
export function reviewInvoiceLine(input: {
  cases: number;
  unitsPerCase: number;
  /** Case price as printed; when absent it is derived from the unit cost. */
  baseCaseCostMinor?: bigint | null;
  unitCostMinor: bigint;
  discountPerCaseMinor?: bigint;
  rebatePerCaseMinor?: bigint;
  lineTotalMinor: bigint;
  casesReceived?: number | null;
  poUnitCostMinor?: bigint | null;
  mappingUnitCostMinor?: bigint | null;
  mappingUnitsPerCase?: number | null;
}): InvoiceLineReview {
  assertPositiveInt(input.cases, 'CASES_INVALID');
  const base = input.baseCaseCostMinor ?? input.unitCostMinor * BigInt(input.unitsPerCase);
  const cost = effectiveCost({ baseCaseCostMinor: base, unitsPerCase: input.unitsPerCase,
    ...(input.discountPerCaseMinor === undefined ? {} : { discountPerCaseMinor: input.discountPerCaseMinor }),
    ...(input.rebatePerCaseMinor === undefined ? {} : { rebatePerCaseMinor: input.rebatePerCaseMinor }) });
  const receivedCases = input.casesReceived ?? input.cases;
  const calculatedLineTotalMinor = cost.payableCaseCostMinor * BigInt(input.cases);
  const discrepancies: InvoiceDiscrepancy[] = [];
  if (calculatedLineTotalMinor !== input.lineTotalMinor) discrepancies.push({ code: 'LINE_TOTAL_MISMATCH', message: 'Cases × case cost (after discount) does not equal the printed line total.', expectedMinor: calculatedLineTotalMinor, actualMinor: input.lineTotalMinor });
  if (input.casesReceived !== undefined && input.casesReceived !== null && input.casesReceived !== input.cases) discrepancies.push({ code: 'CASES_RECEIVED_DIFFER', message: `Ordered ${input.cases} cases but ${input.casesReceived} received.` });
  if (input.poUnitCostMinor !== undefined && input.poUnitCostMinor !== null && input.poUnitCostMinor !== cost.effectiveUnitCostMinor && input.poUnitCostMinor !== unitCostFromCase(cost.payableCaseCostMinor, input.unitsPerCase)) discrepancies.push({ code: 'PO_COST_MISMATCH', message: 'Invoice unit cost differs from the purchase order.', expectedMinor: input.poUnitCostMinor, actualMinor: cost.effectiveUnitCostMinor });
  if (input.mappingUnitCostMinor !== undefined && input.mappingUnitCostMinor !== null && input.mappingUnitCostMinor !== unitCostFromCase(cost.baseCaseCostMinor, input.unitsPerCase)) discrepancies.push({ code: 'VENDOR_COST_MISMATCH', message: 'Invoice case cost (before discounts) differs from the current vendor cost.', expectedMinor: input.mappingUnitCostMinor, actualMinor: unitCostFromCase(cost.baseCaseCostMinor, input.unitsPerCase) });
  if (input.mappingUnitsPerCase !== undefined && input.mappingUnitsPerCase !== null && input.mappingUnitsPerCase !== input.unitsPerCase) discrepancies.push({ code: 'UNITS_PER_CASE_MISMATCH', message: `Invoice says ${input.unitsPerCase} units per case; vendor mapping says ${input.mappingUnitsPerCase}.` });
  return { ...cost, cases: input.cases, totalUnits: receivedCases * input.unitsPerCase, calculatedLineTotalMinor, discrepancies };
}

export type InvoiceTotalsReview = {
  linesSubtotalMinor: bigint;
  expectedTotalMinor: bigint | null;
  discrepancies: Array<{ code: 'SUBTOTAL_MISMATCH' | 'TOTAL_MISMATCH'; message: string; expectedMinor: bigint; actualMinor: bigint }>;
};

/** Header reconciliation: Σ line totals = subtotal, and subtotal − discounts + tax + fees = total. Rebates are not on the invoice amount. */
export function reviewInvoiceTotals(input: { lineTotalsMinor: bigint[]; subtotalMinor?: bigint | null; discountMinor?: bigint | null; taxMinor?: bigint | null; feesMinor?: bigint | null; totalMinor?: bigint | null }): InvoiceTotalsReview {
  const linesSubtotalMinor = input.lineTotalsMinor.reduce((sum, value) => sum + value, 0n);
  const discrepancies: InvoiceTotalsReview['discrepancies'] = [];
  const subtotal = input.subtotalMinor ?? null;
  if (subtotal !== null && subtotal !== linesSubtotalMinor) discrepancies.push({ code: 'SUBTOTAL_MISMATCH', message: 'The printed subtotal does not equal the sum of the line totals.', expectedMinor: linesSubtotalMinor, actualMinor: subtotal });
  const base = subtotal ?? linesSubtotalMinor;
  const expectedTotalMinor = input.totalMinor === undefined || input.totalMinor === null ? null : base - (input.discountMinor ?? 0n) + (input.taxMinor ?? 0n) + (input.feesMinor ?? 0n);
  if (expectedTotalMinor !== null && input.totalMinor !== undefined && input.totalMinor !== null && expectedTotalMinor !== input.totalMinor) discrepancies.push({ code: 'TOTAL_MISMATCH', message: 'Subtotal − discounts + tax + fees does not equal the printed total.', expectedMinor: expectedTotalMinor, actualMinor: input.totalMinor });
  return { linesSubtotalMinor, expectedTotalMinor, discrepancies };
}

export type VendorDealInput = {
  kind: 'DISCOUNT_PER_CASE' | 'DEAL_CASE_PRICE' | 'QUANTITY_BREAK' | 'REBATE' | 'ALLOWANCE';
  amountMinor?: bigint | null;
  dealCaseCostMinor?: bigint | null;
  minimumCases?: number | null;
};

/**
 * Applies active vendor deals to a base case cost for an order of `cases`.
 * DISCOUNT_PER_CASE / QUANTITY_BREAK reduce the payable price, DEAL_CASE_PRICE replaces it (only if lower), and
 * REBATE / ALLOWANCE reduce effective cost after payment. Original components are returned for history.
 */
export function applyVendorDeals(input: { baseCaseCostMinor: bigint; unitsPerCase: number; cases: number; deals: VendorDealInput[] }): CostBreakdown {
  let discount = 0n; let rebate = 0n; let dealPrice: bigint | null = null;
  for (const deal of input.deals) {
    if (deal.minimumCases && input.cases < deal.minimumCases) continue;
    if (deal.kind === 'DEAL_CASE_PRICE' && deal.dealCaseCostMinor !== undefined && deal.dealCaseCostMinor !== null && deal.dealCaseCostMinor < input.baseCaseCostMinor) dealPrice = dealPrice === null || deal.dealCaseCostMinor < dealPrice ? deal.dealCaseCostMinor : dealPrice;
    else if ((deal.kind === 'DISCOUNT_PER_CASE' || deal.kind === 'QUANTITY_BREAK') && deal.amountMinor) discount += deal.amountMinor;
    else if ((deal.kind === 'REBATE' || deal.kind === 'ALLOWANCE') && deal.amountMinor) rebate += deal.amountMinor;
  }
  if (dealPrice !== null) discount = input.baseCaseCostMinor - dealPrice + (discount > 0n ? discount : 0n);
  const capped = discount > input.baseCaseCostMinor ? input.baseCaseCostMinor : discount;
  const cappedRebate = rebate > input.baseCaseCostMinor - capped ? input.baseCaseCostMinor - capped : rebate;
  return effectiveCost({ baseCaseCostMinor: input.baseCaseCostMinor, unitsPerCase: input.unitsPerCase, discountPerCaseMinor: capped, rebatePerCaseMinor: cappedRebate });
}
