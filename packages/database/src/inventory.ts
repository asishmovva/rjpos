import { Prisma, type PrismaClient } from '@prisma/client';
import { PosError } from './pos-errors.js';

export type InventoryMutationInput = {
  organizationId: string;
  storeId: string;
  variantId: string;
  employeeId: string;
  quantity: number;
  reason: string;
};

async function requireInventoryContext(
  tx: Prisma.TransactionClient,
  input: InventoryMutationInput,
): Promise<{ lowStockThreshold: number }> {
  const [variant, employee] = await Promise.all([
    tx.productVariant.findFirst({
      where: {
        id: input.variantId,
        organizationId: input.organizationId,
        product: { inventoryTracked: true },
      },
    }),
    tx.employeeStore.findUnique({
      where: {
        organizationId_employeeId_storeId: {
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          storeId: input.storeId,
        },
      },
    }),
  ]);
  if (!variant) throw new PosError('INVENTORY_VARIANT_NOT_FOUND', 404);
  // Pack variants sell from their base variant's stock and never hold their own.
  if (variant.baseVariantId) throw new PosError('PACK_VARIANT_HAS_NO_OWN_STOCK', 409);
  if (!employee) throw new PosError('EMPLOYEE_STORE_ACCESS_DENIED', 403);
  return variant;
}

export async function postOpeningBalance(
  prisma: PrismaClient,
  input: InventoryMutationInput,
) {
  if (!Number.isInteger(input.quantity) || input.quantity < 0)
    throw new PosError('INVENTORY_QUANTITY_INVALID');
  if (!input.reason.trim()) throw new PosError('INVENTORY_REASON_REQUIRED');
  return prisma.$transaction(async (tx) => {
    const variant = await requireInventoryContext(tx, input);
    const existing = await tx.inventoryMovement.findFirst({
      where: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: input.variantId,
        type: 'INITIAL',
      },
    });
    if (existing) throw new PosError('OPENING_BALANCE_ALREADY_POSTED', 409);
    const level = await tx.inventoryLevel.upsert({
      where: {
        organizationId_storeId_variantId: {
          organizationId: input.organizationId,
          storeId: input.storeId,
          variantId: input.variantId,
        },
      },
      create: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: input.variantId,
        onHand: input.quantity,
        lowStockThreshold: variant.lowStockThreshold,
        reorderTarget: variant.lowStockThreshold,
      },
      update: { onHand: { increment: input.quantity } },
    });
    const movement = await tx.inventoryMovement.create({
      data: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: input.variantId,
        employeeId: input.employeeId,
        quantityDelta: input.quantity,
        type: 'INITIAL',
        referenceType: 'OPENING_BALANCE',
        reason: input.reason.trim(),
        resultingOnHand: level.onHand,
      },
    });
    await tx.auditRecord.create({
      data: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        userId: input.employeeId,
        action: 'INVENTORY_OPENING_BALANCE',
        entityType: 'InventoryMovement',
        entityId: movement.id,
        afterJson: {
          variantId: input.variantId,
          quantity: input.quantity,
          reason: input.reason.trim(),
        },
      },
    });
    return { level, movement };
  });
}

