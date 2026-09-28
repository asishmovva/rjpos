import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import { CorePosController } from '../src/core-pos.js';
import { PhaseThreeController } from '../src/phase-three.js';
import { PhaseFiveController } from '../src/phase-five.js';
import { PurchasingController } from '../src/purchasing.js';
import { ReportingController } from '../src/reporting.js';
import { rolePermissions, TenantContextService, type TenantRequest } from '../src/tenant-context.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();

describe('Phase 6 mixed-workflow-to-reports PostgreSQL E2E', () => {
  it('generates purchasing, transfer, promoted/loyalty/gift-card sale, refund, and closed-register activity, then verifies authoritative reports and CSV export', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const organizationId = randomUUID(); const sourceStoreId = randomUUID(); const destinationStoreId = randomUUID();
    const registerId = randomUUID(); const employeeId = randomUUID(); const categoryId = randomUUID(); const productId = randomUUID(); const variantId = randomUUID();
    const request = (storeId: string, role: keyof typeof rolePermissions = 'OWNER') => ({ tenantContext: {
      organizationId, storeId, registerId, userId: employeeId, permissions: new Set(rolePermissions[role]),
    } }) as unknown as TenantRequest;
    const orgActor = { tenantContext: { organizationId, userId: employeeId, permissions: new Set(rolePermissions.OWNER) } } as unknown as TenantRequest;
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Phase 6 E2E' } });
      await prisma.store.createMany({ data: [{ id: sourceStoreId, organizationId, name: 'Warehouse Store', taxRateBasisPoints: 0 }, { id: destinationStoreId, organizationId, name: 'Retail Store', taxRateBasisPoints: 0 }] });
      await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Phase', lastName: 'Six' } });
      await prisma.employeeStore.createMany({ data: [{ organizationId, employeeId, storeId: sourceStoreId }, { organizationId, employeeId, storeId: destinationStoreId }] });
      await prisma.register.create({ data: { id: registerId, organizationId, storeId: destinationStoreId, name: 'Register R6', code: `P6-${registerId.slice(0, 6)}` } });
      await prisma.category.create({ data: { id: categoryId, organizationId, name: 'E2E Wine' } });
      await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'E2E Cabernet' } });
      await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: '750 ml', sku: `P6-${variantId.slice(0, 8)}` } });
      await prisma.price.create({ data: { organizationId, storeId: destinationStoreId, variantId, amountMinor: 2000n, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });

      const tenants = new TenantContextService();
      const purchasing = new PurchasingController(prisma, tenants);
      const phaseFive = new PhaseFiveController(prisma, tenants);
      const phaseThree = new PhaseThreeController(prisma, tenants);
      const pos = new CorePosController(prisma, new SimulatedTerminalProvider(), tenants);
      const reporting = new ReportingController(prisma, tenants);
      const ownerA = request(sourceStoreId); const ownerB = request(destinationStoreId);

      // Purchasing: order and receive stock at the source store.
      const vendor = await purchasing.addVendor(ownerA, { name: `E2E Vendor ${organizationId.slice(0, 8)}` });
      await purchasing.saveMapping(ownerA, { vendorId: vendor.id, variantId, vendorCostMinor: '800', casePackQuantity: 6, minimumOrderQuantity: 6, preferred: true });
      const po = await purchasing.createPurchaseOrder(ownerA, { storeId: sourceStoreId, vendorId: vendor.id, poNumber: `P6-${organizationId.slice(0, 8)}`, lines: [{ variantId, quantity: 12 }] });
      await purchasing.submitPurchaseOrder(ownerA, po.id);
      await purchasing.receive(ownerA, po.id, { idempotencyKey: randomUUID(), lines: [{ purchaseOrderLineId: po.lines[0]!.id, deliveredQuantity: 12 }] });
      const secondPo = await purchasing.createPurchaseOrder(ownerA, { storeId: sourceStoreId, vendorId: vendor.id, poNumber: `P6-OUTSTANDING-${organizationId.slice(0, 6)}`, lines: [{ variantId, quantity: 6 }] });
      await purchasing.submitPurchaseOrder(ownerA, secondPo.id);

      // Transfer + count at the destination store.
      const transfer = await phaseFive.addTransfer(ownerA, { sourceStoreId, destinationStoreId, lines: [{ variantId, quantity: 5 }] });
      await phaseFive.submit(ownerA, transfer.id);
      await phaseFive.ship(ownerA, transfer.id, { idempotencyKey: randomUUID(), lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 5 }] });
      await phaseFive.receive(ownerB, transfer.id, { idempotencyKey: randomUUID(), lines: [{ transferLineId: transfer.lines[0]!.id, quantity: 5 }] });
      const count = await phaseFive.addStockCount(ownerB, { storeId: destinationStoreId, variantIds: [variantId] });
      await phaseFive.review(ownerB, count.id, { lines: [{ stockCountLineId: count.lines[0]!.id, countedQuantity: 5 }] });
      await phaseFive.finalize(ownerB, count.id);

      // Promotion.
      await phaseFive.addPromotion(ownerB, { name: 'E2E 25% off', type: 'PERCENTAGE', scope: 'VARIANT', variantId,
        percentageBasisPoints: 2500, minimumQuantity: 1, minimumSpendMinor: '0', priority: 10,
        startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString(), active: true });

      // Customer, loyalty program, and gift card.
      const customer = await phaseThree.addCustomer(ownerB, { name: 'E2E Customer', email: `e2e-${organizationId.slice(0, 6)}@example.test` });
      await phaseThree.setLoyaltyProgram(ownerB, { enabled: true, pointsEarned: 1, spendMinor: '100', redeemMinorPerPoint: '10' });
      const card = await phaseThree.addGiftCard(ownerB, { amountMinor: '1000', reason: 'E2E issue' });

      // Register open, promoted + loyalty + gift-card sale, partial refund, register close.
      const session = await pos.open(ownerB, { openingCashMinor: '0' });
      const sale = await pos.mixedCheckout(ownerB, { registerSessionId: session.id, idempotencyKey: randomUUID(), customerId: customer.id,
        lines: [{ variantId, quantity: 2 }], giftCards: [{ code: card.code, amountMinor: '500' }], remainder: { kind: 'CASH', tenderedMinor: '2500' } });
      const receipt = await pos.receipt(ownerB, sale.orderId);
      expect(receipt?.items[0]).toMatchObject({ promotionNameSnapshot: 'E2E 25% off', quantity: 2, totalMinor: '3000' });
      const refund = await pos.refund(ownerB, sale.orderId, { reason: 'E2E partial return', idempotencyKey: randomUUID(),
        items: [{ orderItemId: receipt!.items[0]!.id, quantity: 1 }] });
      expect(refund.status).toBe('SUCCEEDED');
      await pos.close(ownerB, session.id, { countedCashMinor: '2500' });

      // Reports must reflect authoritative totals across both stores for the organization.
      const filters = { page: '1', pageSize: '50' } as Record<string, string>;
      const sales = await reporting.report(orgActor, 'sales', filters);
      expect(sales.data.summary).toMatchObject({ transactionCount: 1, discountsMinor: '1000' });
      expect(Number((sales.data.summary as { refundsMinor: string }).refundsMinor)).toBeGreaterThan(0);

      const products = await reporting.report(orgActor, 'products', filters);
      expect((products.data.items as Array<Record<string, unknown>>)[0]).toMatchObject({ quantitySold: 2, refundedQuantity: 1 });

      const purchasingReport = await reporting.report(orgActor, 'purchasing', filters);
      expect(purchasingReport.data.summary).toMatchObject({ outstandingCount: 1 });

      const customers = await reporting.report(orgActor, 'customers', filters);
      expect(customers.data.summary).toMatchObject({ customers: 1 });
      expect(Number((customers.data.summary as { earnedPoints: number }).earnedPoints)).toBeGreaterThan(0);

      const giftCards = await reporting.report(orgActor, 'gift-cards', filters);
      expect(giftCards.data.summary).toMatchObject({ cards: 1, issuedMinor: '1000', redeemedMinor: '500' });

      const promotions = await reporting.report(orgActor, 'promotions', filters);
      expect((promotions.data.promotions as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ label: 'E2E 25% off', unitsAffected: 2 });

      const employees = await reporting.report(orgActor, 'employees', filters);
      expect((employees.data.registerSessions as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ register: 'Register R6', status: 'CLOSED' });

      const response = { setHeader: () => undefined, send: (body: string) => { csvBody = body; } };
      let csvBody = '';
      await reporting.csv(orgActor, 'products', filters, response as never);
      expect(csvBody).toContain('# report=products');
      expect(csvBody).toContain('E2E Cabernet');

      await expect(reporting.report(request(destinationStoreId, 'CASHIER'), 'sales', filters)).rejects.toThrow();
      await expect(reporting.csv(request(destinationStoreId, 'CASHIER'), 'sales', filters, response as never)).rejects.toThrow();
    } finally { await prisma.$disconnect(); }
  });
});
