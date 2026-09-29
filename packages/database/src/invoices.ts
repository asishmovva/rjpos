import { Prisma, type InvoiceLineMatchStatus, type PrismaClient } from '@prisma/client';
import { applyVendorDeals, reviewInvoiceLine, reviewInvoiceTotals, unitCostFromCase } from '@rjpos/domain-types';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { createPurchaseOrder, receivePurchaseOrder, transitionPurchaseOrder } from './purchasing.js';
import { addMasterProductToStore, saveVendorMapping } from './purchasing.js';
import { createProduct, createVariant, schedulePrice } from './back-office.js';

export type InvoiceOcrLine = {
  description: string;
  upc?: string;
  vendorSku?: string;
  /** Cases ordered (invoice quantity). */
  quantity: number;
  /** Units per case. */
  caseQuantity?: number;
  size?: string;
  casesReceived?: number;
  /** Printed case price; when present it is the base for the discount and effective-cost review. */
  caseCostMinor?: string;
  discountPerCaseMinor?: string;
  /** Printed or derived per-unit cost. May be omitted when caseCostMinor and caseQuantity are given. */
  unitCostMinor?: string;
  lineTotalMinor: string;
  confidence?: number;
  rawText?: string;
};

export type InvoiceOcrResult = {
  vendorName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  poReference?: string;
  subtotalMinor?: string;
  discountMinor?: string;
  rebateMinor?: string;
  taxMinor?: string;
  feesMinor?: string;
  totalMinor?: string;
  rawText?: string;
  confidence?: number;
  provider: string;
  rawReference?: Record<string, unknown>;
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
  vendor: true,
  store: true,
  purchaseOrder: true,
  uploadedBy: { select: { id: true, firstName: true, lastName: true } },
  lines: { include: { variant: { include: { product: true, barcodes: true } }, masterProduct: true }, orderBy: { lineNumber: 'asc' as const } },
};

