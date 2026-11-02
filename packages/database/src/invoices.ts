import { Prisma, type InvoiceLineMatchStatus, type PrismaClient } from '@prisma/client';
import { applyVendorDeals, reviewInvoiceLine, reviewInvoiceTotals, unitCostFromCase } from '@rjpos/domain-types';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { createPurchaseOrder, receivePurchaseOrder, transitionPurchaseOrder } from './purchasing.js';
import { addMasterProductToStore, saveVendorMapping } from './purchasing.js';
import { createProduct, createVariant, schedulePrice } from './back-office.js';
import { createVendorClaim } from './vendor-claims.js';
import { DERIVED, auditChange, buildLineRecord, changedFields, getReceivingReview, matchInvoiceLine, moneyOrNull, type ChargeInput, type FieldEvidence, type InvoiceLineInput } from './invoice-receiving.js';
import { createHash, randomUUID } from 'node:crypto';

/** One extracted line. Canonical fields live in InvoiceLineInput; vendor-specific labels go in `evidence` and are never discarded. */
export type InvoiceOcrLine = Omit<InvoiceLineInput, 'quantity'> & { quantity?: number };

/** Header fields a distributor may print. None is required; unknown printed fields go to `extras` as label/value pairs. */
export type InvoiceHeaderInput = {
  docType?: 'INVOICE' | 'CREDIT_MEMO' | 'DELIVERY_RECEIPT' | 'BACKORDER' | 'ADJUSTMENT';
  vendorName?: string; vendorAccountNumber?: string; vendorAddress?: string; vendorPhone?: string; billTo?: string; shipTo?: string; customerAccountNumber?: string; licenseNumber?: string;
  invoiceNumber?: string; invoiceDate?: string; orderNumber?: string; poReference?: string; documentNumber?: string; shipDate?: string; deliveryDate?: string; dueDate?: string;
  routeReference?: string; salesperson?: string; customerTerms?: string; paymentTerms?: string;
  subtotalMinor?: string; discountMinor?: string; rebateMinor?: string; taxMinor?: string; feesMinor?: string; totalMinor?: string;
  grossMerchandiseMinor?: string; postOffTotalMinor?: string; depositMinor?: string; creditMinor?: string; amountDueMinor?: string; invoiceNetMinor?: string;
  summaryMetadata?: Record<string, unknown> | null; remittanceMetadata?: Record<string, unknown> | null; extras?: Array<{ label: string; value: string }> | null;
};

export type InvoiceOcrResult = InvoiceHeaderInput & {
  rawText?: string;
  confidence?: number;
  provider: string;
  rawReference?: Record<string, unknown>;
  /** Per canonical header field: the printed label/value, normalized value, confidence, page. */
  fieldEvidence?: Record<string, FieldEvidence>;
  charges?: ChargeInput[];
  /** 1-based page this result was read from, and whether the document says it continues. */
  pageNumber?: number; continued?: boolean;
  lines: InvoiceOcrLine[];
};

export type InvoiceNewProductDraft = {
  categoryId: string;
  productName: string;
  variantName: string;
  sku: string;
  barcode?: string;
  priceMinor: string;
  brand?: string;
  ageRestricted?: boolean;
};

const invoiceInclude = {
  charges: true,
  pages: { select: { id: true, pageNumber: true, originalFilename: true, mimeType: true, fileSize: true, uploadedAt: true }, orderBy: { pageNumber: 'asc' as const } },
  vendor: true,
  store: true,
  purchaseOrder: true,
  uploadedBy: { select: { id: true, firstName: true, lastName: true } },
  lines: { include: { variant: { include: { product: true, barcodes: true } }, masterProduct: true }, orderBy: { lineNumber: 'asc' as const } },
};

async function audit(prisma: PrismaClient, actor: AdminActor, action: string, entityId: string, after?: Prisma.InputJsonValue) {
  await prisma.auditRecord.create({ data: { organizationId: actor.organizationId, userId: actor.userId, action, entityType: 'InvoiceDocument', entityId, ...(after === undefined ? {} : { afterJson: after }) } });
}

export async function createInvoiceDocument(prisma: PrismaClient, actor: AdminActor, input: {
  storeId?: string; vendorId?: string; purchaseOrderId?: string; originalFilename: string; mimeType: string;
  content: Buffer; documentHash: string;
}) {
  const storeId = input.storeId ?? actor.storeId;
  if (!storeId || (actor.storeId && actor.storeId !== storeId)) throw new PosError('STORE_ACCESS_DENIED', 403);
  const [store, employee, duplicate, vendor, purchaseOrder] = await Promise.all([
    prisma.store.findFirst({ where: { id: storeId, organizationId: actor.organizationId, status: 'ACTIVE' } }),
    prisma.employee.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId, status: 'ACTIVE', stores: { some: { storeId } } } }),
    prisma.invoiceDocument.findFirst({ where: { organizationId: actor.organizationId, documentHash: input.documentHash } }),
    input.vendorId ? prisma.vendor.findFirst({ where: { id: input.vendorId, organizationId: actor.organizationId, active: true } }) : null,
    input.purchaseOrderId ? prisma.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, organizationId: actor.organizationId, storeId } }) : null,
  ]);
  if (!store) throw new PosError('STORE_NOT_FOUND', 404);
  if (!employee) throw new PosError('INVOICE_UPLOADER_NOT_ALLOWED', 403);
  if (duplicate) throw new PosError('INVOICE_DUPLICATE_DOCUMENT', 409);
  if (input.vendorId && !vendor) throw new PosError('VENDOR_NOT_FOUND', 404);
  if (input.purchaseOrderId && !purchaseOrder) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
  const document = await prisma.invoiceDocument.create({ data: {
    organizationId: actor.organizationId, storeId, vendorId: vendor?.id ?? null, purchaseOrderId: purchaseOrder?.id ?? null,
    uploadedByEmployeeId: actor.userId, originalFilename: input.originalFilename.trim(), mimeType: input.mimeType,
    fileSize: input.content.length, storageReference: `database://${input.documentHash}`, documentHash: input.documentHash,
    documentData: Uint8Array.from(input.content),
  } });
  await audit(prisma, actor, 'INVOICE_UPLOADED', document.id, { filename: document.originalFilename, mimeType: document.mimeType, fileSize: document.fileSize });
  return getInvoiceDocument(prisma, actor, document.id);
}

export async function listInvoiceDocuments(prisma: PrismaClient, actor: AdminActor) {
  return prisma.invoiceDocument.findMany({ where: { organizationId: actor.organizationId, ...(actor.storeId ? { storeId: actor.storeId } : {}) },
    select: { id: true, originalFilename: true, uploadedAt: true, ocrStatus: true, reviewStatus: true, invoiceNumber: true,
      totalMinor: true, possibleDuplicate: true, vendor: { select: { id: true, name: true } }, store: { select: { id: true, name: true } },
      _count: { select: { lines: true } } }, orderBy: { uploadedAt: 'desc' } });
}

export async function getInvoiceDocument(prisma: PrismaClient, actor: AdminActor, id: string) {
  const document = await prisma.invoiceDocument.findFirst({ where: { id, organizationId: actor.organizationId,
    ...(actor.storeId ? { storeId: actor.storeId } : {}) }, include: invoiceInclude });
  if (!document) throw new PosError('INVOICE_NOT_FOUND', 404);
  const { documentData: _documentData, ...safe } = document;
  return safe;
}

export async function getInvoiceDocumentInput(prisma: PrismaClient, actor: AdminActor, id: string) {
  const document = await prisma.invoiceDocument.findFirst({ where: { id, organizationId: actor.organizationId,
    ...(actor.storeId ? { storeId: actor.storeId } : {}) } });
  if (!document) throw new PosError('INVOICE_NOT_FOUND', 404);
  if (document.reviewStatus !== 'DRAFT') throw new PosError('INVOICE_NOT_DRAFT', 409);
  return document;
}

