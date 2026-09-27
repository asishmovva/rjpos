import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type InventoryTransferStatus,
  type PrismaClient,
  type PromotionScope,
  type PromotionType,
} from '@prisma/client';
import type { CartDiscount } from '@rjpos/domain-types';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';

type Tx = Prisma.TransactionClient;
type PageInput = { page?: number; pageSize?: number };

const pageArgs = (input: PageInput) => {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize ?? 25)));
  return { page, pageSize, skip: (page - 1) * pageSize };
};

const required = (value: string | undefined, code: string): string => {
  const result = value?.trim() ?? '';
  if (!result) throw new PosError(code);
  return result;
};

const positive = (value: number, code: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PosError(code);
  return value;
};

const nonnegative = (value: number, code: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new PosError(code);
  return value;
};

const money = (value: string, code: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new PosError(code);
  return BigInt(value);
};

const fingerprint = (lines: Array<{ transferLineId: string; quantity: number }>): string => createHash('sha256')
  .update(JSON.stringify([...lines].sort((a, b) => a.transferLineId.localeCompare(b.transferLineId)))).digest('hex');

async function audit(
  tx: Tx,
  actor: AdminActor,
  input: { action: string; entityType: string; entityId: string; storeId?: string; metadata?: Prisma.InputJsonObject },
): Promise<void> {
  await tx.auditRecord.create({ data: {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    ...(input.storeId ? { storeId: input.storeId } : {}),
    ...(input.metadata ? { metadataJson: input.metadata } : {}),
  } });
}

export async function updateInventoryPolicy(
  prisma: PrismaClient,
  actor: AdminActor,
  input: { storeId: string; variantId: string; lowStockThreshold: number; reorderTarget: number },
) {
  const threshold = nonnegative(input.lowStockThreshold, 'LOW_STOCK_THRESHOLD_INVALID');
  const target = nonnegative(input.reorderTarget, 'REORDER_TARGET_INVALID');
  if (target < threshold) throw new PosError('REORDER_TARGET_BELOW_THRESHOLD');
  const level = await prisma.inventoryLevel.findFirst({ where: {
    organizationId: actor.organizationId, storeId: input.storeId, variantId: input.variantId,
  } });
  if (!level) throw new PosError('INVENTORY_LEVEL_NOT_FOUND', 404);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.inventoryLevel.update({ where: { id: level.id }, data: { lowStockThreshold: threshold, reorderTarget: target } });
    await audit(tx, actor, { action: 'INVENTORY_POLICY_UPDATED', entityType: 'InventoryLevel', entityId: level.id,
      storeId: input.storeId, metadata: { variantId: input.variantId, lowStockThreshold: threshold, reorderTarget: target } });
    return updated;
  });
}

const transferInclude = {
  sourceStore: true,
  destinationStore: true,
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  lines: { include: { variant: { include: { product: true } } }, orderBy: { id: 'asc' as const } },
  receipts: { include: { lines: true }, orderBy: { receivedAt: 'asc' as const } },
} satisfies Prisma.InventoryTransferInclude;

