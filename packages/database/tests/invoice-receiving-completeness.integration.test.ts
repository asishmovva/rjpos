import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { describe, expect, it } from 'vitest';
import {
  addInvoiceLine, addInvoicePage, applyInvoiceOcrResult, confirmInvoiceDocument, createClaimFromInvoiceLine, createInvoiceDocument, createManualInvoice, findContinuationCandidates, getInvoiceReview, getReceiptDetail,
  lineFromPrintedFields, mergeInvoiceDocuments, productReceiptHistory, saveInvoiceCharge, searchReceiving, updateInvoiceDocument, updateInvoiceLine, vendorOverview, type InvoiceOcrResult,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const upc = () => String(Math.floor(1e11 + Math.random() * 9e11));
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');

async function fixture(prisma: PrismaClient) {
  const organizationId = randomUUID(); const storeId = randomUUID(); const employeeId = randomUUID(); const categoryId = randomUUID();
  await prisma.organization.create({ data: { id: organizationId, name: 'Receiving' } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Receiving Store' } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Rita', lastName: 'Receiver' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'Spirits' } });
  const actor = { organizationId, storeId, userId: employeeId };
  const vendor = await prisma.vendor.create({ data: { organizationId, name: `Distributor ${randomUUID().slice(0, 4)}` } });
  const product = async (name: string, opts: { vendorSku?: string; caseUpc?: string; caseCostMinor?: bigint; unitsPerCase?: number; retailMinor?: bigint; altUpc?: string } = {}) => {
    const p = await prisma.product.create({ data: { organizationId, categoryId, name, inventoryTracked: true } });
    const variant = await prisma.productVariant.create({ data: { organizationId, productId: p.id, name: '750 ml', sku: `S-${randomUUID().slice(0, 8).toUpperCase()}` } });
    const code = upc();
    await prisma.barcode.create({ data: { organizationId, variantId: variant.id, barcodeValue: code } });
    if (opts.altUpc) await prisma.barcode.create({ data: { organizationId, variantId: variant.id, barcodeValue: opts.altUpc, kind: 'ALTERNATE' } });
    if (opts.retailMinor) await prisma.price.create({ data: { organizationId, storeId, variantId: variant.id, amountMinor: opts.retailMinor, effectiveFrom: new Date('2026-01-01') } });
    if (opts.vendorSku || opts.caseUpc || opts.caseCostMinor) {
      const upcs = opts.unitsPerCase ?? 12;
      await prisma.vendorProductMapping.create({ data: { organizationId, vendorId: vendor.id, variantId: variant.id, vendorSku: opts.vendorSku ?? null, caseUpc: opts.caseUpc ?? null, casePackQuantity: upcs,
        caseCostMinor: opts.caseCostMinor ?? null, vendorCostMinor: (opts.caseCostMinor ?? 0n) / BigInt(upcs) } });
    }
    return { variantId: variant.id, upc: code };
  };
  const draft = async (result: InvoiceOcrResult, vendorId: string | null = vendor.id) => {
    const content = Buffer.from(`inv-${randomUUID()}`);
    const document = await createInvoiceDocument(prisma, actor, { ...(vendorId ? { vendorId } : {}), originalFilename: 'inv.png', mimeType: 'image/png', content, documentHash: createHash('sha256').update(content).digest('hex') });
    return applyInvoiceOcrResult(prisma, actor, document.id, result);
  };
  const onHand = async (variantId: string) => (await prisma.inventoryLevel.findUnique({ where: { organizationId_storeId_variantId: { organizationId, storeId, variantId } } }))?.onHand ?? 0;
  return { prisma, organizationId, storeId, actor, vendor, product, draft, onHand };
}