export async function markInvoiceOcrProcessing(prisma: PrismaClient, actor: AdminActor, id: string) {
  await getInvoiceDocumentInput(prisma, actor, id);
  await prisma.invoiceDocument.update({ where: { id }, data: { ocrStatus: 'PROCESSING', ocrError: null } });
  await audit(prisma, actor, 'INVOICE_OCR_STARTED', id);
}

export async function markInvoiceOcrFailed(prisma: PrismaClient, actor: AdminActor, id: string, provider: string, error: string) {
  await prisma.invoiceDocument.updateMany({ where: { id, organizationId: actor.organizationId, reviewStatus: 'DRAFT' },
    data: { ocrStatus: 'FAILED', ocrProvider: provider, ocrError: error.slice(0, 500) } });
  await audit(prisma, actor, 'INVOICE_OCR_FAILED', id, { provider });
  return getInvoiceDocument(prisma, actor, id);
}

const HEADER_TEXT = ['vendorAccountNumber', 'vendorAddress', 'vendorPhone', 'billTo', 'shipTo', 'customerAccountNumber', 'licenseNumber', 'orderNumber', 'documentNumber', 'routeReference', 'salesperson', 'customerTerms', 'paymentTerms'] as const;
const HEADER_DATES = ['shipDate', 'deliveryDate', 'dueDate'] as const;
const HEADER_MONEY: Array<[keyof InvoiceHeaderInput, string, string]> = [['grossMerchandiseMinor', 'grossMerchandiseMinor', 'INVOICE_TOTAL_INVALID'], ['postOffTotalMinor', 'postOffTotalMinor', 'INVOICE_TOTAL_INVALID'], ['depositMinor', 'depositMinor', 'INVOICE_TOTAL_INVALID'],
  ['creditMinor', 'creditMinor', 'INVOICE_TOTAL_INVALID'], ['amountDueMinor', 'amountDueMinor', 'INVOICE_TOTAL_INVALID'], ['invoiceNetMinor', 'invoiceNetMinor', 'INVOICE_TOTAL_INVALID']];
const DOC_TYPES = ['INVOICE', 'CREDIT_MEMO', 'DELIVERY_RECEIPT', 'BACKORDER', 'ADJUSTMENT'];

/** Canonical header columns from a header input. Only keys present in the input are returned, so edits never blank other fields. */
function headerData(input: InvoiceHeaderInput): Prisma.InvoiceDocumentUncheckedUpdateInput {
  const data: Record<string, unknown> = {};
  if (input.docType !== undefined) { if (!DOC_TYPES.includes(input.docType)) throw new PosError('INVOICE_DOC_TYPE_INVALID'); data.docType = input.docType; }
  for (const key of HEADER_TEXT) if (input[key] !== undefined) data[key] = input[key]?.trim().slice(0, 300) || null;
  for (const key of HEADER_DATES) if (input[key] !== undefined) { const value = input[key] ? new Date(input[key]!) : null; if (value && Number.isNaN(value.getTime())) throw new PosError('INVOICE_DATE_INVALID'); data[key] = value; }
  for (const [key, column, code] of HEADER_MONEY) if (input[key] !== undefined) data[column] = moneyOrNull(input[key] as string, code);
  if (input.summaryMetadata !== undefined) data.summaryMetadata = input.summaryMetadata === null ? Prisma.DbNull : (input.summaryMetadata as Prisma.InputJsonValue);
  if (input.remittanceMetadata !== undefined) data.remittanceMetadata = input.remittanceMetadata === null ? Prisma.DbNull : (input.remittanceMetadata as Prisma.InputJsonValue);
  if (input.extras !== undefined) data.vendorExtras = input.extras === null ? Prisma.DbNull : (input.extras as Prisma.InputJsonValue);
  return data as Prisma.InvoiceDocumentUncheckedUpdateInput;
}

/**
 * Adds what OCR read from an additional page to the SAME invoice: lines are appended in order, charges are added, and header values the
 * first page lacked are filled in. Values already on the invoice are never overwritten by a later page.
 */
export async function appendInvoiceOcrResult(prisma: PrismaClient, actor: AdminActor, id: string, pageNumber: number, result: InvoiceOcrResult) {
  const document = await getInvoiceDocumentInput(prisma, actor, id);
  await prisma.$transaction(async (tx) => {
    const last = (await tx.invoiceLine.aggregate({ where: { organizationId: actor.organizationId, invoiceDocumentId: id }, _max: { lineNumber: true } }))._max.lineNumber ?? 0;
    for (const [index, raw] of result.lines.entries()) {
      const { data } = buildLineRecord({ ...raw, sourcePage: pageNumber });
      const product = data.lineKind === 'PRODUCT';
      const match = product ? await matchInvoiceLine(tx, actor.organizationId, document.vendorId, data as unknown as Record<string, string | null>) : { variantId: null, masterProductId: null, matchedBy: null };
      await tx.invoiceLine.create({ data: { ...data, organizationId: actor.organizationId, invoiceDocumentId: id, lineNumber: last + index + 1, variantId: match.variantId, masterProductId: match.masterProductId,
        matchStatus: !product || match.variantId ? 'MATCHED' : match.masterProductId ? 'MASTER_CATALOG' : 'NEEDS_REVIEW' } as Prisma.InvoiceLineUncheckedCreateInput });
    }
    for (const charge of result.charges ?? []) await tx.invoiceCharge.create({ data: { organizationId: actor.organizationId, invoiceDocumentId: id, kind: charge.kind, label: charge.label?.trim() || charge.kind.toLowerCase(), originalLabel: charge.originalLabel?.trim() || null, amountMinor: moneyOrNull(charge.amountMinor, 'INVOICE_CHARGE_AMOUNT_INVALID') ?? 0n } });
    const header = headerData(result) as Record<string, unknown>; const fill: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(header)) if ((document as Record<string, unknown>)[key] === null || (document as Record<string, unknown>)[key] === undefined) fill[key] = value;
    const plain: Array<[string, unknown]> = [['invoiceNumber', result.invoiceNumber?.trim() || null], ['poReference', result.poReference?.trim() || null], ['invoiceDate', result.invoiceDate ? new Date(result.invoiceDate) : null], ['totalMinor', moneyOrNull(result.totalMinor, 'INVOICE_TOTAL_INVALID')],
      ['subtotalMinor', moneyOrNull(result.subtotalMinor, 'INVOICE_SUBTOTAL_INVALID')], ['taxMinor', moneyOrNull(result.taxMinor, 'INVOICE_TAX_INVALID')]];
    for (const [key, value] of plain) if (value !== null && (document as Record<string, unknown>)[key] === null) fill[key] = value;
    await tx.invoiceDocument.update({ where: { id }, data: { ...(fill as Prisma.InvoiceDocumentUncheckedUpdateInput), ocrStatus: 'COMPLETED', ocrError: null } });
    await auditChange(tx, actor, { action: 'INVOICE_PAGE_READ', entityId: id, after: { pageNumber, linesAdded: result.lines.length, provider: result.provider }, storeId: document.storeId });
  });
  return getInvoiceDocument(prisma, actor, id);
}

