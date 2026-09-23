import { Prisma, type PrismaClient } from '@prisma/client';

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
): Promise<void> {
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
  if (!variant) throw new Error('INVENTORY_VARIANT_NOT_FOUND');
  if (!employee) throw new Error('EMPLOYEE_STORE_ACCESS_DENIED');
}

export async function postOpeningBalance(
  prisma: PrismaClient,
  input: InventoryMutationInput,
): Promise<void> {
  if (!Number.isInteger(input.quantity) || input.quantity < 0)
    throw new Error('INVENTORY_QUANTITY_INVALID');
  if (!input.reason.trim()) throw new Error('INVENTORY_REASON_REQUIRED');
  await prisma.$transaction(async (tx) => {
    await requireInventoryContext(tx, input);
    const existing = await tx.inventoryMovement.findFirst({
      where: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: input.variantId,
        type: 'INITIAL',
      },
    });
    if (existing) throw new Error('OPENING_BALANCE_ALREADY_POSTED');
    await tx.inventoryLevel.upsert({
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
        referenceId: input.reason.trim(),
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
  });
}

export async function adjustInventory(
  prisma: PrismaClient,
  input: InventoryMutationInput,
): Promise<void> {
  if (!Number.isInteger(input.quantity) || input.quantity === 0)
    throw new Error('INVENTORY_ADJUSTMENT_INVALID');
  if (!input.reason.trim()) throw new Error('INVENTORY_REASON_REQUIRED');
  await prisma.$transaction(async (tx) => {
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
    if (!level) throw new Error('INVENTORY_LEVEL_NOT_FOUND');
    if (level.onHand + input.quantity < level.reserved)
      throw new Error('INVENTORY_WOULD_BE_NEGATIVE');
    await tx.inventoryLevel.update({
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
        referenceId: input.reason.trim(),
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
