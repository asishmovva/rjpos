import { Prisma, type PrismaClient } from '@prisma/client';

export type ReservationRequest = {
  organizationId: string;
  storeId: string;
  orderId: string;
  lines: Array<{ variantId: string; quantity: number }>;
};

type TransactionClient = Prisma.TransactionClient;

async function lockLevels(
  tx: TransactionClient,
  request: ReservationRequest,
): Promise<void> {
  const variantIds = request.lines.map((line) => Prisma.sql`${line.variantId}::uuid`);
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "InventoryLevel"
    WHERE "organizationId" = ${request.organizationId}::uuid
      AND "storeId" = ${request.storeId}::uuid
      AND "variantId" IN (${Prisma.join(variantIds)})
    ORDER BY id
    FOR UPDATE
  `;
}

export async function reserveInventory(
  prisma: PrismaClient,
  request: ReservationRequest,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await lockLevels(tx, request);
    for (const line of request.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0)
        throw new Error('INVALID_RESERVATION_QUANTITY');
      const level = await tx.inventoryLevel.findUnique({
        where: {
          organizationId_storeId_variantId: {
            organizationId: request.organizationId,
            storeId: request.storeId,
            variantId: line.variantId,
          },
        },
      });
      if (!level || level.onHand - level.reserved < line.quantity)
        throw new Error('INSUFFICIENT_INVENTORY');
    }
    const reservation = await tx.inventoryReservation.create({
      data: {
        organizationId: request.organizationId,
        storeId: request.storeId,
        orderId: request.orderId,
        lines: {
          create: request.lines.map((line) => ({
            storeId: request.storeId,
            variantId: line.variantId,
            quantity: line.quantity,
          })),
        },
      },
    });
    for (const line of request.lines) {
      await tx.inventoryLevel.update({
        where: {
          organizationId_storeId_variantId: {
            organizationId: request.organizationId,
            storeId: request.storeId,
            variantId: line.variantId,
          },
        },
        data: { reserved: { increment: line.quantity } },
      });
    }
    return reservation.id;
  });
}

export async function convertReservation(
  prisma: PrismaClient,
  organizationId: string,
  reservationId: string,
  employeeId?: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const reservation = await tx.inventoryReservation.findUnique({
      where: { organizationId_id: { organizationId, id: reservationId } },
      include: { lines: true },
    });
    if (!reservation) throw new Error('RESERVATION_NOT_FOUND');
    if (reservation.status === 'CONVERTED') return;
    if (reservation.status !== 'ACTIVE')
      throw new Error('RESERVATION_NOT_ACTIVE');
    for (const line of reservation.lines) {
      await tx.$queryRaw`SELECT id FROM "InventoryLevel" WHERE "organizationId" = ${organizationId}::uuid AND "storeId" = ${line.storeId}::uuid AND "variantId" = ${line.variantId}::uuid FOR UPDATE`;
      await tx.inventoryLevel.update({
        where: {
          organizationId_storeId_variantId: {
            organizationId,
            storeId: line.storeId,
            variantId: line.variantId,
          },
        },
        data: {
          onHand: { decrement: line.quantity },
          reserved: { decrement: line.quantity },
        },
      });
      await tx.inventoryMovement.create({
        data: {
          organizationId,
          storeId: line.storeId,
          variantId: line.variantId,
          quantityDelta: -line.quantity,
          type: 'SALE',
          referenceType: 'INVENTORY_RESERVATION_CONVERSION',
          referenceId: reservationId,
          employeeId: employeeId ?? null,
        },
      });
    }
    await tx.inventoryReservation.update({
      where: { organizationId_id: { organizationId, id: reservationId } },
      data: { status: 'CONVERTED', convertedAt: new Date() },
    });
  });
}

export async function releaseReservation(
  prisma: PrismaClient,
  organizationId: string,
  reservationId: string,
  expired = false,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const reservation = await tx.inventoryReservation.findUnique({
      where: { organizationId_id: { organizationId, id: reservationId } },
      include: { lines: true },
    });
    if (!reservation) throw new Error('RESERVATION_NOT_FOUND');
    if (reservation.status === 'RELEASED' || reservation.status === 'EXPIRED')
      return;
    if (reservation.status !== 'ACTIVE')
      throw new Error('RESERVATION_NOT_ACTIVE');
    for (const line of reservation.lines) {
      await tx.$queryRaw`SELECT id FROM "InventoryLevel" WHERE "organizationId" = ${organizationId}::uuid AND "storeId" = ${line.storeId}::uuid AND "variantId" = ${line.variantId}::uuid FOR UPDATE`;
      await tx.inventoryLevel.update({
        where: {
          organizationId_storeId_variantId: {
            organizationId,
            storeId: line.storeId,
            variantId: line.variantId,
          },
        },
        data: { reserved: { decrement: line.quantity } },
      });
    }
    await tx.inventoryReservation.update({
      where: { organizationId_id: { organizationId, id: reservationId } },
      data: {
        status: expired ? 'EXPIRED' : 'RELEASED',
        releasedAt: new Date(),
      },
    });
  });
}