/** Starts an invoice with no file and no OCR. Receiving never depends on OCR: the same header and line fields can be typed. */
export async function createManualInvoice(prisma: PrismaClient, actor: AdminActor, input: InvoiceHeaderInput & { storeId?: string; vendorId?: string; purchaseOrderId?: string; label?: string }) {
  const storeId = input.storeId ?? actor.storeId;
  if (!storeId || (actor.storeId && actor.storeId !== storeId)) throw new PosError('STORE_ACCESS_DENIED', 403);
  const [store, employee, vendor] = await Promise.all([
    prisma.store.findFirst({ where: { id: storeId, organizationId: actor.organizationId, status: 'ACTIVE' } }),
    prisma.employee.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId, status: 'ACTIVE', stores: { some: { storeId } } } }),
    input.vendorId ? prisma.vendor.findFirst({ where: { id: input.vendorId, organizationId: actor.organizationId, active: true } }) : null,
  ]);
  if (!store) throw new PosError('STORE_NOT_FOUND', 404); if (!employee) throw new PosError('INVOICE_UPLOADER_NOT_ALLOWED', 403);
  if (input.vendorId && !vendor) throw new PosError('VENDOR_NOT_FOUND', 404);
  const token = randomUUID(); const content = Buffer.from(`manual-entry:${token}`);
  const invoiceDate = input.invoiceDate ? new Date(input.invoiceDate) : null;
  if (invoiceDate && Number.isNaN(invoiceDate.getTime())) throw new PosError('INVOICE_DATE_INVALID');
  const created = await prisma.invoiceDocument.create({ data: { organizationId: actor.organizationId, storeId, vendorId: vendor?.id ?? null, purchaseOrderId: input.purchaseOrderId ?? null, uploadedByEmployeeId: actor.userId,
    originalFilename: (input.label?.trim() || 'Manual entry').slice(0, 120), mimeType: 'application/x-rjpos-manual', fileSize: content.length, storageReference: `manual://${token}`, documentHash: createHash('sha256').update(content).digest('hex'),
    documentData: Uint8Array.from(content), ocrStatus: 'COMPLETED', ocrProvider: 'MANUAL', invoiceNumber: input.invoiceNumber?.trim() || null, invoiceDate, poReference: input.poReference?.trim() || null,
    subtotalMinor: moneyOrNull(input.subtotalMinor, 'INVOICE_SUBTOTAL_INVALID'), taxMinor: moneyOrNull(input.taxMinor, 'INVOICE_TAX_INVALID'), totalMinor: moneyOrNull(input.totalMinor, 'INVOICE_TOTAL_INVALID'),
    discountMinor: moneyOrNull(input.discountMinor, 'INVOICE_DISCOUNT_INVALID'), rebateMinor: moneyOrNull(input.rebateMinor, 'INVOICE_REBATE_INVALID'), feesMinor: moneyOrNull(input.feesMinor, 'INVOICE_FEES_INVALID'),
    vendorNameExtracted: input.vendorName?.trim() || null, ...(headerData(input) as object) } as Prisma.InvoiceDocumentUncheckedCreateInput });
  await auditChange(prisma, actor, { action: 'INVOICE_CREATED_MANUALLY', entityId: created.id, after: { vendorId: created.vendorId, invoiceNumber: created.invoiceNumber }, storeId });
  return getInvoiceDocument(prisma, actor, created.id);
}

export async function applyInvoiceOcrResult(prisma: PrismaClient, actor: AdminActor, id: string, result: InvoiceOcrResult) {
  const document = await getInvoiceDocumentInput(prisma, actor, id);
  if (!result.lines.length) throw new PosError('INVOICE_OCR_LINES_REQUIRED');
  const invoiceDate = result.invoiceDate ? new Date(result.invoiceDate) : null;
  if (invoiceDate && Number.isNaN(invoiceDate.getTime())) throw new PosError('INVOICE_DATE_INVALID');
  const subtotalMinor = moneyOrNull(result.subtotalMinor, 'INVOICE_SUBTOTAL_INVALID');
  const taxMinor = moneyOrNull(result.taxMinor, 'INVOICE_TAX_INVALID');
  const totalMinor = moneyOrNull(result.totalMinor, 'INVOICE_TOTAL_INVALID');
  const discountMinor = moneyOrNull(result.discountMinor, 'INVOICE_DISCOUNT_INVALID');
  const rebateMinor = moneyOrNull(result.rebateMinor, 'INVOICE_REBATE_INVALID');
  const feesMinor = moneyOrNull(result.feesMinor, 'INVOICE_FEES_INVALID');
  const duplicate = Boolean(result.invoiceNumber && await prisma.invoiceDocument.findFirst({ where: {
    organizationId: actor.organizationId, id: { not: id }, reviewStatus: { not: 'REJECTED' },
    ...(document.vendorId ? { vendorId: document.vendorId } : {}), invoiceNumber: result.invoiceNumber.trim(),
    ...(invoiceDate ? { invoiceDate } : {}), ...(totalMinor === null ? {} : { totalMinor }),
  } }));
  const header = headerData(result);
  await prisma.$transaction(async (tx) => {
    await tx.invoiceLine.deleteMany({ where: { organizationId: actor.organizationId, invoiceDocumentId: id } });
    for (const [index, raw] of result.lines.entries()) {
      const line: InvoiceLineInput = { ...raw, ...(raw.quantity === undefined ? {} : { quantity: raw.quantity }) };
      const product = (line.lineKind ?? 'PRODUCT') === 'PRODUCT';
      const absent = line.fulfillment === 'BACKORDERED' || line.fulfillment === 'OUT_OF_STOCK' || line.fulfillment === 'CANCELLED' || (line.casesBackordered ?? 0) > 0;
      if (product && !absent && (line.casesShipped ?? line.quantity ?? 0) < 1) throw new PosError('INVOICE_LINE_INVALID');
      const { data, economics } = buildLineRecord(line);
      if (product && economics?.warnings.some((warning) => warning.code === 'NO_BASE_COST')) throw new PosError('INVOICE_LINE_COST_INVALID');
      const match = product ? await matchInvoiceLine(tx, actor.organizationId, document.vendorId, (data as unknown as Record<string, string | null>)) : { variantId: null, masterProductId: null, matchedBy: null };
      const matchStatus: InvoiceLineMatchStatus = !product ? 'MATCHED' : match.variantId ? 'MATCHED' : match.masterProductId ? 'MASTER_CATALOG' : 'NEEDS_REVIEW';
      const evidence = { ...(line.evidence ?? {}), ...(match.matchedBy ? { matchedBy: { original: match.matchedBy } } : {}) };
      await tx.invoiceLine.create({ data: { ...data, evidence: Object.keys(evidence).length ? (evidence as Prisma.InputJsonValue) : Prisma.DbNull, organizationId: actor.organizationId, invoiceDocumentId: id, lineNumber: index + 1, matchStatus,
        variantId: match.variantId, masterProductId: match.masterProductId } as Prisma.InvoiceLineUncheckedCreateInput });
    }
    await tx.invoiceCharge.deleteMany({ where: { organizationId: actor.organizationId, invoiceDocumentId: id } });
    for (const charge of result.charges ?? []) {
      await tx.invoiceCharge.create({ data: { organizationId: actor.organizationId, invoiceDocumentId: id, kind: charge.kind, label: charge.label?.trim() || charge.kind.toLowerCase(), originalLabel: charge.originalLabel?.trim() || null, amountMinor: moneyOrNull(charge.amountMinor, 'INVOICE_CHARGE_AMOUNT_INVALID') ?? 0n } });
    }
    await tx.invoiceDocument.update({ where: { id }, data: { ocrStatus: 'COMPLETED', ocrProvider: result.provider, ocrError: null,
      ...(result.confidence === undefined ? {} : { ocrConfidence: result.confidence }),
      ...(result.rawReference === undefined ? {} : { rawProviderResult: result.rawReference as Prisma.InputJsonValue }),
      ...(result.fieldEvidence === undefined ? {} : { fieldEvidence: result.fieldEvidence as unknown as Prisma.InputJsonValue }),
      vendorNameExtracted: result.vendorName?.trim() || null, invoiceNumber: result.invoiceNumber?.trim() || null, invoiceDate,
      subtotalMinor, taxMinor, totalMinor, discountMinor, rebateMinor, feesMinor, poReference: result.poReference?.trim() || null,
      rawText: result.rawText?.slice(0, 20000) ?? null, possibleDuplicate: duplicate, ...header } });
  });
  await auditChange(prisma, actor, { action: 'INVOICE_OCR_COMPLETED', entityId: id, after: { provider: result.provider, lineCount: result.lines.length, possibleDuplicate: duplicate, pageNumber: result.pageNumber ?? 1, continued: result.continued ?? false }, storeId: document.storeId });
  return getInvoiceDocument(prisma, actor, id);
}

