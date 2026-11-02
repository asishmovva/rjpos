import type { Prisma, PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';

export type ReceivingFilter = {
  vendorId?: string; invoiceNumber?: string; poNumber?: string; product?: string; employeeId?: string; status?: string; from?: Date; to?: Date; discrepancy?: boolean; page?: number; pageSize?: number;
};

/** Searchable receiving history. "product" matches name, SKU, UPC or vendor SKU, so a person can find a receipt from whatever they have in hand. */
export async function searchReceiving(prisma: PrismaClient, actor: AdminActor, filter: ReceivingFilter) {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 100); const page = Math.max(filter.page ?? 1, 1);
  const org = actor.organizationId;
  const product = filter.product?.trim();
  let shortReceiptIds: string[] | undefined;
  if (filter.discrepancy) shortReceiptIds = (await prisma.productCostHistory.findMany({ where: { organizationId: org, unitsShort: { gt: 0 }, purchaseReceiptId: { not: null } }, select: { purchaseReceiptId: true }, take: 2000 })).map((row) => row.purchaseReceiptId!);
  const where: Prisma.PurchaseReceiptWhereInput = { organizationId: org,
    purchaseOrder: { ...(actor.storeId ? { storeId: actor.storeId } : {}), ...(filter.vendorId ? { vendorId: filter.vendorId } : {}), ...(filter.poNumber?.trim() ? { poNumber: { contains: filter.poNumber.trim(), mode: 'insensitive' } } : {}), ...(filter.status ? { status: filter.status as never } : {}) },
    ...(filter.invoiceNumber?.trim() ? { vendorReferenceNumber: { contains: filter.invoiceNumber.trim(), mode: 'insensitive' } } : {}),
    ...(filter.employeeId ? { receivedByEmployeeId: filter.employeeId } : {}),
    ...(filter.from || filter.to ? { receivedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
    ...(product ? { lines: { some: { purchaseOrderLine: { OR: [{ productNameSnapshot: { contains: product, mode: 'insensitive' } }, { skuSnapshot: { contains: product, mode: 'insensitive' } }, { vendorSkuSnapshot: { contains: product, mode: 'insensitive' } },
      { variant: { barcodes: { some: { barcodeValue: product } } } }] } } } } : {}),
    ...(filter.discrepancy ? { OR: [{ lines: { some: { OR: [{ damagedQuantity: { gt: 0 } }, { rejectedQuantity: { gt: 0 } }] } } }, { id: { in: shortReceiptIds ?? [] } }] } : {}) };
  const [items, total] = await Promise.all([
    prisma.purchaseReceipt.findMany({ where, orderBy: { receivedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      include: { purchaseOrder: { select: { id: true, poNumber: true, status: true, vendor: { select: { id: true, name: true } } } }, receivedBy: { select: { id: true, firstName: true, lastName: true } }, _count: { select: { lines: true } },
        lines: { select: { deliveredQuantity: true, damagedQuantity: true, rejectedQuantity: true } } } }),
    prisma.purchaseReceipt.count({ where }),
  ]);
  return { total, page, pageSize, items: items.map((receipt) => ({ id: receipt.id, receivedAt: receipt.receivedAt, invoiceNumber: receipt.vendorReferenceNumber, purchaseOrder: receipt.purchaseOrder, receivedBy: receipt.receivedBy, lineCount: receipt._count.lines,
    deliveredUnits: receipt.lines.reduce((sum, line) => sum + line.deliveredQuantity, 0), damagedUnits: receipt.lines.reduce((sum, line) => sum + line.damagedQuantity, 0), rejectedUnits: receipt.lines.reduce((sum, line) => sum + line.rejectedQuantity, 0) })) };
}

/** One receipt with the exact economics it was posted with (from append-only cost history, not today's vendor price). */
export async function getReceiptDetail(prisma: PrismaClient, actor: AdminActor, receiptId: string) {
  const receipt = await prisma.purchaseReceipt.findFirst({ where: { id: receiptId, organizationId: actor.organizationId, ...(actor.storeId ? { purchaseOrder: { storeId: actor.storeId } } : {}) },
    include: { purchaseOrder: { include: { vendor: { select: { id: true, name: true } }, store: { select: { id: true, name: true } } } }, receivedBy: { select: { id: true, firstName: true, lastName: true } },
      lines: { include: { purchaseOrderLine: true } } } });
  if (!receipt) throw new PosError('RECEIPT_NOT_FOUND', 404);
  const history = await prisma.productCostHistory.findMany({ where: { organizationId: actor.organizationId, purchaseReceiptId: receiptId }, orderBy: { createdAt: 'asc' } });
  const invoiceId = history.find((row) => row.invoiceDocumentId)?.invoiceDocumentId
    ?? (await prisma.invoiceDocument.findFirst({ where: { organizationId: actor.organizationId, purchaseOrderId: receipt.purchaseOrderId, reviewStatus: 'CONFIRMED' }, select: { id: true } }))?.id ?? null;
  const invoice = invoiceId ? await prisma.invoiceDocument.findFirst({ where: { id: invoiceId, organizationId: actor.organizationId }, select: { id: true, invoiceNumber: true, invoiceDate: true, totalMinor: true, docType: true, orderNumber: true, paymentTerms: true, dueDate: true } }) : null;
  const claims = invoiceId ? await prisma.vendorClaim.findMany({ where: { organizationId: actor.organizationId, invoiceDocumentId: invoiceId }, select: { id: true, kind: true, status: true, expectedCreditMinor: true, creditedMinor: true, creditReference: true, resolvedAt: true } }) : [];
  const lines = receipt.lines.map((line) => {
    const cost = history.find((row) => row.variantId === line.purchaseOrderLine.variantId);
    return { id: line.id, productName: line.purchaseOrderLine.productNameSnapshot, variantName: line.purchaseOrderLine.variantNameSnapshot, sku: line.purchaseOrderLine.skuSnapshot, vendorSku: line.purchaseOrderLine.vendorSkuSnapshot,
      deliveredUnits: line.deliveredQuantity, damagedUnits: line.damagedQuantity, rejectedUnits: line.rejectedQuantity, sellableUnits: line.deliveredQuantity - line.damagedQuantity - line.rejectedQuantity, unitCostMinor: line.unitCostMinor,
      cost: cost ? { unitsPerCase: cost.unitsPerCase, listCaseCostMinor: cost.listCaseCostMinor, baseCaseCostMinor: cost.baseCaseCostMinor, discountPerCaseMinor: cost.discountPerCaseMinor, rebatePerCaseMinor: cost.rebatePerCaseMinor, netCaseCostMinor: cost.netCaseCostMinor,
        effectiveCaseCostMinor: cost.effectiveCaseCostMinor, effectiveUnitCostMinor: cost.effectiveUnitCostMinor, unitsShort: cost.unitsShort, componentsJson: cost.componentsJson, temporaryDeal: cost.temporaryDeal, occurredAt: cost.occurredAt } : null };
  });
  return { id: receipt.id, receivedAt: receipt.receivedAt, receivedBy: receipt.receivedBy, notes: receipt.notes, invoiceNumber: receipt.vendorReferenceNumber, purchaseOrder: receipt.purchaseOrder, invoice, claims, lines };
}

/** Purchasing view of one vendor: invoices, POs, receipts, current mappings, cost history, deals, claims and credits. */
export async function vendorOverview(prisma: PrismaClient, actor: AdminActor, vendorId: string) {
  const org = actor.organizationId; const store = actor.storeId ? { storeId: actor.storeId } : {};
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, organizationId: org } });
  if (!vendor) throw new PosError('VENDOR_NOT_FOUND', 404);
  const [invoices, purchaseOrders, receipts, mappings, costHistory, deals, claims] = await Promise.all([
    prisma.invoiceDocument.findMany({ where: { organizationId: org, vendorId, ...store }, orderBy: { uploadedAt: 'desc' }, take: 25, select: { id: true, invoiceNumber: true, invoiceDate: true, totalMinor: true, reviewStatus: true, docType: true, uploadedAt: true } }),
    prisma.purchaseOrder.findMany({ where: { organizationId: org, vendorId, ...store }, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, poNumber: true, status: true, createdAt: true, _count: { select: { lines: true } } } }),
    prisma.purchaseReceipt.findMany({ where: { organizationId: org, purchaseOrder: { vendorId, ...store } }, orderBy: { receivedAt: 'desc' }, take: 25, select: { id: true, receivedAt: true, vendorReferenceNumber: true, purchaseOrder: { select: { poNumber: true } } } }),
    prisma.vendorProductMapping.findMany({ where: { organizationId: org, vendorId, active: true }, take: 200, orderBy: { updatedAt: 'desc' }, include: { variant: { select: { id: true, name: true, sku: true, product: { select: { id: true, name: true } } } } } }),
    prisma.productCostHistory.findMany({ where: { organizationId: org, vendorId }, orderBy: { occurredAt: 'desc' }, take: 40, include: { variant: { select: { name: true, sku: true, product: { select: { name: true } } } } } }),
    prisma.vendorDeal.findMany({ where: { organizationId: org, vendorId, active: true }, take: 50 }),
    prisma.vendorClaim.findMany({ where: { organizationId: org, vendorId, ...store }, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, kind: true, status: true, reason: true, expectedCreditMinor: true, creditedMinor: true, creditReference: true, invoiceDocumentId: true, createdAt: true, resolvedAt: true } }),
  ]);
  const openCredit = claims.filter((claim) => claim.status === 'SUBMITTED').reduce((sum, claim) => sum + claim.expectedCreditMinor, 0n);
  return { vendor, invoices, purchaseOrders, receipts, mappings, costHistory, deals, claims, openCreditExpectedMinor: openCredit };
}

