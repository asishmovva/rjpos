import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { describe, expect, it } from 'vitest';
import { accountingExport, getReport, reportCsv } from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const suite = describe.sequential;

async function fixture() {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const organizationId = randomUUID(); const otherOrganizationId = randomUUID(); const storeId = randomUUID(); const employeeId = randomUUID();
  const registerId = randomUUID(); const categoryId = randomUUID(); const productId = randomUUID(); const variantId = randomUUID(); const sessionId = randomUUID();
  await prisma.organization.createMany({ data: [{ id: organizationId, name: 'Report Tenant' }, { id: otherOrganizationId, name: 'Other Tenant' }] });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'New York Store', timezone: 'America/New_York' } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Report', lastName: 'Owner' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Front', code: `R-${organizationId.slice(0, 6)}` } });
  await prisma.registerSession.create({ data: { id: sessionId, organizationId, storeId, registerId, employeeId, openingCashMinor: 10_000n, status: 'CLOSED', expectedCashMinor: 12_000n, actualCashMinor: 11_950n, differenceMinor: -50n, openedAt: new Date('2026-03-09T05:00:00Z'), closedAt: new Date('2026-03-09T12:00:00Z') } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'Historical Category' } });
  await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'Current Product', brand: 'Current Brand' } });
  await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: 'Current Variant', sku: `SKU-${organizationId.slice(0, 6)}`, costMinor: 400n } });
  await prisma.inventoryLevel.create({ data: { organizationId, storeId, variantId, onHand: 7, reserved: 2, lowStockThreshold: 5, reorderTarget: 10 } });
  const promotion = await prisma.promotion.create({ data: { organizationId, storeId, productId, createdByEmployeeId: employeeId, name: 'Spring Sale', type: 'FIXED', scope: 'PRODUCT', fixedAmountMinor: 200n, startsAt: new Date('2026-03-01T00:00:00Z'), endsAt: new Date('2026-04-01T00:00:00Z') } });
  const order = await prisma.order.create({ data: { organizationId, storeId, registerId, registerSessionId: sessionId, orderNumber: `SALE-${organizationId.slice(0, 6)}`, status: 'PARTIALLY_REFUNDED', subtotalMinor: 2000n, discountMinor: 200n, taxMinor: 100n, totalMinor: 1900n, completedAt: new Date('2026-03-09T05:30:00Z'), createdAt: new Date('2026-03-09T05:30:00Z') } });
  const item = await prisma.orderItem.create({ data: { organizationId, orderId: order.id, variantId, productNameSnapshot: 'Original Product', variantNameSnapshot: 'Original Variant', skuSnapshot: 'ORIGINAL-SKU', unitPriceMinor: 1000n, quantity: 2, subtotalMinor: 2000n, discountMinor: 200n, taxMinor: 100n, totalMinor: 1900n, promotionId: promotion.id, promotionNameSnapshot: 'Spring Sale' } });
  const payment = await prisma.payment.create({ data: { organizationId, orderId: order.id, kind: 'CASH', status: 'CAPTURED', amountMinor: 1900n, capturedMinor: 1900n } });
  const refund = await prisma.refund.create({ data: { organizationId, orderId: order.id, paymentId: payment.id, employeeId, status: 'SUCCEEDED', amountMinor: 950n, reason: 'Partial', completedAt: new Date('2026-03-09T06:00:00Z') } });
  await prisma.refundItem.create({ data: { organizationId, refundId: refund.id, orderItemId: item.id, variantId, quantity: 1, amountMinor: 950n } });
  await prisma.inventoryMovement.create({ data: { organizationId, storeId, variantId, type: 'SALE', quantityDelta: -2, resultingOnHand: 7, referenceType: 'ORDER', referenceId: order.id, createdAt: new Date('2026-03-09T05:30:00Z') } });
  await prisma.inventoryMovement.createMany({ data: [
    { organizationId, storeId, variantId, type: 'PURCHASE_RECEIPT', quantityDelta: 4, resultingOnHand: 9, referenceType: 'PURCHASE_RECEIPT', createdAt: new Date('2026-03-09T07:00:00Z') },
    { organizationId, storeId, variantId, type: 'TRANSFER_IN', quantityDelta: 2, resultingOnHand: 11, referenceType: 'TRANSFER', createdAt: new Date('2026-03-09T08:00:00Z') },
    { organizationId, storeId, variantId, type: 'ADJUSTMENT_OUT', quantityDelta: -4, resultingOnHand: 7, referenceType: 'STOCK_COUNT', createdAt: new Date('2026-03-09T09:00:00Z') },
  ] });
  const customer = await prisma.customer.create({ data: { organizationId, storeId, name: 'Report Customer' } });
  await prisma.loyaltyTransaction.createMany({ data: [
    { organizationId, customerId: customer.id, orderId: order.id, type: 'EARN', points: 20, createdAt: new Date('2026-03-09T06:00:00Z') },
    { organizationId, customerId: customer.id, orderId: order.id, type: 'REDEEM', points: -5, createdAt: new Date('2026-03-09T06:01:00Z') },
  ] });
  const card = await prisma.giftCard.create({ data: { organizationId, codeHash: randomUUID(), lastFour: '1234' } });
  await prisma.giftCardTransaction.createMany({ data: [
    { organizationId, giftCardId: card.id, employeeId, type: 'ISSUE', amountMinor: 2500n, createdAt: new Date('2026-03-09T06:00:00Z') },
    { organizationId, giftCardId: card.id, orderId: order.id, employeeId, type: 'REDEEM', amountMinor: -500n, createdAt: new Date('2026-03-09T06:05:00Z') },
  ] });
  const vendor = await prisma.vendor.create({ data: { organizationId, name: 'Report Vendor' } });
  const purchaseOrder = await prisma.purchaseOrder.create({ data: { organizationId, storeId, vendorId: vendor.id, createdByEmployeeId: employeeId, poNumber: `PO-${organizationId.slice(0, 6)}`, status: 'PARTIALLY_RECEIVED', createdAt: new Date('2026-03-09T07:00:00Z') } });
  await prisma.purchaseOrderLine.create({ data: { organizationId, purchaseOrderId: purchaseOrder.id, variantId, productNameSnapshot: 'Original Product', variantNameSnapshot: 'Original Variant', skuSnapshot: 'ORIGINAL-SKU', orderedQuantity: 10, receivedQuantity: 4, unitCostMinor: 400n } });
  await prisma.employeeShift.create({ data: { organizationId, employeeId, storeId, registerId, clockedInAt: new Date('2026-03-09T05:00:00Z'), clockedOutAt: new Date('2026-03-09T13:00:00Z') } });
  return { prisma, actor: { organizationId, userId: employeeId, storeId }, organizationId, otherOrganizationId, storeId };
}

