import { Prisma, type InvoiceLineFulfillment, type InvoiceLineKind, type InvoiceLineMatchStatus, type PrismaClient, type ReceivingDisposition } from '@prisma/client';
import { assessCostChange, compareOrderInvoiceReceipt, normalizeVendorLabel, reconcileInvoice, resolveLineEconomics, resolveQuantities, type ComparisonFlag } from '@rjpos/domain-types';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';

type Tx = Prisma.TransactionClient;
export const PRODUCT = 'PRODUCT' as const;
export const DERIVED = 'DERIVED';
export const NON_INVENTORY_KINDS = ['DELIVERY', 'FREIGHT', 'SERVICE', 'FEE', 'DEPOSIT', 'CREDIT', 'REBATE', 'OTHER'] as const;

/** One printed field kept exactly as the vendor showed it, next to what RJ POS understood. */
export type FieldEvidence = { label?: string; original?: string; normalized?: string; confidence?: number; page?: number; corrected?: string };

/**
 * Everything a vendor invoice line can carry. All money values are minor-unit strings. Nothing but `description` is required, so the
 * same type serves OCR output and manual entry. `quantity` (cases invoiced/shipped) is kept for backward compatibility.
 */
export type InvoiceLineInput = {
  lineKind?: InvoiceLineKind; description: string;
  upc?: string; caseUpc?: string; alternateUpc?: string; vendorSku?: string; vendorItemNumber?: string; brand?: string; size?: string; packLabel?: string; vintage?: string; categoryHint?: string; sourcePage?: number;
  caseQuantity?: number;
  quantity?: number; casesShipped?: number; casesOrdered?: number; casesReceived?: number; casesBackordered?: number; casesRejected?: number; casesDamaged?: number;
  unitsOrdered?: number; looseUnitsShipped?: number; looseUnitsReceived?: number; unitsDamaged?: number; unitsBroken?: number; unitsMissing?: number; bonusUnits?: number;
  fulfillment?: InvoiceLineFulfillment; damageDisposition?: ReceivingDisposition | null;
  unitListMinor?: string; listCaseMinor?: string; caseCostMinor?: string; grossLineMinor?: string; unitCostMinor?: string; netCaseCostMinor?: string; netUnitCostMinor?: string;
  postOffPerCaseMinor?: string; qtyDiscountPerCaseMinor?: string; caseDiscountPerCaseMinor?: string; promoDiscountPerCaseMinor?: string; otherDiscountPerCaseMinor?: string; lineDiscountMinor?: string;
  discountPerCaseMinor?: string; allowancePerCaseMinor?: string; rebatePerCaseMinor?: string;
  lineTotalMinor?: string; lineTaxMinor?: string;
  ripCode?: string; ripValueMinor?: string; temporaryDeal?: boolean; dealEndsAt?: string | null; standardCaseCostMinor?: string;
  notes?: string; confidence?: number; rawText?: string; evidence?: Record<string, FieldEvidence> | null;
};

export const moneyOrNull = (value: string | undefined | null, code: string): bigint | null => {
  if (value === undefined || value === null || value === '') return null;
  if (!/^(0|[1-9]\d{0,17})$/.test(value)) throw new PosError(code);
  return BigInt(value);
};
const countOrNull = (value: number | undefined | null, code: string): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new PosError(code);
  return value;
};
const count = (value: number | undefined | null, code: string): number => countOrNull(value, code) ?? 0;
const text = (value: string | undefined | null, max = 200): string | null => value?.trim().slice(0, max) || null;
const normalizeCode = (value: string | undefined | null): string | null => value?.trim().replace(/[\s-]/g, '') || null;

export type MatchResult = { variantId: string | null; masterProductId: string | null; matchedBy: 'VENDOR_SKU' | 'UPC' | 'CASE_UPC' | 'ALTERNATE_UPC' | 'MASTER_CATALOG' | null };

/** Matching priority: vendor SKU mapping, UPC, case UPC, alternate UPC, master catalog. A fuzzy description alone never matches. */
export async function matchInvoiceLine(tx: Tx | PrismaClient, organizationId: string, vendorId: string | null, ids: { vendorSku?: string | null; vendorItemNumber?: string | null; upc?: string | null; caseUpc?: string | null; alternateUpc?: string | null }): Promise<MatchResult> {
  const skus = [ids.vendorSku, ids.vendorItemNumber].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (vendorId && skus.length) {
    const mapping = await tx.vendorProductMapping.findFirst({ where: { organizationId, vendorId, vendorSku: { in: skus }, active: true }, select: { variantId: true } });
    if (mapping) return { variantId: mapping.variantId, masterProductId: null, matchedBy: 'VENDOR_SKU' };
  }
  const upc = normalizeCode(ids.upc);
  if (upc) {
    const barcode = await tx.barcode.findFirst({ where: { organizationId, barcodeValue: upc }, select: { variantId: true, kind: true } });
    if (barcode) return { variantId: barcode.variantId, masterProductId: null, matchedBy: barcode.kind === 'ALTERNATE' ? 'ALTERNATE_UPC' : 'UPC' };
  }
  const caseUpc = normalizeCode(ids.caseUpc) ?? upc;
  if (caseUpc) {
    const mapping = await tx.vendorProductMapping.findFirst({ where: { organizationId, caseUpc, active: true }, select: { variantId: true } });
    if (mapping) return { variantId: mapping.variantId, masterProductId: null, matchedBy: 'CASE_UPC' };
  }
  const alternate = normalizeCode(ids.alternateUpc);
  if (alternate) {
    const barcode = await tx.barcode.findFirst({ where: { organizationId, barcodeValue: alternate }, select: { variantId: true } });
    if (barcode) return { variantId: barcode.variantId, masterProductId: null, matchedBy: 'ALTERNATE_UPC' };
  }
  for (const candidate of [upc, alternate].filter((value): value is string => Boolean(value))) {
    const master = await tx.masterProduct.findUnique({ where: { upc: candidate }, select: { id: true } });
    if (master) return { variantId: null, masterProductId: master.id, matchedBy: 'MASTER_CATALOG' };
  }
  return { variantId: null, masterProductId: null, matchedBy: null };
}