/** Last received facts and the receipt history for a product, from what was actually posted. */
export async function productReceiptHistory(prisma: PrismaClient, actor: AdminActor, variantIds: string[]) {
  if (!variantIds.length) return { last: null, history: [] };
  const history = await prisma.productCostHistory.findMany({ where: { organizationId: actor.organizationId, variantId: { in: variantIds }, source: { in: ['INVOICE_CONFIRMED', 'PURCHASE_RECEIPT'] } }, orderBy: { occurredAt: 'desc' }, take: 50 });
  const vendorIds = [...new Set(history.map((row) => row.vendorId).filter((value): value is string => Boolean(value)))];
  const [vendors, invoices] = await Promise.all([
    prisma.vendor.findMany({ where: { organizationId: actor.organizationId, id: { in: vendorIds } }, select: { id: true, name: true } }),
    prisma.invoiceDocument.findMany({ where: { organizationId: actor.organizationId, id: { in: history.map((row) => row.invoiceDocumentId).filter((value): value is string => Boolean(value)) } }, select: { id: true, invoiceNumber: true } }),
  ]);
  const rows = history.map((row) => ({ id: row.id, occurredAt: row.occurredAt, vendor: vendors.find((vendor) => vendor.id === row.vendorId) ?? null, invoice: invoices.find((invoice) => invoice.id === row.invoiceDocumentId) ?? null,
    unitsReceived: row.unitsReceived, unitsPerCase: row.unitsPerCase, baseCaseCostMinor: row.baseCaseCostMinor, listCaseCostMinor: row.listCaseCostMinor, discountPerCaseMinor: row.discountPerCaseMinor, netCaseCostMinor: row.netCaseCostMinor,
    effectiveCaseCostMinor: row.effectiveCaseCostMinor, effectiveUnitCostMinor: row.effectiveUnitCostMinor, temporaryDeal: row.temporaryDeal }));
  return { last: rows[0] ?? null, history: rows };
}
