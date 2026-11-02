// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmPanel } from '../app/admin/invoices/receiving-flow.js';
import { dollarsToMinor, minorToDollars, type FullReview, type ReceivingLine, type ReceivingReview } from '../app/admin/invoices/receiving-client.js';
import { ReceivingTable } from '../app/admin/invoices/receiving-table.js';

afterEach(() => cleanup());

const costChange = { previousCaseMinor: '12000', invoiceCaseMinor: '13300', deltaMinor: '1300', deltaBasisPoints: 1083, direction: 'UP' as const, significant: true, retailMinor: '1999', previousUnitMinor: '1000', newUnitMinor: '1108', previousMarginBasisPoints: 4997, newMarginBasisPoints: 4457, marginDropBasisPoints: 540 };
const line = { id: 'l1', lineNumber: 1, lineKind: 'PRODUCT', description: 'Gin 750', upc: '123', caseUpc: null, alternateUpc: null, vendorSku: 'GIN-1', vendorItemNumber: 'G1', brand: null, size: '750 ML', packLabel: '12', quantity: 2, caseQuantity: 12, casesOrdered: 3, casesReceived: null, casesBackordered: 1, casesRejected: 0,
  looseUnitsReceived: 0, bonusUnits: 0, unitsDamaged: 0, unitsBroken: 1, unitsMissing: 0, fulfillment: 'PARTIAL', damageDisposition: null, listCaseMinor: '18948', unitListMinor: null, caseCostMinor: '18948', postOffPerCaseMinor: '5640', qtyDiscountPerCaseMinor: null, caseDiscountPerCaseMinor: null, promoDiscountPerCaseMinor: null,
  otherDiscountPerCaseMinor: null, allowancePerCaseMinor: null, rebatePerCaseMinor: null, discountPerCaseMinor: '5640', netCaseCostMinor: '13308', netUnitCostMinor: '1109', lineTotalMinor: '26616', ripCode: 'R1', ripValueMinor: null, temporaryDeal: false, dealEndsAt: null, standardCaseCostMinor: null, notes: null, confidence: '0.6',
  matchStatus: 'MATCHED', ignored: false, updateVendorCost: false, variantId: 'v1', sourcePage: 1, evidence: { postOffPerCaseMinor: { label: 'UNIT POST OFF', original: '4.70', confidence: 0.6 } }, correctedFields: null, variant: { id: 'v1', name: '750 ml', sku: 'S1', product: { name: 'Gin' } } } as unknown as ReceivingLine;
const receiving = (overrides: Partial<ReceivingReview> = {}): ReceivingReview => ({ docType: 'INVOICE', postsInventory: true, stages: [], lines: [{ lineId: 'l1', lineNumber: 1, ignored: false, matched: true, lowConfidence: true, issues: ['DAMAGE_DISPOSITION_REQUIRED'],
  economics: { baseCaseMinor: '18948', discountPerCaseMinor: '5640', netCaseMinor: '13308', rebatePerCaseMinor: '0', effectiveCaseMinor: '13308', netUnitMinor: '1109', effectiveUnitMinor: '1109', extendedMinor: '26616', warnings: [] },
  quantities: { invoicedUnits: 24, receivedUnits: 24, rejectedUnits: 0, damagedUnits: 1, sellableUnits: 23, backorderedUnits: 12, shortUnits: 0, overUnits: 0, orderedUnits: 36, variance: 'EXACT', fulfillment: 'PARTIAL' }, comparison: { flags: ['BACKORDER'], invoicedVsOrdered: -12, receivedVsInvoiced: 0 }, costChange, effectiveCostChange: null }],
  nonInventoryLines: [], charges: [], reconciliation: { merchandiseMinor: '26616', calculatedTotalMinor: '26616', invoiceTotalMinor: '26616', differenceMinor: '0', status: 'MATCH', thresholdMinor: '100' }, missingFromInvoice: [], exactDuplicate: null, continuation: [], blockers: [], warnings: [], requiresNote: false, ...overrides });

describe('money helpers', () => {
  it('converts dollars to minor units without floating point and rejects bad input', () => {
    expect(dollarsToMinor('189.48')).toBe('18948'); expect(dollarsToMinor('$5')).toBe('500'); expect(dollarsToMinor('0.1')).toBe('10'); expect(dollarsToMinor('')).toBeUndefined();
    expect(dollarsToMinor('1.234')).toBeNull(); expect(dollarsToMinor('abc')).toBeNull(); expect(dollarsToMinor('-5')).toBeNull();
    expect(minorToDollars('13308')).toBe('133.08'); expect(minorToDollars('5')).toBe('0.05');
  });
});