/**
 * Turns a line input into stored columns. The printed base/list price, each discount component and the net cost are all kept;
 * derived values (combined discount, net case/unit cost, extended amount) are computed here so they can never disagree with the parts.
 */
export function buildLineRecord(input: InvoiceLineInput, existing?: { quantity?: number }) {
  const kind: InvoiceLineKind = input.lineKind ?? 'PRODUCT';
  if (!input.description?.trim() || input.description.length > 300) throw new PosError('INVOICE_LINE_INVALID');
  const evidence = input.evidence ?? null;
  if (kind !== 'PRODUCT') {
    const amount = moneyOrNull(input.lineTotalMinor ?? input.unitCostMinor, 'INVOICE_LINE_TOTAL_INVALID');
    if (amount === null) throw new PosError('INVOICE_LINE_TOTAL_INVALID');
    return { economics: null, quantities: null, data: { lineKind: kind, description: input.description.trim(), quantity: 1, caseQuantity: 1, unitCostMinor: amount, lineTotalMinor: amount, notes: text(input.notes, 500), rawText: input.rawText?.slice(0, 2000) ?? null,
      ...(input.sourcePage === undefined ? {} : { sourcePage: input.sourcePage }), ...(input.confidence === undefined ? {} : { confidence: input.confidence }), evidence: (evidence ?? Prisma.DbNull) as Prisma.InputJsonValue } };
  }
  const unitsPerCase = input.caseQuantity ?? 1;
  if (!Number.isSafeInteger(unitsPerCase) || unitsPerCase < 1) throw new PosError('INVOICE_LINE_CASE_QUANTITY_INVALID');
  const shipped = countOrNull(input.casesShipped ?? input.quantity ?? existing?.quantity ?? 1, 'INVOICE_LINE_QUANTITY_INVALID')!;
  const receivedCases = countOrNull(input.casesReceived, 'INVOICE_LINE_QUANTITY_INVALID');
  const economics = resolveLineEconomics({ unitsPerCase, cases: shipped,
    listCaseMinor: moneyOrNull(input.listCaseMinor, 'INVOICE_LINE_COST_INVALID'), baseCaseMinor: moneyOrNull(input.caseCostMinor, 'INVOICE_LINE_COST_INVALID'), unitListMinor: moneyOrNull(input.unitListMinor, 'INVOICE_LINE_COST_INVALID'),
    netCaseMinor: moneyOrNull(input.netCaseCostMinor, 'INVOICE_LINE_COST_INVALID'), netUnitMinor: moneyOrNull(input.netUnitCostMinor, 'INVOICE_LINE_COST_INVALID'),
    postOffPerCaseMinor: moneyOrNull(input.postOffPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), qtyDiscountPerCaseMinor: moneyOrNull(input.qtyDiscountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'),
    caseDiscountPerCaseMinor: moneyOrNull(input.caseDiscountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), promoDiscountPerCaseMinor: moneyOrNull(input.promoDiscountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'),
    otherDiscountPerCaseMinor: moneyOrNull(input.otherDiscountPerCaseMinor ?? input.discountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), lineDiscountMinor: moneyOrNull(input.lineDiscountMinor, 'INVOICE_LINE_DISCOUNT_INVALID'),
    allowancePerCaseMinor: moneyOrNull(input.allowancePerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), rebatePerCaseMinor: moneyOrNull(input.rebatePerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'),
    printedExtendedMinor: moneyOrNull(input.lineTotalMinor, 'INVOICE_LINE_TOTAL_INVALID') });
  // A legacy "unit cost" is the pre-discount bottle cost when nothing else gave a base price.
  let base = economics;
  const legacyUnit = moneyOrNull(input.unitCostMinor, 'INVOICE_LINE_COST_INVALID');
  if (legacyUnit !== null && economics.warnings.some((warning) => warning.code === 'NO_BASE_COST')) {
    base = resolveLineEconomics({ unitsPerCase, cases: shipped, baseCaseMinor: legacyUnit * BigInt(unitsPerCase), otherDiscountPerCaseMinor: economics.discountPerCaseMinor, allowancePerCaseMinor: economics.components.allowance, rebatePerCaseMinor: economics.components.rebate });
  }
  const quantities = resolveQuantities({ unitsPerCase, casesOrdered: input.casesOrdered ?? null, casesShipped: shipped, casesReceived: receivedCases, casesRejected: count(input.casesRejected, 'INVOICE_LINE_QUANTITY_INVALID'),
    casesBackordered: count(input.casesBackordered, 'INVOICE_LINE_QUANTITY_INVALID'), looseUnitsReceived: count(input.looseUnitsReceived, 'INVOICE_LINE_QUANTITY_INVALID'), bonusUnits: count(input.bonusUnits, 'INVOICE_LINE_QUANTITY_INVALID'),
    unitsDamaged: count(input.unitsDamaged, 'INVOICE_LINE_QUANTITY_INVALID'), unitsBroken: count(input.unitsBroken, 'INVOICE_LINE_QUANTITY_INVALID'), unitsMissing: count(input.unitsMissing, 'INVOICE_LINE_QUANTITY_INVALID') });
  if (quantities.issues.length) throw new PosError(quantities.issues[0]!.code, 409);
  const printedTotal = moneyOrNull(input.lineTotalMinor, 'INVOICE_LINE_TOTAL_INVALID');
  const lineTotal = printedTotal ?? base.extendedMinor;
  // Remember that the total was computed here, not printed on the invoice, so a later edit recomputes it instead of leaving it stale.
  const withMarker: Record<string, FieldEvidence> | null = printedTotal === null ? { ...(evidence ?? {}), lineTotal: { label: DERIVED } } : evidence;
  const casesDamaged = count(input.casesDamaged, 'INVOICE_LINE_QUANTITY_INVALID');
  return { economics: base, quantities, data: {
    lineKind: kind, description: input.description.trim(), upc: normalizeCode(input.upc), caseUpc: normalizeCode(input.caseUpc), alternateUpc: normalizeCode(input.alternateUpc),
    vendorSku: text(input.vendorSku, 80), vendorItemNumber: text(input.vendorItemNumber, 80), brand: text(input.brand, 80), size: text(input.size, 40), packLabel: text(input.packLabel, 40), vintage: text(input.vintage, 20), categoryHint: text(input.categoryHint, 60),
    quantity: shipped, caseQuantity: unitsPerCase, casesReceived: receivedCases, casesOrdered: countOrNull(input.casesOrdered, 'INVOICE_LINE_QUANTITY_INVALID'), casesBackordered: count(input.casesBackordered, 'INVOICE_LINE_QUANTITY_INVALID'),
    casesRejected: count(input.casesRejected, 'INVOICE_LINE_QUANTITY_INVALID'), casesDamaged, unitsOrdered: countOrNull(input.unitsOrdered, 'INVOICE_LINE_QUANTITY_INVALID'), looseUnitsShipped: count(input.looseUnitsShipped, 'INVOICE_LINE_QUANTITY_INVALID'),
    looseUnitsReceived: count(input.looseUnitsReceived, 'INVOICE_LINE_QUANTITY_INVALID'), unitsDamaged: count(input.unitsDamaged, 'INVOICE_LINE_QUANTITY_INVALID'), unitsBroken: count(input.unitsBroken, 'INVOICE_LINE_QUANTITY_INVALID'),
    unitsMissing: count(input.unitsMissing, 'INVOICE_LINE_QUANTITY_INVALID'), bonusUnits: count(input.bonusUnits, 'INVOICE_LINE_QUANTITY_INVALID'),
    fulfillment: input.fulfillment ?? quantities.fulfillment, damageDisposition: input.damageDisposition ?? null,
    unitListMinor: moneyOrNull(input.unitListMinor, 'INVOICE_LINE_COST_INVALID'), listCaseMinor: moneyOrNull(input.listCaseMinor, 'INVOICE_LINE_COST_INVALID'), grossLineMinor: moneyOrNull(input.grossLineMinor, 'INVOICE_LINE_COST_INVALID'),
    caseCostMinor: base.baseCaseMinor, discountPerCaseMinor: base.discountPerCaseMinor, netCaseCostMinor: base.netCaseMinor, netUnitCostMinor: base.netUnitMinor, unitCostMinor: legacyUnit ?? base.baseCaseMinor / BigInt(unitsPerCase),
    postOffPerCaseMinor: moneyOrNull(input.postOffPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), qtyDiscountPerCaseMinor: moneyOrNull(input.qtyDiscountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), caseDiscountPerCaseMinor: moneyOrNull(input.caseDiscountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'),
    promoDiscountPerCaseMinor: moneyOrNull(input.promoDiscountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), otherDiscountPerCaseMinor: moneyOrNull(input.otherDiscountPerCaseMinor ?? input.discountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'),
    allowancePerCaseMinor: moneyOrNull(input.allowancePerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), rebatePerCaseMinor: moneyOrNull(input.rebatePerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID'), lineDiscountMinor: moneyOrNull(input.lineDiscountMinor, 'INVOICE_LINE_DISCOUNT_INVALID'),
    lineTotalMinor: lineTotal, lineTaxMinor: moneyOrNull(input.lineTaxMinor, 'INVOICE_LINE_TAX_INVALID'), ripCode: text(input.ripCode, 60), ripValueMinor: moneyOrNull(input.ripValueMinor, 'INVOICE_LINE_COST_INVALID'),
    temporaryDeal: input.temporaryDeal === true, dealEndsAt: input.dealEndsAt ? new Date(input.dealEndsAt) : null, standardCaseCostMinor: moneyOrNull(input.standardCaseCostMinor, 'INVOICE_LINE_COST_INVALID'),
    notes: text(input.notes, 500), rawText: input.rawText?.slice(0, 2000) ?? null, ...(input.sourcePage === undefined ? {} : { sourcePage: input.sourcePage }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }), evidence: (withMarker ?? Prisma.DbNull) as Prisma.InputJsonValue } };
}

/** Records who changed what, with old and new values, in the audit log the owner reads. */
export async function auditChange(client: Tx | PrismaClient, actor: AdminActor, data: { action: string; entityId: string; before?: Record<string, unknown>; after?: Record<string, unknown>; reason?: string; storeId?: string }) {
  const json = (value: Record<string, unknown> | undefined) => JSON.parse(JSON.stringify(value ?? {}, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))) as Prisma.InputJsonValue;
  await client.auditRecord.create({ data: { organizationId: actor.organizationId, userId: actor.userId, action: data.action, entityType: 'InvoiceDocument', entityId: data.entityId, ...(data.storeId ? { storeId: data.storeId } : {}),
    beforeJson: json(data.before), afterJson: json({ ...(data.after ?? {}), ...(data.reason ? { reason: data.reason } : {}) }) } });
}
/** Only the fields whose value actually changed, as { field: value } maps for before/after. */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const norm = (value: unknown) => (value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? value.toString() : value === undefined ? null : value);
  const out = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const key of Object.keys(after)) { if (JSON.stringify(norm(before[key])) !== JSON.stringify(norm(after[key]))) { out.before[key] = norm(before[key]); out.after[key] = norm(after[key]); } }
  return out;
}

// ---- Pages (multi-photo / multi-page invoices) ---------------------------------------------------------------------------
async function draftInvoice(client: Tx | PrismaClient, actor: AdminActor, id: string) {
  const document = await client.invoiceDocument.findFirst({ where: { id, organizationId: actor.organizationId, ...(actor.storeId ? { storeId: actor.storeId } : {}) } });
  if (!document) throw new PosError('INVOICE_NOT_FOUND', 404);
  if (document.reviewStatus !== 'DRAFT') throw new PosError('INVOICE_NOT_DRAFT', 409);
  return document;
}

/** Attaches another photo/page to the same invoice. The file is kept; its lines come from OCR or manual entry on the same invoice. */
export async function addInvoicePage(prisma: PrismaClient, actor: AdminActor, invoiceId: string, input: { originalFilename: string; mimeType: string; content: Buffer; documentHash: string; rawText?: string }) {
  const document = await draftInvoice(prisma, actor, invoiceId);
  const [dupDoc, dupPage] = await Promise.all([
    prisma.invoiceDocument.findFirst({ where: { organizationId: actor.organizationId, documentHash: input.documentHash }, select: { id: true } }),
    prisma.invoiceDocumentPage.findFirst({ where: { organizationId: actor.organizationId, documentHash: input.documentHash }, select: { id: true } }),
  ]);
  if (dupDoc || dupPage) throw new PosError('INVOICE_DUPLICATE_DOCUMENT', 409);
  return prisma.$transaction(async (tx) => {
    const pageNumber = document.pageCount + 1;
    const page = await tx.invoiceDocumentPage.create({ data: { organizationId: actor.organizationId, invoiceDocumentId: invoiceId, pageNumber, originalFilename: input.originalFilename.trim(), mimeType: input.mimeType,
      fileSize: input.content.length, documentHash: input.documentHash, documentData: Uint8Array.from(input.content), rawText: input.rawText?.slice(0, 20000) ?? null } });
    await tx.invoiceDocument.update({ where: { id: invoiceId }, data: { pageCount: pageNumber } });
    await auditChange(tx, actor, { action: 'INVOICE_PAGE_ADDED', entityId: invoiceId, after: { pageNumber, filename: page.originalFilename }, storeId: document.storeId });
    return { id: page.id, pageNumber, originalFilename: page.originalFilename, mimeType: page.mimeType, fileSize: page.fileSize };
  });
}

/** Other draft invoices that look like another page of this one (same vendor and invoice number). A person confirms; nothing merges automatically. */
export async function findContinuationCandidates(prisma: PrismaClient, actor: AdminActor, invoiceId: string) {
  const document = await prisma.invoiceDocument.findFirst({ where: { id: invoiceId, organizationId: actor.organizationId, ...(actor.storeId ? { storeId: actor.storeId } : {}) } });
  if (!document || !document.invoiceNumber) return [];
  const rows = await prisma.invoiceDocument.findMany({ where: { organizationId: actor.organizationId, storeId: document.storeId, id: { not: invoiceId }, reviewStatus: 'DRAFT', invoiceNumber: document.invoiceNumber,
    ...(document.vendorId ? { OR: [{ vendorId: document.vendorId }, { vendorId: null }] } : {}) }, select: { id: true, originalFilename: true, invoiceNumber: true, uploadedAt: true, pageCount: true, _count: { select: { lines: true } } }, take: 10 });
  return rows;
}

/** Folds another draft invoice (a photo of the next page) into this one: its file becomes a page and its lines/charges are appended in order. */
export async function mergeInvoiceDocuments(prisma: PrismaClient, actor: AdminActor, targetId: string, sourceId: string) {
  if (targetId === sourceId) throw new PosError('INVOICE_MERGE_INVALID');
  return prisma.$transaction(async (tx) => {
    const [target, source] = await Promise.all([draftInvoice(tx, actor, targetId), draftInvoice(tx, actor, sourceId)]);
    if (target.storeId !== source.storeId) throw new PosError('INVOICE_MERGE_INVALID');
    if (target.vendorId && source.vendorId && target.vendorId !== source.vendorId) throw new PosError('INVOICE_MERGE_VENDOR_MISMATCH', 409);
    let pageNumber = target.pageCount + 1;
    const sourcePages = await tx.invoiceDocumentPage.findMany({ where: { organizationId: actor.organizationId, invoiceDocumentId: sourceId }, orderBy: { pageNumber: 'asc' } });
    const firstPage = pageNumber;
    // The source's own file first, then any pages it had. Rows are moved, never copied twice.
    const mainHash = source.documentHash;
    await tx.invoiceDocumentPage.deleteMany({ where: { organizationId: actor.organizationId, invoiceDocumentId: sourceId } });
    await tx.invoiceDocumentPage.create({ data: { organizationId: actor.organizationId, invoiceDocumentId: targetId, pageNumber: pageNumber++, originalFilename: source.originalFilename, mimeType: source.mimeType, fileSize: source.fileSize,
      documentHash: `${mainHash}`, documentData: Uint8Array.from(source.documentData), rawText: source.rawText } });
    for (const page of sourcePages) await tx.invoiceDocumentPage.create({ data: { organizationId: actor.organizationId, invoiceDocumentId: targetId, pageNumber: pageNumber++, originalFilename: page.originalFilename, mimeType: page.mimeType, fileSize: page.fileSize,
      documentHash: page.documentHash, documentData: Uint8Array.from(page.documentData), rawText: page.rawText } });
    const maxLine = (await tx.invoiceLine.aggregate({ where: { organizationId: actor.organizationId, invoiceDocumentId: targetId }, _max: { lineNumber: true } }))._max.lineNumber ?? 0;
    const lines = await tx.invoiceLine.findMany({ where: { organizationId: actor.organizationId, invoiceDocumentId: sourceId }, orderBy: { lineNumber: 'asc' } });
    for (const [index, line] of lines.entries()) await tx.invoiceLine.update({ where: { id: line.id }, data: { invoiceDocumentId: targetId, lineNumber: maxLine + index + 1, sourcePage: line.sourcePage ?? firstPage } });
    await tx.invoiceCharge.updateMany({ where: { organizationId: actor.organizationId, invoiceDocumentId: sourceId }, data: { invoiceDocumentId: targetId } });
    // Header values the first page lacked are filled from the continuation; existing values are never overwritten.
    const fill: Prisma.InvoiceDocumentUncheckedUpdateInput = { pageCount: pageNumber - 1 };
    for (const key of ['vendorId', 'invoiceNumber', 'invoiceDate', 'poReference', 'orderNumber', 'paymentTerms', 'totalMinor', 'subtotalMinor', 'taxMinor', 'amountDueMinor'] as const) {
      if ((target as Record<string, unknown>)[key] === null && (source as Record<string, unknown>)[key] !== null) (fill as Record<string, unknown>)[key] = (source as Record<string, unknown>)[key];
    }
    await tx.invoiceDocument.update({ where: { id: targetId }, data: fill });
    await tx.invoiceDocument.delete({ where: { id: sourceId } });
    await auditChange(tx, actor, { action: 'INVOICE_PAGES_MERGED', entityId: targetId, before: { pageCount: target.pageCount }, after: { pageCount: pageNumber - 1, mergedFrom: source.originalFilename, linesMoved: lines.length }, storeId: target.storeId });
    return { id: targetId, pageCount: pageNumber - 1, linesMoved: lines.length };
  });
}

// ---- Invoice-level charges -----------------------------------------------------------------------------------------------
const CHARGE_KINDS = ['DELIVERY', 'FREIGHT', 'SERVICE', 'FUEL', 'FEE', 'DEPOSIT', 'TAX', 'CREDIT', 'OTHER'] as const;
export type ChargeInput = { kind: (typeof CHARGE_KINDS)[number]; label?: string; originalLabel?: string; amountMinor: string };

export async function saveInvoiceCharge(prisma: PrismaClient, actor: AdminActor, invoiceId: string, chargeId: string | null, input: Partial<ChargeInput>) {
  const document = await draftInvoice(prisma, actor, invoiceId);
  if (input.kind !== undefined && !CHARGE_KINDS.includes(input.kind)) throw new PosError('INVOICE_CHARGE_KIND_INVALID');
  const amount = input.amountMinor === undefined ? undefined : moneyOrNull(input.amountMinor, 'INVOICE_CHARGE_AMOUNT_INVALID');
  if (chargeId === null && (input.kind === undefined || amount === null || amount === undefined)) throw new PosError('INVOICE_CHARGE_INVALID');
  return prisma.$transaction(async (tx) => {
    if (chargeId === null) {
      const created = await tx.invoiceCharge.create({ data: { organizationId: actor.organizationId, invoiceDocumentId: invoiceId, kind: input.kind!, label: text(input.label, 80) ?? input.kind!.toLowerCase(), originalLabel: text(input.originalLabel, 80), amountMinor: amount! } });
      await auditChange(tx, actor, { action: 'INVOICE_CHARGE_ADDED', entityId: invoiceId, after: { kind: created.kind, amountMinor: created.amountMinor }, storeId: document.storeId });
      return created;
    }
    const current = await tx.invoiceCharge.findFirst({ where: { id: chargeId, invoiceDocumentId: invoiceId, organizationId: actor.organizationId } });
    if (!current) throw new PosError('INVOICE_CHARGE_NOT_FOUND', 404);
    const updated = await tx.invoiceCharge.update({ where: { id: chargeId }, data: { ...(input.kind === undefined ? {} : { kind: input.kind }), ...(input.label === undefined ? {} : { label: text(input.label, 80) ?? current.label }), ...(amount === undefined || amount === null ? {} : { amountMinor: amount }) } });
    const diff = changedFields({ kind: current.kind, label: current.label, amountMinor: current.amountMinor }, { kind: updated.kind, label: updated.label, amountMinor: updated.amountMinor });
    await auditChange(tx, actor, { action: 'INVOICE_CHARGE_CHANGED', entityId: invoiceId, before: diff.before, after: diff.after, storeId: document.storeId });
    return updated;
  });
}
export async function removeInvoiceCharge(prisma: PrismaClient, actor: AdminActor, invoiceId: string, chargeId: string) {
  const document = await draftInvoice(prisma, actor, invoiceId);
  const current = await prisma.invoiceCharge.findFirst({ where: { id: chargeId, invoiceDocumentId: invoiceId, organizationId: actor.organizationId } });
  if (!current) throw new PosError('INVOICE_CHARGE_NOT_FOUND', 404);
  await prisma.$transaction(async (tx) => { await tx.invoiceCharge.delete({ where: { id: chargeId } }); await auditChange(tx, actor, { action: 'INVOICE_CHARGE_REMOVED', entityId: invoiceId, before: { kind: current.kind, amountMinor: current.amountMinor }, storeId: document.storeId }); });
  return { id: chargeId, removed: true as const };
}

// ---- Manual line entry (same capability as OCR) --------------------------------------------------------------------------
export async function addInvoiceLine(prisma: PrismaClient, actor: AdminActor, invoiceId: string, input: InvoiceLineInput) {
  const document = await draftInvoice(prisma, actor, invoiceId);
  const { data } = buildLineRecord(input);
  return prisma.$transaction(async (tx) => {
    const last = (await tx.invoiceLine.aggregate({ where: { organizationId: actor.organizationId, invoiceDocumentId: invoiceId }, _max: { lineNumber: true } }))._max.lineNumber ?? 0;
    const product = data.lineKind === 'PRODUCT';
    const match = product ? await matchInvoiceLine(tx, actor.organizationId, document.vendorId, { vendorSku: data.vendorSku, vendorItemNumber: data.vendorItemNumber, upc: data.upc, caseUpc: data.caseUpc, alternateUpc: data.alternateUpc }) : { variantId: null, masterProductId: null, matchedBy: null };
    const matchStatus: InvoiceLineMatchStatus = !product ? 'MATCHED' : match.variantId ? 'MATCHED' : match.masterProductId ? 'MASTER_CATALOG' : 'NEEDS_REVIEW';
    const line = await tx.invoiceLine.create({ data: { ...data, organizationId: actor.organizationId, invoiceDocumentId: invoiceId, lineNumber: last + 1, matchStatus, variantId: match.variantId, masterProductId: match.masterProductId } as Prisma.InvoiceLineUncheckedCreateInput });
    // Typing lines into a draft whose OCR failed or never ran makes it a manual invoice, ready for review like any other.
    if (document.ocrStatus === 'FAILED' || document.ocrStatus === 'PENDING') await tx.invoiceDocument.update({ where: { id: invoiceId }, data: { ocrStatus: 'COMPLETED', ocrProvider: document.ocrProvider ?? 'MANUAL' } });
    await auditChange(tx, actor, { action: 'INVOICE_LINE_ADDED', entityId: invoiceId, after: { lineId: line.id, description: line.description, kind: line.lineKind, matchedBy: match.matchedBy, entry: 'MANUAL' }, storeId: document.storeId });
    return line;
  });
}

export async function removeInvoiceLine(prisma: PrismaClient, actor: AdminActor, invoiceId: string, lineId: string) {
  const document = await draftInvoice(prisma, actor, invoiceId);
  const line = await prisma.invoiceLine.findFirst({ where: { id: lineId, invoiceDocumentId: invoiceId, organizationId: actor.organizationId } });
  if (!line) throw new PosError('INVOICE_LINE_NOT_FOUND', 404);
  await prisma.$transaction(async (tx) => { await tx.invoiceLine.delete({ where: { id: lineId } }); await auditChange(tx, actor, { action: 'INVOICE_LINE_REMOVED', entityId: invoiceId, before: { lineId, description: line.description, lineTotalMinor: line.lineTotalMinor }, storeId: document.storeId }); });
  return { id: lineId, removed: true as const };
}

// ---- Review extension -----------------------------------------------------------------------------------------------------
type ReviewLine = Prisma.InvoiceLineGetPayload<Record<string, never>>;

const STAGES = ['Upload', 'Header', 'Matching', 'Costs', 'Receiving', 'Discrepancies', 'Reconciliation', 'Confirm'] as const;

/**
 * Extra review facts for the receiving screen: canonical economics, quantities, order vs invoice vs receipt, cost-change and margin impact,
 * charges, reconciliation, duplicate evidence, and the blockers that must be cleared before Final Confirmation. Computed from stored data only.
 */
export async function getReceivingReview(prisma: PrismaClient, actor: AdminActor, id: string) {
  const document = await prisma.invoiceDocument.findFirst({ where: { id, organizationId: actor.organizationId, ...(actor.storeId ? { storeId: actor.storeId } : {}) },
    include: { lines: { orderBy: { lineNumber: 'asc' } }, charges: true, purchaseOrder: { include: { lines: true } } } });
  if (!document) throw new PosError('INVOICE_NOT_FOUND', 404);
  const org = actor.organizationId;
  const productLines = document.lines.filter((line) => line.lineKind === 'PRODUCT');
  const variantIds = productLines.map((line) => line.variantId).filter((value): value is string => Boolean(value));
  const at = document.invoiceDate ?? new Date();
  const [mappings, prices] = variantIds.length && document.vendorId
    ? await Promise.all([
      prisma.vendorProductMapping.findMany({ where: { organizationId: org, vendorId: document.vendorId, variantId: { in: variantIds }, active: true } }),
      prisma.price.findMany({ where: { organizationId: org, storeId: document.storeId, variantId: { in: variantIds }, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }, orderBy: { effectiveFrom: 'desc' } }),
    ])
    : [[], variantIds.length ? await prisma.price.findMany({ where: { organizationId: org, storeId: document.storeId, variantId: { in: variantIds }, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }, orderBy: { effectiveFrom: 'desc' } }) : []];
  const lines = productLines.map((line: ReviewLine) => {
    const economics = resolveLineEconomics({ unitsPerCase: line.caseQuantity, cases: line.quantity, baseCaseMinor: line.caseCostMinor, postOffPerCaseMinor: line.postOffPerCaseMinor, qtyDiscountPerCaseMinor: line.qtyDiscountPerCaseMinor,
      caseDiscountPerCaseMinor: line.caseDiscountPerCaseMinor, promoDiscountPerCaseMinor: line.promoDiscountPerCaseMinor, otherDiscountPerCaseMinor: line.otherDiscountPerCaseMinor ?? (line.postOffPerCaseMinor || line.qtyDiscountPerCaseMinor || line.caseDiscountPerCaseMinor || line.promoDiscountPerCaseMinor ? null : line.discountPerCaseMinor),
      allowancePerCaseMinor: line.allowancePerCaseMinor, rebatePerCaseMinor: line.rebatePerCaseMinor, printedExtendedMinor: line.lineTotalMinor });
    const quantities = resolveQuantities({ unitsPerCase: line.caseQuantity, casesOrdered: line.casesOrdered, casesShipped: line.quantity, casesReceived: line.casesReceived, casesRejected: line.casesRejected, casesBackordered: line.casesBackordered,
      looseUnitsReceived: line.looseUnitsReceived, bonusUnits: line.bonusUnits, unitsDamaged: line.unitsDamaged, unitsBroken: line.unitsBroken, unitsMissing: line.unitsMissing });
    const mapping = mappings.find((candidate) => candidate.variantId === line.variantId);
    const poLine = document.purchaseOrder?.lines.find((candidate) => candidate.variantId === line.variantId);
    const retail = prices.find((candidate) => candidate.variantId === line.variantId)?.amountMinor ?? null;
    const costChange = assessCostChange({ previousCaseMinor: mapping?.caseCostMinor ?? (mapping ? mapping.vendorCostMinor * BigInt(mapping.casePackQuantity) : null), invoiceCaseMinor: economics.baseCaseMinor, unitsPerCase: line.caseQuantity, retailMinor: retail });
    const effectiveCostChange = line.temporaryDeal ? assessCostChange({ previousCaseMinor: line.standardCaseCostMinor ?? mapping?.caseCostMinor ?? null, invoiceCaseMinor: economics.netCaseMinor, unitsPerCase: line.caseQuantity, retailMinor: retail }) : null;
    const comparison = compareOrderInvoiceReceipt({ orderedUnits: poLine ? poLine.orderedQuantity : line.casesOrdered === null ? null : line.casesOrdered * line.caseQuantity, invoicedUnits: quantities.invoicedUnits, receivedUnits: quantities.receivedUnits,
      poUnitCostMinor: poLine?.unitCostMinor ?? null, invoiceUnitCostMinor: economics.netUnitMinor, backorderedUnits: quantities.backorderedUnits });
    const remaining = poLine ? poLine.orderedQuantity - poLine.receivedQuantity : null;
    const issues: string[] = [];
    if (!line.variantId && !line.newProductData && !line.ignored) issues.push('NEEDS_MATCH');
    if (remaining !== null && quantities.receivedUnits > remaining && !line.ignored) issues.push('OVER_SHIPMENT_EXCEEDS_PO');
    if (quantities.damagedUnits > 0 && !line.damageDisposition && !line.ignored) issues.push('DAMAGE_DISPOSITION_REQUIRED');
    if (line.temporaryDeal && line.dealEndsAt === null && !line.ignored) issues.push('TEMPORARY_DEAL_NEEDS_END_DATE');
    return { lineId: line.id, lineNumber: line.lineNumber, ignored: line.ignored, matched: Boolean(line.variantId), economics: { ...economics, warnings: economics.warnings.map((warning) => warning.code) }, quantities, comparison, costChange, effectiveCostChange,
      lowConfidence: line.confidence !== null && Number(line.confidence) < 0.8, issues };
  });
  const nonInventory = document.lines.filter((line) => line.lineKind !== 'PRODUCT');
  const chargeTotal = document.charges.reduce((sum, charge) => (['CREDIT'].includes(charge.kind) ? sum : charge.kind === 'TAX' ? sum : sum + charge.amountMinor), 0n)
    + nonInventory.filter((line) => !['CREDIT', 'REBATE'].includes(line.lineKind)).reduce((sum, line) => sum + line.lineTotalMinor, 0n);
  const credits = document.charges.filter((charge) => charge.kind === 'CREDIT').reduce((sum, charge) => sum + charge.amountMinor, 0n)
    + nonInventory.filter((line) => ['CREDIT', 'REBATE'].includes(line.lineKind)).reduce((sum, line) => sum + line.lineTotalMinor, 0n) + (document.creditMinor ?? 0n);
  const extraTax = document.charges.filter((charge) => charge.kind === 'TAX').reduce((sum, charge) => sum + charge.amountMinor, 0n);
  const reconciliation = reconcileInvoice({ lineExtendedMinor: productLines.filter((line) => !line.ignored).map((line) => line.lineTotalMinor), chargesMinor: chargeTotal + (document.feesMinor ?? 0n), taxMinor: (document.taxMinor ?? 0n) + extraTax,
    depositMinor: document.depositMinor ?? 0n, creditMinor: credits, invoiceTotalMinor: document.totalMinor ?? document.invoiceNetMinor, amountDueMinor: document.amountDueMinor });
  // PO lines the invoice never mentions.
  const invoiceVariants = new Set(variantIds);
  const missingFromInvoice = (document.purchaseOrder?.lines ?? []).filter((poLine) => poLine.receivedQuantity < poLine.orderedQuantity && !invoiceVariants.has(poLine.variantId))
    .map((poLine) => ({ variantId: poLine.variantId, productName: poLine.productNameSnapshot, variantName: poLine.variantNameSnapshot, outstandingUnits: poLine.orderedQuantity - poLine.receivedQuantity }));
  const exactDuplicate = document.vendorId && document.invoiceNumber ? await prisma.invoiceDocument.findFirst({ where: { organizationId: org, id: { not: id }, reviewStatus: 'CONFIRMED', vendorId: document.vendorId, invoiceNumber: document.invoiceNumber,
    ...(document.totalMinor === null ? {} : { totalMinor: document.totalMinor }) }, select: { id: true, confirmedAt: true } }) : null;
  const continuation = await findContinuationCandidates(prisma, actor, id);
  const blockers: Array<{ code: string; message: string }> = [];
  if (!document.vendorId) blockers.push({ code: 'VENDOR_REQUIRED', message: 'Choose the vendor.' });
  if (exactDuplicate) blockers.push({ code: 'ALREADY_RECEIVED', message: 'This vendor invoice number was already received and confirmed.' });
  if (lines.some((line) => line.issues.includes('NEEDS_MATCH'))) blockers.push({ code: 'LINES_NEED_MATCH', message: 'Match, create, or ignore every unmatched line.' });
  if (lines.some((line) => line.issues.includes('OVER_SHIPMENT_EXCEEDS_PO'))) blockers.push({ code: 'OVER_SHIPMENT', message: 'A line is received above the open purchase order quantity. Change the received quantity or detach the purchase order.' });
  if (lines.some((line) => line.issues.includes('DAMAGE_DISPOSITION_REQUIRED'))) blockers.push({ code: 'DAMAGE_DISPOSITION', message: 'Choose what happens to damaged or broken units.' });
  const warnings: Array<{ code: string; message: string }> = [];
  if (document.possibleDuplicate) warnings.push({ code: 'PROBABLE_DUPLICATE', message: 'A similar invoice exists for this vendor. Check it is not the same delivery.' });
  if (reconciliation.status === 'MATERIAL_DIFFERENCE') warnings.push({ code: 'TOTAL_MATERIAL_DIFFERENCE', message: 'The calculated total differs materially from the invoice total. A note is required to confirm.' });
  if (reconciliation.status === 'MINOR_DIFFERENCE') warnings.push({ code: 'TOTAL_MINOR_DIFFERENCE', message: 'The calculated total differs slightly from the invoice total (rounding?).' });
  if (lines.some((line) => line.costChange.significant)) warnings.push({ code: 'COST_CHANGE', message: 'One or more case costs changed significantly. Review pricing; retail prices are never changed automatically.' });
  if (lines.some((line) => line.lowConfidence)) warnings.push({ code: 'LOW_CONFIDENCE', message: 'Some extracted values have low confidence. Check them against the invoice.' });
  if (continuation.length) warnings.push({ code: 'POSSIBLE_CONTINUATION', message: 'Another draft has the same invoice number and may be another page of this invoice.' });
  const noPosting = ['CREDIT_MEMO', 'ADJUSTMENT', 'BACKORDER'].includes(document.docType);
  return { docType: document.docType, postsInventory: !noPosting, stages: STAGES, lines, nonInventoryLines: nonInventory.map((line) => ({ lineId: line.id, kind: line.lineKind, description: line.description, amountMinor: line.lineTotalMinor })), charges: document.charges,
    adjustments: { chargesMinor: chargeTotal + (document.depositMinor ?? 0n), creditsMinor: credits, extraTaxMinor: extraTax }, reconciliation, missingFromInvoice, exactDuplicate: exactDuplicate ? { invoiceId: exactDuplicate.id, confirmedAt: exactDuplicate.confirmedAt } : null, continuation, blockers, warnings,
    requiresNote: reconciliation.status === 'MATERIAL_DIFFERENCE' };
}

export type ReceivingComparisonFlag = ComparisonFlag;
export type { ReceivingDisposition };

// ---- Printed-column adapter -------------------------------------------------------------------------------------------------
const dollarsToMinor = (value: string): string | null => {
  const match = /^\s*\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(value);
  return match ? String(BigInt(match[1]!.replace(/,/g, '')) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')) : null;
};
export type PrintedField = { label: string; value: string; page?: number; confidence?: number };
export type PrintedLineResult = { line: InvoiceLineInput; unmapped: PrintedField[]; ambiguous: Array<{ label: string; mappedTo: string }>; unreadable: PrintedField[] };

/**
 * Vendor-specific adapters read printed columns as label/value pairs; this maps them into the canonical line using
 * normalizeVendorLabel, converts per-bottle amounts to per-case, and keeps every label and original value as evidence.
 * Labels it does not know are returned in `unmapped` (and kept in evidence), never dropped.
 */
export function lineFromPrintedFields(fields: PrintedField[], defaults: { unitsPerCase?: number; description?: string } = {}): PrintedLineResult {
  const evidence: Record<string, FieldEvidence> = {};
  const unmapped: PrintedField[] = []; const ambiguous: PrintedLineResult['ambiguous'] = []; const unreadable: PrintedField[] = [];
  const mapped = fields.map((field) => ({ field, mapping: normalizeVendorLabel(field.label) }));
  const packField = mapped.find((entry) => entry.mapping?.field === 'pack');
  const packMatch = packField ? /^\s*(\d+)/.exec(packField.field.value) : null;
  const unitsPerCase = packMatch ? Number(packMatch[1]) : defaults.unitsPerCase ?? 1;
  const line: Record<string, unknown> = { description: defaults.description ?? '', caseQuantity: unitsPerCase };
  const money = (entry: { field: PrintedField }): string | null => { const value = dollarsToMinor(entry.field.value); if (value === null) unreadable.push(entry.field); return value; };
  for (const entry of mapped) {
    const { field, mapping } = entry;
    if (!mapping) { unmapped.push(field); evidence[`extra:${field.label}`] = { label: field.label, original: field.value, ...(field.page === undefined ? {} : { page: field.page }) }; continue; }
    if (mapping.ambiguous) ambiguous.push({ label: field.label, mappedTo: mapping.field });
    const toCase = (minor: string | null): string | undefined => (minor === null ? undefined : mapping.scope === 'unit' ? String(BigInt(minor) * BigInt(unitsPerCase)) : minor);
    const set = (key: string, value: unknown) => { if (value !== undefined && value !== null) { line[key] = value; evidence[key] = { label: field.label, original: field.value, normalized: String(value), ...(field.confidence === undefined ? {} : { confidence: field.confidence }), ...(field.page === undefined ? {} : { page: field.page }) }; } };
    switch (mapping.field) {
      case 'vendorItem': set('vendorItemNumber', field.value.trim()); break;
      case 'description': set('description', field.value.trim()); break;
      case 'size': set('size', field.value.trim()); break;
      case 'pack': set('packLabel', field.value.trim()); set('caseQuantity', unitsPerCase); break;
      case 'vintage': set('vintage', field.value.trim()); break;
      case 'upc': set('upc', field.value.trim()); break;
      case 'cases': { const n = Number(field.value.replace(/\D/g, '')); if (Number.isFinite(n) && field.value.trim()) set('casesShipped', n); else unreadable.push(field); break; }
      case 'bottles': { const n = Number(field.value.replace(/\D/g, '')); if (Number.isFinite(n) && field.value.trim()) set('looseUnitsShipped', n); else unreadable.push(field); break; }
      case 'rip': set('ripCode', field.value.trim()); break;
      case 'unitList': set('unitListMinor', money(entry) ?? undefined); break;
      case 'listCase': set('listCaseMinor', money(entry) ?? undefined); break;
      case 'baseCase': set('caseCostMinor', money(entry) ?? undefined); break;
      case 'grossLine': set('grossLineMinor', money(entry) ?? undefined); break;
      case 'lineDiscount': set('lineDiscountMinor', money(entry) ?? undefined); break;
      case 'postOff': set('postOffPerCaseMinor', toCase(money(entry))); break;
      case 'qtyDiscount': set('qtyDiscountPerCaseMinor', toCase(money(entry))); break;
      case 'caseDiscount': set('caseDiscountPerCaseMinor', toCase(money(entry))); break;
      case 'promoDiscount': set('promoDiscountPerCaseMinor', toCase(money(entry))); break;
      case 'otherDiscount': set('otherDiscountPerCaseMinor', toCase(money(entry))); break;
      case 'allowance': set('allowancePerCaseMinor', toCase(money(entry))); break;
      case 'rebate': set('rebatePerCaseMinor', toCase(money(entry))); break;
      case 'netUnitCost': set('netUnitCostMinor', money(entry) ?? undefined); break;
      case 'netCaseCost': set('netCaseCostMinor', money(entry) ?? undefined); break;
      case 'extendedPrice': set('lineTotalMinor', money(entry) ?? undefined); break;
    }
  }
  line.evidence = evidence;
  return { line: line as unknown as InvoiceLineInput, unmapped, ambiguous, unreadable };
}