export async function updateInvoiceDocument(prisma: PrismaClient, actor: AdminActor, id: string, input: InvoiceHeaderInput & {
  vendorId?: string | null; purchaseOrderId?: string | null; invoiceNumber?: string; invoiceDate?: string; reason?: string;
}) {
  const document = await getInvoiceDocumentInput(prisma, actor, id);
  if (input.vendorId && !await prisma.vendor.findFirst({ where: { id: input.vendorId, organizationId: actor.organizationId, active: true } })) throw new PosError('VENDOR_NOT_FOUND', 404);
  if (input.purchaseOrderId && !await prisma.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, organizationId: actor.organizationId, storeId: document.storeId } })) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
  const date = input.invoiceDate === undefined ? undefined : input.invoiceDate ? new Date(input.invoiceDate) : null;
  if (date && Number.isNaN(date.getTime())) throw new PosError('INVOICE_DATE_INVALID');
  const data: Prisma.InvoiceDocumentUncheckedUpdateInput = {
    ...(input.vendorId === undefined ? {} : { vendorId: input.vendorId }), ...(input.purchaseOrderId === undefined ? {} : { purchaseOrderId: input.purchaseOrderId }),
    ...(input.invoiceNumber === undefined ? {} : { invoiceNumber: input.invoiceNumber.trim() || null }), ...(date === undefined ? {} : { invoiceDate: date }),
    ...(input.subtotalMinor === undefined ? {} : { subtotalMinor: moneyOrNull(input.subtotalMinor, 'INVOICE_SUBTOTAL_INVALID') }),
    ...(input.taxMinor === undefined ? {} : { taxMinor: moneyOrNull(input.taxMinor, 'INVOICE_TAX_INVALID') }),
    ...(input.totalMinor === undefined ? {} : { totalMinor: moneyOrNull(input.totalMinor, 'INVOICE_TOTAL_INVALID') }),
    ...(input.poReference === undefined ? {} : { poReference: input.poReference.trim() || null }),
    ...(input.discountMinor === undefined ? {} : { discountMinor: moneyOrNull(input.discountMinor, 'INVOICE_DISCOUNT_INVALID') }),
    ...(input.rebateMinor === undefined ? {} : { rebateMinor: moneyOrNull(input.rebateMinor, 'INVOICE_REBATE_INVALID') }),
    ...(input.feesMinor === undefined ? {} : { feesMinor: moneyOrNull(input.feesMinor, 'INVOICE_FEES_INVALID') }),
    ...(headerData(input) as object),
  };
  const diff = changedFields(document as unknown as Record<string, unknown>, data as Record<string, unknown>);
  // A corrected field keeps what the vendor printed: the evidence entry gains the corrected value instead of being replaced.
  const evidence = (document.fieldEvidence ?? {}) as Record<string, FieldEvidence>;
  for (const key of Object.keys(diff.after)) if (evidence[key]) evidence[key] = { ...evidence[key]!, corrected: String(diff.after[key] ?? '') };
  await prisma.invoiceDocument.update({ where: { id }, data: { ...data, ...(Object.keys(evidence).length ? { fieldEvidence: evidence as unknown as Prisma.InputJsonValue } : {}) } });
  if (Object.keys(diff.after).length) await auditChange(prisma, actor, { action: 'INVOICE_REVIEW_UPDATED', entityId: id, before: diff.before, after: diff.after, ...(input.reason ? { reason: input.reason } : {}), storeId: document.storeId });
  return getInvoiceDocument(prisma, actor, id);
}

type LineRow = Prisma.InvoiceLineGetPayload<Record<string, never>>;
const str = (value: bigint | null | undefined): string | undefined => (value === null || value === undefined ? undefined : value.toString());

/** Rebuilds the editable input from a stored line so an edit can be re-validated and re-derived as a whole. */
export function lineToInput(line: LineRow): InvoiceLineInput {
  const noComponents = [line.postOffPerCaseMinor, line.qtyDiscountPerCaseMinor, line.caseDiscountPerCaseMinor, line.promoDiscountPerCaseMinor, line.otherDiscountPerCaseMinor].every((value) => value === null);
  const input: Record<string, unknown> = {
    lineKind: line.lineKind, description: line.description, upc: line.upc ?? undefined, caseUpc: line.caseUpc ?? undefined, alternateUpc: line.alternateUpc ?? undefined, vendorSku: line.vendorSku ?? undefined, vendorItemNumber: line.vendorItemNumber ?? undefined,
    brand: line.brand ?? undefined, size: line.size ?? undefined, packLabel: line.packLabel ?? undefined, vintage: line.vintage ?? undefined, categoryHint: line.categoryHint ?? undefined, caseQuantity: line.caseQuantity,
    casesShipped: line.quantity, casesOrdered: line.casesOrdered ?? undefined, casesReceived: line.casesReceived ?? undefined, casesBackordered: line.casesBackordered, casesRejected: line.casesRejected, casesDamaged: line.casesDamaged,
    unitsOrdered: line.unitsOrdered ?? undefined, looseUnitsShipped: line.looseUnitsShipped, looseUnitsReceived: line.looseUnitsReceived, unitsDamaged: line.unitsDamaged, unitsBroken: line.unitsBroken, unitsMissing: line.unitsMissing, bonusUnits: line.bonusUnits,
    damageDisposition: line.damageDisposition, unitListMinor: str(line.unitListMinor), listCaseMinor: str(line.listCaseMinor), caseCostMinor: str(line.caseCostMinor), grossLineMinor: str(line.grossLineMinor),
    postOffPerCaseMinor: str(line.postOffPerCaseMinor), qtyDiscountPerCaseMinor: str(line.qtyDiscountPerCaseMinor), caseDiscountPerCaseMinor: str(line.caseDiscountPerCaseMinor), promoDiscountPerCaseMinor: str(line.promoDiscountPerCaseMinor),
    otherDiscountPerCaseMinor: str(line.otherDiscountPerCaseMinor) ?? (noComponents ? str(line.discountPerCaseMinor) : undefined), lineDiscountMinor: str(line.lineDiscountMinor), allowancePerCaseMinor: str(line.allowancePerCaseMinor), rebatePerCaseMinor: str(line.rebatePerCaseMinor),
    lineTotalMinor: str(line.lineTotalMinor), lineTaxMinor: str(line.lineTaxMinor), ripCode: line.ripCode ?? undefined, ripValueMinor: str(line.ripValueMinor), temporaryDeal: line.temporaryDeal, dealEndsAt: line.dealEndsAt?.toISOString() ?? null,
    standardCaseCostMinor: str(line.standardCaseCostMinor), notes: line.notes ?? undefined, confidence: line.confidence === null ? undefined : Number(line.confidence), rawText: line.rawText ?? undefined, sourcePage: line.sourcePage ?? undefined,
  };
  for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key];
  return input as unknown as InvoiceLineInput;
}

const EDIT_KEYS = ['lineKind', 'description', 'upc', 'caseUpc', 'alternateUpc', 'vendorSku', 'vendorItemNumber', 'brand', 'size', 'packLabel', 'vintage', 'categoryHint', 'caseQuantity', 'quantity', 'casesShipped', 'casesOrdered', 'casesReceived', 'casesBackordered', 'casesRejected', 'casesDamaged',
  'unitsOrdered', 'looseUnitsShipped', 'looseUnitsReceived', 'unitsDamaged', 'unitsBroken', 'unitsMissing', 'bonusUnits', 'fulfillment', 'damageDisposition', 'unitListMinor', 'listCaseMinor', 'caseCostMinor', 'grossLineMinor', 'unitCostMinor', 'netCaseCostMinor', 'netUnitCostMinor',
  'postOffPerCaseMinor', 'qtyDiscountPerCaseMinor', 'caseDiscountPerCaseMinor', 'promoDiscountPerCaseMinor', 'otherDiscountPerCaseMinor', 'lineDiscountMinor', 'discountPerCaseMinor', 'allowancePerCaseMinor', 'rebatePerCaseMinor', 'lineTotalMinor', 'lineTaxMinor', 'ripCode', 'ripValueMinor',
  'temporaryDeal', 'dealEndsAt', 'standardCaseCostMinor', 'notes'] as const;

