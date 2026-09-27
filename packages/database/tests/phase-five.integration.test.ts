import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import {
  adjustInventory, checkoutCash, createPromotion, createStockCount, createTransfer, finalizeStockCount,
  openRegisterSession, quoteCheckout, receiveTransfer, refundOrder, replenishmentSuggestions, reviewStockCount,
  shipTransfer, submitTransfer, updateInventoryPolicy,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const suite = describe.sequential;

async function fixture(onHand = 20) {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const organizationId = randomUUID();
  const sourceStoreId = randomUUID();
  const destinationStoreId = randomUUID();
  const registerId = randomUUID();
  const employeeId = randomUUID();
  const categoryId = randomUUID();
  const productId = randomUUID();
  const variantId = randomUUID();
  const suffix = organizationId.slice(0, 8);
  await prisma.organization.create({ data: { id: organizationId, name: `Phase 5 ${suffix}` } });
  await prisma.store.createMany({ data: [
    { id: sourceStoreId, organizationId, name: 'Source', taxRateBasisPoints: 0 },
    { id: destinationStoreId, organizationId, name: 'Destination', taxRateBasisPoints: 0 },
  ] });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Inventory', lastName: 'Manager' } });
  await prisma.employeeStore.createMany({ data: [
    { organizationId, employeeId, storeId: sourceStoreId },
    { organizationId, employeeId, storeId: destinationStoreId },
  ] });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId: destinationStoreId, name: 'Register', code: `P5-${suffix}` } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'Spirits' } });
  await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'Phase 5 Whiskey' } });
  await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: '750 ml', sku: `P5-${suffix}` } });
  await prisma.price.create({ data: { organizationId, storeId: destinationStoreId, variantId, amountMinor: 600n, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  await prisma.inventoryLevel.createMany({ data: [
    { organizationId, storeId: sourceStoreId, variantId, onHand },
    { organizationId, storeId: destinationStoreId, variantId, onHand: 0 },
  ] });
  return { prisma, organizationId, sourceStoreId, destinationStoreId, registerId, employeeId, categoryId, productId, variantId,
    actor: { organizationId, userId: employeeId, storeId: sourceStoreId } };
}

suite('Phase 5 advanced inventory and promotions with PostgreSQL', () => {
  it('moves stock through the transfer lifecycle with immutable, idempotent ledger entries and partial receipt', async () => {
    const f = await fixture(10);
    try {
      await expect(createTransfer(f.prisma, f.actor, { sourceStoreId: f.sourceStoreId, destinationStoreId: f.sourceStoreId,
        lines: [{ variantId: f.variantId, quantity: 1 }] })).rejects.toThrow('TRANSFER_STORES_MUST_DIFFER');
      const transfer = await createTransfer(f.prisma, f.actor, { sourceStoreId: f.sourceStoreId, destinationStoreId: f.destinationStoreId,
        notes: 'Rebalance', lines: [{ variantId: f.variantId, quantity: 6 }] });
      await submitTransfer(f.prisma, f.actor, transfer.id);
      expect((await submitTransfer(f.prisma, f.actor, transfer.id)).status).toBe('SUBMITTED');
      const shipInput = { idempotencyKey: randomUUID(), lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 6 }] };
      expect((await shipTransfer(f.prisma, f.actor, transfer.id, shipInput)).status).toBe('IN_TRANSIT');
      await expect(shipTransfer(f.prisma, f.actor, transfer.id, { ...shipInput,
        lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 5 }] })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
      expect((await shipTransfer(f.prisma, f.actor, transfer.id, shipInput)).status).toBe('IN_TRANSIT');
      expect((await f.prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: {
        organizationId: f.organizationId, storeId: f.sourceStoreId, variantId: f.variantId } } })).onHand).toBe(4);
      const firstInput = { idempotencyKey: randomUUID(), lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 2 }] };
      const first = await receiveTransfer(f.prisma, f.actor, transfer.id, firstInput);
      expect((await receiveTransfer(f.prisma, f.actor, transfer.id, firstInput)).id).toBe(first.id);
      await expect(receiveTransfer(f.prisma, f.actor, transfer.id, { ...firstInput,
        lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 1 }] })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
      await expect(receiveTransfer(f.prisma, f.actor, transfer.id, { idempotencyKey: randomUUID(),
        lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 5 }] })).rejects.toThrow('TRANSFER_RECEIPT_EXCEEDS_SHIPPED');
      await receiveTransfer(f.prisma, f.actor, transfer.id, { idempotencyKey: randomUUID(),
        lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 4 }] });
      expect((await f.prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe('RECEIVED');
      expect((await f.prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: {
        organizationId: f.organizationId, storeId: f.destinationStoreId, variantId: f.variantId } } })).onHand).toBe(6);
      expect(await f.prisma.inventoryMovement.count({ where: { referenceType: 'TRANSFER', referenceId: transfer.id, type: 'TRANSFER_OUT' } })).toBe(1);
      expect(await f.prisma.inventoryMovement.count({ where: { organizationId: f.organizationId, type: 'TRANSFER_IN' } })).toBe(2);
      await expect(createTransfer(f.prisma, { ...f.actor, organizationId: randomUUID() }, {
        sourceStoreId: f.sourceStoreId, destinationStoreId: f.destinationStoreId, lines: [{ variantId: f.variantId, quantity: 1 }],
      })).rejects.toThrow('TRANSFER_STORE_NOT_FOUND');
    } finally { await f.prisma.$disconnect(); }
  });

  it('serializes concurrent final-stock transfers so only one can ship', async () => {
    const f = await fixture(5);
    try {
      const transfers = await Promise.all([0, 1].map(() => createTransfer(f.prisma, f.actor, {
        sourceStoreId: f.sourceStoreId, destinationStoreId: f.destinationStoreId,
        lines: [{ variantId: f.variantId, quantity: 4 }],
      })));
      await Promise.all(transfers.map((transfer) => submitTransfer(f.prisma, f.actor, transfer.id)));
      const results = await Promise.allSettled(transfers.map((transfer) => shipTransfer(f.prisma, f.actor, transfer.id, {
        idempotencyKey: randomUUID(), lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 4 }],
      })));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect((await f.prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: {
        organizationId: f.organizationId, storeId: f.sourceStoreId, variantId: f.variantId } } })).onHand).toBe(1);
    } finally { await f.prisma.$disconnect(); }
  });

  it('snapshots, reviews, and finalizes stock counts exactly once with adjustment attribution', async () => {
    const f = await fixture(10);
    try {
      const count = await createStockCount(f.prisma, f.actor, { storeId: f.sourceStoreId, variantIds: [f.variantId] });
      expect(count.lines[0]?.expectedQuantity).toBe(10);
      await adjustInventory(f.prisma, { organizationId: f.organizationId, storeId: f.sourceStoreId, variantId: f.variantId,
        employeeId: f.employeeId, quantity: -1, reason: 'Movement after count snapshot' });
      const reviewed = await reviewStockCount(f.prisma, f.actor, count.id, {
        lines: [{ stockCountLineId: count.lines[0]!.id, countedQuantity: 7 }],
      });
      expect(reviewed.lines[0]).toMatchObject({ countedQuantity: 7, variance: -3 });
      expect((await finalizeStockCount(f.prisma, f.actor, count.id)).status).toBe('FINALIZED');
      expect((await finalizeStockCount(f.prisma, f.actor, count.id)).status).toBe('FINALIZED');
      expect(await f.prisma.inventoryMovement.count({ where: { referenceType: 'STOCK_COUNT', referenceId: count.id } })).toBe(1);
      expect(await f.prisma.inventoryMovement.findFirstOrThrow({ where: { referenceType: 'STOCK_COUNT', referenceId: count.id } })).toMatchObject({ quantityDelta: -2 });
      expect(await f.prisma.auditRecord.count({ where: { action: 'STOCK_COUNT_FINALIZED', entityId: count.id } })).toBe(1);
      expect((await f.prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: {
        organizationId: f.organizationId, storeId: f.sourceStoreId, variantId: f.variantId } } })).onHand).toBe(7);
      const gain = await createStockCount(f.prisma, f.actor, { storeId: f.sourceStoreId, variantIds: [f.variantId] });
      await reviewStockCount(f.prisma, f.actor, gain.id, { lines: [{ stockCountLineId: gain.lines[0]!.id, countedQuantity: 9 }] });
      await finalizeStockCount(f.prisma, f.actor, gain.id);
      expect((await f.prisma.inventoryMovement.findFirstOrThrow({ where: { referenceType: 'STOCK_COUNT', referenceId: gain.id } }))).toMatchObject({ type: 'ADJUSTMENT_IN', quantityDelta: 2 });
    } finally { await f.prisma.$disconnect(); }
  });

  it('rounds replenishment to preferred-vendor case packs and MOQ without placing an order', async () => {
    const f = await fixture(3);
    try {
      await updateInventoryPolicy(f.prisma, f.actor, { storeId: f.sourceStoreId, variantId: f.variantId, lowStockThreshold: 4, reorderTarget: 24 });
      const vendor = await f.prisma.vendor.create({ data: { organizationId: f.organizationId, name: 'Preferred Vendor' } });
      await f.prisma.vendorProductMapping.create({ data: { organizationId: f.organizationId, vendorId: vendor.id, variantId: f.variantId,
        vendorCostMinor: 500n, casePackQuantity: 6, minimumOrderQuantity: 20, preferred: true } });
      const suggestions = await replenishmentSuggestions(f.prisma, f.actor, f.sourceStoreId);
      expect(suggestions[0]).toMatchObject({ available: 3, reorderTarget: 24, suggestedUnits: 24, suggestedCases: 4,
        casePackQuantity: 6, minimumOrderQuantity: 20, vendorId: vendor.id });
      expect(await f.prisma.purchaseOrder.count({ where: { organizationId: f.organizationId } })).toBe(0);
    } finally { await f.prisma.$disconnect(); }
  });

  it('applies the deterministic highest-priority promotion and refunds the actual paid total', async () => {
    const f = await fixture(10);
    try {
      await f.prisma.inventoryLevel.update({ where: { organizationId_storeId_variantId: {
        organizationId: f.organizationId, storeId: f.destinationStoreId, variantId: f.variantId,
      } }, data: { onHand: 10 } });
      const now = Date.now();
      const common = { organizationId: f.organizationId, userId: f.employeeId, storeId: f.destinationStoreId };
      await expect(createPromotion(f.prisma, common, { name: 'Invalid tenant target', type: 'FIXED', scope: 'VARIANT', variantId: randomUUID(),
        fixedAmountMinor: '100', startsAt: new Date(now - 60_000), endsAt: new Date(now + 60_000) })).rejects.toThrow('PROMOTION_TARGET_NOT_FOUND');
      await createPromotion(f.prisma, common, { name: 'Category 10%', type: 'PERCENTAGE', scope: 'CATEGORY', categoryId: f.categoryId,
        percentageBasisPoints: 1000, priority: 1, startsAt: new Date(now - 60_000), endsAt: new Date(now + 60_000) });
      expect(await quoteCheckout(f.prisma, { organizationId: f.organizationId, storeId: f.destinationStoreId,
        lines: [{ variantId: f.variantId, quantity: 2 }] })).toMatchObject({ subtotalMinor: '1200', discountMinor: '120', totalMinor: '1080' });
      await createPromotion(f.prisma, common, { name: '$2.50 product discount', type: 'FIXED', scope: 'PRODUCT', productId: f.productId,
        fixedAmountMinor: '250', priority: 5, startsAt: new Date(now - 60_000), endsAt: new Date(now + 60_000) });
      expect(await quoteCheckout(f.prisma, { organizationId: f.organizationId, storeId: f.destinationStoreId,
        lines: [{ variantId: f.variantId, quantity: 2 }] })).toMatchObject({ discountMinor: '250', totalMinor: '950' });
      await createPromotion(f.prisma, { ...common, storeId: f.sourceStoreId }, { name: 'Other store only', type: 'FIXED', scope: 'VARIANT', variantId: f.variantId,
        storeId: f.sourceStoreId, fixedAmountMinor: '999', priority: 100, startsAt: new Date(now - 60_000), endsAt: new Date(now + 60_000) });
      await createPromotion(f.prisma, common, { name: 'Three for $10', type: 'MULTIBUY', scope: 'PRODUCT', productId: f.productId,
        bundleQuantity: 3, bundlePriceMinor: '1000', priority: 10, startsAt: new Date(now - 60_000), endsAt: new Date(now + 60_000) });
      await createPromotion(f.prisma, common, { name: 'Expired fixed', type: 'FIXED', scope: 'VARIANT', variantId: f.variantId,
        fixedAmountMinor: '999', priority: 99, startsAt: new Date(now - 120_000), endsAt: new Date(now - 60_000) });
      const session = await openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.destinationStoreId,
        registerId: f.registerId, employeeId: f.employeeId, openingCashMinor: 0n });
      const checkoutInput = { organizationId: f.organizationId, storeId: f.destinationStoreId, registerId: f.registerId,
        registerSessionId: session.id, employeeId: f.employeeId, idempotencyKey: randomUUID(),
        lines: [{ variantId: f.variantId, quantity: 3 }], tenderedMinor: 2000n };
      const sale = await checkoutCash(f.prisma, checkoutInput);
      expect(sale).toMatchObject({ subtotalMinor: '1800', discountMinor: '800', totalMinor: '1000' });
      expect((await checkoutCash(f.prisma, checkoutInput)).orderId).toBe(sale.orderId);
      const item = await f.prisma.orderItem.findFirstOrThrow({ where: { orderId: sale.orderId } });
      expect(item).toMatchObject({ promotionNameSnapshot: 'Three for $10', discountMinor: 800n, totalMinor: 1000n });
      const refund = await refundOrder(f.prisma, new SimulatedTerminalProvider(), { organizationId: f.organizationId,
        orderId: sale.orderId, employeeId: f.employeeId, reason: 'Return', idempotencyKey: randomUUID(),
        items: [{ orderItemId: item.id, quantity: 3 }] });
      expect(refund).toMatchObject({ status: 'SUCCEEDED', amountMinor: '1000' });
    } finally { await f.prisma.$disconnect(); }
  });
});
