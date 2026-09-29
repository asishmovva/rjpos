import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { describe, expect, it } from 'vitest';
import { checkoutCash, closeRegisterSession, getShiftReport, listQuickKeys, openRegisterSession, reorderQuickKeys, saveQuickKey, seedDemoStoreCatalog } from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();

async function fixture(prisma: PrismaClient) {
  const id = () => randomUUID();
  const organizationId = id(); const storeId = id(); const registerId = id(); const employeeId = id(); const categoryId = id();
  await prisma.organization.create({ data: { id: organizationId, name: 'Ops' } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Ops Store', taxRateBasisPoints: 0 } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Ops', lastName: 'Cashier' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Front', code: `OP-${organizationId.slice(0, 6)}` } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'General' } });
  const variants: string[] = [];
  for (const [index, price] of [500n, 1000n, 2000n].entries()) {
    const productId = id(); const variantId = id();
    await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: `Item ${index}`, inventoryTracked: false } });
    await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: 'Each', sku: `OP-${index}-${organizationId.slice(0, 6)}` } });
    await prisma.price.create({ data: { organizationId, storeId, variantId, amountMinor: price, effectiveFrom: new Date('2026-01-01') } });
    variants.push(variantId);
  }
  return { organizationId, storeId, registerId, employeeId, variants, actor: { organizationId, storeId, registerId, userId: employeeId } };
}