export async function updateInvoiceLine(prisma: PrismaClient, actor: AdminActor, documentId: string, lineId: string, input: Partial<Omit<InvoiceLineInput, 'caseCostMinor' | 'size' | 'casesReceived' | 'discountPerCaseMinor'>> & {
  casesReceived?: number | null; caseCostMinor?: string | null; discountPerCaseMinor?: string | null; size?: string | null;
  variantId?: string | null; ignored?: boolean;
  /** Explicit, reviewed choice: update the vendor's current cost from this line when the invoice is confirmed. */
  updateVendorCost?: boolean;
  newProduct?: InvoiceNewProductDraft | null;
  reason?: string;
}) {
  const document = await getInvoiceDocumentInput(prisma, actor, documentId);
  const line = await prisma.invoiceLine.findFirst({ where: { id: lineId, invoiceDocumentId: documentId, organizationId: actor.organizationId } });
  if (!line) throw new PosError('INVOICE_LINE_NOT_FOUND', 404);
  if (input.variantId && !await prisma.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId, active: true } })) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
  if (input.quantity !== undefined && (!Number.isSafeInteger(input.quantity) || input.quantity < 0)) throw new PosError('INVOICE_LINE_QUANTITY_INVALID');
  if (input.caseQuantity !== undefined && (!Number.isSafeInteger(input.caseQuantity) || input.caseQuantity < 1)) throw new PosError('INVOICE_LINE_CASE_QUANTITY_INVALID');
  const variantId = input.variantId === undefined ? line.variantId : input.variantId;
  if (input.newProduct) {
    if (!input.newProduct.categoryId || !input.newProduct.productName.trim() || !input.newProduct.variantName.trim()
      || !input.newProduct.sku.trim() || !/^(0|[1-9]\d*)$/.test(input.newProduct.priceMinor)) throw new PosError('INVOICE_NEW_PRODUCT_INVALID');
  }
  const record = input as Record<string, unknown>;
  const touched = EDIT_KEYS.filter((key) => record[key] !== undefined);
  let rebuilt: Record<string, unknown> = {}; let beforeValues: Record<string, unknown> = {}; let afterValues: Record<string, unknown> = {};
  if (touched.length) {
    const oldInput = lineToInput(line);
    const merged: Record<string, unknown> = { ...oldInput };
    for (const key of touched) { if (record[key] === null) delete merged[key]; else merged[key] = record[key]; }
    if (input.caseCostMinor === null) delete merged.caseCostMinor;
    if (input.discountPerCaseMinor !== undefined) { merged.otherDiscountPerCaseMinor = input.discountPerCaseMinor ?? undefined; delete merged.discountPerCaseMinor; }
    if (input.quantity !== undefined) { merged.casesShipped = input.quantity; delete merged.quantity; }
    // A line total that was only ever derived is derived again after an edit; a printed one stays as printed and is checked against the math.
    const wasDerived = (line.evidence as Record<string, { label?: string }> | null)?.lineTotal?.label === DERIVED;
    if (record.lineTotalMinor === undefined && wasDerived) delete merged.lineTotalMinor;
    const built = buildLineRecord(merged as unknown as InvoiceLineInput);
    const { evidence: newEvidence, ...columns } = built.data as Record<string, unknown>;
    // Keep the vendor evidence as it was; only the derived-total marker follows the edit.
    const oldEvidence = { ...((line.evidence ?? {}) as Record<string, unknown>) }; delete oldEvidence.lineTotal;
    const marker = (newEvidence as Record<string, unknown> | null)?.lineTotal;
    rebuilt = { ...columns, evidence: { ...oldEvidence, ...(marker ? { lineTotal: marker } : {}) } };
    const diff = changedFields(line as unknown as Record<string, unknown>, columns);
    beforeValues = diff.before; afterValues = diff.after;
  }
  const data: Prisma.InvoiceLineUncheckedUpdateInput = { ...(rebuilt as Prisma.InvoiceLineUncheckedUpdateInput),
    ...(input.variantId === undefined ? {} : { variantId: input.variantId, masterProductId: null }),
    ...(input.ignored === undefined ? {} : { ignored: input.ignored }),
    ...(input.updateVendorCost === undefined ? {} : { updateVendorCost: input.updateVendorCost }),
    ...(input.newProduct === undefined ? {} : { newProductData: input.newProduct === null ? Prisma.DbNull : input.newProduct as Prisma.InputJsonValue }),
    ...(Object.keys(afterValues).length ? { correctedFields: { ...((line.correctedFields ?? {}) as Record<string, unknown>), ...Object.fromEntries(Object.keys(afterValues).map((key) => [key, { from: beforeValues[key] ?? null, to: afterValues[key] ?? null }])) } as Prisma.InputJsonValue } : {}),
    matchStatus: input.ignored ? 'INVALID' : input.newProduct ? 'NEW_PRODUCT' : (line.lineKind !== 'PRODUCT' || variantId) ? 'MATCHED' : 'NEEDS_REVIEW' };
  await prisma.$transaction(async (tx) => {
    await tx.invoiceLine.update({ where: { id: lineId }, data });
    if (input.variantId !== undefined && input.variantId !== line.variantId) await auditChange(tx, actor, { action: 'INVOICE_PRODUCT_MATCH_CHANGED', entityId: documentId, before: { lineId, variantId: line.variantId }, after: { lineId, variantId: input.variantId }, ...(input.reason ? { reason: input.reason } : {}), storeId: document.storeId });
    if (Object.keys(afterValues).length) {
      const costKeys = ['caseCostMinor', 'netCaseCostMinor', 'netUnitCostMinor', 'discountPerCaseMinor', 'postOffPerCaseMinor', 'qtyDiscountPerCaseMinor', 'caseDiscountPerCaseMinor', 'promoDiscountPerCaseMinor', 'otherDiscountPerCaseMinor', 'allowancePerCaseMinor', 'rebatePerCaseMinor', 'unitCostMinor', 'listCaseMinor', 'unitListMinor'];
      const qtyKeys = ['quantity', 'casesReceived', 'casesOrdered', 'casesBackordered', 'casesRejected', 'looseUnitsReceived', 'unitsDamaged', 'unitsBroken', 'unitsMissing', 'bonusUnits', 'caseQuantity'];
      const pick = (keys: string[], source: Record<string, unknown>) => Object.fromEntries(Object.entries(source).filter(([key]) => keys.includes(key)));
      const action = Object.keys(afterValues).some((key) => costKeys.includes(key)) ? 'INVOICE_COST_OVERRIDDEN' : Object.keys(afterValues).some((key) => qtyKeys.includes(key)) ? 'INVOICE_QUANTITY_CHANGED' : 'INVOICE_LINE_CORRECTED';
      await auditChange(tx, actor, { action, entityId: documentId, before: { lineId, ...beforeValues }, after: { lineId, ...afterValues }, ...(input.reason ? { reason: input.reason } : {}), storeId: document.storeId });
      if ('damageDisposition' in afterValues) await auditChange(tx, actor, { action: 'INVOICE_DISCREPANCY_DISPOSITION', entityId: documentId, before: { lineId, ...pick(['damageDisposition'], beforeValues) }, after: { lineId, ...pick(['damageDisposition'], afterValues) }, storeId: document.storeId });
      void qtyKeys;
    } else if (input.ignored !== undefined || input.updateVendorCost !== undefined || input.newProduct !== undefined) {
      await auditChange(tx, actor, { action: 'INVOICE_LINE_CORRECTED', entityId: documentId, before: { lineId, ignored: line.ignored, updateVendorCost: line.updateVendorCost }, after: { lineId, ignored: input.ignored ?? line.ignored, updateVendorCost: input.updateVendorCost ?? line.updateVendorCost }, storeId: document.storeId });
    }
  });
  return getInvoiceDocument(prisma, actor, documentId);
}

