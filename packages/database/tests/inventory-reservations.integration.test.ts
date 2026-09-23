import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { reserveInventory } from '../src/inventory-reservations.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = describe;

suite('inventory reservation concurrency', () => {
  it('allows only one checkout to reserve the final unit', async () => {
    if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for Phase 0 verification');
    const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    const organizationId = process.env.TEST_ORGANIZATION_ID ?? '';
    const storeId = process.env.TEST_STORE_ID ?? '';
    const variantId = process.env.TEST_VARIANT_ID ?? '';
    const orderIds = [process.env.TEST_ORDER_ID_ONE ?? '', process.env.TEST_ORDER_ID_TWO ?? ''];

    try {
      await prisma.inventoryReservationLine.deleteMany({ where: { organizationId, variantId } });
      await prisma.inventoryReservation.deleteMany({ where: { organizationId, orderId: { in: orderIds } } });
      await prisma.inventoryLevel.update({
        where: { organizationId_storeId_variantId: { organizationId, storeId, variantId } },
        data: { onHand: 1, reserved: 0 },
      });
      const results = await Promise.allSettled(orderIds.map((orderId) => reserveInventory(prisma, {
        organizationId,
        storeId,
        orderId,
        lines: [{ variantId, quantity: 1 }],
      })));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => String(result.reason));
      expect(results.filter((result) => result.status === 'fulfilled'), failures.join('; ')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected'), failures.join('; ')).toHaveLength(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});
