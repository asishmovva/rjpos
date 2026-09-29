import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { describe, expect, it } from 'vitest';
import { createEmployee, listEmployees, searchInventory, setEmployeePin, updateEmployee } from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();

async function fixture(prisma: PrismaClient) {
  const organizationId = randomUUID(); const storeId = randomUUID(); const employeeId = randomUUID(); const categoryId = randomUUID();
  await prisma.organization.create({ data: { id: organizationId, name: 'Directory' } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Dir Store' } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Owner', lastName: 'One' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'General' } });
  return { organizationId, storeId, employeeId, categoryId };
}

describe.sequential('Register inventory search and employee PIN management', () => {
  it('pages and filters stock by text, size, category, and status', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const { organizationId, storeId, categoryId } = await fixture(prisma);
      const wine = await prisma.category.create({ data: { organizationId, name: 'Wine' } });
      const specs: Array<[string, string, string, string, number, number]> = [
        ['Vodka Plain', '750 ML', categoryId, '111000111000', 0, 0], ['Gin Dry', '750 ML', categoryId, '111000111001', 2, 5],
        ['Rum Dark', '375 ML', categoryId, '111000111002', 40, 5], ['Merlot Reserve', '1.5 L', wine.id, '777000111222', 12, 5],
      ];
      for (const [name, variantName, category, barcodeValue, onHand, lowStockThreshold] of specs) {
        const product = await prisma.product.create({ data: { organizationId, categoryId: category, name } });
        const variant = await prisma.productVariant.create({ data: { organizationId, productId: product.id, name: variantName, sku: `S-${barcodeValue}` } });
        await prisma.barcode.create({ data: { organizationId, variantId: variant.id, barcodeValue } });
        await prisma.inventoryLevel.create({ data: { organizationId, storeId, variantId: variant.id, onHand, lowStockThreshold, reorderTarget: lowStockThreshold } });
      }
      const search = (extra: Partial<Parameters<typeof searchInventory>[1]>) => searchInventory(prisma, { organizationId, storeId, ...extra });
      expect((await search({})).total).toBe(4);
      expect((await search({ pageSize: 2, page: 2 })).items).toHaveLength(2);
      expect((await search({ search: 'merlot' })).items.map((row) => row.variant.name)).toEqual(['1.5 L']);
      expect((await search({ search: '777000' })).total).toBe(1);
      expect((await search({ search: 'S-111000111001' })).total).toBe(1);
      expect((await search({ size: '750' })).total).toBe(2);
      expect((await search({ categoryId: wine.id })).total).toBe(1);
      expect((await search({ status: 'zero' })).total).toBe(1);
      expect((await search({ status: 'low' })).items.map((row) => row.onHand)).toEqual([2]);
      expect((await search({ status: 'in_stock' })).total).toBe(3);
      expect((await search({ search: 'gin', status: 'zero' })).total).toBe(0);
      expect((await search({})).categories.map((category) => category.name).sort()).toEqual(['General', 'Wine']);
      expect((await searchInventory(prisma, { organizationId: randomUUID(), storeId })).total).toBe(0);
      expect((await search({ pageSize: 5000 })).pageSize).toBe(100);
    } finally { await prisma.$disconnect(); }
  });

  it('creates, resets, and hides employee PINs with uniqueness and Owner-only elevated PIN management', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const { organizationId, storeId, employeeId } = await fixture(prisma);
      for (const name of ['CASHIER', 'MANAGER', 'OWNER']) await prisma.role.create({ data: { organizationId, name } });
      const actor = { organizationId, userId: employeeId, storeId };
      const cashier = await createEmployee(prisma, actor, { firstName: 'Pat', lastName: 'Till', roleNames: ['CASHIER'], storeIds: [storeId], pin: '4455' });
      expect(cashier).toMatchObject({ hasPin: true }); expect(cashier).not.toHaveProperty('pinHash');
      const stored = await prisma.employee.findUniqueOrThrow({ where: { id: cashier.id } });
      expect(stored.pinHash).toMatch(/^scrypt\$/); expect(stored.pinHash).not.toContain('4455');
      const other = await createEmployee(prisma, actor, { firstName: 'Sam', lastName: 'Till', roleNames: ['CASHIER'], storeIds: [storeId] });
      expect(other).toMatchObject({ hasPin: false });
      await expect(setEmployeePin(prisma, actor, other.id, '4455', false)).rejects.toThrow('PIN_ALREADY_IN_USE');
      await expect(setEmployeePin(prisma, actor, other.id, '12', false)).rejects.toThrow('PIN_INVALID');
      await expect(setEmployeePin(prisma, actor, other.id, '9090', false)).resolves.toEqual({ id: other.id, hasPin: true });
      await expect(setEmployeePin(prisma, actor, cashier.id, '4455', false)).resolves.toMatchObject({ hasPin: true });
      const manager = await createEmployee(prisma, actor, { firstName: 'Mo', lastName: 'Boss', roleNames: ['MANAGER'], storeIds: [storeId] });
      await expect(setEmployeePin(prisma, actor, manager.id, '6060', false)).rejects.toThrow('PIN_RESET_REQUIRES_OWNER');
      await expect(setEmployeePin(prisma, actor, manager.id, '6060', true)).resolves.toMatchObject({ hasPin: true });
      await expect(createEmployee(prisma, actor, { firstName: 'X', lastName: 'Y', roleNames: ['MANAGER'], storeIds: [storeId], pin: '7070' })).rejects.toThrow('PIN_RESET_REQUIRES_OWNER');
      const listed = await listEmployees(prisma, actor, { pageSize: 50 });
      expect(JSON.stringify(listed)).not.toContain('pinHash'); expect(JSON.stringify(listed)).not.toContain('scrypt');
      expect(listed.items.find((employee) => employee.id === manager.id)).toMatchObject({ hasPin: true });
      const audit = await prisma.auditRecord.findMany({ where: { organizationId, action: 'EMPLOYEE_PIN_SET' } });
      expect(audit.length).toBeGreaterThanOrEqual(3); expect(JSON.stringify(audit)).not.toMatch(/4455|9090|6060/);
      expect(await updateEmployee(prisma, actor, other.id, { status: 'INACTIVE' })).toMatchObject({ status: 'INACTIVE' });
      expect(await prisma.employee.count({ where: { id: other.id } })).toBe(1);
    } finally { await prisma.$disconnect(); }
  });
});