export async function rejectInvoiceDocument(prisma: PrismaClient, actor: AdminActor, id: string) {
  await getInvoiceDocumentInput(prisma, actor, id);
  await prisma.invoiceDocument.update({ where: { id }, data: { reviewStatus: 'REJECTED', rejectedByEmployeeId: actor.userId, rejectedAt: new Date() } });
  await audit(prisma, actor, 'INVOICE_REJECTED', id);
  return getInvoiceDocument(prisma, actor, id);
}

type ReviewableLine = {
  id: string; variantId: string | null; ignored: boolean; quantity: number; caseQuantity: number; unitCostMinor: bigint; lineTotalMinor: bigint;
  caseCostMinor: bigint | null; discountPerCaseMinor: bigint | null; casesReceived: number | null;
};

function safeReviewLine(line: ReviewableLine, context?: { poUnitCostMinor?: bigint | null; mappingUnitCostMinor?: bigint | null; mappingUnitsPerCase?: number | null }) {
  try {
    return { review: reviewInvoiceLine({ cases: line.quantity, unitsPerCase: line.caseQuantity, baseCaseCostMinor: line.caseCostMinor, unitCostMinor: line.unitCostMinor,
      discountPerCaseMinor: line.discountPerCaseMinor ?? 0n, lineTotalMinor: line.lineTotalMinor, casesReceived: line.casesReceived,
      poUnitCostMinor: context?.poUnitCostMinor ?? null, mappingUnitCostMinor: context?.mappingUnitCostMinor ?? null, mappingUnitsPerCase: context?.mappingUnitsPerCase ?? null }), error: null };
  } catch (error) { return { review: null, error: error instanceof Error ? error.message : 'INVOICE_LINE_INVALID' }; }
}

/**
 * Review data for the confirm step: per-line case economics (base case, discount, effective case and unit cost, units),
 * discrepancies against the printed line total, the PO, and the current vendor mapping, header reconciliation, and any
 * vendor deals that could apply (shown, never applied automatically).
 */
export async function getInvoiceReview(prisma: PrismaClient, actor: AdminActor, id: string) {
  const document = await prisma.invoiceDocument.findFirst({ where: { id, organizationId: actor.organizationId, ...(actor.storeId ? { storeId: actor.storeId } : {}) },
    include: { lines: { orderBy: { lineNumber: 'asc' }, include: { variant: { select: { id: true, name: true, sku: true, product: { select: { name: true } } } } } }, purchaseOrder: { include: { lines: true } } } });
  if (!document) throw new PosError('INVOICE_NOT_FOUND', 404);
  const variantIds = document.lines.map((line) => line.variantId).filter((value): value is string => Boolean(value));
  const at = document.invoiceDate ?? new Date();
  const [mappings, deals] = document.vendorId && variantIds.length
    ? await Promise.all([
      prisma.vendorProductMapping.findMany({ where: { organizationId: actor.organizationId, vendorId: document.vendorId, variantId: { in: variantIds }, active: true } }),
      prisma.vendorDeal.findMany({ where: { organizationId: actor.organizationId, vendorId: document.vendorId, active: true, OR: [{ variantId: { in: variantIds } }, { variantId: null }],
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: at } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: at } }] }] } }),
    ])
    : [[], []];
  const lines = document.lines.filter((line) => line.lineKind === 'PRODUCT').map((line) => {
    const mapping = mappings.find((candidate) => candidate.variantId === line.variantId);
    const poLine = document.purchaseOrder?.lines.find((candidate) => candidate.variantId === line.variantId);
    const { review, error } = line.quantity === 0 ? { review: null, error: null } : safeReviewLine(line, { poUnitCostMinor: poLine?.unitCostMinor ?? null, mappingUnitCostMinor: mapping?.vendorCostMinor ?? null, mappingUnitsPerCase: mapping?.casePackQuantity ?? null });
    const applicable = deals.filter((deal) => deal.variantId === null || deal.variantId === line.variantId);
    let dealPreview = null;
    if (review && applicable.length) {
      try { dealPreview = applyVendorDeals({ baseCaseCostMinor: review.baseCaseCostMinor, unitsPerCase: line.caseQuantity, cases: line.quantity, deals: applicable }); } catch { dealPreview = null; }
    }
    return { lineId: line.id, ignored: line.ignored, review, error, availableDeals: applicable.map((deal) => ({ id: deal.id, name: deal.name, kind: deal.kind })), dealPreview };
  });
  const receivingFirst = await getReceivingReview(prisma, actor, id);
  // Freight, fees, deposits, other tax and credits are real invoice money: they join the header reconciliation without touching product cost.
  const totals = reviewInvoiceTotals({ lineTotalsMinor: document.lines.filter((line) => line.lineKind === 'PRODUCT').map((line) => line.lineTotalMinor), subtotalMinor: document.subtotalMinor, discountMinor: (document.discountMinor ?? 0n) + receivingFirst.adjustments.creditsMinor,
    taxMinor: (document.taxMinor ?? 0n) + receivingFirst.adjustments.extraTaxMinor, feesMinor: (document.feesMinor ?? 0n) + receivingFirst.adjustments.chargesMinor, totalMinor: document.totalMinor });
  const receiving = receivingFirst;
  const hasDiscrepancies = totals.discrepancies.length > 0 || lines.some((line) => !line.ignored && (line.error !== null || (line.review?.discrepancies.length ?? 0) > 0))
    || receiving.reconciliation.status === 'MATERIAL_DIFFERENCE' || receiving.lines.some((line) => !line.ignored && line.quantities.variance !== 'EXACT');
  return { invoiceId: document.id, lines, totals, hasDiscrepancies, receiving };
}

const BLOCKER_ERRORS: Record<string, string> = { ALREADY_RECEIVED: 'INVOICE_ALREADY_RECEIVED', LINES_NEED_MATCH: 'INVOICE_LINES_REQUIRE_REVIEW', OVER_SHIPMENT: 'INVOICE_OVER_SHIPMENT_EXCEEDS_PO', DAMAGE_DISPOSITION: 'INVOICE_DAMAGE_DISPOSITION_REQUIRED', VENDOR_REQUIRED: 'INVOICE_VENDOR_REQUIRED' };
/** Documents that record money or paperwork but never move stock. */
const NO_POSTING_TYPES = ['CREDIT_MEMO', 'ADJUSTMENT', 'BACKORDER'];

/**
 * Final Confirmation. Posts only physically received, sellable units through the inventory ledger (damaged units get their own DAMAGE
 * movement), stores the exact invoice economics as cost history, updates the vendor's current cost only when explicitly chosen, never
 * touches retail prices, and drafts vendor claims for shortages, damage, and rejections. Nothing here runs before this call.
 */
