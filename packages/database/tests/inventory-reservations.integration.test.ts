import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import {
  convertReservation,
  releaseReservation,
  reserveInventory,
} from '../src/inventory-reservations.js';

const testEnvironment = loadTestEnvironment();
const suite = describe;

suite('inventory reservation concurrency', () => {
  it('serializes competing reservations and preserves lifecycle invariants', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: testEnvironment.TEST_DATABASE_URL } },
    });
    const organizationId = testEnvironment.TEST_ORGANIZATION_ID;
    const storeId = testEnvironment.TEST_STORE_ID;
    const variantId = testEnvironment.TEST_VARIANT_ID;
    const orderIds = [
      testEnvironment.TEST_ORDER_ID_ONE,
      testEnvironment.TEST_ORDER_ID_TWO,
    ];

    try {
      await prisma.inventoryReservationLine.deleteMany({
        where: { organizationId, variantId },
      });
      await prisma.inventoryReservation.deleteMany({
        where: { organizationId, orderId: { in: orderIds } },
      });
      await prisma.inventoryLevel.update({
        where: {
          organizationId_storeId_variantId: {
            organizationId,
            storeId,
            variantId,
          },
        },
        data: { onHand: 1, reserved: 0 },
      });
      const results = await Promise.allSettled(
        orderIds.map((orderId) =>
          reserveInventory(prisma, {
            organizationId,
            storeId,
            orderId,
            lines: [{ variantId, quantity: 1 }],
          }),
        ),
      );
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
        .map((result) => String(result.reason));
      expect(
        results.filter((result) => result.status === 'fulfilled'),
        failures.join('; '),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
        failures.join('; '),
      ).toHaveLength(1);

      const winningIndex = results.findIndex(
        (result) => result.status === 'fulfilled',
      );
      const winningOrderId = orderIds[winningIndex];
      const losingOrderId = orderIds[winningIndex === 0 ? 1 : 0];
      const activeReservations = await prisma.inventoryReservation.findMany({
        where: { organizationId, orderId: { in: orderIds }, status: 'ACTIVE' },
        include: { lines: true },
      });
      const racedLevel = await prisma.inventoryLevel.findUniqueOrThrow({
        where: {
          organizationId_storeId_variantId: {
            organizationId,
            storeId,
            variantId,
          },
        },
      });
      expect(activeReservations).toHaveLength(1);
      expect(activeReservations[0]?.orderId).toBe(winningOrderId);
      expect(activeReservations[0]?.lines).toHaveLength(1);
      expect(
        await prisma.inventoryReservation.count({
          where: { organizationId, orderId: losingOrderId },
        }),
      ).toBe(0);
      expect(racedLevel).toMatchObject({ onHand: 1, reserved: 1 });
      expect(racedLevel.onHand - racedLevel.reserved).toBeGreaterThanOrEqual(0);

      // Stock is now sufficient, so this duplicate fails specifically at the
      // partial unique index for an active reservation on the same order.
      await prisma.inventoryLevel.update({
        where: {
          organizationId_storeId_variantId: {
            organizationId,
            storeId,
            variantId,
          },
        },
        data: { onHand: 2 },
      });
      await expect(
        reserveInventory(prisma, {
          organizationId,
          storeId,
          orderId: winningOrderId,
          lines: [{ variantId, quantity: 1 }],
        }),
      ).rejects.toThrow();
      expect(
        (
          await prisma.inventoryLevel.findUniqueOrThrow({
            where: {
              organizationId_storeId_variantId: {
                organizationId,
                storeId,
                variantId,
              },
            },
          })
        ).reserved,
      ).toBe(1);

      const releasedReservationId = activeReservations[0]!.id;
      await releaseReservation(
        prisma,
        organizationId,
        releasedReservationId,
      );
      await releaseReservation(
        prisma,
        organizationId,
        releasedReservationId,
      );
      expect(
        await prisma.inventoryReservation.findUniqueOrThrow({
          where: {
            organizationId_id: {
              organizationId,
              id: releasedReservationId,
            },
          },
          include: { lines: true },
        }),
      ).toMatchObject({ status: 'RELEASED', lines: [{ quantity: 1 }] });

      await prisma.inventoryLevel.update({
        where: {
          organizationId_storeId_variantId: {
            organizationId,
            storeId,
            variantId,
          },
        },
        data: { onHand: 1, reserved: 0 },
      });
      const convertedReservationId = await reserveInventory(prisma, {
        organizationId,
        storeId,
        orderId: losingOrderId,
        lines: [{ variantId, quantity: 1 }],
      });
      await convertReservation(
        prisma,
        organizationId,
        convertedReservationId,
      );
      await convertReservation(
        prisma,
        organizationId,
        convertedReservationId,
      );
      expect(
        await prisma.inventoryLevel.findUniqueOrThrow({
          where: {
            organizationId_storeId_variantId: {
              organizationId,
              storeId,
              variantId,
            },
          },
        }),
      ).toMatchObject({ onHand: 0, reserved: 0 });
      expect(
        await prisma.inventoryMovement.count({
          where: {
            organizationId,
            referenceType: 'INVENTORY_RESERVATION_CONVERSION',
            referenceId: convertedReservationId,
          },
        }),
      ).toBe(1);

      await prisma.inventoryLevel.update({
        where: {
          organizationId_storeId_variantId: {
            organizationId,
            storeId,
            variantId,
          },
        },
        data: { onHand: 1, reserved: 0 },
      });
      const expiredReservationId = await reserveInventory(prisma, {
        organizationId,
        storeId,
        orderId: winningOrderId,
        lines: [{ variantId, quantity: 1 }],
      });
      await releaseReservation(
        prisma,
        organizationId,
        expiredReservationId,
        true,
      );
      await releaseReservation(
        prisma,
        organizationId,
        expiredReservationId,
        true,
      );
      const expiredReservation =
        await prisma.inventoryReservation.findUniqueOrThrow({
          where: {
            organizationId_id: {
              organizationId,
              id: expiredReservationId,
            },
          },
          include: { lines: true },
        });
      expect(expiredReservation.status).toBe('EXPIRED');
      expect(expiredReservation.releasedAt).not.toBeNull();
      expect(expiredReservation.lines).toHaveLength(1);
      expect(
        (
          await prisma.inventoryLevel.findUniqueOrThrow({
            where: {
              organizationId_storeId_variantId: {
                organizationId,
                storeId,
                variantId,
              },
            },
          })
        ).reserved,
      ).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
