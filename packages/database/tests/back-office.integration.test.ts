import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import {
  adjustInventory,
  checkoutCash,
  createCategory,
  createEmployee,
  createProduct,
  createRegister,
  createStore,
  createVariant,
  getDashboard,
  getOrderAdmin,
  listAuditRecords,
  listCategories,
  listEmployees,
  listInventoryAdmin,
  listInventoryMovements,
  listOrdersAdmin,
  listPriceHistory,
  listProducts,
  listRefunds,
  listRegisters,
  lookupCatalog,
  openRegisterSession,
  postOpeningBalance,
  refundOrder,
  schedulePrice,
  updateCategory,
  updateEmployee,
  updateProduct,
  updateRegister,
  updateStore,
  updateVariant,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const suite = describe.sequential;

async function fixture() {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const organizationId = randomUUID();
  const storeId = randomUUID();
  const registerId = randomUUID();
  const employeeId = randomUUID();
  const suffix = organizationId.slice(0, 8);
  await prisma.organization.create({ data: { id: organizationId, name: `Phase 2 ${suffix}` } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Main Store', taxRateBasisPoints: 625 } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Olivia', lastName: 'Owner' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  for (const roleName of ['OWNER', 'MANAGER', 'CASHIER']) {
    await prisma.role.create({ data: { organizationId, name: roleName } });
  }
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { organizationId, name: 'OWNER' } });
  await prisma.employeeRole.create({ data: { organizationId, employeeId, roleId: ownerRole.id } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Front', code: `R-${suffix}` } });
  return { prisma, organizationId, storeId, registerId, employeeId, actor: { organizationId, storeId, userId: employeeId } };
}

async function catalog(f: Awaited<ReturnType<typeof fixture>>, suffix = randomUUID().slice(0, 8)) {
  const category = await createCategory(f.prisma, f.actor, { name: `Spirits ${suffix}` });
  const product = await createProduct(f.prisma, f.actor, { categoryId: category.id, name: `Vodka ${suffix}`, brand: 'RJ', ageRestricted: true });
  const variant = await createVariant(f.prisma, f.actor, product.id, { name: '750 ml', sku: `SKU-${suffix}`, barcode: `UPC${suffix}`, size: '750', unit: 'ML', costMinor: '900', lowStockThreshold: 2 });
  return { category, product, variant, barcode: `UPC${suffix}` };
}

suite('Phase 2 back-office with PostgreSQL', () => {
  it('creates, edits, searches, and lifecycle-manages categories, products, and variants', async () => {
    const f = await fixture();
    try {
      const c = await catalog(f);
      expect((await listProducts(f.prisma, f.actor, { search: c.barcode })).items).toHaveLength(1);
      await updateProduct(f.prisma, f.actor, c.product.id, { name: 'Renamed Vodka', active: false });
      await updateVariant(f.prisma, f.actor, c.variant.id, { name: 'One Liter', active: false, lowStockThreshold: 4 });
      await updateCategory(f.prisma, f.actor, c.category.id, { name: 'Archived Spirits', active: false });
      const product = await f.prisma.product.findUniqueOrThrow({ where: { id: c.product.id }, include: { variants: true } });
      expect(product).toMatchObject({ name: 'Renamed Vodka', active: false });
      expect(product.variants[0]).toMatchObject({ name: 'One Liter', active: false, lowStockThreshold: 4 });
      expect((await listCategories(f.prisma, f.actor, { active: false })).items[0]?._count.products).toBe(1);
      await expect(f.prisma.category.delete({ where: { id: c.category.id } })).rejects.toThrow();
    } finally { await f.prisma.$disconnect(); }
  });

  it('enforces tenant SKU/UPC ownership and allows exactly one concurrent duplicate UPC', async () => {
    const f = await fixture();
    try {
      const c = await catalog(f);
      await expect(createVariant(f.prisma, f.actor, c.product.id, { name: 'Duplicate', sku: c.variant.sku, barcode: `NEW${randomUUID()}` })).rejects.toThrow('SKU_ALREADY_ASSIGNED');
      await expect(createVariant(f.prisma, f.actor, c.product.id, { name: 'Duplicate', sku: `NEW-${randomUUID()}`, barcode: c.barcode })).rejects.toThrow('UPC_ALREADY_ASSIGNED');
      const raceBarcode = `RACE${randomUUID().replaceAll('-', '')}`;
      const race = await Promise.allSettled([
        createVariant(f.prisma, f.actor, c.product.id, { name: 'Race A', sku: `A-${randomUUID()}`, barcode: raceBarcode }),
        createVariant(f.prisma, f.actor, c.product.id, { name: 'Race B', sku: `B-${randomUUID()}`, barcode: raceBarcode }),
      ]);
      expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(race.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      expect(await f.prisma.barcode.count({ where: { organizationId: f.organizationId, barcodeValue: raceBarcode } })).toBe(1);
      expect((await listProducts(f.prisma, { ...f.actor, organizationId: randomUUID() }, {})).items).toHaveLength(0);
    } finally { await f.prisma.$disconnect(); }
  });

  it('preserves effective price history and rejects invalid, overlapping, and racing periods', async () => {
    const f = await fixture();
    try {
      const c = await catalog(f); const from = new Date(Date.now() - 60_000); const next = new Date(Date.now() + 86_400_000);
      await schedulePrice(f.prisma, f.actor, { variantId: c.variant.id, storeId: f.storeId, amountMinor: '1999', effectiveFrom: from });
      await schedulePrice(f.prisma, f.actor, { variantId: c.variant.id, storeId: f.storeId, amountMinor: '2199', effectiveFrom: next });
      const history = await listPriceHistory(f.prisma, f.actor, c.variant.id, f.storeId);
      expect(history.map(({ amountMinor }) => amountMinor)).toEqual([2199n, 1999n]);
      expect(history[1]?.effectiveTo).toEqual(next);
      expect((await lookupCatalog(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, barcode: c.barcode }))[0]?.priceMinor).toBe('1999');
      await expect(schedulePrice(f.prisma, f.actor, { variantId: c.variant.id, storeId: f.storeId, amountMinor: '1', effectiveFrom: new Date(next.getTime() - 1000) })).rejects.toThrow();
      await expect(schedulePrice(f.prisma, f.actor, { variantId: c.variant.id, amountMinor: '1', effectiveFrom: next, effectiveTo: from })).rejects.toThrow('PRICE_EFFECTIVE_WINDOW_INVALID');
      await expect(schedulePrice(f.prisma, f.actor, { variantId: c.variant.id, amountMinor: '-1', effectiveFrom: from })).rejects.toThrow('PRICE_INVALID');
      await expect(listPriceHistory(f.prisma, { ...f.actor, organizationId: randomUUID() }, c.variant.id)).rejects.toThrow('VARIANT_NOT_FOUND');
      const c2 = await catalog(f); const raceFrom = new Date(Date.now() + 200_000);
      const race = await Promise.allSettled([
        schedulePrice(f.prisma, f.actor, { variantId: c2.variant.id, storeId: f.storeId, amountMinor: '100', effectiveFrom: raceFrom }),
        schedulePrice(f.prisma, f.actor, { variantId: c2.variant.id, storeId: f.storeId, amountMinor: '200', effectiveFrom: raceFrom }),
      ]);
      expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    } finally { await f.prisma.$disconnect(); }
  });

  it('uses immutable movements for opening balance and serialized manual adjustments', async () => {
    const f = await fixture();
    try {
      const c = await catalog(f);
      await postOpeningBalance(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: c.variant.id, quantity: 5, reason: 'Shelf count' });
      await Promise.all([
        adjustInventory(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: c.variant.id, quantity: 2, reason: 'Found stock' }),
        adjustInventory(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: c.variant.id, quantity: -1, reason: 'Damage' }),
      ]);
      await expect(adjustInventory(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: c.variant.id, quantity: 1, reason: ' ' })).rejects.toThrow('INVENTORY_REASON_REQUIRED');
      const inventory = await listInventoryAdmin(f.prisma, f.actor, { storeId: f.storeId });
      expect(inventory.items[0]).toMatchObject({ onHand: 6, available: 6, inventoryStatus: 'IN_STOCK' });
      const movements = await listInventoryMovements(f.prisma, f.actor, { storeId: f.storeId, variantId: c.variant.id });
      expect(movements.items).toHaveLength(3);
      expect(movements.items.map(({ reason }) => reason)).toEqual(expect.arrayContaining(['Shelf count', 'Found stock', 'Damage']));
      expect(movements.items.every(({ resultingOnHand }) => resultingOnHand !== null)).toBe(true);
    } finally { await f.prisma.$disconnect(); }
  });

  it('assigns employee roles/stores, deactivates without deleting historical attribution, and rejects cross-tenant assignments', async () => {
    const f = await fixture();
    try {
      const employee = await createEmployee(f.prisma, f.actor, { firstName: 'Casey', lastName: 'Cashier', roleNames: ['CASHIER'], storeIds: [f.storeId] });
      const c = await catalog(f);
      await postOpeningBalance(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: employee.id, variantId: c.variant.id, quantity: 1, reason: 'Employee attribution' });
      await updateEmployee(f.prisma, f.actor, employee.id, { roleNames: ['MANAGER'], status: 'INACTIVE' });
      const listed = await listEmployees(f.prisma, f.actor, { status: 'INACTIVE' });
      expect(listed.items[0]?.roles[0]?.role.name).toBe('MANAGER');
      expect(await f.prisma.employee.count({ where: { id: employee.id } })).toBe(1);
      expect((await f.prisma.inventoryMovement.findFirstOrThrow({ where: { organizationId: f.organizationId, employeeId: employee.id } })).employeeId).toBe(employee.id);
      await expect(createEmployee(f.prisma, f.actor, { firstName: 'Bad', lastName: 'Store', roleNames: ['CASHIER'], storeIds: [randomUUID()] })).rejects.toThrow('EMPLOYEE_STORE_INVALID');
    } finally { await f.prisma.$disconnect(); }
  });

  it('manages stores/registers while preventing unsafe changes during active sessions', async () => {
    const f = await fixture();
    try {
      const store = await createStore(f.prisma, f.actor, { name: 'West', timezone: 'America/Chicago', taxRateBasisPoints: 825, receiptFooter: 'Thank you' });
      const register = await createRegister(f.prisma, f.actor, { storeId: store.id, name: 'West Front', code: 'WEST-1' });
      expect((await listRegisters(f.prisma, f.actor, store.id))[0]?.code).toBe('WEST-1');
      await updateStore(f.prisma, f.actor, store.id, { ageRestrictionLabel: 'ID required: 21+', taxRateBasisPoints: 800 });
      await expect(updateStore(f.prisma, f.actor, store.id, { timezone: 'Not/A_Timezone' })).rejects.toThrow('STORE_TIMEZONE_INVALID');
      const employee = await createEmployee(f.prisma, f.actor, { firstName: 'West', lastName: 'Manager', roleNames: ['MANAGER'], storeIds: [store.id] });
      await openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: store.id, registerId: register.id, employeeId: employee.id, openingCashMinor: 0n });
      await expect(updateRegister(f.prisma, f.actor, register.id, { status: 'INACTIVE' })).rejects.toThrow('REGISTER_HAS_ACTIVE_SESSION');
      await expect(updateStore(f.prisma, f.actor, store.id, { status: 'INACTIVE' })).rejects.toThrow('STORE_HAS_ACTIVE_SESSIONS');
    } finally { await f.prisma.$disconnect(); }
  });

  it('serializes session opening against concurrent store and register deactivation', async () => {
    const f = await fixture();
    try {
      const registerRace = await Promise.allSettled([
        openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId, employeeId: f.employeeId, openingCashMinor: 0n }),
        updateRegister(f.prisma, f.actor, f.registerId, { status: 'INACTIVE' }),
      ]);
      expect(registerRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const register = await f.prisma.register.findUniqueOrThrow({ where: { id: f.registerId } });
      const activeRegisterSessions = await f.prisma.registerSession.count({ where: { organizationId: f.organizationId, registerId: f.registerId, status: { in: ['OPEN', 'CLOSING'] } } });
      expect(register.status === 'INACTIVE' && activeRegisterSessions > 0).toBe(false);

      const store = await createStore(f.prisma, f.actor, { name: 'Race Store' });
      const employee = await createEmployee(f.prisma, f.actor, { firstName: 'Race', lastName: 'Manager', roleNames: ['MANAGER'], storeIds: [store.id] });
      const register2 = await createRegister(f.prisma, f.actor, { storeId: store.id, name: 'Race Register', code: `RACE-${store.id.slice(0, 6)}` });
      const storeRace = await Promise.allSettled([
        openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: store.id, registerId: register2.id, employeeId: employee.id, openingCashMinor: 0n }),
        updateStore(f.prisma, f.actor, store.id, { status: 'INACTIVE' }),
      ]);
      expect(storeRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const persistedStore = await f.prisma.store.findUniqueOrThrow({ where: { id: store.id } });
      const activeStoreSessions = await f.prisma.registerSession.count({ where: { organizationId: f.organizationId, storeId: store.id, status: { in: ['OPEN', 'CLOSING'] } } });
      expect(persistedStore.status === 'INACTIVE' && activeStoreSessions > 0).toBe(false);
    } finally { await f.prisma.$disconnect(); }
  });

  it('filters order/refund administration, returns detail, and enforces tenant isolation', async () => {
    const f = await fixture(); const provider = new SimulatedTerminalProvider();
    try {
      const c = await catalog(f); const start = new Date(Date.now() - 1000);
      await schedulePrice(f.prisma, f.actor, { variantId: c.variant.id, storeId: f.storeId, amountMinor: '1000', effectiveFrom: start });
      await postOpeningBalance(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: c.variant.id, quantity: 3, reason: 'Opening' });
      const session = await openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId, employeeId: f.employeeId, openingCashMinor: 0n });
      const sale = await checkoutCash(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId, registerSessionId: session.id,
        employeeId: f.employeeId, idempotencyKey: randomUUID(), lines: [{ variantId: c.variant.id, quantity: 1 }], ageVerified: true, tenderedMinor: 2000n });
      const detail = await getOrderAdmin(f.prisma, f.actor, sale.orderId);
      const item = detail.items[0]!;
      await refundOrder(f.prisma, provider, { organizationId: f.organizationId, orderId: sale.orderId, employeeId: f.employeeId, reason: 'Returned', idempotencyKey: randomUUID(), items: [{ orderItemId: item.id, quantity: 1 }] });
      expect((await listOrdersAdmin(f.prisma, f.actor, { paymentKind: 'CASH', search: sale.orderNumber })).items).toHaveLength(1);
      expect((await listRefunds(f.prisma, f.actor, { search: sale.orderNumber, status: 'SUCCEEDED' })).items).toHaveLength(1);
      await expect(getOrderAdmin(f.prisma, { ...f.actor, organizationId: randomUUID() }, sale.orderId)).rejects.toThrow('ORDER_NOT_FOUND');
    } finally { await f.prisma.$disconnect(); }
  });

  it('records tenant-scoped immutable audit history for administrative mutations', async () => {
    const f = await fixture();
    try {
      const c = await catalog(f); await updateProduct(f.prisma, f.actor, c.product.id, { brand: 'Updated' });
      const records = await listAuditRecords(f.prisma, f.actor, { entityType: 'Product' });
      expect(records.items.map(({ action }) => action)).toEqual(expect.arrayContaining(['PRODUCT_CREATED', 'PRODUCT_UPDATED']));
      await expect(f.prisma.auditRecord.update({ where: { id: records.items[0]!.id }, data: { action: 'TAMPERED' } })).rejects.toThrow();
      expect((await listAuditRecords(f.prisma, { ...f.actor, organizationId: randomUUID() }, {})).total).toBe(0);
    } finally { await f.prisma.$disconnect(); }
  });

  it('derives dashboard cards from authoritative orders, refunds, sessions, and inventory', async () => {
    const f = await fixture();
    try {
      const c = await catalog(f); await postOpeningBalance(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: c.variant.id, quantity: 1, reason: 'Low stock' });
      await openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId, employeeId: f.employeeId, openingCashMinor: 0n });
      expect(await getDashboard(f.prisma, f.actor, f.storeId)).toMatchObject({ salesMinor: '0', transactions: 0, refundMinor: '0', openRegisters: 1, lowStockProducts: 1 });
    } finally { await f.prisma.$disconnect(); }
  });

  it('completes the owner catalog-to-register-to-order-and-audit flow without seed or SQL changes', async () => {
    const f = await fixture();
    try {
      const c = await catalog(f, 'E2EFLOW');
      await schedulePrice(f.prisma, f.actor, { variantId: c.variant.id, storeId: f.storeId, amountMinor: '1599', effectiveFrom: new Date(Date.now() - 1000) });
      await postOpeningBalance(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: c.variant.id, quantity: 8, reason: 'Opening count' });
      expect((await lookupCatalog(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, barcode: c.barcode }))[0]).toMatchObject({ variantId: c.variant.id, priceMinor: '1599' });
      const session = await openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId, employeeId: f.employeeId, openingCashMinor: 0n });
      const sale = await checkoutCash(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId, registerSessionId: session.id,
        employeeId: f.employeeId, idempotencyKey: randomUUID(), lines: [{ variantId: c.variant.id, quantity: 1 }], ageVerified: true, tenderedMinor: 2000n });
      expect((await listInventoryAdmin(f.prisma, f.actor, { storeId: f.storeId })).items[0]?.onHand).toBe(7);
      expect((await listOrdersAdmin(f.prisma, f.actor, { search: sale.orderNumber })).items).toHaveLength(1);
      expect((await listAuditRecords(f.prisma, f.actor, {})).items.map(({ action }) => action)).toEqual(expect.arrayContaining(['PRODUCT_CREATED', 'PRODUCT_PRICE_SCHEDULED', 'INVENTORY_OPENING_BALANCE', 'SALE_COMPLETED']));
    } finally { await f.prisma.$disconnect(); }
  });
});