export async function confirmInvoiceDocument(prisma: PrismaClient, actor: AdminActor, id: string, acknowledgeDuplicate = false, acknowledgeDiscrepancies = false, options: { reconciliationNote?: string; createClaims?: boolean } = {}) {
  const document = await prisma.invoiceDocument.findFirst({ where: { id, organizationId: actor.organizationId,
    ...(actor.storeId ? { storeId: actor.storeId } : {}) }, include: { lines: true } });
  if (!document) throw new PosError('INVOICE_NOT_FOUND', 404);
  if (document.reviewStatus !== 'DRAFT' || document.ocrStatus !== 'COMPLETED') throw new PosError('INVOICE_NOT_CONFIRMABLE', 409);
  if (!document.vendorId) throw new PosError('INVOICE_VENDOR_REQUIRED');
  if (document.possibleDuplicate && !acknowledgeDuplicate) throw new PosError('INVOICE_DUPLICATE_REQUIRES_ACKNOWLEDGEMENT', 409);
  const productLines = document.lines.filter((line) => line.lineKind === 'PRODUCT' && !line.ignored);
  const posts = !NO_POSTING_TYPES.includes(document.docType);
  if (posts && !productLines.length) throw new PosError('INVOICE_LINES_REQUIRE_REVIEW', 409);
  if (posts && productLines.some((line) => !line.variantId && !line.newProductData)) throw new PosError('INVOICE_LINES_REQUIRE_REVIEW', 409);
  // The reviewed calculations must be valid, and any disagreement must have been seen and explicitly accepted before anything is posted.
  const review = await getInvoiceReview(prisma, actor, id);
  const receiving = review.receiving;
  const blocker = receiving.blockers.find((item) => item.code !== 'LINES_NEED_MATCH' || posts);
  if (blocker && (posts || blocker.code === 'ALREADY_RECEIVED')) throw new PosError(BLOCKER_ERRORS[blocker.code] ?? `INVOICE_${blocker.code}`, 409);
  if (review.lines.some((line) => !line.ignored && line.error)) throw new PosError('INVOICE_LINE_INVALID', 409);
  if (review.hasDiscrepancies && !acknowledgeDiscrepancies) throw new PosError('INVOICE_DISCREPANCIES_REQUIRE_ACKNOWLEDGEMENT', 409);
  if (receiving.requiresNote && !options.reconciliationNote?.trim()) throw new PosError('INVOICE_RECONCILIATION_NOTE_REQUIRED', 409);
  const noteFields = options.reconciliationNote?.trim() ? { reconciliationNote: options.reconciliationNote.trim().slice(0, 500) } : {};

  if (!posts) {
    await prisma.invoiceDocument.update({ where: { id }, data: { reviewStatus: 'CONFIRMED', confirmedByEmployeeId: actor.userId, confirmedAt: new Date() } });
    await auditChange(prisma, actor, { action: 'INVOICE_CONFIRMED', entityId: id, after: { docType: document.docType, inventoryPosted: false, ...noteFields }, storeId: document.storeId });
    return getInvoiceDocument(prisma, actor, id);
  }

  const econ = new Map(receiving.lines.map((line) => [line.lineId, line]));
  for (const line of productLines) {
    if (line.variantId) continue;
    const draft = line.newProductData as InvoiceNewProductDraft | null;
    if (!draft) throw new PosError('INVOICE_LINES_REQUIRE_REVIEW', 409);
    const economics = econ.get(line.id)!.economics;
    let variant: { id: string };
    if (line.masterProductId && line.upc) {
      const added = await addMasterProductToStore(prisma, actor, line.upc, { categoryId: draft.categoryId, sku: draft.sku,
        variantName: draft.variantName, storeId: document.storeId, priceMinor: draft.priceMinor, costMinor: economics.effectiveUnitMinor.toString() });
      variant = added.variant;
    } else {
      const product = await createProduct(prisma, actor, { categoryId: draft.categoryId, name: draft.productName,
        ...(draft.brand ? { brand: draft.brand } : {}),
        ageRestricted: draft.ageRestricted ?? false, inventoryTracked: true });
      const barcode = draft.barcode || line.upc;
      const created = await createVariant(prisma, actor, product.id, { name: draft.variantName, sku: draft.sku,
        ...(barcode ? { barcode } : {}), costMinor: economics.effectiveUnitMinor.toString() });
      if (!created) throw new PosError('INVOICE_PRODUCT_CREATE_FAILED');
      variant = created;
      await schedulePrice(prisma, actor, { variantId: variant.id, storeId: document.storeId, amountMinor: draft.priceMinor, effectiveFrom: new Date() });
    }
    await prisma.invoiceLine.update({ where: { id: line.id }, data: { variantId: variant.id, matchStatus: 'MATCHED' } });
    line.variantId = variant.id;
  }
  let costUpdates = 0;
  for (const line of productLines) {
    const economics = econ.get(line.id)!.economics;
    const mapping = await prisma.vendorProductMapping.findFirst({ where: { organizationId: actor.organizationId, vendorId: document.vendorId, variantId: line.variantId! } });
    // The vendor's current cost changes only through an explicit, reviewed choice. A missing mapping is created (a new link, not an overwrite).
    if (mapping && !line.updateVendorCost) continue;
    // A temporary deal price never becomes the standard cost: use the stated standard case cost, or leave the mapping alone.
    const standardCase = line.temporaryDeal ? line.standardCaseCostMinor : economics.baseCaseMinor;
    if (standardCase === null || standardCase === undefined) continue;
    await saveVendorMapping(prisma, actor, { ...(mapping ? { id: mapping.id } : {}), vendorId: document.vendorId, variantId: line.variantId!,
      ...(line.vendorSku || line.vendorItemNumber ? { vendorSku: (line.vendorSku ?? line.vendorItemNumber)! } : {}), vendorCostMinor: unitCostFromCase(standardCase, line.caseQuantity).toString(), caseCostMinor: standardCase.toString(),
      casePackQuantity: line.caseQuantity, minimumOrderQuantity: line.caseQuantity, active: true });
    costUpdates += 1;
    if (mapping) await auditChange(prisma, actor, { action: 'INVOICE_VENDOR_COST_UPDATED', entityId: id, before: { variantId: line.variantId, caseCostMinor: mapping.caseCostMinor, unitCostMinor: mapping.vendorCostMinor }, after: { variantId: line.variantId, caseCostMinor: standardCase, unitCostMinor: unitCostFromCase(standardCase, line.caseQuantity) }, storeId: document.storeId });
  }
  let purchaseOrderId = document.purchaseOrderId;
  if (!purchaseOrderId) {
    const ordered = productLines.map((line) => ({ line, units: ((line.casesOrdered ?? line.quantity + line.casesBackordered) * line.caseQuantity) + line.looseUnitsShipped })).filter((entry) => entry.units > 0);
    if (!ordered.length) throw new PosError('INVOICE_NOTHING_RECEIVED', 409);
    const po = await createPurchaseOrder(prisma, actor, { storeId: document.storeId, vendorId: document.vendorId,
      poNumber: `INV-${document.invoiceNumber?.trim() || document.id.slice(0, 8)}`, notes: `Created from reviewed invoice ${document.originalFilename}`,
      lines: ordered.map(({ line, units }) => { const economics = econ.get(line.id)!.economics; return { variantId: line.variantId!, quantity: units, unitCostMinor: economics.effectiveUnitMinor.toString(),
        unitsPerCase: line.caseQuantity, caseCostMinor: economics.baseCaseMinor.toString(), discountPerCaseMinor: economics.discountPerCaseMinor.toString(), rebatePerCaseMinor: economics.rebatePerCaseMinor.toString() }; }) });
    purchaseOrderId = po.id;
    await prisma.invoiceDocument.update({ where: { id }, data: { purchaseOrderId } });
    await transitionPurchaseOrder(prisma, actor, purchaseOrderId, 'SUBMIT');
  }
  const order = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, organizationId: actor.organizationId }, include: { lines: true } });
  if (!order) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
  const posted: Array<{ lineId: string; variantId: string; receivedUnits: number; sellableUnits: number; damagedUnits: number; rejectedUnits: number; shortUnits: number }> = [];
  const receiptLines = productLines.flatMap((line) => {
    const poLine = order.lines.find((candidate) => candidate.variantId === line.variantId);
    if (!poLine) throw new PosError('INVOICE_PO_LINE_MISMATCH', 409);
    const reviewed = econ.get(line.id)!; const quantities = reviewed.quantities; const economics = reviewed.economics;
    if (quantities.receivedUnits <= 0) return [];
    posted.push({ lineId: line.id, variantId: line.variantId!, receivedUnits: quantities.receivedUnits, sellableUnits: quantities.sellableUnits, damagedUnits: quantities.damagedUnits, rejectedUnits: quantities.rejectedUnits, shortUnits: quantities.shortUnits });
    const components: Record<string, string> = {};
    for (const [key, value] of Object.entries({ postOff: economics.components.postOff, qtyDiscount: economics.components.qty, caseDiscount: economics.components.caseDiscount, promoDiscount: economics.components.promo, otherDiscount: economics.components.other, allowance: economics.components.allowance, rebate: economics.components.rebate })) {
      if (value > 0n) components[key] = value.toString();
    }
    if (line.ripCode) components.ripCode = line.ripCode;
    if (line.ripValueMinor !== null) components.ripValueMinor = line.ripValueMinor.toString();
    return [{ purchaseOrderLineId: poLine.id, deliveredQuantity: quantities.receivedUnits, damagedQuantity: quantities.damagedUnits, rejectedQuantity: quantities.rejectedUnits, shortQuantity: quantities.shortUnits,
      unitCostMinor: economics.effectiveUnitMinor.toString(),
      costDetail: { invoiceLineId: line.id, ...(line.listCaseMinor !== null ? { listCaseCostMinor: line.listCaseMinor.toString() } : {}), baseCaseCostMinor: economics.baseCaseMinor.toString(), discountPerCaseMinor: economics.discountPerCaseMinor.toString(),
        rebatePerCaseMinor: economics.rebatePerCaseMinor.toString(), netCaseCostMinor: economics.netCaseMinor.toString(), components, temporaryDeal: line.temporaryDeal } }];
  });
  if (!receiptLines.length) throw new PosError('INVOICE_NOTHING_RECEIVED', 409);
  const receipt = await receivePurchaseOrder(prisma, actor, order.id, { idempotencyKey: `invoice:${id}`, invoiceDocumentId: id,
    ...(document.invoiceNumber ? { vendorReferenceNumber: document.invoiceNumber } : {}), notes: `Confirmed from invoice ${document.originalFilename}`, lines: receiptLines });
  await prisma.invoiceDocument.update({ where: { id }, data: { reviewStatus: 'CONFIRMED', confirmedByEmployeeId: actor.userId,
    confirmedAt: new Date(), purchaseOrderId: order.id } });
  await auditChange(prisma, actor, { action: 'INVOICE_CONFIRMED', entityId: id, after: { purchaseOrderId: order.id, receiptId: receipt.id, discrepanciesAcknowledged: review.hasDiscrepancies, vendorCostUpdatedLines: costUpdates, ...noteFields,
    postedLines: posted.length, sellableUnits: posted.reduce((sum, entry) => sum + entry.sellableUnits, 0), damagedUnits: posted.reduce((sum, entry) => sum + entry.damagedUnits, 0) }, storeId: document.storeId });
  await auditChange(prisma, actor, { action: 'INVOICE_RECEIVING_POSTED', entityId: id, after: { receiptId: receipt.id, lines: posted }, storeId: document.storeId });
  const claims = options.createClaims === false ? [] : await draftReceivingClaims(prisma, actor, { documentId: id, storeId: document.storeId, vendorId: document.vendorId, purchaseOrderId: order.id, lines: productLines, econ });
  return { ...(await getInvoiceDocument(prisma, actor, id)), receiptId: receipt.id, claimsCreated: claims };
}