export async function adjustInventory(
  prisma: PrismaClient,
  input: InventoryMutationInput,
) {
  if (!Number.isInteger(input.quantity) || input.quantity === 0)
    throw new PosError('INVENTORY_ADJUSTMENT_INVALID');
  if (!input.reason.trim()) throw new PosError('INVENTORY_REASON_REQUIRED');
  return prisma.$transaction(async (tx) => {
    await requireInventoryContext(tx, input);
    await tx.$queryRaw`
      SELECT id FROM "InventoryLevel"
      WHERE "organizationId" = ${input.organizationId}::uuid
        AND "storeId" = ${input.storeId}::uuid
        AND "variantId" = ${input.variantId}::uuid
      FOR UPDATE
    `;
    const level = await tx.inventoryLevel.findUnique({
      where: {
        organizationId_storeId_variantId: {
          organizationId: input.organizationId,
          storeId: input.storeId,
          variantId: input.variantId,
        },
      },
    });
    if (!level) throw new PosError('INVENTORY_LEVEL_NOT_FOUND', 404);
    if (level.onHand + input.quantity < level.reserved)
      throw new PosError('INVENTORY_WOULD_BE_NEGATIVE', 409);
    const updatedLevel = await tx.inventoryLevel.update({
      where: { id: level.id },
      data: { onHand: { increment: input.quantity } },
    });
    const movement = await tx.inventoryMovement.create({
      data: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: input.variantId,
        employeeId: input.employeeId,
        quantityDelta: input.quantity,
        type: input.quantity > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        referenceType: 'MANUAL_ADJUSTMENT',
        reason: input.reason.trim(),
        resultingOnHand: updatedLevel.onHand,
      },
    });
    await tx.auditRecord.create({
      data: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        userId: input.employeeId,
        action: 'INVENTORY_ADJUSTED',
        entityType: 'InventoryMovement',
        entityId: movement.id,
        afterJson: {
          variantId: input.variantId,
          quantityDelta: input.quantity,
          reason: input.reason.trim(),
        },
      },
    });
    return { level: updatedLevel, movement };
  });
}

export async function getInventorySnapshot(
  prisma: PrismaClient,
  organizationId: string,
  storeId: string,
): Promise<unknown[]> {
  return prisma.inventoryLevel.findMany({
    where: { organizationId, storeId },
    include: {
      variant: { include: { product: true } },
    },
    orderBy: { variant: { product: { name: 'asc' } } },
  });
}

export type InventorySearchInput = {
  organizationId: string;
  storeId: string;
  search?: string;
  categoryId?: string;
  size?: string;
  status?: 'in_stock' | 'low' | 'zero';
  page?: number;
  pageSize?: number;
};

/** Paged, filterable stock list for the register. Bounded: pageSize is capped at 100. */
export async function searchInventory(prisma: PrismaClient, input: InventorySearchInput) {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize ?? 25)));
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const search = input.search?.trim();
  const size = input.size?.trim();
  const where: Prisma.InventoryLevelWhereInput = { organizationId: input.organizationId, storeId: input.storeId };
  const variantFilters: Prisma.ProductVariantWhereInput[] = [];
  if (search) variantFilters.push({ OR: [
    { product: { name: { contains: search, mode: 'insensitive' } } },
    { product: { brand: { contains: search, mode: 'insensitive' } } },
    { sku: { contains: search, mode: 'insensitive' } },
    { barcodes: { some: { barcodeValue: { contains: search } } } },
  ] });
  if (size) variantFilters.push({ name: { contains: size, mode: 'insensitive' } });
  if (input.categoryId) variantFilters.push({ product: { categoryId: input.categoryId } });
  if (variantFilters.length) where.variant = { AND: variantFilters };
  if (input.status === 'zero') where.onHand = { lte: 0 };
  else if (input.status === 'in_stock') where.onHand = { gt: 0 };
  else if (input.status === 'low') {
    // Column-to-column comparison needs SQL; the id list is bounded by this store's stock rows.
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "InventoryLevel" WHERE "organizationId" = ${input.organizationId}::uuid AND "storeId" = ${input.storeId}::uuid AND "onHand" > 0 AND "onHand" <= "lowStockThreshold"`;
    where.id = { in: rows.map((row) => row.id) };
  }
  const [items, total, categories] = await Promise.all([
    prisma.inventoryLevel.findMany({
      where, orderBy: [{ variant: { product: { name: 'asc' } } }, { variant: { name: 'asc' } }], skip: (page - 1) * pageSize, take: pageSize,
      include: { variant: { select: { name: true, sku: true, product: { select: { name: true, category: { select: { name: true } } } }, barcodes: { select: { barcodeValue: true }, take: 1 } } } },
    }),
    prisma.inventoryLevel.count({ where }),
    prisma.category.findMany({ where: { organizationId: input.organizationId, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  return { items, total, page, pageSize, categories };
}
