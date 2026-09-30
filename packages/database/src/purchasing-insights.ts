import type { PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';

const SOLD = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const OPEN_PO = ['SUBMITTED', 'PARTIALLY_RECEIVED'];

export type VelocitySuggestion = {
  variantId: string; productName: string; variantName: string; sku: string; available: number; onOrder: number; soldUnits: number; dailyVelocity: number; daysOfSupply: number | null;
  lowStockThreshold: number; reorderTarget: number; targetUnits: number; suggestedUnits: number; suggestedCases: number; casePackQuantity: number; minimumOrderQuantity: number;
  vendorId: string | null; vendorName: string | null; unitCostMinor: string | null; estimatedCostMinor: string | null;
};

/**
 * Purchase suggestions driven by recent sales. Units sold (pack sales count as their base bottles, stock-returns are netted out)
 * over the look-back window give a daily velocity; the suggestion covers lead time plus cover days, less stock on hand and on open
 * purchase orders, never below the configured reorder target, then rounded up to the vendor's minimum and case pack.
 * Nothing is ordered automatically; the result only feeds a reviewed draft purchase order.
 */
export async function velocitySuggestions(prisma: PrismaClient, actor: AdminActor, input: { storeId?: string; lookbackDays?: number; coverDays?: number; leadTimeDays?: number }): Promise<VelocitySuggestion[]> {
  const storeId = input.storeId ?? actor.storeId;
  if (!storeId) throw new PosError('STORE_REQUIRED');
  if (actor.storeId && actor.storeId !== storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
  const lookbackDays = input.lookbackDays ?? 28; const coverDays = input.coverDays ?? 14; const leadTimeDays = input.leadTimeDays ?? 3;
  for (const value of [lookbackDays, coverDays, leadTimeDays]) if (!Number.isInteger(value) || value < 0 || value > 365) throw new PosError('VELOCITY_PARAMETER_INVALID');
  if (lookbackDays < 1) throw new PosError('VELOCITY_PARAMETER_INVALID');
  const since = new Date(Date.now() - lookbackDays * 86_400_000);
  const org = actor.organizationId;
  const [sold, returned, levels, onOrder] = await Promise.all([
    prisma.$queryRaw<Array<{ variantId: string; units: bigint }>>`
      SELECT COALESCE(v."baseVariantId", v."id") AS "variantId", COALESCE(SUM(oi."quantity" * CASE WHEN v."baseVariantId" IS NULL THEN 1 ELSE v."unitsPerPack" END), 0) AS units
      FROM "OrderItem" oi JOIN "Order" o ON o."id" = oi."orderId" AND o."organizationId" = oi."organizationId"
      JOIN "ProductVariant" v ON v."id" = oi."variantId" AND v."organizationId" = oi."organizationId"
      WHERE o."organizationId" = ${org}::uuid AND o."storeId" = ${storeId}::uuid AND o."createdAt" >= ${since} AND o."status"::text = ANY(${SOLD}) GROUP BY 1`,
    prisma.$queryRaw<Array<{ variantId: string; units: bigint }>>`
      SELECT COALESCE(v."baseVariantId", v."id") AS "variantId", COALESCE(SUM(ri."quantity" * CASE WHEN v."baseVariantId" IS NULL THEN 1 ELSE v."unitsPerPack" END), 0) AS units
      FROM "RefundItem" ri JOIN "Refund" r ON r."id" = ri."refundId" AND r."organizationId" = ri."organizationId"
      JOIN "Order" o ON o."id" = r."orderId" AND o."organizationId" = r."organizationId"
      JOIN "ProductVariant" v ON v."id" = ri."variantId" AND v."organizationId" = ri."organizationId"
      WHERE o."organizationId" = ${org}::uuid AND o."storeId" = ${storeId}::uuid AND r."createdAt" >= ${since} AND r."status"::text = 'SUCCEEDED' AND ri."disposition"::text = 'RETURN_TO_STOCK' GROUP BY 1`,
    prisma.inventoryLevel.findMany({ where: { organizationId: org, storeId, variant: { active: true, baseVariantId: null, product: { active: true, inventoryTracked: true } } },
      include: { variant: { include: { product: true, vendorMappings: { where: { active: true }, include: { vendor: true }, orderBy: [{ preferred: 'desc' }, { createdAt: 'asc' }], take: 1 } } } } }),
    prisma.purchaseOrderLine.groupBy({ by: ['variantId'], where: { organizationId: org, purchaseOrder: { storeId, status: { in: OPEN_PO as never[] } } }, _sum: { orderedQuantity: true, receivedQuantity: true } }),
  ]);
  const soldBy = new Map(sold.map((row) => [row.variantId, Number(row.units)]));
  const returnedBy = new Map(returned.map((row) => [row.variantId, Number(row.units)]));
  const onOrderBy = new Map(onOrder.map((row) => [row.variantId, Math.max(0, (row._sum.orderedQuantity ?? 0) - (row._sum.receivedQuantity ?? 0))]));
  const suggestions: VelocitySuggestion[] = [];
  for (const level of levels) {
    const soldUnits = Math.max(0, (soldBy.get(level.variantId) ?? 0) - (returnedBy.get(level.variantId) ?? 0));
    const available = level.onHand - level.reserved; const pending = onOrderBy.get(level.variantId) ?? 0;
    const dailyVelocity = soldUnits / lookbackDays;
    const targetUnits = Math.max(Math.ceil(dailyVelocity * (leadTimeDays + coverDays)), level.reorderTarget);
    const need = targetUnits - (available + pending);
    if (need <= 0) continue;
    const mapping = level.variant.vendorMappings[0];
    const casePack = mapping?.casePackQuantity ?? 1; const moq = mapping?.minimumOrderQuantity ?? 1;
    const suggestedUnits = Math.ceil(Math.max(need, moq) / casePack) * casePack;
    const unitCost = mapping?.vendorCostMinor ?? null;
    suggestions.push({ variantId: level.variantId, productName: level.variant.product.name, variantName: level.variant.name, sku: level.variant.sku, available, onOrder: pending, soldUnits,
      dailyVelocity: Math.round(dailyVelocity * 100) / 100, daysOfSupply: dailyVelocity > 0 ? Math.round((available / dailyVelocity) * 10) / 10 : null, lowStockThreshold: level.lowStockThreshold, reorderTarget: level.reorderTarget,
      targetUnits, suggestedUnits, suggestedCases: Math.ceil(suggestedUnits / casePack), casePackQuantity: casePack, minimumOrderQuantity: moq, vendorId: mapping?.vendorId ?? null, vendorName: mapping?.vendor.name ?? null,
      unitCostMinor: unitCost?.toString() ?? null, estimatedCostMinor: unitCost === null ? null : (unitCost * BigInt(suggestedUnits)).toString() });
  }
  return suggestions.sort((left, right) => (left.daysOfSupply ?? Infinity) - (right.daysOfSupply ?? Infinity) || left.productName.localeCompare(right.productName)).slice(0, 200);
}