type ReviewedLines = Map<string, Awaited<ReturnType<typeof getReceivingReview>>['lines'][number]>;

/**
 * Draft claims for what the vendor owes: shortages not explained by a backorder, damaged units sent to claim/pending credit, and rejected cases.
 * Drafts only; a person submits them. A failure here never undoes the receipt.
 */
async function draftReceivingClaims(prisma: PrismaClient, actor: AdminActor, input: { documentId: string; storeId: string; vendorId: string; purchaseOrderId: string; lines: LineRow[]; econ: ReviewedLines }) {
  const groups = new Map<'SHORTAGE' | 'DAMAGE' | 'OTHER', Array<{ variantId: string; quantity: number; unitCostMinor: string; reason: string; invoiceLineId: string }>>();
  const add = (kind: 'SHORTAGE' | 'DAMAGE' | 'OTHER', entry: { variantId: string; quantity: number; unitCostMinor: string; reason: string; invoiceLineId: string }) => groups.set(kind, [...(groups.get(kind) ?? []), entry]);
  for (const line of input.lines) {
    const reviewed = input.econ.get(line.id); if (!reviewed || !line.variantId) continue;
    const unitCostMinor = reviewed.economics.effectiveUnitMinor.toString(); const q = reviewed.quantities;
    const unexplainedShort = Math.max(0, q.shortUnits - q.backorderedUnits);
    if (unexplainedShort > 0) add('SHORTAGE', { variantId: line.variantId, quantity: unexplainedShort, unitCostMinor, reason: 'Invoiced but not delivered', invoiceLineId: line.id });
    if (q.damagedUnits > 0 && (line.damageDisposition === 'VENDOR_CLAIM' || line.damageDisposition === 'PENDING_CREDIT' || line.damageDisposition === 'REJECT_TO_VENDOR')) add('DAMAGE', { variantId: line.variantId, quantity: q.damagedUnits, unitCostMinor, reason: 'Damaged or broken on receipt', invoiceLineId: line.id });
    if (q.rejectedUnits > 0) add('OTHER', { variantId: line.variantId, quantity: q.rejectedUnits, unitCostMinor, reason: 'Rejected at receiving', invoiceLineId: line.id });
  }
  const created: Array<{ id: string; kind: string; expectedCreditMinor: bigint }> = [];
  for (const [kind, lines] of groups) {
    try {
      const claim = await createVendorClaim(prisma, actor, { storeId: input.storeId, vendorId: input.vendorId, kind, reason: kind === 'SHORTAGE' ? 'Short shipment on invoice' : kind === 'DAMAGE' ? 'Damage on receipt' : 'Rejected at receiving',
        invoiceDocumentId: input.documentId, purchaseOrderId: input.purchaseOrderId, lines });
      created.push({ id: claim.id, kind, expectedCreditMinor: claim.expectedCreditMinor });
    } catch (error) {
      await auditChange(prisma, actor, { action: 'INVOICE_CLAIM_DRAFT_FAILED', entityId: input.documentId, after: { kind, error: error instanceof PosError ? error.code : 'UNKNOWN' }, storeId: input.storeId });
    }
  }
  return created;
}

/** Draft claim for one invoice line (incorrect cost, overcharge, missing discount, wrong product, and so on). The amount is quantity × per-unit difference. */
export async function createClaimFromInvoiceLine(prisma: PrismaClient, actor: AdminActor, invoiceId: string, input: { lineId: string; kind: Parameters<typeof createVendorClaim>[2]['kind']; quantity: number; unitCostMinor: string; reason: string }) {
  const document = await prisma.invoiceDocument.findFirst({ where: { id: invoiceId, organizationId: actor.organizationId, ...(actor.storeId ? { storeId: actor.storeId } : {}) } });
  if (!document) throw new PosError('INVOICE_NOT_FOUND', 404);
  if (!document.vendorId) throw new PosError('INVOICE_VENDOR_REQUIRED');
  const line = await prisma.invoiceLine.findFirst({ where: { id: input.lineId, invoiceDocumentId: invoiceId, organizationId: actor.organizationId } });
  if (!line?.variantId) throw new PosError('INVOICE_LINE_NOT_FOUND', 404);
  return createVendorClaim(prisma, actor, { storeId: document.storeId, vendorId: document.vendorId, kind: input.kind, reason: input.reason, invoiceDocumentId: invoiceId, ...(document.purchaseOrderId ? { purchaseOrderId: document.purchaseOrderId } : {}),
    lines: [{ variantId: line.variantId, quantity: input.quantity, unitCostMinor: input.unitCostMinor, reason: input.reason, invoiceLineId: line.id }] });
}
