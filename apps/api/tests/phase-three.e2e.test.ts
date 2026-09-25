import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import { CorePosController } from '../src/core-pos.js';
import { PhaseThreeController } from '../src/phase-three.js';
import { rolePermissions, TenantContextService, type TenantRequest } from '../src/tenant-context.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();

describe('Phase 3 API + PostgreSQL retention E2E', () => {
  it('clocks in, earns and spends customer value, refunds compensation, and clocks out through controllers', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const organizationId = randomUUID(); const storeId = randomUUID(); const registerId = randomUUID(); const employeeId = randomUUID();
    const categoryId = randomUUID(); const productId = randomUUID(); const variantId = randomUUID();
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Phase 3 API E2E' } });
      await prisma.store.create({ data: { id: storeId, organizationId, name: 'Retention Store', taxRateBasisPoints: 0 } });
      await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'E2E', lastName: 'Owner' } });
      await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
      await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'E2E Register', code: `E2E-${registerId.slice(0, 6)}` } });
      await prisma.category.create({ data: { id: categoryId, organizationId, name: `E2E ${categoryId.slice(0, 6)}` } });
      await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'E2E Item', taxCategory: 'EXEMPT' } });
      await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: 'Each', sku: `E2E-${variantId.slice(0, 8)}` } });
      await prisma.price.create({ data: { organizationId, storeId, variantId, amountMinor: 1000n, effectiveFrom: new Date('2026-01-01') } });
      await prisma.inventoryLevel.create({ data: { organizationId, storeId, variantId, onHand: 10 } });
      const request = { tenantContext: { organizationId, storeId, registerId, userId: employeeId, permissions: new Set(rolePermissions.OWNER) } } as TenantRequest;
      const tenants = new TenantContextService(); const provider = new SimulatedTerminalProvider();
      const phase3 = new PhaseThreeController(prisma, tenants); const pos = new CorePosController(prisma, provider, tenants);
      await phase3.startShift(request);
      const customer = await phase3.addCustomer(request, { name: 'E2E Customer', email: 'e2e@example.test' });
      await phase3.setLoyaltyProgram(request, { enabled: true, pointsEarned: 1, spendMinor: '100', redeemMinorPerPoint: '10' });
      const card = await phase3.addGiftCard(request, { amountMinor: '500', reason: 'E2E issue' });
      const registerSession = await pos.open(request, { openingCashMinor: '0' });
      await pos.cash(request, { registerSessionId: registerSession.id, idempotencyKey: randomUUID(), customerId: customer.id,
        lines: [{ variantId, quantity: 1 }], tenderedMinor: '1000' });
      expect((await phase3.customer(request, customer.id)).pointsBalance).toBe(10);
      const second = await pos.mixedCheckout(request, { registerSessionId: registerSession.id, idempotencyKey: randomUUID(), customerId: customer.id,
        lines: [{ variantId, quantity: 1 }], giftCards: [{ code: card.code, amountMinor: '400' }], loyaltyPoints: 5,
        remainder: { kind: 'CASH', tenderedMinor: '550' } });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: second.orderId }, include: { items: true } });
      expect((await phase3.customer(request, customer.id)).orders).toHaveLength(2);
      await pos.refund(request, second.orderId, { reason: 'E2E return', idempotencyKey: randomUUID(),
        items: [{ orderItemId: order.items[0]!.id, quantity: 1 }] });
      const detail = await phase3.customer(request, customer.id);
      expect(detail.pointsBalance).toBe(10);
      expect((await phase3.giftCard(request, card.code)).balanceMinor).toBe('500');
      await phase3.endShift(request);
      expect(await phase3.currentShift(request)).toBeNull();
    } finally { await prisma.$disconnect(); }
  });
});
