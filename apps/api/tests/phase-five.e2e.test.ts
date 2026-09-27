import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import { CorePosController } from '../src/core-pos.js';
import { PhaseFiveController } from '../src/phase-five.js';
import { PurchasingController } from '../src/purchasing.js';
import { rolePermissions, TenantContextService, type TenantRequest } from '../src/tenant-context.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();

describe('Phase 5 purchasing-to-transfer-to-promoted-sale PostgreSQL E2E', () => {
  it('receives, transfers, counts, promotes, sells, receipts, and refunds without mocked persistence', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const organizationId = randomUUID(); const sourceStoreId = randomUUID(); const destinationStoreId = randomUUID();
    const registerId = randomUUID(); const employeeId = randomUUID(); const categoryId = randomUUID(); const productId = randomUUID(); const variantId = randomUUID();
    const request = (storeId: string, role: keyof typeof rolePermissions = 'OWNER') => ({ tenantContext: {
      organizationId, storeId, registerId, userId: employeeId, permissions: new Set(rolePermissions[role]),
    } }) as unknown as TenantRequest;
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Phase 5 E2E' } });
      await prisma.store.createMany({ data: [{ id: sourceStoreId, organizationId, name: 'Store A', taxRateBasisPoints: 0 }, { id: destinationStoreId, organizationId, name: 'Store B', taxRateBasisPoints: 0 }] });
      await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Phase', lastName: 'Five' } });
      await prisma.employeeStore.createMany({ data: [{ organizationId, employeeId, storeId: sourceStoreId }, { organizationId, employeeId, storeId: destinationStoreId }] });
      await prisma.register.create({ data: { id: registerId, organizationId, storeId: destinationStoreId, name: 'Register B', code: `P5-${registerId.slice(0, 6)}` } });
      await prisma.category.create({ data: { id: categoryId, organizationId, name: 'E2E Spirits' } });
      await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'E2E Bourbon' } });
      await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: '750 ml', sku: `P5-${variantId.slice(0, 8)}` } });
      await prisma.price.create({ data: { organizationId, storeId: destinationStoreId, variantId, amountMinor: 1000n, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });

      const tenants = new TenantContextService(); const purchasing = new PurchasingController(prisma, tenants);
      const inventory = new PhaseFiveController(prisma, tenants); const pos = new CorePosController(prisma, new SimulatedTerminalProvider(), tenants);
      const ownerA = request(sourceStoreId); const ownerB = request(destinationStoreId);
      const vendor = await purchasing.addVendor(ownerA, { name: `E2E Vendor ${organizationId.slice(0, 8)}` });
      await purchasing.saveMapping(ownerA, { vendorId: vendor.id, variantId, vendorCostMinor: '500', casePackQuantity: 6, minimumOrderQuantity: 6, preferred: true });
      const po = await purchasing.createPurchaseOrder(ownerA, { storeId: sourceStoreId, vendorId: vendor.id, poNumber: `P5-${organizationId.slice(0, 8)}`, lines: [{ variantId, quantity: 12 }] });
      await purchasing.submitPurchaseOrder(ownerA, po.id);
      await purchasing.receive(ownerA, po.id, { idempotencyKey: randomUUID(), lines: [{ purchaseOrderLineId: po.lines[0]!.id, deliveredQuantity: 12 }] });

      const transfer = await inventory.addTransfer(ownerA, { sourceStoreId, destinationStoreId, lines: [{ variantId, quantity: 3 }] });
      await inventory.submit(ownerA, transfer.id);
      await inventory.ship(ownerA, transfer.id, { idempotencyKey: randomUUID(), lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 3 }] });
      await inventory.receive(ownerB, transfer.id, { idempotencyKey: randomUUID(), lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 3 }] });
      const count = await inventory.addStockCount(ownerB, { storeId: destinationStoreId, variantIds: [variantId] });
      await inventory.review(ownerB, count.id, { lines: [{ stockCountLineId: count.lines[0]!.id, countedQuantity: 2 }] });
      await inventory.finalize(ownerB, count.id);
      await inventory.addPromotion(ownerB, { name: 'E2E 25% off', type: 'PERCENTAGE', scope: 'VARIANT', variantId,
        percentageBasisPoints: 2500, minimumQuantity: 1, minimumSpendMinor: '0', priority: 10,
        startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString(), active: true });

      const quote = await pos.quote(ownerB, { lines: [{ variantId, quantity: 1 }] });
      expect(quote).toMatchObject({ subtotalMinor: '1000', discountMinor: '250', totalMinor: '750' });
      const session = await pos.open(ownerB, { openingCashMinor: '0' });
      const sale = await pos.cash(ownerB, { registerSessionId: session.id, idempotencyKey: randomUUID(), lines: [{ variantId, quantity: 1 }], tenderedMinor: '1000' });
      const receipt = await pos.receipt(ownerB, sale.orderId);
      expect(receipt?.items[0]).toMatchObject({ promotionNameSnapshot: 'E2E 25% off', discountMinor: '250', totalMinor: '750' });
      const refund = await pos.refund(ownerB, sale.orderId, { reason: 'E2E return', idempotencyKey: randomUUID(), items: [{ orderItemId: receipt!.items[0]!.id, quantity: 1 }] });
      expect(refund).toMatchObject({ status: 'SUCCEEDED', amountMinor: '750' });
      expect((await prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: { organizationId, storeId: destinationStoreId, variantId } } })).onHand).toBe(2);
      expect((await prisma.inventoryMovement.findMany({ where: { organizationId }, select: { type: true } })).map(row => row.type)).toEqual(expect.arrayContaining(['PURCHASE_RECEIPT', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_OUT', 'SALE', 'SALE_RETURN']));
      await expect(inventory.transfers(request(sourceStoreId, 'CASHIER'), {})).rejects.toThrow();
      await expect(inventory.promotions(request(sourceStoreId, 'CASHIER'), {})).rejects.toThrow();
    } finally { await prisma.$disconnect(); }
  });
});
