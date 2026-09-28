import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { describe, expect, it } from 'vitest';
import { holdTransaction, listHeldTransactions, listQuickKeys, resumeHeldTransaction, saveQuickKey } from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
describe.sequential('Phase 7 register operations with PostgreSQL', () => {
  it('configures tenant-scoped Quick Keys and holds/resumes a revalidated cart idempotently', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const organizationId = randomUUID(); const storeId = randomUUID(); const registerId = randomUUID(); const employeeId = randomUUID(); const categoryId = randomUUID(); const productId = randomUUID(); const variantId = randomUUID();
    const actor = { organizationId, storeId, registerId, userId: employeeId };
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Phase 7' } });
      await prisma.store.create({ data: { id: storeId, organizationId, name: 'Touch Store' } });
      await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Touch', lastName: 'Cashier' } });
      await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
      await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Front', code: `P7-${organizationId.slice(0, 6)}` } });
      await prisma.category.create({ data: { id: categoryId, organizationId, name: 'Quick' } });
      await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'Quick Product' } });
      await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: 'Each', sku: `Q-${organizationId.slice(0, 6)}` } });
      await prisma.price.create({ data: { organizationId, storeId, variantId, amountMinor: 500n, effectiveFrom: new Date('2026-01-01') } });
      const key = await saveQuickKey(prisma, actor, { variantId, label: 'Quick Item', groupName: 'Popular', position: 0 });
      expect(await listQuickKeys(prisma, actor)).toEqual([expect.objectContaining({ id: key.id, label: 'Quick Item', priceMinor: '500' })]);
      const idempotencyKey = randomUUID(); const input = { idempotencyKey, label: 'Jamie', cart: { lines: [{ variantId, quantity: 2 }], ageVerified: true } };
      const held = await holdTransaction(prisma, actor, input);
      expect((await holdTransaction(prisma, actor, input)).id).toBe(held.id);
      await expect(holdTransaction(prisma, actor, { ...input, cart: { lines: [{ variantId, quantity: 3 }] } })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
      expect(await listHeldTransactions(prisma, actor)).toHaveLength(1);
      await prisma.price.updateMany({ where: { organizationId, variantId }, data: { effectiveTo: new Date('2026-06-01') } });
      await prisma.price.create({ data: { organizationId, storeId, variantId, amountMinor: 650n, effectiveFrom: new Date('2026-06-01') } });
      const resumed = await resumeHeldTransaction(prisma, actor, held.id);
      expect(resumed).toMatchObject({ id: held.id, pricingRevalidated: true, quote: { subtotalMinor: '1300' } });
      expect((await resumeHeldTransaction(prisma, actor, held.id)).id).toBe(held.id);
      expect(await listHeldTransactions(prisma, actor)).toHaveLength(0);
      expect(await prisma.auditRecord.count({ where: { organizationId, entityId: held.id, action: { in: ['TRANSACTION_HELD', 'TRANSACTION_RESUMED'] } } })).toBe(2);
      await expect(listQuickKeys(prisma, { ...actor, organizationId: randomUUID() })).resolves.toEqual([]);
    } finally { await prisma.$disconnect(); }
  });
});