suite('Phase 6 PostgreSQL reporting', () => {
  it('uses timezone-correct boundaries, tenant isolation, refunds, discounts, tax, snapshots, and ledger valuation', async () => {
    const f = await fixture();
    try {
      const filters = { from: '2026-03-09', to: '2026-03-09', storeId: f.storeId };
      const sales = await getReport(f.prisma, f.actor, 'sales', filters);
      expect(sales.filters).toMatchObject({ from: '2026-03-09T04:00:00.000Z', toExclusive: '2026-03-10T04:00:00.000Z', timezone: 'America/New_York' });
      expect(sales.data.summary).toMatchObject({ grossSalesMinor: '2000', discountsMinor: '200', taxMinor: '100', refundsMinor: '950', netSalesMinor: '950', transactionCount: 1, averageTransactionMinor: '1900' });
      const products = await getReport(f.prisma, f.actor, 'products', filters);
      expect(products.data.items[0]).toMatchObject({ label: 'Original Product — Original Variant', sku: 'ORIGINAL-SKU', quantitySold: 2, refundedQuantity: 1, refundsMinor: '950' });
      const inventory = await getReport(f.prisma, f.actor, 'inventory', filters);
      expect(inventory.data.summary).toMatchObject({ valuationMinor: '2800', onHand: 7, reserved: 2, available: 5, lowStockCount: 1 });
      expect((inventory.data.movements.items as Array<{ type: string }>)[0]?.type).toBe('ADJUSTMENT_OUT');
      expect(inventory.data.movementTotals).toMatchObject({ SALE: -2, PURCHASE_RECEIPT: 4, TRANSFER_IN: 2, ADJUSTMENT_OUT: -4 });
      expect((await getReport(f.prisma, f.actor, 'purchasing', filters)).data.summary).toMatchObject({ purchaseTotalMinor: '4000', outstandingCount: 1, partiallyReceivedCount: 1 });
      const employees = await getReport(f.prisma, f.actor, 'employees', filters);
      expect(employees.data.registerSessions.items[0]).toMatchObject({ differenceMinor: '-50', refundsMinor: '950' });
      expect(employees.data.shifts.items[0]).toMatchObject({ workedSeconds: 28_800 });
      expect((await getReport(f.prisma, f.actor, 'customers', filters)).data.summary).toMatchObject({ earnedPoints: 20, redeemedPoints: -5, outstandingPoints: 15 });
      expect((await getReport(f.prisma, f.actor, 'gift-cards', filters)).data.summary).toMatchObject({ issuedMinor: '2500', redeemedMinor: '500', outstandingLiabilityMinor: '2000' });
      expect((await getReport(f.prisma, f.actor, 'promotions', filters)).data.promotions.items[0]).toMatchObject({ label: 'Spring Sale', unitsAffected: 2, ordersAffected: 1, discountMinor: '200', revenueMinor: '1900' });
      await expect(getReport(f.prisma, { ...f.actor, organizationId: f.otherOrganizationId }, 'sales', filters)).rejects.toThrow('REPORT_STORE_NOT_FOUND');
    } finally { await f.prisma.$disconnect(); }
  });

  it('exports filter-identical, safely escaped CSV and a provider-neutral accounting contract', async () => {
    const f = await fixture();
    try {
      const filters = { from: '2026-03-09', to: '2026-03-09', storeId: f.storeId };
      const products = await getReport(f.prisma, f.actor, 'products', filters);
      const csv = reportCsv(products);
      expect(csv).toContain('# from=2026-03-09T04:00:00.000Z,toExclusive=2026-03-10T04:00:00.000Z,timezone=America/New_York');
      expect(csv).toContain('"Original Product — Original Variant"');
      expect(csv.split('\r\n').length).toBeGreaterThan(3);
      const accounting = await accountingExport(f.prisma, f.actor, filters);
      expect(accounting).toMatchObject({ schemaVersion: '1.0', provider: 'provider-neutral', sales: { summary: { taxMinor: '100', refundsMinor: '950' } }, inventory: { valuationMinor: '2800' }, purchasing: { purchaseTotalMinor: '4000' } });
    } finally { await f.prisma.$disconnect(); }
  });
});