const integerMoney = (value: string | undefined, code: string): bigint | null => {
  if (value === undefined || value === '') return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new PosError(code);
  return BigInt(value);
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

export async function applyInvoiceOcrResult(prisma: PrismaClient, actor: AdminActor, id: string, result: InvoiceOcrResult) {
  const document = await getInvoiceDocumentInput(prisma, actor, id);
  if (!result.lines.length) throw new PosError('INVOICE_OCR_LINES_REQUIRED');
  const invoiceDate = result.invoiceDate ? new Date(result.invoiceDate) : null;
  if (invoiceDate && Number.isNaN(invoiceDate.getTime())) throw new PosError('INVOICE_DATE_INVALID');
  const subtotalMinor = integerMoney(result.subtotalMinor, 'INVOICE_SUBTOTAL_INVALID');
  const taxMinor = integerMoney(result.taxMinor, 'INVOICE_TAX_INVALID');
  const totalMinor = integerMoney(result.totalMinor, 'INVOICE_TOTAL_INVALID');
  const discountMinor = integerMoney(result.discountMinor, 'INVOICE_DISCOUNT_INVALID');
  const rebateMinor = integerMoney(result.rebateMinor, 'INVOICE_REBATE_INVALID');
  const feesMinor = integerMoney(result.feesMinor, 'INVOICE_FEES_INVALID');
  const duplicate = Boolean(result.invoiceNumber && await prisma.invoiceDocument.findFirst({ where: {
    organizationId: actor.organizationId, id: { not: id }, reviewStatus: { not: 'REJECTED' },
    ...(document.vendorId ? { vendorId: document.vendorId } : {}), invoiceNumber: result.invoiceNumber.trim(),
    ...(invoiceDate ? { invoiceDate } : {}), ...(totalMinor === null ? {} : { totalMinor }),
  } }));
  await prisma.$transaction(async (tx) => {
    await tx.invoiceLine.deleteMany({ where: { organizationId: actor.organizationId, invoiceDocumentId: id } });
    for (const [index, line] of result.lines.entries()) {
      if (!line.description.trim() || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || !Number.isSafeInteger(line.caseQuantity ?? 1) || (line.caseQuantity ?? 1) < 1) throw new PosError('INVOICE_LINE_INVALID');
      const caseCostMinor = integerMoney(line.caseCostMinor, 'INVOICE_LINE_COST_INVALID');
      const discountPerCaseMinor = integerMoney(line.discountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID');
      const unitCostMinor = integerMoney(line.unitCostMinor, 'INVOICE_LINE_COST_INVALID') ?? (caseCostMinor === null ? null : unitCostFromCase(caseCostMinor, line.caseQuantity ?? 1));
      const lineTotalMinor = integerMoney(line.lineTotalMinor, 'INVOICE_LINE_TOTAL_INVALID');
      if (unitCostMinor === null || lineTotalMinor === null) throw new PosError('INVOICE_LINE_COST_INVALID');
      if (line.casesReceived !== undefined && (!Number.isSafeInteger(line.casesReceived) || line.casesReceived < 0)) throw new PosError('INVOICE_LINE_INVALID');
      const upc = line.upc?.trim().replace(/[\s-]/g, '') || null;
      const storeMatch = upc ? await tx.barcode.findFirst({ where: { organizationId: actor.organizationId, barcodeValue: upc }, select: { variantId: true } }) : null;
      const master = !storeMatch && upc ? await tx.masterProduct.findUnique({ where: { upc }, select: { id: true } }) : null;
      const matchStatus: InvoiceLineMatchStatus = storeMatch ? 'MATCHED' : master ? 'MASTER_CATALOG' : 'NEEDS_REVIEW';
      await tx.invoiceLine.create({ data: { organizationId: actor.organizationId, invoiceDocumentId: id, lineNumber: index + 1,
        description: line.description.trim(), upc, vendorSku: line.vendorSku?.trim() || null, quantity: line.quantity,
        caseQuantity: line.caseQuantity ?? 1, unitCostMinor, lineTotalMinor, caseCostMinor, discountPerCaseMinor,
        size: line.size?.trim() || null, casesReceived: line.casesReceived ?? null, rawText: line.rawText?.slice(0, 2000) ?? null,
        ...(line.confidence === undefined ? {} : { confidence: line.confidence }),
        matchStatus, variantId: storeMatch?.variantId ?? null, masterProductId: master?.id ?? null } });
    }
    await tx.invoiceDocument.update({ where: { id }, data: { ocrStatus: 'COMPLETED', ocrProvider: result.provider, ocrError: null,
      ...(result.confidence === undefined ? {} : { ocrConfidence: result.confidence }),
      ...(result.rawReference === undefined ? {} : { rawProviderResult: result.rawReference as Prisma.InputJsonValue }),
      vendorNameExtracted: result.vendorName?.trim() || null, invoiceNumber: result.invoiceNumber?.trim() || null, invoiceDate,
      subtotalMinor, taxMinor, totalMinor, discountMinor, rebateMinor, feesMinor, poReference: result.poReference?.trim() || null,
      rawText: result.rawText?.slice(0, 20000) ?? null, possibleDuplicate: duplicate } });
  });
  await audit(prisma, actor, 'INVOICE_OCR_COMPLETED', id, { provider: result.provider, lineCount: result.lines.length, possibleDuplicate: duplicate });
  return getInvoiceDocument(prisma, actor, id);
}

export async function updateInvoiceDocument(prisma: PrismaClient, actor: AdminActor, id: string, input: {
  vendorId?: string | null; purchaseOrderId?: string | null; invoiceNumber?: string; invoiceDate?: string; subtotalMinor?: string; taxMinor?: string; totalMinor?: string;
  poReference?: string; discountMinor?: string; rebateMinor?: string; feesMinor?: string;
}) {
  const document = await getInvoiceDocumentInput(prisma, actor, id);
  if (input.vendorId && !await prisma.vendor.findFirst({ where: { id: input.vendorId, organizationId: actor.organizationId, active: true } })) throw new PosError('VENDOR_NOT_FOUND', 404);
  if (input.purchaseOrderId && !await prisma.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, organizationId: actor.organizationId, storeId: document.storeId } })) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
  const date = input.invoiceDate === undefined ? undefined : input.invoiceDate ? new Date(input.invoiceDate) : null;
  if (date && Number.isNaN(date.getTime())) throw new PosError('INVOICE_DATE_INVALID');
  await prisma.invoiceDocument.update({ where: { id }, data: {
    ...(input.vendorId === undefined ? {} : { vendorId: input.vendorId }), ...(input.purchaseOrderId === undefined ? {} : { purchaseOrderId: input.purchaseOrderId }),
    ...(input.invoiceNumber === undefined ? {} : { invoiceNumber: input.invoiceNumber.trim() || null }), ...(date === undefined ? {} : { invoiceDate: date }),
    ...(input.subtotalMinor === undefined ? {} : { subtotalMinor: integerMoney(input.subtotalMinor, 'INVOICE_SUBTOTAL_INVALID') }),
    ...(input.taxMinor === undefined ? {} : { taxMinor: integerMoney(input.taxMinor, 'INVOICE_TAX_INVALID') }),
    ...(input.totalMinor === undefined ? {} : { totalMinor: integerMoney(input.totalMinor, 'INVOICE_TOTAL_INVALID') }),
    ...(input.poReference === undefined ? {} : { poReference: input.poReference.trim() || null }),
    ...(input.discountMinor === undefined ? {} : { discountMinor: integerMoney(input.discountMinor, 'INVOICE_DISCOUNT_INVALID') }),
    ...(input.rebateMinor === undefined ? {} : { rebateMinor: integerMoney(input.rebateMinor, 'INVOICE_REBATE_INVALID') }),
    ...(input.feesMinor === undefined ? {} : { feesMinor: integerMoney(input.feesMinor, 'INVOICE_FEES_INVALID') }),
  } });
  await audit(prisma, actor, 'INVOICE_REVIEW_UPDATED', id);
  return getInvoiceDocument(prisma, actor, id);
}

