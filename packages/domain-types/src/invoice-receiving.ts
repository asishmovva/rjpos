import { divideRounded, unitCostFromCase } from './pricing.js';

/**
 * Canonical invoice receiving math. Pure functions over integer minor units; vendor-specific parsing maps INTO these
 * shapes, so nothing here knows what any one distributor calls a column.
 */

// ---- Vendor label normalization ----------------------------------------------------------------------------------------
export type CanonicalField =
  | 'unitList' | 'listCase' | 'baseCase' | 'grossLine' | 'lineDiscount' | 'postOff' | 'qtyDiscount' | 'caseDiscount' | 'promoDiscount' | 'allowance' | 'rebate' | 'otherDiscount'
  | 'netUnitCost' | 'netCaseCost' | 'extendedPrice' | 'rip' | 'vendorItem' | 'size' | 'pack' | 'vintage' | 'cases' | 'bottles' | 'upc' | 'description';
/** unit: the printed amount is per bottle; case: per case; line: for the whole line. */
export type FieldScope = 'unit' | 'case' | 'line' | 'none';
export type LabelMapping = { field: CanonicalField; scope: FieldScope; /** The label means different things on different invoices; always ask a person. */ ambiguous?: boolean };

const squash = (label: string): string => label.toUpperCase().replace(/[.:#]/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();

// Keys are squashed (upper-case, no dots/colons, single spaces). Extend per vendor with `overrides` in normalizeVendorLabel.
const LABELS: Record<string, LabelMapping> = {
  'PRICE': { field: 'listCase', scope: 'case', ambiguous: true },
  'GROSS AMT': { field: 'grossLine', scope: 'line' }, 'GROSS AMOUNT': { field: 'grossLine', scope: 'line' },
  'DISCOUNT': { field: 'lineDiscount', scope: 'line' }, 'DISCOUNT TOTAL': { field: 'lineDiscount', scope: 'line' },
  'BTL/COST': { field: 'netUnitCost', scope: 'unit' }, 'BOTTLE COST': { field: 'netUnitCost', scope: 'unit' }, 'NET BOTTLE COST': { field: 'netUnitCost', scope: 'unit' }, 'NET BTL COST': { field: 'netUnitCost', scope: 'unit' },
  'NET AMT': { field: 'extendedPrice', scope: 'line' }, 'NET AMOUNT': { field: 'extendedPrice', scope: 'line' }, 'EXTENDED PRICE': { field: 'extendedPrice', scope: 'line' }, 'EXTENSION': { field: 'extendedPrice', scope: 'line' }, 'AMOUNT': { field: 'extendedPrice', scope: 'line', ambiguous: true },
  'UNIT LIST': { field: 'unitList', scope: 'unit' }, 'LIST PRICE': { field: 'unitList', scope: 'unit', ambiguous: true },
  'LIST CASE': { field: 'listCase', scope: 'case' }, 'CASE PRICE': { field: 'listCase', scope: 'case' },
  'UNIT POST OFF': { field: 'postOff', scope: 'unit' }, 'POST OFF': { field: 'postOff', scope: 'case' }, 'POST-OFF': { field: 'postOff', scope: 'case' }, 'POSTOFF': { field: 'postOff', scope: 'case' },
  'UNIT QTY DISCOUNT': { field: 'qtyDiscount', scope: 'unit' }, 'QTY DISCOUNT': { field: 'qtyDiscount', scope: 'case' }, 'QUANTITY DISCOUNT': { field: 'qtyDiscount', scope: 'case' },
  'CASE DISCOUNT': { field: 'caseDiscount', scope: 'case' }, 'PROMO DISCOUNT': { field: 'promoDiscount', scope: 'case' }, 'PROMOTIONAL DISCOUNT': { field: 'promoDiscount', scope: 'case' },
  'ALLOWANCE': { field: 'allowance', scope: 'case' }, 'REBATE': { field: 'rebate', scope: 'case' }, 'OTHER DISCOUNT': { field: 'otherDiscount', scope: 'case' },
  'NET CASE COST': { field: 'netCaseCost', scope: 'case' }, 'UNIT CASE COST': { field: 'baseCase', scope: 'case', ambiguous: true }, 'CASE COST': { field: 'baseCase', scope: 'case' },
  'RIP': { field: 'rip', scope: 'none' }, 'R I P': { field: 'rip', scope: 'none' },
  'ITEM': { field: 'vendorItem', scope: 'none' }, 'ITEM NO': { field: 'vendorItem', scope: 'none' }, 'PROD NO': { field: 'vendorItem', scope: 'none' }, 'PRODUCT NO': { field: 'vendorItem', scope: 'none' }, 'SKU': { field: 'vendorItem', scope: 'none' },
  'PRODUCT DESCRIPTION': { field: 'description', scope: 'none' }, 'DESCRIPTION': { field: 'description', scope: 'none' },
  'SIZE': { field: 'size', scope: 'none' }, 'PACK': { field: 'pack', scope: 'none' }, 'PK': { field: 'pack', scope: 'none' }, 'VINTAGE': { field: 'vintage', scope: 'none' },
  'CASE': { field: 'cases', scope: 'none' }, 'CASES': { field: 'cases', scope: 'none' }, 'BOTTLES': { field: 'bottles', scope: 'none' }, 'BOTL': { field: 'bottles', scope: 'none' }, 'BTL': { field: 'bottles', scope: 'none' },
  'UPC': { field: 'upc', scope: 'none' },
};

/** Maps a printed column label to a canonical field, or null when unknown (callers must keep the original label/value). */
export function normalizeVendorLabel(label: string, overrides: Record<string, LabelMapping> = {}): LabelMapping | null {
  const key = squash(label);
  const custom = Object.entries(overrides).find(([name]) => squash(name) === key);
  return custom?.[1] ?? LABELS[key] ?? null;
}

// ---- Line economics ----------------------------------------------------------------------------------------------------
export type LineEconomicsInput = {
  unitsPerCase: number;
  cases: number;
  listCaseMinor?: bigint | null;
  baseCaseMinor?: bigint | null;
  unitListMinor?: bigint | null;
  netCaseMinor?: bigint | null;
  netUnitMinor?: bigint | null;
  /** On-invoice discounts per case. */
  postOffPerCaseMinor?: bigint | null; qtyDiscountPerCaseMinor?: bigint | null; caseDiscountPerCaseMinor?: bigint | null; promoDiscountPerCaseMinor?: bigint | null; otherDiscountPerCaseMinor?: bigint | null;
  /** Whole-line discount; spread across cases when no per-case components were given. */
  lineDiscountMinor?: bigint | null;
  /** After-payment reductions of the true cost (not on the invoice amount). */
  allowancePerCaseMinor?: bigint | null; rebatePerCaseMinor?: bigint | null;
  printedExtendedMinor?: bigint | null;
};
export type LineEconomics = {
  baseCaseMinor: bigint; discountPerCaseMinor: bigint; netCaseMinor: bigint; rebatePerCaseMinor: bigint; effectiveCaseMinor: bigint;
  netUnitMinor: bigint; effectiveUnitMinor: bigint; extendedMinor: bigint;
  components: { postOff: bigint; qty: bigint; caseDiscount: bigint; promo: bigint; other: bigint; allowance: bigint; rebate: bigint };
  warnings: Array<{ code: 'NET_CASE_MISMATCH' | 'NET_UNIT_MISMATCH' | 'EXTENDED_MISMATCH' | 'DISCOUNT_EXCEEDS_BASE' | 'NO_BASE_COST'; message: string }>;
};

const z = (value: bigint | null | undefined): bigint => value ?? 0n;

/**
 * Keeps base cost, each discount, and net cost separate. The base case cost is never replaced by the net cost; the net is derived
 * (or checked against the printed net). Printed values that disagree with the math are reported, not silently trusted.
 */
export function resolveLineEconomics(input: LineEconomicsInput): LineEconomics {
  if (!Number.isSafeInteger(input.unitsPerCase) || input.unitsPerCase < 1) throw new Error('UNITS_PER_CASE_INVALID');
  if (!Number.isSafeInteger(input.cases) || input.cases < 0) throw new Error('CASES_INVALID');
  const upc = BigInt(input.unitsPerCase);
  const warnings: LineEconomics['warnings'] = [];
  const components = { postOff: z(input.postOffPerCaseMinor), qty: z(input.qtyDiscountPerCaseMinor), caseDiscount: z(input.caseDiscountPerCaseMinor), promo: z(input.promoDiscountPerCaseMinor), other: z(input.otherDiscountPerCaseMinor), allowance: z(input.allowancePerCaseMinor), rebate: z(input.rebatePerCaseMinor) };
  let discount = components.postOff + components.qty + components.caseDiscount + components.promo + components.other;
  if (discount === 0n && z(input.lineDiscountMinor) > 0n && input.cases > 0) discount = divideRounded(z(input.lineDiscountMinor), BigInt(input.cases));

  let base = input.listCaseMinor ?? input.baseCaseMinor ?? (input.unitListMinor === null || input.unitListMinor === undefined ? null : input.unitListMinor * upc);
  if (base === null || base === undefined) {
    if (input.netCaseMinor !== null && input.netCaseMinor !== undefined) base = input.netCaseMinor + discount;
    else if (input.netUnitMinor !== null && input.netUnitMinor !== undefined) base = input.netUnitMinor * upc + discount;
  }
  if (base === null || base === undefined) { warnings.push({ code: 'NO_BASE_COST', message: 'No list, base, or net cost was provided for this line.' }); base = 0n; }
  if (discount > base) { warnings.push({ code: 'DISCOUNT_EXCEEDS_BASE', message: 'The discounts are larger than the case price.' }); discount = base; }

  const netCase = base - discount;
  if (input.netCaseMinor !== null && input.netCaseMinor !== undefined && input.netCaseMinor !== netCase) warnings.push({ code: 'NET_CASE_MISMATCH', message: 'The printed net case cost differs from the case price minus discounts.' });
  const netUnit = unitCostFromCase(netCase, input.unitsPerCase);
  if (input.netUnitMinor !== null && input.netUnitMinor !== undefined && input.netUnitMinor !== netUnit) warnings.push({ code: 'NET_UNIT_MISMATCH', message: 'The printed bottle cost differs from the net case cost divided by units per case.' });
  const rebate = components.allowance + components.rebate;
  const effectiveCase = netCase > rebate ? netCase - rebate : 0n;
  const extended = netCase * BigInt(input.cases);
  if (input.printedExtendedMinor !== null && input.printedExtendedMinor !== undefined && input.printedExtendedMinor !== extended) warnings.push({ code: 'EXTENDED_MISMATCH', message: 'Cases × net case cost differs from the printed line amount.' });
  return { baseCaseMinor: base, discountPerCaseMinor: discount, netCaseMinor: netCase, rebatePerCaseMinor: rebate, effectiveCaseMinor: effectiveCase, netUnitMinor: netUnit, effectiveUnitMinor: unitCostFromCase(effectiveCase, input.unitsPerCase), extendedMinor: extended, components, warnings };
}

// ---- Quantities --------------------------------------------------------------------------------------------------------
export type QuantityInput = {
  unitsPerCase: number;
  casesOrdered?: number | null; casesShipped: number; casesReceived?: number | null; casesRejected?: number; casesBackordered?: number;
  looseUnitsReceived?: number; bonusUnits?: number; unitsDamaged?: number; unitsBroken?: number; unitsMissing?: number;
};
export type QuantityResolution = {
  invoicedUnits: number; receivedUnits: number; rejectedUnits: number; damagedUnits: number; sellableUnits: number; backorderedUnits: number; shortUnits: number; overUnits: number;
  orderedUnits: number | null; variance: 'SHORT' | 'OVER' | 'EXACT'; fulfillment: 'RECEIVED' | 'PARTIAL' | 'BACKORDERED' | 'OUT_OF_STOCK';
  issues: Array<{ code: 'DAMAGE_EXCEEDS_RECEIVED' | 'REJECTED_EXCEEDS_RECEIVED'; message: string }>;
};

/**
 * Converts cases/bottles into base inventory units. Only sellable units (received minus rejected, damaged and broken) may increase
 * stock; damaged units are recorded separately. Never add the raw invoice quantity.
 */
export function resolveQuantities(input: QuantityInput): QuantityResolution {
  const upc = input.unitsPerCase;
  if (!Number.isSafeInteger(upc) || upc < 1) throw new Error('UNITS_PER_CASE_INVALID');
  const count = (value: number | null | undefined, code: string): number => { const v = value ?? 0; if (!Number.isSafeInteger(v) || v < 0) throw new Error(code); return v; };
  const shipped = count(input.casesShipped, 'CASES_INVALID'); const receivedCases = input.casesReceived === null || input.casesReceived === undefined ? shipped : count(input.casesReceived, 'CASES_INVALID');
  const rejectedCases = count(input.casesRejected, 'CASES_INVALID'); const backorderedCases = count(input.casesBackordered, 'CASES_INVALID');
  const loose = count(input.looseUnitsReceived, 'UNITS_INVALID'); const bonus = count(input.bonusUnits, 'UNITS_INVALID');
  const damaged = count(input.unitsDamaged, 'UNITS_INVALID') + count(input.unitsBroken, 'UNITS_INVALID');
  const invoicedUnits = shipped * upc; const receivedUnits = receivedCases * upc + loose + bonus; const rejectedUnits = rejectedCases * upc;
  const issues: QuantityResolution['issues'] = [];
  if (rejectedUnits > receivedUnits) issues.push({ code: 'REJECTED_EXCEEDS_RECEIVED', message: 'More units were rejected than were received.' });
  if (damaged > receivedUnits - rejectedUnits) issues.push({ code: 'DAMAGE_EXCEEDS_RECEIVED', message: 'More units are damaged or broken than were received.' });
  const sellableUnits = Math.max(0, receivedUnits - rejectedUnits - damaged);
  const shortUnits = Math.max(0, invoicedUnits - (receivedCases * upc + loose)); const overUnits = Math.max(0, receivedCases * upc + loose - invoicedUnits);
  const orderedUnits = input.casesOrdered === null || input.casesOrdered === undefined ? null : count(input.casesOrdered, 'CASES_INVALID') * upc;
  const fulfillment = receivedUnits === 0 ? (backorderedCases > 0 ? 'BACKORDERED' : 'OUT_OF_STOCK') : (shortUnits > 0 || backorderedCases > 0 ? 'PARTIAL' : 'RECEIVED');
  return { invoicedUnits, receivedUnits, rejectedUnits, damagedUnits: damaged, sellableUnits, backorderedUnits: backorderedCases * upc, shortUnits, overUnits, orderedUnits, variance: shortUnits > 0 ? 'SHORT' : overUnits > 0 ? 'OVER' : 'EXACT', fulfillment, issues };
}

// ---- Invoice reconciliation --------------------------------------------------------------------------------------------
export type ReconciliationInput = {
  /** Net extended amounts of merchandise lines (already after line discounts) unless linesBasis is GROSS. */
  lineExtendedMinor: bigint[];
  linesBasis?: 'NET' | 'GROSS';
  /** Subtracted only when lines are GROSS (header discount/post-off). */
  headerDiscountsMinor?: bigint;
  chargesMinor?: bigint; taxMinor?: bigint; depositMinor?: bigint; creditMinor?: bigint;
  invoiceTotalMinor?: bigint | null; amountDueMinor?: bigint | null;
};
export type Reconciliation = {
  merchandiseMinor: bigint; calculatedTotalMinor: bigint; invoiceTotalMinor: bigint | null; differenceMinor: bigint | null;
  status: 'MATCH' | 'MINOR_DIFFERENCE' | 'MATERIAL_DIFFERENCE' | 'NO_TOTAL';
  thresholdMinor: bigint;
};

/** Σ lines + charges + tax + deposits − credits (− header discounts for gross lines) against the printed total. Material = over $1.00 or 0.5%. */
export function reconcileInvoice(input: ReconciliationInput): Reconciliation {
  const merchandise = input.lineExtendedMinor.reduce((sum, value) => sum + value, 0n);
  const gross = input.linesBasis === 'GROSS';
  const calculated = merchandise - (gross ? input.headerDiscountsMinor ?? 0n : 0n) + (input.chargesMinor ?? 0n) + (input.taxMinor ?? 0n) + (input.depositMinor ?? 0n) - (input.creditMinor ?? 0n);
  const printed = input.invoiceTotalMinor ?? input.amountDueMinor ?? null;
  const half = printed === null ? 0n : (printed < 0n ? -printed : printed) / 200n;
  const threshold = half > 100n ? half : 100n;
  if (printed === null) return { merchandiseMinor: merchandise, calculatedTotalMinor: calculated, invoiceTotalMinor: null, differenceMinor: null, status: 'NO_TOTAL', thresholdMinor: threshold };
  const difference = printed - calculated; const magnitude = difference < 0n ? -difference : difference;
  return { merchandiseMinor: merchandise, calculatedTotalMinor: calculated, invoiceTotalMinor: printed, differenceMinor: difference, status: magnitude === 0n ? 'MATCH' : magnitude > threshold ? 'MATERIAL_DIFFERENCE' : 'MINOR_DIFFERENCE', thresholdMinor: threshold };
}

// ---- Cost change and retail impact ---------------------------------------------------------------------------------------
export type CostChange = {
  previousCaseMinor: bigint | null; invoiceCaseMinor: bigint; deltaMinor: bigint | null; deltaBasisPoints: number | null; direction: 'UP' | 'DOWN' | 'SAME' | 'NEW'; significant: boolean;
  retailMinor: bigint | null; previousUnitMinor: bigint | null; newUnitMinor: bigint; previousMarginBasisPoints: number | null; newMarginBasisPoints: number | null; marginDropBasisPoints: number | null;
};

/** Compares an invoice case cost to the vendor's current cost and shows the effect on margin. Never changes any price. */
export function assessCostChange(input: { previousCaseMinor?: bigint | null; invoiceCaseMinor: bigint; unitsPerCase: number; retailMinor?: bigint | null; significantBasisPoints?: number }): CostChange {
  const previous = input.previousCaseMinor ?? null;
  const delta = previous === null ? null : input.invoiceCaseMinor - previous;
  const bp = previous === null || previous === 0n || delta === null ? null : Number(divideRounded((delta < 0n ? -delta : delta) * 10_000n, previous)) * (delta < 0n ? -1 : 1);
  const newUnit = unitCostFromCase(input.invoiceCaseMinor, input.unitsPerCase);
  const prevUnit = previous === null ? null : unitCostFromCase(previous, input.unitsPerCase);
  const retail = input.retailMinor ?? null;
  const margin = (unit: bigint | null): number | null => (unit === null || retail === null || retail === 0n ? null : Number(divideRounded((retail - unit) * 10_000n, retail)));
  const prevMargin = margin(prevUnit); const newMargin = margin(newUnit);
  const threshold = input.significantBasisPoints ?? 500;
  return { previousCaseMinor: previous, invoiceCaseMinor: input.invoiceCaseMinor, deltaMinor: delta, deltaBasisPoints: bp, direction: delta === null ? 'NEW' : delta > 0n ? 'UP' : delta < 0n ? 'DOWN' : 'SAME',
    significant: bp !== null && Math.abs(bp) >= threshold, retailMinor: retail, previousUnitMinor: prevUnit, newUnitMinor: newUnit, previousMarginBasisPoints: prevMargin, newMarginBasisPoints: newMargin,
    marginDropBasisPoints: prevMargin === null || newMargin === null ? null : prevMargin - newMargin };
}

// ---- Order / invoice / receipt comparison ------------------------------------------------------------------------------
export type ComparisonFlag = 'UNEXPECTED_ITEM' | 'MISSING_ITEM' | 'PRICE_CHANGED' | 'OVER_SHIPMENT' | 'SHORTAGE' | 'BACKORDER' | 'EXACT';
export function compareOrderInvoiceReceipt(input: { orderedUnits: number | null; invoicedUnits: number; receivedUnits: number; poUnitCostMinor?: bigint | null; invoiceUnitCostMinor?: bigint | null; backorderedUnits?: number }): { flags: ComparisonFlag[]; invoicedVsOrdered: number | null; receivedVsInvoiced: number } {
  const flags: ComparisonFlag[] = [];
  if (input.orderedUnits === null) flags.push('UNEXPECTED_ITEM');
  else if (input.invoicedUnits === 0 && input.orderedUnits > 0) flags.push('MISSING_ITEM');
  if (input.orderedUnits !== null && input.invoicedUnits > input.orderedUnits) flags.push('OVER_SHIPMENT');
  if (input.receivedUnits < input.invoicedUnits) flags.push('SHORTAGE');
  if ((input.backorderedUnits ?? 0) > 0) flags.push('BACKORDER');
  if (input.poUnitCostMinor !== null && input.poUnitCostMinor !== undefined && input.invoiceUnitCostMinor !== null && input.invoiceUnitCostMinor !== undefined && input.poUnitCostMinor !== input.invoiceUnitCostMinor) flags.push('PRICE_CHANGED');
  return { flags: flags.length ? flags : ['EXACT'], invoicedVsOrdered: input.orderedUnits === null ? null : input.invoicedUnits - input.orderedUnits, receivedVsInvoiced: input.receivedUnits - input.invoicedUnits };
}