describe.sequential('invoice receiving completeness', () => {
  it('maps different distributor layouts to the same canonical economics, keeps base and net separate, and preserves original labels', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      // Layout A prints UNIT LIST / UNIT POST OFF / BTL/COST per bottle; layout B prints PRICE / GROSS AMT / DISCOUNT / NET AMT per case/line.
      const a = lineFromPrintedFields([{ label: 'PROD NO.', value: 'GAL-100' }, { label: 'PRODUCT DESCRIPTION', value: 'CHARDONNAY' }, { label: 'SIZE', value: '750 ML' }, { label: 'PACK', value: '12' }, { label: 'CASES', value: '2' },
        { label: 'UNIT LIST', value: '15.79' }, { label: 'UNIT POST OFF', value: '4.70' }, { label: 'UNIT QTY DISCOUNT', value: '0.00' }, { label: 'BTL/COST', value: '11.09' }, { label: 'NET AMT.', value: '266.16' }, { label: 'RIP', value: 'R1' }, { label: 'MYSTERY COL', value: 'xyz' }]);
      expect(a.line).toMatchObject({ vendorItemNumber: 'GAL-100', size: '750 ML', caseQuantity: 12, casesShipped: 2, unitListMinor: '1579', postOffPerCaseMinor: '5640', qtyDiscountPerCaseMinor: '0', netUnitCostMinor: '1109', lineTotalMinor: '26616', ripCode: 'R1' });
      expect(a.unmapped.map((field) => field.label)).toEqual(['MYSTERY COL']);
      expect(a.line.evidence).toMatchObject({ postOffPerCaseMinor: { label: 'UNIT POST OFF', original: '4.70' }, 'extra:MYSTERY COL': { original: 'xyz' } });
      const b = lineFromPrintedFields([{ label: 'ITEM', value: 'B-77' }, { label: 'DESCRIPTION', value: 'VODKA' }, { label: 'PACK', value: '6' }, { label: 'CASES', value: '4' }, { label: 'PRICE', value: '120.00' }, { label: 'GROSS AMT', value: '480.00' }, { label: 'DISCOUNT', value: '80.00' }, { label: 'NET AMT', value: '400.00' }]);
      expect(b.ambiguous).toEqual([{ label: 'PRICE', mappedTo: 'listCase' }]);

      const one = await f.product('Chardonnay', { vendorSku: 'GAL-100', caseCostMinor: 18_948n, retailMinor: 1_999n });
      const two = await f.product('Vodka', { vendorSku: 'B-77', caseCostMinor: 12_000n, unitsPerCase: 6, retailMinor: 2_499n });
      const doc = await f.draft({ provider: 'T', invoiceNumber: 'LAYOUT-1', totalMinor: '66616', lines: [{ ...a.line, description: 'CHARDONNAY' }, { ...b.line, description: 'VODKA' }] });
      expect(doc.lines.map((line) => line.matchStatus)).toEqual(['MATCHED', 'MATCHED']);
      expect(doc.lines[0]).toMatchObject({ variantId: one.variantId, caseCostMinor: 18_948n, discountPerCaseMinor: 5_640n, netCaseCostMinor: 13_308n, netUnitCostMinor: 1_109n, lineTotalMinor: 26_616n });
      expect(doc.lines[1]).toMatchObject({ variantId: two.variantId, caseCostMinor: 12_000n, discountPerCaseMinor: 2_000n, netCaseCostMinor: 10_000n, lineTotalMinor: 40_000n });
      const review = await getInvoiceReview(prisma, f.actor, doc.id);
      expect(review.receiving.lines[0]!.economics).toMatchObject({ baseCaseMinor: 18_948n, netCaseMinor: 13_308n, netUnitMinor: 1_109n });
      expect(review.receiving.reconciliation.status).toBe('MATCH');
    } finally { await prisma.$disconnect(); }
  });

  it('receives partially with a backorder, one broken bottle, a vendor claim, exact cost history, and never changes retail or the standard vendor cost', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const item = await f.product('Gin', { vendorSku: 'GIN-1', caseCostMinor: 12_000n, retailMinor: 1_999n });
      const doc = await f.draft({ provider: 'T', invoiceNumber: 'PART-1', totalMinor: '26616', lines: [{ description: 'Gin', vendorSku: 'GIN-1', caseQuantity: 12, casesOrdered: 3, casesShipped: 2, casesBackordered: 1, listCaseMinor: '18948', postOffPerCaseMinor: '5640',
        unitsBroken: 1, damageDisposition: 'VENDOR_CLAIM', lineTotalMinor: '26616', ripCode: 'RIP-9' }] });
      const review = await getInvoiceReview(prisma, f.actor, doc.id);
      expect(review.receiving.lines[0]!.quantities).toMatchObject({ invoicedUnits: 24, receivedUnits: 24, damagedUnits: 1, sellableUnits: 23, backorderedUnits: 12, orderedUnits: 36, fulfillment: 'PARTIAL' });
      expect(review.receiving.lines[0]!.costChange).toMatchObject({ direction: 'UP', previousMarginBasisPoints: 4997, significant: true });
      expect(await f.onHand(item.variantId)).toBe(0);
      const confirmed = await confirmInvoiceDocument(prisma, f.actor, doc.id, false, true);
      expect(await f.onHand(item.variantId)).toBe(23);
      const movements = await prisma.inventoryMovement.findMany({ where: { organizationId: f.organizationId, variantId: item.variantId }, orderBy: { createdAt: 'asc' } });
      expect(movements.map((movement) => [movement.type, movement.quantityDelta])).toEqual([['PURCHASE_RECEIPT', 24], ['DAMAGE', -1]]);
      // PO stays open for the backordered case.
      const order = await prisma.purchaseOrder.findFirstOrThrow({ where: { organizationId: f.organizationId } });
      expect(order.status).toBe('PARTIALLY_RECEIVED');
      // Exact economics are kept: list, discount component, net, effective, RIP, and the receipt link.
      const history = await prisma.productCostHistory.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.variantId } });
      expect(history).toMatchObject({ listCaseCostMinor: 18_948n, baseCaseCostMinor: 18_948n, discountPerCaseMinor: 5_640n, netCaseCostMinor: 13_308n, effectiveCaseCostMinor: 13_308n, effectiveUnitCostMinor: 1_109n, unitsDamaged: 1, purchaseReceiptId: confirmed.receiptId });
      expect(history.componentsJson).toMatchObject({ postOff: '5640', ripCode: 'RIP-9' });
      // Retail untouched, standard vendor cost untouched (no explicit choice).
      expect((await prisma.price.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.variantId } })).amountMinor).toBe(1_999n);
      expect((await prisma.vendorProductMapping.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.variantId } })).caseCostMinor).toBe(12_000n);
      // A draft damage claim was created and linked to the invoice line.
      expect(confirmed.claimsCreated).toHaveLength(1);
      const claim = await prisma.vendorClaim.findFirstOrThrow({ where: { organizationId: f.organizationId }, include: { lines: true } });
      expect(claim).toMatchObject({ kind: 'DAMAGE', status: 'DRAFT', invoiceDocumentId: doc.id, expectedCreditMinor: 1_109n });
      expect(claim.lines[0]!.invoiceLineId).toBe(doc.lines[0]!.id);
      // History views read from what was posted.
      const found = await searchReceiving(prisma, f.actor, { invoiceNumber: 'PART-1', discrepancy: true });
      expect(found.total).toBe(1);
      const detail = await getReceiptDetail(prisma, f.actor, confirmed.receiptId);
      expect(detail.lines[0]).toMatchObject({ sellableUnits: 23, damagedUnits: 1, cost: { netCaseCostMinor: 13_308n, listCaseCostMinor: 18_948n } });
      expect(detail.claims).toHaveLength(1);
      expect((await productReceiptHistory(prisma, f.actor, [item.variantId])).last).toMatchObject({ netCaseCostMinor: 13_308n });
      expect((await vendorOverview(prisma, f.actor, f.vendor.id)).claims).toHaveLength(1);
    } finally { await prisma.$disconnect(); }
  });

  it('blocks exact duplicate invoices, warns on probable ones, and supports manual entry, non-inventory charges, reconciliation, and credit memos', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const caseUpc = upc();
      const item = await f.product('Rum', { caseUpc, caseCostMinor: 12_000n });
      // Manual entry, no OCR: header, case UPC match, freight charge, and a freight line that must not create a product.
      const manual = await createManualInvoice(prisma, f.actor, { vendorId: f.vendor.id, invoiceNumber: 'MAN-1', invoiceDate: '2026-03-02', totalMinor: '13508', paymentTerms: 'NET 30', docType: 'INVOICE' });
      expect(manual.ocrProvider).toBe('MANUAL');
      const line = await addInvoiceLine(prisma, f.actor, manual.id, { description: 'Rum case', caseUpc, caseQuantity: 12, casesShipped: 1, caseCostMinor: '12000' });
      expect(line).toMatchObject({ variantId: item.variantId, matchStatus: 'MATCHED', lineTotalMinor: 12_000n });
      await addInvoiceLine(prisma, f.actor, manual.id, { lineKind: 'FREIGHT', description: 'Freight', lineTotalMinor: '1500' });
      await saveInvoiceCharge(prisma, f.actor, manual.id, null, { kind: 'FEE', amountMinor: '8', label: 'Fuel' });
      expect(await prisma.product.count({ where: { organizationId: f.organizationId } })).toBe(1);
      let review = await getInvoiceReview(prisma, f.actor, manual.id);
      expect(review.receiving.nonInventoryLines).toHaveLength(1);
      expect(review.receiving.reconciliation).toMatchObject({ merchandiseMinor: 12_000n, calculatedTotalMinor: 13_508n, differenceMinor: 0n, status: 'MATCH' });
      // A wrong printed total is a material difference that needs an explicit acknowledgement AND a note.
      await updateInvoiceDocument(prisma, f.actor, manual.id, { totalMinor: '20000', reason: 'typo check' });
      review = await getInvoiceReview(prisma, f.actor, manual.id);
      expect(review.receiving.reconciliation.status).toBe('MATERIAL_DIFFERENCE');
      await expect(confirmInvoiceDocument(prisma, f.actor, manual.id)).rejects.toMatchObject({ code: 'INVOICE_DISCREPANCIES_REQUIRE_ACKNOWLEDGEMENT' });
      await expect(confirmInvoiceDocument(prisma, f.actor, manual.id, false, true)).rejects.toMatchObject({ code: 'INVOICE_RECONCILIATION_NOTE_REQUIRED' });
      await updateInvoiceDocument(prisma, f.actor, manual.id, { totalMinor: '13508' });
      await confirmInvoiceDocument(prisma, f.actor, manual.id);
      expect(await f.onHand(item.variantId)).toBe(12);
      expect(await prisma.product.count({ where: { organizationId: f.organizationId } })).toBe(1);
      // The same vendor invoice number again is blocked outright.
      const again = await createManualInvoice(prisma, f.actor, { vendorId: f.vendor.id, invoiceNumber: 'MAN-1', totalMinor: '13508' });
      await addInvoiceLine(prisma, f.actor, again.id, { description: 'Rum case', caseUpc, caseQuantity: 12, casesShipped: 1, caseCostMinor: '12000' });
      expect((await getInvoiceReview(prisma, f.actor, again.id)).receiving.blockers.map((blocker) => blocker.code)).toContain('ALREADY_RECEIVED');
      await expect(confirmInvoiceDocument(prisma, f.actor, again.id, true, true)).rejects.toMatchObject({ code: 'INVOICE_ALREADY_RECEIVED' });
      expect(await f.onHand(item.variantId)).toBe(12);
      // A credit memo is recorded but never posts stock.
      const credit = await createManualInvoice(prisma, f.actor, { vendorId: f.vendor.id, invoiceNumber: 'CM-1', docType: 'CREDIT_MEMO', totalMinor: '1000' });
      await addInvoiceLine(prisma, f.actor, credit.id, { description: 'Rum case', caseUpc, caseQuantity: 12, casesShipped: 1, caseCostMinor: '1000' });
      await confirmInvoiceDocument(prisma, f.actor, credit.id, false, true);
      expect(await f.onHand(item.variantId)).toBe(12);
    } finally { await prisma.$disconnect(); }
  });

  it('keeps temporary deal prices out of the standard cost, warns on cost changes, and audits manual corrections with old and new values', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const item = await f.product('Whiskey', { vendorSku: 'W-1', caseCostMinor: 12_000n, retailMinor: 1_999n });
      const doc = await f.draft({ provider: 'T', invoiceNumber: 'DEAL-1', totalMinor: '10000', lines: [{ description: 'Whiskey', vendorSku: 'W-1', caseQuantity: 12, casesShipped: 1, listCaseMinor: '13300', postOffPerCaseMinor: '3300', temporaryDeal: true, lineTotalMinor: '10000' }] });
      const lineId = doc.lines[0]!.id;
      let review = await getInvoiceReview(prisma, f.actor, doc.id);
      expect(review.receiving.lines[0]!.costChange).toMatchObject({ previousCaseMinor: 12_000n, invoiceCaseMinor: 13_300n, deltaMinor: 1_300n, significant: true, direction: 'UP' });
      expect(review.receiving.lines[0]!.costChange.newMarginBasisPoints).toBeLessThan(review.receiving.lines[0]!.costChange.previousMarginBasisPoints!);
      expect(review.receiving.warnings.map((warning) => warning.code)).toContain('COST_CHANGE');
      // Manual correction: cost override is audited with before/after and kept in correctedFields.
      await updateInvoiceLine(prisma, f.actor, doc.id, lineId, { postOffPerCaseMinor: '3000', lineTotalMinor: '10300', reason: 'Vendor rep corrected the deal' });
      const corrected = await prisma.invoiceLine.findFirstOrThrow({ where: { id: lineId } });
      expect(corrected).toMatchObject({ postOffPerCaseMinor: 3_000n, netCaseCostMinor: 10_300n });
      expect(corrected.correctedFields).toMatchObject({ postOffPerCaseMinor: { from: '3300', to: '3000' } });
      const audit = await prisma.auditRecord.findFirstOrThrow({ where: { organizationId: f.organizationId, action: 'INVOICE_COST_OVERRIDDEN' } });
      expect(audit.beforeJson).toMatchObject({ postOffPerCaseMinor: '3300' }); expect(audit.afterJson).toMatchObject({ postOffPerCaseMinor: '3000', reason: 'Vendor rep corrected the deal' });
      await updateInvoiceDocument(prisma, f.actor, doc.id, { totalMinor: '10300' });
      // Explicitly choosing to update vendor cost does nothing for a temporary deal with no stated standard cost.
      await updateInvoiceLine(prisma, f.actor, doc.id, lineId, { updateVendorCost: true });
      await confirmInvoiceDocument(prisma, f.actor, doc.id, false, true);
      expect((await prisma.vendorProductMapping.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.variantId } })).caseCostMinor).toBe(12_000n);
      expect(await prisma.productCostHistory.count({ where: { organizationId: f.organizationId, variantId: item.variantId, temporaryDeal: true } })).toBe(1);
      // A second invoice states the standard cost: now the mapping follows the standard, not the deal, while history keeps the deal price.
      const next = await f.draft({ provider: 'T', invoiceNumber: 'DEAL-2', totalMinor: '9000', lines: [{ description: 'Whiskey', vendorSku: 'W-1', caseQuantity: 12, casesShipped: 1, listCaseMinor: '13000', postOffPerCaseMinor: '4000', temporaryDeal: true, standardCaseCostMinor: '12500', updateVendorCost: undefined, lineTotalMinor: '9000' }] } as InvoiceOcrResult);
      await updateInvoiceLine(prisma, f.actor, next.id, next.lines[0]!.id, { updateVendorCost: true });
      await confirmInvoiceDocument(prisma, f.actor, next.id, false, true);
      expect((await prisma.vendorProductMapping.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.variantId } })).caseCostMinor).toBe(12_500n);
      const history = await prisma.productCostHistory.findMany({ where: { organizationId: f.organizationId, variantId: item.variantId }, orderBy: { createdAt: 'asc' } });
      expect(history.map((row) => row.netCaseCostMinor)).toEqual([10_300n, 9_000n]);
      // Retail price never changed.
      expect((await prisma.price.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.variantId } })).amountMinor).toBe(1_999n);
    } finally { await prisma.$disconnect(); }
  });

  it('groups multi-page invoices, flags unexpected and over-shipped lines against a PO, and keeps order, invoice and receipt separate', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const one = await f.product('Tequila', { vendorSku: 'T-1', caseCostMinor: 12_000n });
      const two = await f.product('Mezcal', { vendorSku: 'M-1', caseCostMinor: 24_000n });
      const page1 = await f.draft({ provider: 'T', invoiceNumber: 'MULTI-1', pageNumber: 1, continued: true, lines: [{ description: 'Tequila', vendorSku: 'T-1', caseQuantity: 12, casesShipped: 1, caseCostMinor: '12000' }] });
      const page2 = await f.draft({ provider: 'T', invoiceNumber: 'MULTI-1', pageNumber: 2, totalMinor: '36000', lines: [{ description: 'Mezcal', vendorSku: 'M-1', caseQuantity: 12, casesShipped: 1, caseCostMinor: '24000', sourcePage: 2 }] });
      expect((await findContinuationCandidates(prisma, f.actor, page1.id)).map((candidate) => candidate.id)).toEqual([page2.id]);
      const extra = Buffer.from('another photo');
      const added = await addInvoicePage(prisma, f.actor, page1.id, { originalFilename: 'p-extra.jpg', mimeType: 'image/jpeg', content: extra, documentHash: hash() });
      expect(added.pageNumber).toBe(2);
      await expect(addInvoicePage(prisma, f.actor, page1.id, { originalFilename: 'again.jpg', mimeType: 'image/jpeg', content: extra, documentHash: createHash('sha256').update(page1.id).digest('hex') })).resolves.toBeTruthy();
      const merged = await mergeInvoiceDocuments(prisma, f.actor, page1.id, page2.id);
      expect(merged).toMatchObject({ linesMoved: 1, pageCount: 4 });
      expect(await prisma.invoiceDocument.count({ where: { organizationId: f.organizationId } })).toBe(1);
      const whole = await prisma.invoiceDocument.findFirstOrThrow({ where: { id: page1.id }, include: { lines: { orderBy: { lineNumber: 'asc' } }, pages: true } });
      expect(whole.lines.map((line) => [line.lineNumber, line.description])).toEqual([[1, 'Tequila'], [2, 'Mezcal']]);
      expect(whole.totalMinor).toBe(36_000n); expect(whole.pages).toHaveLength(3);
      // PO comparison: the PO has tequila 12 units and a bottle of an item the invoice omits; the invoice ships 24 tequila (over) and mezcal (unexpected).
      const missing = await f.product('Brandy', { vendorSku: 'BR-1', caseCostMinor: 6_000n });
      const po = await prisma.purchaseOrder.create({ data: { organizationId: f.organizationId, storeId: f.storeId, vendorId: f.vendor.id, createdByEmployeeId: f.actor.userId, poNumber: `PO-${randomUUID().slice(0, 6)}`, status: 'SUBMITTED' } });
      await prisma.purchaseOrderLine.createMany({ data: [{ organizationId: f.organizationId, purchaseOrderId: po.id, variantId: one.variantId, productNameSnapshot: 'Tequila', variantNameSnapshot: '750 ml', skuSnapshot: 'T', orderedQuantity: 12, unitCostMinor: 1_000n, unitsPerCase: 12, caseCostMinor: 12_000n },
        { organizationId: f.organizationId, purchaseOrderId: po.id, variantId: missing.variantId, productNameSnapshot: 'Brandy', variantNameSnapshot: '750 ml', skuSnapshot: 'B', orderedQuantity: 12, unitCostMinor: 500n, unitsPerCase: 12, caseCostMinor: 6_000n }] });
      await updateInvoiceDocument(prisma, f.actor, page1.id, { purchaseOrderId: po.id });
      await updateInvoiceLine(prisma, f.actor, page1.id, whole.lines[0]!.id, { casesShipped: 2 });
      const review = await getInvoiceReview(prisma, f.actor, page1.id);
      const byVariant = new Map(review.receiving.lines.map((line) => [line.lineId, line]));
      expect(byVariant.get(whole.lines[0]!.id)!.comparison.flags).toEqual(expect.arrayContaining(['OVER_SHIPMENT']));
      expect(byVariant.get(whole.lines[1]!.id)!.comparison.flags).toContain('UNEXPECTED_ITEM');
      expect(review.receiving.missingFromInvoice.map((entry) => entry.productName)).toEqual(['Brandy']);
      expect(review.receiving.blockers.map((blocker) => blocker.code)).toContain('OVER_SHIPMENT');
      expect(await f.onHand(two.variantId)).toBe(0);
      // Manual claim from an invoice line (incorrect cost) stays a draft linked to the line.
      const claim = await createClaimFromInvoiceLine(prisma, f.actor, page1.id, { lineId: whole.lines[0]!.id, kind: 'INCORRECT_COST', quantity: 12, unitCostMinor: '50', reason: 'Billed above PO cost' });
      expect(claim).toMatchObject({ kind: 'INCORRECT_COST', status: 'DRAFT', expectedCreditMinor: 600n });
    } finally { await prisma.$disconnect(); }
  });
});