export async function updateInvoiceLine(prisma: PrismaClient, actor: AdminActor, documentId: string, lineId: string, input: {
  variantId?: string | null; quantity?: number; caseQuantity?: number; unitCostMinor?: string; lineTotalMinor?: string; ignored?: boolean;
  casesReceived?: number | null; caseCostMinor?: string | null; discountPerCaseMinor?: string | null; size?: string | null;
  /** Explicit, reviewed choice: update the vendor's current cost from this line when the invoice is confirmed. */
  updateVendorCost?: boolean;
  newProduct?: InvoiceNewProductDraft | null;
}) {
  await getInvoiceDocumentInput(prisma, actor, documentId);
  const line = await prisma.invoiceLine.findFirst({ where: { id: lineId, invoiceDocumentId: documentId, organizationId: actor.organizationId } });
  if (!line) throw new PosError('INVOICE_LINE_NOT_FOUND', 404);
  if (input.variantId && !await prisma.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId, active: true } })) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
  if (input.quantity !== undefined && (!Number.isSafeInteger(input.quantity) || input.quantity < 1)) throw new PosError('INVOICE_LINE_QUANTITY_INVALID');
  if (input.caseQuantity !== undefined && (!Number.isSafeInteger(input.caseQuantity) || input.caseQuantity < 1)) throw new PosError('INVOICE_LINE_CASE_QUANTITY_INVALID');
  const variantId = input.variantId === undefined ? line.variantId : input.variantId;
  if (input.newProduct) {
    if (!input.newProduct.categoryId || !input.newProduct.productName.trim() || !input.newProduct.variantName.trim()
      || !input.newProduct.sku.trim() || !/^(0|[1-9]\d*)$/.test(input.newProduct.priceMinor)) throw new PosError('INVOICE_NEW_PRODUCT_INVALID');
  }
  const data: Prisma.InvoiceLineUncheckedUpdateInput = { ...(input.variantId === undefined ? {} : { variantId: input.variantId, masterProductId: null }),
    ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.caseQuantity === undefined ? {} : { caseQuantity: input.caseQuantity }),
    ...(input.unitCostMinor === undefined ? {} : { unitCostMinor: integerMoney(input.unitCostMinor, 'INVOICE_LINE_COST_INVALID')! }),
    ...(input.lineTotalMinor === undefined ? {} : { lineTotalMinor: integerMoney(input.lineTotalMinor, 'INVOICE_LINE_TOTAL_INVALID')! }),
    ...(input.ignored === undefined ? {} : { ignored: input.ignored }),
    ...(input.casesReceived === undefined ? {} : { casesReceived: input.casesReceived }),
    ...(input.caseCostMinor === undefined ? {} : { caseCostMinor: input.caseCostMinor === null ? null : integerMoney(input.caseCostMinor, 'INVOICE_LINE_COST_INVALID') }),
    ...(input.discountPerCaseMinor === undefined ? {} : { discountPerCaseMinor: input.discountPerCaseMinor === null ? null : integerMoney(input.discountPerCaseMinor, 'INVOICE_LINE_DISCOUNT_INVALID') }),
    ...(input.size === undefined ? {} : { size: input.size?.trim() || null }),
    ...(input.updateVendorCost === undefined ? {} : { updateVendorCost: input.updateVendorCost }),
    ...(input.newProduct === undefined ? {} : { newProductData: input.newProduct === null ? Prisma.DbNull : input.newProduct as Prisma.InputJsonValue }),
    matchStatus: input.ignored ? 'INVALID' : input.newProduct ? 'NEW_PRODUCT' : variantId ? 'MATCHED' : 'NEEDS_REVIEW' };
  await prisma.invoiceLine.update({ where: { id: lineId }, data });
  await audit(prisma, actor, 'INVOICE_PRODUCT_MATCH_CHANGED', documentId, { lineId, variantId, ignored: input.ignored ?? line.ignored });
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
  const lines = document.lines.map((line) => {
    const mapping = mappings.find((candidate) => candidate.variantId === line.variantId);
    const poLine = document.purchaseOrder?.lines.find((candidate) => candidate.variantId === line.variantId);
    const { review, error } = safeReviewLine(line, { poUnitCostMinor: poLine?.unitCostMinor ?? null, mappingUnitCostMinor: mapping?.vendorCostMinor ?? null, mappingUnitsPerCase: mapping?.casePackQuantity ?? null });
    const applicable = deals.filter((deal) => deal.variantId === null || deal.variantId === line.variantId);
    let dealPreview = null;
    if (review && applicable.length) {
      try { dealPreview = applyVendorDeals({ baseCaseCostMinor: review.baseCaseCostMinor, unitsPerCase: line.caseQuantity, cases: line.quantity, deals: applicable }); } catch { dealPreview = null; }
    }
    return { lineId: line.id, ignored: line.ignored, review, error, availableDeals: applicable.map((deal) => ({ id: deal.id, name: deal.name, kind: deal.kind })), dealPreview };
  });
  const totals = reviewInvoiceTotals({ lineTotalsMinor: document.lines.map((line) => line.lineTotalMinor), subtotalMinor: document.subtotalMinor, discountMinor: document.discountMinor,
    taxMinor: document.taxMinor, feesMinor: document.feesMinor, totalMinor: document.totalMinor });
  const hasDiscrepancies = totals.discrepancies.length > 0 || lines.some((line) => !line.ignored && (line.error !== null || (line.review?.discrepancies.length ?? 0) > 0));
  return { invoiceId: document.id, lines, totals, hasDiscrepancies };
}