describe('receiving table', () => {
  it('shows the decision columns, then expands to every component, evidence in vendor terms, cost-change and retail impact', async () => {
    const user = userEvent.setup(); const saves: Array<[string, Record<string, unknown>]> = [];
    render(<ReceivingTable lines={[line]} review={receiving()} disabled={false} onSave={async (id, body) => { saves.push([id, body]); }} onRemove={() => undefined} onClaim={() => undefined} />);
    const table = screen.getByRole('table', { name: 'Receiving review' });
    for (const header of ['Vendor item #', 'Size', 'Pack', 'Ordered', 'Invoiced', 'Received', 'Base case', 'Discount', 'Net case', 'Net unit', 'Line total', 'Difference', 'Status']) expect(within(table).getByText(header)).toBeTruthy();
    expect(within(table).getByText('$189.48')).toBeTruthy(); expect(within(table).getByText('$133.08')).toBeTruthy(); expect(within(table).getByText('$11.09')).toBeTruthy();
    expect(within(table).getByText('Low confidence: check')).toBeTruthy(); expect(within(table).getByText('Backordered')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Details line 1' }));
    expect(screen.getByText('23 sellable', { exact: false })).toBeTruthy();
    expect(screen.getByText('UNIT POST OFF')).toBeTruthy(); expect(screen.getByText('4.70')).toBeTruthy();
    expect(screen.getByText('+$13.00 / 10.8%')).toBeTruthy(); expect(screen.getByText('44.6%')).toBeTruthy();
    expect(screen.getByText('Review pricing')).toBeTruthy();
    // Editing a discount sends minor units; editing received cases sends an integer; choosing a disposition is explicit.
    const postOff = screen.getByLabelText('Post-off ($)'); await user.clear(postOff); await user.type(postOff, '50.00'); await user.tab();
    expect(saves.at(-1)).toEqual(['l1', { postOffPerCaseMinor: '5000' }]);
    const received = screen.getByLabelText('Cases received line 1'); await user.clear(received); await user.type(received, '1'); await user.tab();
    expect(saves.at(-1)).toEqual(['l1', { casesReceived: 1 }]);
    await user.selectOptions(screen.getByLabelText('Damage disposition'), 'VENDOR_CLAIM');
    expect(saves.at(-1)).toEqual(['l1', { damageDisposition: 'VENDOR_CLAIM' }]);
    await user.clear(postOff); await user.type(postOff, 'abc'); await user.tab();
    expect(screen.getByText('Amount like 12.50')).toBeTruthy();
  });
});

describe('final confirmation panel', () => {
  const props = (review: ReceivingReview, hasDiscrepancies = false): FullReview => ({ invoiceId: 'i', hasDiscrepancies, receiving: review });
  it('blocks confirmation while blockers exist and explains why, and never posts before the explicit click', async () => {
    const confirmed = vi.fn();
    render(<ConfirmPanel docId="i" status="DRAFT" review={props(receiving({ blockers: [{ code: 'ALREADY_RECEIVED', message: 'This vendor invoice number was already received and confirmed.' }] }))} busy={false} onChanged={() => undefined} onConfirmed={confirmed} setError={() => undefined} />);
    expect(screen.getByText(/already received and confirmed/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm and post inventory' }) as HTMLButtonElement).disabled).toBe(true);
    expect(confirmed).not.toHaveBeenCalled();
  });
  it('requires the discrepancy acknowledgement and, for a material total difference, a note', async () => {
    const user = userEvent.setup();
    render(<ConfirmPanel docId="i" status="DRAFT" review={props(receiving({ requiresNote: true, reconciliation: { merchandiseMinor: '10000', calculatedTotalMinor: '10000', invoiceTotalMinor: '12500', differenceMinor: '2500', status: 'MATERIAL_DIFFERENCE', thresholdMinor: '100' } }), true)} busy={false} onChanged={() => undefined} onConfirmed={() => undefined} setError={() => undefined} />);
    const confirm = screen.getByRole('button', { name: 'Confirm and post inventory' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); expect(screen.getByText('Difference')).toBeTruthy();
    await user.click(screen.getByLabelText(/I reviewed the discrepancies/)); expect(confirm.disabled).toBe(true);
    await user.type(screen.getByLabelText('Reconciliation note'), 'Vendor added a fee not shown'); expect(confirm.disabled).toBe(false);
  });
  it('says plainly when a document type does not change inventory', () => {
    render(<ConfirmPanel docId="i" status="DRAFT" review={props(receiving({ docType: 'CREDIT_MEMO', postsInventory: false }))} busy={false} onChanged={() => undefined} onConfirmed={() => undefined} setError={() => undefined} />);
    expect(screen.getByText(/Inventory is not changed/)).toBeTruthy(); expect(screen.getByRole('button', { name: 'Confirm document' })).toBeTruthy();
  });
});