export async function listTransfers(
  prisma: PrismaClient,
  actor: AdminActor,
  input: PageInput & { storeId?: string; status?: InventoryTransferStatus },
) {
  const { page, pageSize, skip } = pageArgs(input);
  const where: Prisma.InventoryTransferWhereInput = {
    organizationId: actor.organizationId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.storeId ? { OR: [{ sourceStoreId: input.storeId }, { destinationStoreId: input.storeId }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.inventoryTransfer.findMany({ where, include: transferInclude, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    prisma.inventoryTransfer.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function createTransfer(
  prisma: PrismaClient,
  actor: AdminActor,
  input: { sourceStoreId: string; destinationStoreId: string; transferNumber?: string; notes?: string; lines: Array<{ variantId: string; quantity: number }> },
) {
  if (input.sourceStoreId === input.destinationStoreId) throw new PosError('TRANSFER_STORES_MUST_DIFFER');
  if (!input.lines.length) throw new PosError('TRANSFER_LINES_REQUIRED');
  const lineMap = new Map<string, number>();
  for (const line of input.lines) {
    if (lineMap.has(line.variantId)) throw new PosError('TRANSFER_VARIANT_DUPLICATE');
    lineMap.set(line.variantId, positive(line.quantity, 'TRANSFER_QUANTITY_INVALID'));
  }
  const [storeCount, variantCount] = await Promise.all([
    prisma.store.count({ where: { organizationId: actor.organizationId, id: { in: [input.sourceStoreId, input.destinationStoreId] }, status: 'ACTIVE' } }),
    prisma.productVariant.count({ where: { organizationId: actor.organizationId, id: { in: [...lineMap.keys()] }, active: true } }),
  ]);
  if (storeCount !== 2) throw new PosError('TRANSFER_STORE_NOT_FOUND', 404);
  if (variantCount !== lineMap.size) throw new PosError('TRANSFER_VARIANT_NOT_FOUND', 404);
  const transferNumber = input.transferNumber?.trim() || `TR-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 5).toUpperCase()}`;
  try {
    return await prisma.$transaction(async (tx) => {
      const transfer = await tx.inventoryTransfer.create({ data: {
        organizationId: actor.organizationId, sourceStoreId: input.sourceStoreId, destinationStoreId: input.destinationStoreId,
        createdByEmployeeId: actor.userId, transferNumber, notes: input.notes?.trim() || null,
      } });
      await tx.inventoryTransferLine.createMany({ data: [...lineMap].map(([variantId, requestedQuantity]) => ({
        organizationId: actor.organizationId, transferId: transfer.id, variantId, requestedQuantity,
      })) });
      await audit(tx, actor, { action: 'TRANSFER_CREATED', entityType: 'InventoryTransfer', entityId: transfer.id,
        storeId: input.sourceStoreId, metadata: { destinationStoreId: input.destinationStoreId, transferNumber } });
      return tx.inventoryTransfer.findUniqueOrThrow({ where: { id: transfer.id }, include: transferInclude });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('TRANSFER_NUMBER_CONFLICT', 409);
    throw error;
  }
}

async function lockedTransfer(tx: Tx, actor: AdminActor, transferId: string) {
  await tx.$queryRaw`SELECT id FROM "InventoryTransfer" WHERE id = ${transferId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
  const transfer = await tx.inventoryTransfer.findFirst({ where: { id: transferId, organizationId: actor.organizationId }, include: transferInclude });
  if (!transfer) throw new PosError('TRANSFER_NOT_FOUND', 404);
  return transfer;
}

export async function submitTransfer(prisma: PrismaClient, actor: AdminActor, transferId: string) {
  return prisma.$transaction(async (tx) => {
    const transfer = await lockedTransfer(tx, actor, transferId);
    if (transfer.status === 'SUBMITTED') return transfer;
    if (transfer.status !== 'DRAFT') throw new PosError('TRANSFER_NOT_DRAFT', 409);
    const updated = await tx.inventoryTransfer.update({ where: { id: transfer.id }, data: {
      status: 'SUBMITTED', submittedAt: new Date(), submittedByEmployeeId: actor.userId,
    }, include: transferInclude });
    await audit(tx, actor, { action: 'TRANSFER_SUBMITTED', entityType: 'InventoryTransfer', entityId: transfer.id, storeId: transfer.sourceStoreId });
    return updated;
  });
}

export async function cancelTransfer(prisma: PrismaClient, actor: AdminActor, transferId: string) {
  return prisma.$transaction(async (tx) => {
    const transfer = await lockedTransfer(tx, actor, transferId);
    if (transfer.status === 'CANCELLED') return transfer;
    if (!['DRAFT', 'SUBMITTED'].includes(transfer.status)) throw new PosError('TRANSFER_CANNOT_CANCEL', 409);
    const updated = await tx.inventoryTransfer.update({ where: { id: transfer.id }, data: { status: 'CANCELLED', cancelledAt: new Date() }, include: transferInclude });
    await audit(tx, actor, { action: 'TRANSFER_CANCELLED', entityType: 'InventoryTransfer', entityId: transfer.id, storeId: transfer.sourceStoreId });
    return updated;
  });
}

export async function shipTransfer(
  prisma: PrismaClient,
  actor: AdminActor,
  transferId: string,
  input: { idempotencyKey: string; lines: Array<{ transferLineId: string; quantity: number }> },
) {
  const key = required(input.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED');
  const requestFingerprint = fingerprint(input.lines);
  return prisma.$transaction(async (tx) => {
    const transfer = await lockedTransfer(tx, actor, transferId);
    if (transfer.shipIdempotencyKey === key && ['IN_TRANSIT', 'RECEIVED'].includes(transfer.status)) {
      if (transfer.shipRequestFingerprint !== requestFingerprint) throw new PosError('IDEMPOTENCY_KEY_REUSED', 409);
      return transfer;
    }
    if (transfer.shipIdempotencyKey && transfer.shipIdempotencyKey !== key) throw new PosError('TRANSFER_ALREADY_SHIPPED', 409);
    if (transfer.status !== 'SUBMITTED') throw new PosError('TRANSFER_NOT_SUBMITTED', 409);
    const quantities = new Map<string, number>();
    for (const line of input.lines) {
      if (quantities.has(line.transferLineId)) throw new PosError('TRANSFER_LINE_DUPLICATE');
      quantities.set(line.transferLineId, positive(line.quantity, 'TRANSFER_QUANTITY_INVALID'));
    }
    if (quantities.size !== transfer.lines.length || transfer.lines.some((line) => !quantities.has(line.id))) throw new PosError('TRANSFER_SHIP_LINES_INCOMPLETE');
    const variantIds = [...transfer.lines].map((line) => line.variantId).sort();
    await tx.$queryRaw`SELECT id FROM "InventoryLevel" WHERE "organizationId" = ${actor.organizationId}::uuid AND "storeId" = ${transfer.sourceStoreId}::uuid AND "variantId" IN (${Prisma.join(variantIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "variantId" FOR UPDATE`;
    const levels = await tx.inventoryLevel.findMany({ where: { organizationId: actor.organizationId, storeId: transfer.sourceStoreId, variantId: { in: variantIds } } });
    const levelByVariant = new Map(levels.map((level) => [level.variantId, level]));
    for (const line of transfer.lines) {
      const quantity = quantities.get(line.id)!;
      if (quantity > line.requestedQuantity) throw new PosError('TRANSFER_SHIP_EXCEEDS_REQUESTED');
      const level = levelByVariant.get(line.variantId);
      if (!level || level.onHand - level.reserved < quantity) throw new PosError('TRANSFER_INSUFFICIENT_INVENTORY', 409);
    }
    for (const line of transfer.lines) {
      const quantity = quantities.get(line.id)!;
      const level = levelByVariant.get(line.variantId)!;
      await tx.inventoryLevel.update({ where: { id: level.id }, data: { onHand: { decrement: quantity } } });
      await tx.inventoryMovement.create({ data: {
        organizationId: actor.organizationId, storeId: transfer.sourceStoreId, variantId: line.variantId,
        quantityDelta: -quantity, type: 'TRANSFER_OUT', referenceType: 'TRANSFER', referenceId: transfer.id,
        reason: `Transfer ${transfer.transferNumber} shipped`, resultingOnHand: level.onHand - quantity, employeeId: actor.userId,
      } });
      await tx.inventoryTransferLine.update({ where: { id: line.id }, data: { shippedQuantity: quantity } });
    }
    const updated = await tx.inventoryTransfer.update({ where: { id: transfer.id }, data: {
      status: 'IN_TRANSIT', shippedAt: new Date(), shippedByEmployeeId: actor.userId, shipIdempotencyKey: key,
      shipRequestFingerprint: requestFingerprint,
    }, include: transferInclude });
    await audit(tx, actor, { action: 'TRANSFER_SHIPPED', entityType: 'InventoryTransfer', entityId: transfer.id, storeId: transfer.sourceStoreId });
    return updated;
  });
}

export async function receiveTransfer(
  prisma: PrismaClient,
  actor: AdminActor,
  transferId: string,
  input: { idempotencyKey: string; notes?: string; lines: Array<{ transferLineId: string; quantity: number }> },
) {
  const key = required(input.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED');
  const requestFingerprint = fingerprint(input.lines);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryTransferReceipt.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey: key } }, include: { lines: true } });
    if (existing) {
      if (existing.transferId !== transferId) throw new PosError('IDEMPOTENCY_KEY_REUSED', 409);
      if (existing.requestFingerprint !== requestFingerprint) throw new PosError('IDEMPOTENCY_KEY_REUSED', 409);
      return existing;
    }
    const transfer = await lockedTransfer(tx, actor, transferId);
    if (transfer.status !== 'IN_TRANSIT') throw new PosError('TRANSFER_NOT_IN_TRANSIT', 409);
    const quantities = new Map<string, number>();
    for (const line of input.lines) {
      if (quantities.has(line.transferLineId)) throw new PosError('TRANSFER_LINE_DUPLICATE');
      quantities.set(line.transferLineId, positive(line.quantity, 'TRANSFER_QUANTITY_INVALID'));
    }
    if (!quantities.size) throw new PosError('TRANSFER_RECEIPT_LINES_REQUIRED');
    const lineById = new Map(transfer.lines.map((line) => [line.id, line]));
    for (const [lineId, quantity] of quantities) {
      const line = lineById.get(lineId);
      if (!line) throw new PosError('TRANSFER_LINE_NOT_FOUND', 404);
      if (line.receivedQuantity + quantity > line.shippedQuantity) throw new PosError('TRANSFER_RECEIPT_EXCEEDS_SHIPPED', 409);
    }
    const receipt = await tx.inventoryTransferReceipt.create({ data: {
      organizationId: actor.organizationId, transferId: transfer.id, receivedByEmployeeId: actor.userId,
      idempotencyKey: key, requestFingerprint, notes: input.notes?.trim() || null,
    } });
    for (const [lineId, quantity] of quantities) {
      const line = lineById.get(lineId)!;
      const level = await tx.inventoryLevel.upsert({ where: { organizationId_storeId_variantId: {
        organizationId: actor.organizationId, storeId: transfer.destinationStoreId, variantId: line.variantId,
      } }, create: { organizationId: actor.organizationId, storeId: transfer.destinationStoreId, variantId: line.variantId, onHand: quantity },
      update: { onHand: { increment: quantity } } });
      await tx.inventoryMovement.create({ data: {
        organizationId: actor.organizationId, storeId: transfer.destinationStoreId, variantId: line.variantId,
        quantityDelta: quantity, type: 'TRANSFER_IN', referenceType: 'TRANSFER_RECEIPT', referenceId: receipt.id,
        reason: `Transfer ${transfer.transferNumber} received`, resultingOnHand: level.onHand, employeeId: actor.userId,
      } });
      await tx.inventoryTransferLine.update({ where: { id: line.id }, data: { receivedQuantity: { increment: quantity } } });
      await tx.inventoryTransferReceiptLine.create({ data: { organizationId: actor.organizationId, receiptId: receipt.id, transferLineId: line.id, quantity } });
    }
    const complete = transfer.lines.every((line) => line.receivedQuantity + (quantities.get(line.id) ?? 0) === line.shippedQuantity);
    if (complete) await tx.inventoryTransfer.update({ where: { id: transfer.id }, data: { status: 'RECEIVED', receivedAt: new Date() } });
    await audit(tx, actor, { action: 'TRANSFER_RECEIVED', entityType: 'InventoryTransfer', entityId: transfer.id,
      storeId: transfer.destinationStoreId, metadata: { receiptId: receipt.id, complete } });
    return tx.inventoryTransferReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { lines: true } });
  });
}

const countInclude = {
  store: true,
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  lines: { include: { variant: { include: { product: true } } }, orderBy: { id: 'asc' as const } },
} satisfies Prisma.StockCountInclude;

export async function listStockCounts(prisma: PrismaClient, actor: AdminActor, input: PageInput & { storeId?: string }) {
  const { page, pageSize, skip } = pageArgs(input);
  const where = { organizationId: actor.organizationId, ...(input.storeId ? { storeId: input.storeId } : {}) };
  const [items, total] = await Promise.all([
    prisma.stockCount.findMany({ where, include: countInclude, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    prisma.stockCount.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function createStockCount(
  prisma: PrismaClient,
  actor: AdminActor,
  input: { storeId: string; countNumber?: string; notes?: string; variantIds: string[] },
) {
  const variantIds = [...new Set(input.variantIds)];
  if (!variantIds.length) throw new PosError('STOCK_COUNT_VARIANTS_REQUIRED');
  const levels = await prisma.inventoryLevel.findMany({ where: { organizationId: actor.organizationId, storeId: input.storeId, variantId: { in: variantIds } } });
  if (levels.length !== variantIds.length) throw new PosError('STOCK_COUNT_INVENTORY_NOT_FOUND', 404);
  const countNumber = input.countNumber?.trim() || `CC-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 5).toUpperCase()}`;
  return prisma.$transaction(async (tx) => {
    const count = await tx.stockCount.create({ data: {
      organizationId: actor.organizationId, storeId: input.storeId, createdByEmployeeId: actor.userId,
      countNumber, notes: input.notes?.trim() || null,
    } });
    await tx.stockCountLine.createMany({ data: levels.map((level) => ({
      organizationId: actor.organizationId, stockCountId: count.id, variantId: level.variantId, expectedQuantity: level.onHand,
    })) });
    await audit(tx, actor, { action: 'STOCK_COUNT_CREATED', entityType: 'StockCount', entityId: count.id, storeId: input.storeId });
    return tx.stockCount.findUniqueOrThrow({ where: { id: count.id }, include: countInclude });
  });
}

async function lockedCount(tx: Tx, actor: AdminActor, countId: string) {
  await tx.$queryRaw`SELECT id FROM "StockCount" WHERE id = ${countId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
  const count = await tx.stockCount.findFirst({ where: { id: countId, organizationId: actor.organizationId }, include: countInclude });
  if (!count) throw new PosError('STOCK_COUNT_NOT_FOUND', 404);
  return count;
}

export async function reviewStockCount(
  prisma: PrismaClient,
  actor: AdminActor,
  countId: string,
  input: { lines: Array<{ stockCountLineId: string; countedQuantity: number }> },
) {
  return prisma.$transaction(async (tx) => {
    const count = await lockedCount(tx, actor, countId);
    if (count.status === 'REVIEWED') return count;
    if (count.status !== 'DRAFT') throw new PosError('STOCK_COUNT_NOT_DRAFT', 409);
    const quantities = new Map(input.lines.map((line) => [line.stockCountLineId, nonnegative(line.countedQuantity, 'COUNTED_QUANTITY_INVALID')]));
    if (quantities.size !== count.lines.length || count.lines.some((line) => !quantities.has(line.id))) throw new PosError('STOCK_COUNT_LINES_INCOMPLETE');
    for (const line of count.lines) {
      const countedQuantity = quantities.get(line.id)!;
      await tx.stockCountLine.update({ where: { id: line.id }, data: { countedQuantity, variance: countedQuantity - line.expectedQuantity } });
    }
    const updated = await tx.stockCount.update({ where: { id: count.id }, data: {
      status: 'REVIEWED', reviewedAt: new Date(), reviewedByEmployeeId: actor.userId,
    }, include: countInclude });
    await audit(tx, actor, { action: 'STOCK_COUNT_REVIEWED', entityType: 'StockCount', entityId: count.id, storeId: count.storeId });
    return updated;
  });
}

export async function finalizeStockCount(prisma: PrismaClient, actor: AdminActor, countId: string) {
  return prisma.$transaction(async (tx) => {
    const count = await lockedCount(tx, actor, countId);
    if (count.status === 'FINALIZED') return count;
    if (count.status !== 'REVIEWED') throw new PosError('STOCK_COUNT_NOT_REVIEWED', 409);
    const variantIds = count.lines.map((line) => line.variantId).sort();
    await tx.$queryRaw`SELECT id FROM "InventoryLevel" WHERE "organizationId" = ${actor.organizationId}::uuid AND "storeId" = ${count.storeId}::uuid AND "variantId" IN (${Prisma.join(variantIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "variantId" FOR UPDATE`;
    const levels = await tx.inventoryLevel.findMany({ where: { organizationId: actor.organizationId, storeId: count.storeId, variantId: { in: variantIds } } });
    const byVariant = new Map(levels.map((level) => [level.variantId, level]));
    for (const line of count.lines) {
      if (line.countedQuantity === null || line.variance === null) throw new PosError('STOCK_COUNT_LINES_INCOMPLETE');
      const level = byVariant.get(line.variantId);
      if (!level) throw new PosError('INVENTORY_LEVEL_NOT_FOUND', 404);
      if (line.countedQuantity < level.reserved) throw new PosError('COUNT_BELOW_RESERVED_INVENTORY', 409);
      const adjustmentQuantity = line.countedQuantity - level.onHand;
      if (adjustmentQuantity !== 0) {
        await tx.inventoryLevel.update({ where: { id: level.id }, data: { onHand: line.countedQuantity } });
        await tx.inventoryMovement.create({ data: {
          organizationId: actor.organizationId, storeId: count.storeId, variantId: line.variantId,
          quantityDelta: adjustmentQuantity, type: adjustmentQuantity > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
          referenceType: 'STOCK_COUNT', referenceId: count.id, reason: `Cycle count ${count.countNumber}`,
          resultingOnHand: line.countedQuantity, employeeId: actor.userId,
        } });
      }
    }
    const updated = await tx.stockCount.update({ where: { id: count.id }, data: {
      status: 'FINALIZED', finalizedAt: new Date(), finalizedByEmployeeId: actor.userId,
    }, include: countInclude });
    await audit(tx, actor, { action: 'STOCK_COUNT_FINALIZED', entityType: 'StockCount', entityId: count.id, storeId: count.storeId });
    return updated;
  });
}

export async function replenishmentSuggestions(prisma: PrismaClient, actor: AdminActor, storeId?: string) {
  const levels = await prisma.inventoryLevel.findMany({ where: {
    organizationId: actor.organizationId, ...(storeId ? { storeId } : {}),
  }, include: {
    store: true,
    variant: { include: { product: true, vendorMappings: { where: { active: true }, include: { vendor: true }, orderBy: [{ preferred: 'desc' }, { createdAt: 'asc' }] } } },
  }, orderBy: [{ storeId: 'asc' }, { variantId: 'asc' }] });
  return levels.flatMap((level) => {
    const available = level.onHand - level.reserved;
    if (available > level.lowStockThreshold || level.reorderTarget <= available) return [];
    const mapping = level.variant.vendorMappings[0];
    const requiredUnits = level.reorderTarget - available;
    const minimum = Math.max(requiredUnits, mapping?.minimumOrderQuantity ?? 1);
    const casePack = mapping?.casePackQuantity ?? 1;
    const suggestedUnits = Math.ceil(minimum / casePack) * casePack;
    return [{
      storeId: level.storeId, storeName: level.store.name, variantId: level.variantId,
      productName: level.variant.product.name, variantName: level.variant.name, sku: level.variant.sku,
      available, lowStockThreshold: level.lowStockThreshold, reorderTarget: level.reorderTarget,
      suggestedUnits, suggestedCases: Math.ceil(suggestedUnits / casePack), casePackQuantity: casePack,
      minimumOrderQuantity: mapping?.minimumOrderQuantity ?? 1,
      vendorId: mapping?.vendorId ?? null, vendorName: mapping?.vendor.name ?? null,
      vendorProductMappingId: mapping?.id ?? null, unitCostMinor: mapping?.vendorCostMinor.toString() ?? null,
    }];
  });
}

export type PromotionInput = {
  name: string;
  type: PromotionType;
  scope: PromotionScope;
  storeId?: string | null;
  categoryId?: string;
  productId?: string;
  variantId?: string;
  percentageBasisPoints?: number;
  fixedAmountMinor?: string;
  bundleQuantity?: number;
  bundlePriceMinor?: string;
  minimumQuantity?: number;
  minimumSpendMinor?: string;
  priority?: number;
  startsAt: Date;
  endsAt: Date;
  active?: boolean;
};

function promotionData(actor: AdminActor, input: PromotionInput) {
  const minimumQuantity = positive(input.minimumQuantity ?? 1, 'PROMOTION_MINIMUM_QUANTITY_INVALID');
  const minimumSpendMinor = money(input.minimumSpendMinor ?? '0', 'PROMOTION_MINIMUM_SPEND_INVALID');
  if (minimumSpendMinor < 0n) throw new PosError('PROMOTION_MINIMUM_SPEND_INVALID');
  if (input.endsAt <= input.startsAt) throw new PosError('PROMOTION_DATE_RANGE_INVALID');
  const targets = [input.categoryId, input.productId, input.variantId].filter(Boolean);
  if (targets.length !== 1 || (input.scope === 'CATEGORY' && !input.categoryId) || (input.scope === 'PRODUCT' && !input.productId) || (input.scope === 'VARIANT' && !input.variantId)) {
    throw new PosError('PROMOTION_SCOPE_TARGET_INVALID');
  }
  const percentageBasisPoints = input.type === 'PERCENTAGE' ? positive(input.percentageBasisPoints ?? 0, 'PROMOTION_PERCENTAGE_INVALID') : null;
  if (percentageBasisPoints !== null && percentageBasisPoints > 10_000) throw new PosError('PROMOTION_PERCENTAGE_INVALID');
  const fixedAmountMinor = input.type === 'FIXED' ? money(input.fixedAmountMinor ?? '', 'PROMOTION_FIXED_AMOUNT_INVALID') : null;
  if (fixedAmountMinor !== null && fixedAmountMinor <= 0n) throw new PosError('PROMOTION_FIXED_AMOUNT_INVALID');
  const bundleQuantity = input.type === 'MULTIBUY' ? positive(input.bundleQuantity ?? 0, 'PROMOTION_BUNDLE_QUANTITY_INVALID') : null;
  const bundlePriceMinor = input.type === 'MULTIBUY' ? money(input.bundlePriceMinor ?? '', 'PROMOTION_BUNDLE_PRICE_INVALID') : null;
  if (bundlePriceMinor !== null && bundlePriceMinor < 0n) throw new PosError('PROMOTION_BUNDLE_PRICE_INVALID');
  return {
    organizationId: actor.organizationId, createdByEmployeeId: actor.userId, name: required(input.name, 'PROMOTION_NAME_REQUIRED'),
    type: input.type, scope: input.scope, storeId: input.storeId ?? null,
    categoryId: input.categoryId ?? null, productId: input.productId ?? null, variantId: input.variantId ?? null,
    percentageBasisPoints, fixedAmountMinor, bundleQuantity, bundlePriceMinor,
    minimumQuantity, minimumSpendMinor, priority: Math.trunc(input.priority ?? 0), startsAt: input.startsAt, endsAt: input.endsAt,
    active: input.active ?? true,
  };
}

export async function createPromotion(prisma: PrismaClient, actor: AdminActor, input: PromotionInput) {
  const data = promotionData(actor, input);
  await validatePromotionTarget(prisma, actor, input);
  return prisma.$transaction(async (tx) => {
    const promotion = await tx.promotion.create({ data });
    await audit(tx, actor, { action: 'PROMOTION_CREATED', entityType: 'Promotion', entityId: promotion.id,
      ...(promotion.storeId ? { storeId: promotion.storeId } : {}) });
    return promotion;
  });
}

export async function updatePromotion(
  prisma: PrismaClient,
  actor: AdminActor,
  promotionId: string,
  input: PromotionInput,
) {
  const current = await prisma.promotion.findFirst({ where: { id: promotionId, organizationId: actor.organizationId } });
  if (!current) throw new PosError('PROMOTION_NOT_FOUND', 404);
  const data = promotionData(actor, input);
  await validatePromotionTarget(prisma, actor, input);
  const { organizationId: _organizationId, createdByEmployeeId: _createdByEmployeeId, ...updateData } = data;
  return prisma.$transaction(async (tx) => {
    const promotion = await tx.promotion.update({ where: { id: current.id }, data: updateData });
    await audit(tx, actor, { action: promotion.active ? 'PROMOTION_UPDATED' : 'PROMOTION_DEACTIVATED', entityType: 'Promotion', entityId: promotion.id,
      ...(promotion.storeId ? { storeId: promotion.storeId } : {}) });
    return promotion;
  });
}

async function validatePromotionTarget(prisma: PrismaClient, actor: AdminActor, input: PromotionInput): Promise<void> {
  const [storeCount, targetCount] = await Promise.all([
    input.storeId ? prisma.store.count({ where: { id: input.storeId, organizationId: actor.organizationId } }) : Promise.resolve(1),
    input.scope === 'CATEGORY' ? prisma.category.count({ where: { id: input.categoryId!, organizationId: actor.organizationId } })
      : input.scope === 'PRODUCT' ? prisma.product.count({ where: { id: input.productId!, organizationId: actor.organizationId } })
        : prisma.productVariant.count({ where: { id: input.variantId!, organizationId: actor.organizationId } }),
  ]);
  if (storeCount !== 1 || targetCount !== 1) throw new PosError('PROMOTION_TARGET_NOT_FOUND', 404);
}

export async function listPromotions(prisma: PrismaClient, actor: AdminActor, input: PageInput & { active?: boolean }) {
  const { page, pageSize, skip } = pageArgs(input);
  const where = { organizationId: actor.organizationId, ...(input.active === undefined ? {} : { active: input.active }) };
  const [items, total] = await Promise.all([
    prisma.promotion.findMany({ where, include: { store: true, category: true, product: true, variant: { include: { product: true } } }, orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }], skip, take: pageSize }),
    prisma.promotion.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

type PromotionVariant = { id: string; productId: string; product: { categoryId: string } };
type AppliedPromotion = { promotionId: string; promotionName: string; discount: CartDiscount; discountMinor: bigint };

function roundedRatio(value: bigint, basisPoints: number): bigint {
  return (value * BigInt(basisPoints) + 5_000n) / 10_000n;
}

export async function resolveAutomaticPromotions(
  tx: Tx,
  input: { organizationId: string; storeId: string; lines: Array<{ variant: PromotionVariant; quantity: number; unitPriceMinor: bigint }>; now: Date },
): Promise<Map<string, AppliedPromotion>> {
  const categoryIds = [...new Set(input.lines.map((line) => line.variant.product.categoryId))];
  const productIds = [...new Set(input.lines.map((line) => line.variant.productId))];
  const variantIds = input.lines.map((line) => line.variant.id);
  const promotions = await tx.promotion.findMany({ where: {
    organizationId: input.organizationId, active: true, startsAt: { lte: input.now }, endsAt: { gt: input.now },
    OR: [{ storeId: input.storeId }, { storeId: null }],
    AND: [{ OR: [{ categoryId: { in: categoryIds } }, { productId: { in: productIds } }, { variantId: { in: variantIds } }] }],
  }, orderBy: [{ priority: 'desc' }, { id: 'asc' }] });
  const result = new Map<string, AppliedPromotion>();
  for (const line of input.lines) {
    const subtotal = line.unitPriceMinor * BigInt(line.quantity);
    const eligible = promotions.filter((promotion) =>
      line.quantity >= promotion.minimumQuantity && subtotal >= promotion.minimumSpendMinor &&
      ((promotion.scope === 'VARIANT' && promotion.variantId === line.variant.id) ||
       (promotion.scope === 'PRODUCT' && promotion.productId === line.variant.productId) ||
       (promotion.scope === 'CATEGORY' && promotion.categoryId === line.variant.product.categoryId)));
    let best: AppliedPromotion | undefined;
    let bestPriority = Number.NEGATIVE_INFINITY;
    for (const promotion of eligible) {
      let discountMinor = 0n;
      if (promotion.type === 'PERCENTAGE') discountMinor = roundedRatio(subtotal, promotion.percentageBasisPoints!);
      if (promotion.type === 'FIXED') discountMinor = promotion.fixedAmountMinor! > subtotal ? subtotal : promotion.fixedAmountMinor!;
      if (promotion.type === 'MULTIBUY') {
        const bundleQuantity = promotion.bundleQuantity!;
        const bundles = Math.floor(line.quantity / bundleQuantity);
        const regularBundle = line.unitPriceMinor * BigInt(bundleQuantity);
        const perBundle = regularBundle > promotion.bundlePriceMinor! ? regularBundle - promotion.bundlePriceMinor! : 0n;
        discountMinor = perBundle * BigInt(bundles);
      }
      if (discountMinor <= 0n) continue;
      const candidate = { promotionId: promotion.id, promotionName: promotion.name,
        discount: { kind: 'FIXED' as const, amountMinor: discountMinor }, discountMinor };
      if (!best || promotion.priority > bestPriority || (promotion.priority === bestPriority && discountMinor > best.discountMinor)) {
        best = candidate;
        bestPriority = promotion.priority;
      }
    }
    if (best) result.set(line.variant.id, best);
  }
  return result;
}