export async function confirmInvoiceDocument(prisma: PrismaClient, actor: AdminActor, id: string, acknowledgeDuplicate = false, acknowledgeDiscrepancies = false) {
  const document = await prisma.invoiceDocument.findFirst({ where: { id, organizationId: actor.organizationId,
    ...(actor.storeId ? { storeId: actor.storeId } : {}) }, include: { lines: true } });
  if (!document) throw new PosError('INVOICE_NOT_FOUND', 404);
  if (document.reviewStatus !== 'DRAFT' || document.ocrStatus !== 'COMPLETED') throw new PosError('INVOICE_NOT_CONFIRMABLE', 409);
  if (!document.vendorId) throw new PosError('INVOICE_VENDOR_REQUIRED');
  if (document.possibleDuplicate && !acknowledgeDuplicate) throw new PosError('INVOICE_DUPLICATE_REQUIRES_ACKNOWLEDGEMENT', 409);
  const lines = document.lines.filter((line) => !line.ignored);
  if (!lines.length || lines.some((line) => !line.variantId && !line.newProductData)) throw new PosError('INVOICE_LINES_REQUIRE_REVIEW', 409);
  // The reviewed calculations must be valid, and any disagreement must have been seen and explicitly accepted before anything is posted.
  const review = await getInvoiceReview(prisma, actor, id);
  if (review.lines.some((line) => !line.ignored && line.error)) throw new PosError('INVOICE_LINE_INVALID', 409);
  if (review.hasDiscrepancies && !acknowledgeDiscrepancies) throw new PosError('INVOICE_DISCREPANCIES_REQUIRE_ACKNOWLEDGEMENT', 409);
  const costs = new Map(review.lines.filter((line) => line.review).map((line) => [line.lineId, line.review!]));
  for (const line of lines) {
    if (line.variantId) continue;
    const draft = line.newProductData as InvoiceNewProductDraft | null;
    if (!draft) throw new PosError('INVOICE_LINES_REQUIRE_REVIEW', 409);
    let variant: { id: string };
    if (line.masterProductId && line.upc) {
      const added = await addMasterProductToStore(prisma, actor, line.upc, { categoryId: draft.categoryId, sku: draft.sku,
        variantName: draft.variantName, storeId: document.storeId, priceMinor: draft.priceMinor, costMinor: costs.get(line.id)!.effectiveUnitCostMinor.toString() });
      variant = added.variant;
    } else {
      const product = await createProduct(prisma, actor, { categoryId: draft.categoryId, name: draft.productName,
        ...(draft.brand ? { brand: draft.brand } : {}),
        ageRestricted: draft.ageRestricted ?? false, inventoryTracked: true });
      const barcode = draft.barcode || line.upc;
      const created = await createVariant(prisma, actor, product.id, { name: draft.variantName, sku: draft.sku,
        ...(barcode ? { barcode } : {}), costMinor: costs.get(line.id)!.effectiveUnitCostMinor.toString() });
      if (!created) throw new PosError('INVOICE_PRODUCT_CREATE_FAILED');
      variant = created;
      await schedulePrice(prisma, actor, { variantId: variant.id, storeId: document.storeId, amountMinor: draft.priceMinor, effectiveFrom: new Date() });
    }
    await prisma.invoiceLine.update({ where: { id: line.id }, data: { variantId: variant.id, matchStatus: 'MATCHED' } });
    line.variantId = variant.id;
  }
  for (const line of lines) {
    const cost = costs.get(line.id)!;
    const mapping = await prisma.vendorProductMapping.findFirst({ where: { organizationId: actor.organizationId, vendorId: document.vendorId, variantId: line.variantId! } });
    // The vendor's current cost changes only through an explicit, reviewed choice. A missing mapping is created (a new link, not an overwrite).
    if (mapping && !line.updateVendorCost) continue;
    await saveVendorMapping(prisma, actor, { ...(mapping ? { id: mapping.id } : {}), vendorId: document.vendorId, variantId: line.variantId!,
      ...(line.vendorSku ? { vendorSku: line.vendorSku } : {}), vendorCostMinor: unitCostFromCase(cost.baseCaseCostMinor, cost.unitsPerCase).toString(), caseCostMinor: cost.baseCaseCostMinor.toString(),
      casePackQuantity: line.caseQuantity, minimumOrderQuantity: line.caseQuantity, active: true });
  }
  let purchaseOrderId = document.purchaseOrderId;
  if (!purchaseOrderId) {
    const po = await createPurchaseOrder(prisma, actor, { storeId: document.storeId, vendorId: document.vendorId,
      poNumber: `INV-${document.invoiceNumber?.trim() || document.id.slice(0, 8)}`, notes: `Created from reviewed invoice ${document.originalFilename}`,
      lines: lines.map((line) => { const cost = costs.get(line.id)!; return { variantId: line.variantId!, quantity: line.quantity * line.caseQuantity, unitCostMinor: cost.effectiveUnitCostMinor.toString(),
        unitsPerCase: line.caseQuantity, caseCostMinor: cost.baseCaseCostMinor.toString(), discountPerCaseMinor: cost.discountPerCaseMinor.toString(), rebatePerCaseMinor: cost.rebatePerCaseMinor.toString() }; }) });
    purchaseOrderId = po.id;
    await prisma.invoiceDocument.update({ where: { id }, data: { purchaseOrderId } });
    await transitionPurchaseOrder(prisma, actor, purchaseOrderId, 'SUBMIT');
  }
  const order = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, organizationId: actor.organizationId }, include: { lines: true } });
  if (!order) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
  const receiptLines = lines.flatMap((line) => {
    const poLine = order.lines.find((candidate) => candidate.variantId === line.variantId);
    if (!poLine) throw new PosError('INVOICE_PO_LINE_MISMATCH', 409);
    const deliveredQuantity = (line.casesReceived ?? line.quantity) * line.caseQuantity;
    return deliveredQuantity > 0 ? [{ purchaseOrderLineId: poLine.id, deliveredQuantity, unitCostMinor: costs.get(line.id)!.effectiveUnitCostMinor.toString() }] : [];
  });
  if (!receiptLines.length) throw new PosError('INVOICE_NOTHING_RECEIVED', 409);
  const receipt = await receivePurchaseOrder(prisma, actor, order.id, { idempotencyKey: `invoice:${id}`, invoiceDocumentId: id,
    ...(document.invoiceNumber ? { vendorReferenceNumber: document.invoiceNumber } : {}), notes: `Confirmed from invoice ${document.originalFilename}`, lines: receiptLines });
  await prisma.invoiceDocument.update({ where: { id }, data: { reviewStatus: 'CONFIRMED', confirmedByEmployeeId: actor.userId,
    confirmedAt: new Date(), purchaseOrderId: order.id } });
  await audit(prisma, actor, 'INVOICE_CONFIRMED', id, { purchaseOrderId: order.id, receiptId: receipt.id, discrepanciesAcknowledged: review.hasDiscrepancies,
    vendorCostUpdatedLines: lines.filter((line) => line.updateVendorCost).length });
  return getInvoiceDocument(prisma, actor, id);
}