describe.sequential('Phase 7 register operations (Quick Add management, shift report, demo seed)', () => {
  it('auto-positions, edits without losing scope, reports position conflicts, and reorders Quick Keys', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const { actor, variants } = await fixture(prisma);
      const first = await saveQuickKey(prisma, actor, { variantId: variants[0]!, label: 'One', registerSpecific: false });
      const second = await saveQuickKey(prisma, actor, { variantId: variants[1]!, label: 'Two', registerSpecific: true });
      const third = await saveQuickKey(prisma, actor, { variantId: variants[2]!, label: 'Three', registerSpecific: true });
      expect([first.position, second.position, third.position]).toEqual([0, 0, 1]);
      const edited = await saveQuickKey(prisma, actor, { id: first.id, variantId: variants[0]!, label: 'One renamed', enabled: false });
      expect(edited).toMatchObject({ registerId: null, enabled: false, label: 'One renamed', position: 0 });
      await expect(saveQuickKey(prisma, actor, { id: third.id, variantId: variants[2]!, label: 'Three', position: 0 })).rejects.toThrow('QUICK_KEY_POSITION_TAKEN');
      await reorderQuickKeys(prisma, actor, [third.id, second.id]);
      const registerKeys = (await listQuickKeys(prisma, actor)).filter((key) => key.id !== first.id);
      expect(registerKeys.map((key) => [key.label, key.position])).toEqual([['Three', 0], ['Two', 1]]);
      await expect(reorderQuickKeys(prisma, actor, [first.id, second.id])).rejects.toThrow('QUICK_KEY_ORDER_INVALID');
      await expect(listQuickKeys(prisma, { ...actor, organizationId: randomUUID() })).resolves.toEqual([]);
    } finally { await prisma.$disconnect(); }
  });

  it('records an optional opening note and gives cashiers a summary while managers get the detailed shift report', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const { actor, variants, organizationId, storeId, registerId, employeeId } = await fixture(prisma);
      const scope = { organizationId, storeId, registerId };
      const session = await openRegisterSession(prisma, { ...scope, employeeId, openingCashMinor: 10_000n, note: 'Morning float' });
      const sale = await checkoutCash(prisma, { ...scope, registerSessionId: session.id, employeeId, idempotencyKey: randomUUID(), lines: [{ variantId: variants[1]!, quantity: 2, discount: { kind: 'FIXED', amountMinor: 300n } }], tenderedMinor: 5000n });
      const secondSale = await checkoutCash(prisma, { ...scope, registerSessionId: session.id, employeeId, idempotencyKey: randomUUID(), lines: [{ variantId: variants[0]!, quantity: 1 }], tenderedMinor: 500n });
      expect(sale.orderId).not.toBe(secondSale.orderId);
      expect(await prisma.auditRecord.findFirst({ where: { organizationId, action: 'REGISTER_OPENED', entityId: session.id } })).toMatchObject({ afterJson: { openingCashMinor: '10000', note: 'Morning float' } });
      await closeRegisterSession(prisma, { ...scope, sessionId: session.id, employeeId, countedCashMinor: 11_990n });
      const summary = await getShiftReport(prisma, scope, session.id, false);
      expect(summary).toMatchObject({ openingCashMinor: '10000', expectedCashMinor: '12200', countedCashMinor: '11990', differenceMinor: '-210', status: 'CLOSED' });
      expect(summary.detail).toBeUndefined();
      const detailed = await getShiftReport(prisma, scope, session.id, true);
      expect(detailed.detail).toMatchObject({ transactionCount: 2, sales: { cashMinor: '2200', cardMinor: '0', giftCardMinor: '0' }, refunds: { count: 0, totalMinor: '0' }, voids: { count: 0 }, discountsMinor: '300', channels: [{ channel: 'IN_STORE', orderCount: 2, totalMinor: '2200' }] });
      await expect(getShiftReport(prisma, { ...scope, organizationId: randomUUID() }, session.id, true)).rejects.toThrow('REGISTER_SESSION_NOT_FOUND');
    } finally { await prisma.$disconnect(); }
  });

  it('seeds a demo store from the master catalog idempotently without inventing stock', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const { organizationId, storeId, employeeId } = await fixture(prisma);
      const upc = () => String(Math.floor(1e11 + Math.random() * 9e11));
      const rows = [[upc(), 'Vodka', '9.99', '4.50', '12'], [upc(), 'Soda', '1.99', '0.80', '0'], [upc(), 'Wine', '12.49', '6.00', '-3']] as const;
      for (const [index, [code, category, price, cost]] of rows.entries()) {
        await prisma.masterProduct.create({ data: { upc: code, name: `DEMO ITEM ${code}`, category, sizeLabel: '750ml', referencePriceMinor: BigInt(Math.round(Number(price) * 100)), referenceCostMinor: BigInt(Math.round(Number(cost) * 100)) } });
        void index;
      }
      const csv = ['ITEMNAME,DEPNAME,MAINUPC,SIZENAME,PACKNAME,CURRENTCOST,PRICEPERUNIT,TOTALQTY', ...rows.map(([code, category, price, cost, quantity]) => `DEMO ITEM ${code},${category},${code},750ml,,${cost},${price},${quantity}`), `DUPLICATE,Vodka,${rows[0][0]},750ml,,1,1,1`].join('\n');
      const first = await seedDemoStoreCatalog(prisma, { organizationId, storeId, employeeId }, csv);
      expect(first).toMatchObject({ productsAdded: 3, pricesInitialized: 3, costsInitialized: 3, openingBalancesCreated: 3, zeroQuantityProducts: 2, duplicateRows: 1, missingFromMasterCatalog: 0 });
      expect(first.quantityTreatedAsZero).toHaveLength(1);
      const second = await seedDemoStoreCatalog(prisma, { organizationId, storeId, employeeId }, csv);
      expect(second).toMatchObject({ productsAdded: 0, alreadyInStore: 3, pricesInitialized: 0, costsInitialized: 0, openingBalancesCreated: 0, openingBalancesAlreadyPosted: 3 });
      const levels = await prisma.inventoryLevel.findMany({ where: { organizationId, storeId }, include: { variant: { include: { barcodes: true } } } });
      expect(Object.fromEntries(levels.map((level) => [level.variant.barcodes[0]!.barcodeValue, level.onHand]))).toEqual({ [rows[0][0]]: 12, [rows[1][0]]: 0, [rows[2][0]]: 0 });
      expect(await prisma.barcode.count({ where: { organizationId, barcodeValue: { in: rows.map((row) => row[0]) } } })).toBe(3);
      expect(await prisma.product.findFirst({ where: { organizationId, name: `DEMO ITEM ${rows[1][0]}` } })).toMatchObject({ ageRestricted: false });
      expect(await prisma.product.findFirst({ where: { organizationId, name: `DEMO ITEM ${rows[0][0]}` } })).toMatchObject({ ageRestricted: true });
    } finally { await prisma.$disconnect(); }
  });
});
