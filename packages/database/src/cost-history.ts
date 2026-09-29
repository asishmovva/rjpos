import type { Prisma } from '@prisma/client';
import type { CostBreakdown } from '@rjpos/domain-types';

type Tx = Prisma.TransactionClient;

/** Appends an immutable cost-history row. Current vendor cost changes never rewrite earlier rows. */
export async function recordCostHistory(tx: Tx, input: {
  organizationId: string; storeId?: string | null; variantId: string; vendorId?: string | null; purchaseOrderId?: string | null; invoiceDocumentId?: string | null;
  source: 'PRODUCT_CREATED' | 'PURCHASE_RECEIPT' | 'INVOICE_CONFIRMED' | 'MANUAL_UPDATE'; occurredAt?: Date; casesOrdered?: number | null; casesReceived?: number | null;
  cost: CostBreakdown; unitsReceived?: number | null; unitsDamaged?: number; unitsRejected?: number; unitsShort?: number; createdByEmployeeId?: string | null; notes?: string | null;
}): Promise<void> {
  await tx.productCostHistory.create({ data: {
    organizationId: input.organizationId, storeId: input.storeId ?? null, variantId: input.variantId, vendorId: input.vendorId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? null, invoiceDocumentId: input.invoiceDocumentId ?? null, source: input.source, occurredAt: input.occurredAt ?? new Date(),
    casesOrdered: input.casesOrdered ?? null, casesReceived: input.casesReceived ?? null, unitsPerCase: input.cost.unitsPerCase,
    baseCaseCostMinor: input.cost.baseCaseCostMinor, discountPerCaseMinor: input.cost.discountPerCaseMinor, rebatePerCaseMinor: input.cost.rebatePerCaseMinor,
    effectiveCaseCostMinor: input.cost.effectiveCaseCostMinor, effectiveUnitCostMinor: input.cost.effectiveUnitCostMinor, unitsReceived: input.unitsReceived ?? null,
    unitsDamaged: input.unitsDamaged ?? 0, unitsRejected: input.unitsRejected ?? 0, unitsShort: input.unitsShort ?? 0, createdByEmployeeId: input.createdByEmployeeId ?? null, notes: input.notes ?? null,
  } });
}
