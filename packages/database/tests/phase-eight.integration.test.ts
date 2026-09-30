import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import { describe, expect, it } from 'vitest';
import {
  checkoutCash, checkoutTerminal, closeRegisterSession, createPurchasedProduct, finalizeDayClose, getShiftReport, listCashMovements, lookupUpcForCreation, openRegisterSession, postOpeningBalance,
  previewDayClose, recordCashMovement, refundOrder, todayInTimeZone, zonedMidnightUtc,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const upc = () => String(Math.floor(1e11 + Math.random() * 9e11));

async function fixture(prisma: PrismaClient) {
  const organizationId = randomUUID(); const storeId = randomUUID(); const registerId = randomUUID(); const employeeId = randomUUID(); const categoryId = randomUUID();
  await prisma.organization.create({ data: { id: organizationId, name: 'Phase 8' } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Phase 8 Store', taxRateBasisPoints: 0 } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Phase', lastName: 'Eight' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Front', code: `P8-${organizationId.slice(0, 6)}` } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'General' } });
  const scope = { organizationId, storeId, registerId, employeeId };
  const cashActor = { organizationId, storeId, registerId, userId: employeeId };
  const admin = { organizationId, userId: employeeId, storeId };
  const variant = async (name: string, priceMinor: bigint, tracked = false) => {
    const product = await prisma.product.create({ data: { organizationId, categoryId, name, inventoryTracked: tracked } });
    const created = await prisma.productVariant.create({ data: { organizationId, productId: product.id, name: 'Each', sku: `S-${randomUUID().slice(0, 8)}` } });
    await prisma.price.create({ data: { organizationId, storeId, variantId: created.id, amountMinor: priceMinor, effectiveFrom: new Date('2026-01-01') } });
    return created;
  };
  return { ...scope, categoryId, scope, cashActor, admin, variant };
}
const cashSale = (scope: Record<string, string>, sessionId: string, lines: Array<{ variantId: string; quantity: number; discount?: { kind: 'FIXED'; amountMinor: bigint } }>, tendered: bigint) =>
  ({ ...scope, registerSessionId: sessionId, idempotencyKey: randomUUID(), lines, tenderedMinor: tendered }) as never;

describe.sequential('Return disposition', () => {
  it('returns to stock only when chosen and records explicit ledger movements for damaged, non-resellable, and vendor returns', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const item = await f.variant('Bottle', 1_000n, true);
      await postOpeningBalance(prisma, { ...f.scope, variantId: item.id, quantity: 10, reason: 'Opening' });
      const session = await openRegisterSession(prisma, { ...f.scope, openingCashMinor: 0n });
      const sale = await checkoutCash(prisma, cashSale(f.scope, session.id, [{ variantId: item.id, quantity: 4 }], 4_000n));
      const orderItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: sale.orderId } });
      const level = async () => (await prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: { organizationId: f.organizationId, storeId: f.storeId, variantId: item.id } } })).onHand;
      expect(await level()).toBe(6);
      const refund = (disposition: 'RETURN_TO_STOCK' | 'DAMAGED' | 'NON_RESELLABLE' | 'VENDOR_RETURN') => refundOrder(prisma, new SimulatedTerminalProvider(), { organizationId: f.organizationId, orderId: sale.orderId, employeeId: f.employeeId, reason: `Return ${disposition}`, idempotencyKey: randomUUID(), items: [{ orderItemId: orderItem.id, quantity: 1, disposition }] });
      await refund('RETURN_TO_STOCK'); expect(await level()).toBe(7);
      await refund('DAMAGED'); expect(await level()).toBe(7);
      await refund('NON_RESELLABLE'); expect(await level()).toBe(7);
      await refund('VENDOR_RETURN'); expect(await level()).toBe(7);
      const movements = await prisma.inventoryMovement.findMany({ where: { organizationId: f.organizationId, variantId: item.id }, orderBy: { createdAt: 'asc' } });
      expect(movements.map((movement) => [movement.type, movement.quantityDelta])).toEqual([['INITIAL', 10], ['SALE', -4], ['SALE_RETURN', 1], ['SALE_RETURN', 1], ['DAMAGE', -1], ['SALE_RETURN', 1], ['RETURN_NON_RESELLABLE', -1], ['SALE_RETURN', 1], ['VENDOR_RETURN', -1]]);
      expect(movements.reduce((sum, movement) => sum + movement.quantityDelta, 0)).toBe(await level());
      expect((await prisma.refundItem.findMany({ where: { organizationId: f.organizationId }, orderBy: { id: 'asc' } })).map((row) => row.disposition).sort()).toEqual(['DAMAGED', 'NON_RESELLABLE', 'RETURN_TO_STOCK', 'VENDOR_RETURN']);
      // The legacy flag still works: returnToStock=false is not resellable.
      const second = await checkoutCash(prisma, cashSale(f.scope, session.id, [{ variantId: item.id, quantity: 1 }], 1_000n));
      const secondItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: second.orderId } });
      await refundOrder(prisma, new SimulatedTerminalProvider(), { organizationId: f.organizationId, orderId: second.orderId, employeeId: f.employeeId, reason: 'Legacy', idempotencyKey: randomUUID(), items: [{ orderItemId: secondItem.id, quantity: 1, returnToStock: false }] });
      expect((await prisma.refundItem.findFirstOrThrow({ where: { orderItemId: secondItem.id } })).disposition).toBe('NON_RESELLABLE');
      expect(await level()).toBe(6);
      await expect(refundOrder(prisma, new SimulatedTerminalProvider(), { organizationId: f.organizationId, orderId: sale.orderId, employeeId: f.employeeId, reason: 'Bad', idempotencyKey: randomUUID(), items: [{ orderItemId: orderItem.id, quantity: 1, disposition: 'EATEN' as never }] })).rejects.toThrow('REFUND_DISPOSITION_INVALID');
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Cash operations and shift report', () => {
  it('builds expected cash from sales, paid in/out, safe drops, and adjustments, with limits, reasons, and an append-only ledger', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const item = await f.variant('Item', 2_000n);
      await expect(recordCashMovement(prisma, f.cashActor, { kind: 'PAID_IN', amountMinor: '500' })).rejects.toThrow('REGISTER_SESSION_NOT_OPEN');
      const session = await openRegisterSession(prisma, { ...f.scope, openingCashMinor: 10_000n });
      await checkoutCash(prisma, cashSale(f.scope, session.id, [{ variantId: item.id, quantity: 1, discount: { kind: 'FIXED', amountMinor: 200n } }], 1_800n));
      await recordCashMovement(prisma, f.cashActor, { kind: 'PAID_IN', amountMinor: '500' });
      await recordCashMovement(prisma, f.cashActor, { kind: 'PAID_OUT', amountMinor: '300', reason: 'Ice delivery' });
      await recordCashMovement(prisma, f.cashActor, { kind: 'SAFE_DROP', amountMinor: '5000' });
      await recordCashMovement(prisma, { ...f.cashActor, approvedByEmployeeId: f.employeeId }, { kind: 'ADJUSTMENT_OUT', amountMinor: '100', reason: 'Counting correction' });
      await recordCashMovement(prisma, f.cashActor, { kind: 'NO_SALE', reason: 'Make change' });
      // expected = 10000 + 1800 + 500 − 300 − 5000 − 100 = 6900
      await expect(recordCashMovement(prisma, f.cashActor, { kind: 'PAID_OUT', amountMinor: '6901', reason: 'Too much' })).rejects.toThrow('INSUFFICIENT_DRAWER_CASH');
      await expect(recordCashMovement(prisma, f.cashActor, { kind: 'PAID_OUT', amountMinor: '100' })).rejects.toThrow('CASH_REASON_REQUIRED');
      await expect(recordCashMovement(prisma, f.cashActor, { kind: 'SAFE_DROP', amountMinor: '-5' })).rejects.toThrow('CASH_AMOUNT_INVALID');
      await expect(recordCashMovement(prisma, f.cashActor, { kind: 'SAFE_DROP', amountMinor: '0' })).rejects.toThrow('CASH_AMOUNT_INVALID');
      const movements = await listCashMovements(prisma, f.cashActor, session.id);
      expect(movements.map((movement) => [movement.kind, movement.amountMinor, movement.employeeId === f.employeeId])).toEqual([['PAID_IN', 500n, true], ['PAID_OUT', 300n, true], ['SAFE_DROP', 5_000n, true], ['ADJUSTMENT_OUT', 100n, true], ['NO_SALE', 0n, true]]);
      expect(movements[3]!.approvedByEmployeeId).toBe(f.employeeId);
      expect(await prisma.auditRecord.count({ where: { organizationId: f.organizationId, action: { in: ['CASH_PAID_IN', 'CASH_PAID_OUT', 'CASH_SAFE_DROP', 'CASH_ADJUSTMENT_OUT', 'CASH_NO_SALE'] } } })).toBe(5);
      await expect(prisma.cashMovement.update({ where: { id: movements[0]!.id }, data: { amountMinor: 1n } })).rejects.toThrow(/append-only/);
      await expect(prisma.cashMovement.delete({ where: { id: movements[0]!.id } })).rejects.toThrow(/append-only/);
      const closed = await closeRegisterSession(prisma, { ...f.scope, sessionId: session.id, countedCashMinor: 6_800n });
      expect(closed).toMatchObject({ expectedCashMinor: 6_900n, actualCashMinor: 6_800n, differenceMinor: -100n });
      const summary = await getShiftReport(prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId }, session.id, false);
      expect(summary).toMatchObject({ openingCashMinor: '10000', expectedCashMinor: '6900', countedCashMinor: '6800', differenceMinor: '-100' }); expect(summary.detail).toBeUndefined();
      const detail = (await getShiftReport(prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId }, session.id, true)).detail!;
      expect(detail.cash).toEqual({ openingMinor: '10000', cashSalesMinor: '1800', cashRefundsMinor: '0', paidInMinor: '500', paidOutMinor: '300', safeDropsMinor: '5000', adjustmentsNetMinor: '-100', drawerOpens: 1, expectedMinor: '6900' });
      expect(detail).toMatchObject({ transactionCount: 1, discountsMinor: '200', sales: { cashMinor: '1800' } });
      await expect(recordCashMovement(prisma, f.cashActor, { kind: 'PAID_IN', amountMinor: '100' })).rejects.toThrow('REGISTER_SESSION_NOT_OPEN');
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('End-of-day (Z) report', () => {
  it('totals the store day, warns about open registers, finalizes once, and keeps an immutable snapshot', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const item = await f.variant('Z item', 1_000n);
      const today = todayInTimeZone('America/New_York');
      const session = await openRegisterSession(prisma, { ...f.scope, openingCashMinor: 5_000n });
      const first = await checkoutCash(prisma, cashSale(f.scope, session.id, [{ variantId: item.id, quantity: 2, discount: { kind: 'FIXED', amountMinor: 100n } }], 1_900n));
      await checkoutTerminal(prisma, new SimulatedTerminalProvider('APPROVED'), { ...f.scope, registerSessionId: session.id, idempotencyKey: randomUUID(), lines: [{ variantId: item.id, quantity: 1 }] } as never);
      const orderItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: first.orderId } });
      await refundOrder(prisma, new SimulatedTerminalProvider(), { organizationId: f.organizationId, orderId: first.orderId, employeeId: f.employeeId, reason: 'One back', idempotencyKey: randomUUID(), items: [{ orderItemId: orderItem.id, quantity: 1, disposition: 'RETURN_TO_STOCK' }] });
      await recordCashMovement(prisma, f.cashActor, { kind: 'SAFE_DROP', amountMinor: '1000' });
      await recordCashMovement(prisma, f.cashActor, { kind: 'NO_SALE', reason: 'Change' });
      const preview = await previewDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: today });
      expect(preview.finalized).toBeNull();
      expect(preview.totals).toMatchObject({ transactionCount: 2, grossSalesMinor: '3000', discountsMinor: '100', taxMinor: '0', tenders: { cashMinor: '1900', cardMinor: '1000' }, cash: { safeDropsMinor: '1000', drawerOpens: 1 } });
      expect(preview.totals.refundsMinor).toBe('950');
      expect(preview.totals.netSalesMinor).toBe('1950'); // 3000 gross − 100 discounts − 950 refunded
      expect(preview.totals.openRegisters).toHaveLength(1);
      await expect(finalizeDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: today })).rejects.toThrow('OPEN_REGISTERS_REQUIRE_ACKNOWLEDGEMENT');
      await closeRegisterSession(prisma, { ...f.scope, sessionId: session.id, countedCashMinor: 4_950n });
      const afterClose = await previewDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: today });
      expect(afterClose.totals.openRegisters).toHaveLength(0);
      expect(afterClose.totals.registerSessions[0]).toMatchObject({ expectedCashMinor: '4950', countedCashMinor: '4950', differenceMinor: '0' });
      const finalized = await finalizeDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: today });
      expect(finalized.totals.netSalesMinor).toBe('1950');
      await expect(finalizeDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: today })).rejects.toThrow('DAY_ALREADY_CLOSED');
      await expect(finalizeDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: '2999-01-01' })).rejects.toThrow('BUSINESS_DATE_IN_FUTURE');
      await expect(finalizeDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: '2026-02-30' })).rejects.toThrow('BUSINESS_DATE_INVALID');
      await expect(finalizeDayClose(prisma, { ...f.admin, storeId: randomUUID() }, { storeId: f.storeId, businessDate: today })).rejects.toThrow('STORE_ACCESS_DENIED');
      expect(await prisma.dayClose.count({ where: { organizationId: f.organizationId } })).toBe(1);
      const row = await prisma.dayClose.findFirstOrThrow({ where: { organizationId: f.organizationId } });
      await expect(prisma.dayClose.update({ where: { id: row.id }, data: { openRegisterCount: 9 } })).rejects.toThrow(/append-only/);
      await expect(prisma.dayClose.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
      // Once finalized, later activity does not change the stored report.
      await openRegisterSession(prisma, { ...f.scope, openingCashMinor: 0n });
      expect((await previewDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: today })).finalized?.id).toBe(row.id);
      expect((await previewDayClose(prisma, f.admin, { storeId: f.storeId, businessDate: today })).totals.openRegisters).toHaveLength(0);
    } finally { await prisma.$disconnect(); }
  });

  it('computes business-day windows in the store time zone across daylight-saving changes', () => {
    expect(zonedMidnightUtc('2026-03-07', 'America/New_York').toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(zonedMidnightUtc('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedMidnightUtc('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(zonedMidnightUtc('2026-11-01', 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(zonedMidnightUtc('2026-11-02', 'America/New_York').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(zonedMidnightUtc('2026-06-01', 'Asia/Kolkata').toISOString()).toBe('2026-05-31T18:30:00.000Z');
    expect(todayInTimeZone('Pacific/Kiritimati', new Date('2026-09-29T20:00:00Z'))).toBe('2026-09-30');
  });
});

describe.sequential('Product creation: case UPC, MOQ, and reorder settings', () => {
  it('stores the case UPC, honors case-multiple MOQ and reorder settings, and recognizes the case UPC as an existing product', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const vendor = await prisma.vendor.create({ data: { organizationId: f.organizationId, name: 'Case Vendor' } });
      const code = upc(); const caseCode = upc();
      const base = { storeId: f.storeId, product: { name: 'Stout', categoryId: f.categoryId, brand: 'B' }, identity: { upc: code, sizeLabel: '16 oz', sku: 'STOUT-1' },
        sellingUnits: [{ name: 'Single', unitsPerPack: 1, priceMinor: '399' }] };
      const vendorInput = { vendorId: vendor.id, vendorSku: 'V-1', caseCostMinor: '4800', unitsPerCase: 24, caseUpc: caseCode, minimumOrderQuantity: 48, preferred: true };
      await expect(createPurchasedProduct(prisma, f.admin, { ...base, vendor: { ...vendorInput, minimumOrderQuantity: 30 } })).rejects.toThrow('MINIMUM_ORDER_INVALID');
      await expect(createPurchasedProduct(prisma, f.admin, { ...base, vendor: vendorInput, inventory: { openingQuantity: 0, lowStockThreshold: 10, reorderTarget: 5 } })).rejects.toThrow('REORDER_SETTINGS_INVALID');
      const created = await createPurchasedProduct(prisma, f.admin, { ...base, vendor: vendorInput, inventory: { openingQuantity: 0, lowStockThreshold: 12, reorderTarget: 48 } });
      expect(await prisma.vendorProductMapping.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: created.baseVariantId } })).toMatchObject({ caseUpc: caseCode, minimumOrderQuantity: 48, casePackQuantity: 24, preferred: true, vendorCostMinor: 200n });
      expect(await prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: { organizationId: f.organizationId, storeId: f.storeId, variantId: created.baseVariantId } } })).toMatchObject({ onHand: 0, lowStockThreshold: 12, reorderTarget: 48 });
      expect(await prisma.inventoryMovement.count({ where: { organizationId: f.organizationId, variantId: created.baseVariantId } })).toBe(0);
      expect(await lookupUpcForCreation(prisma, f.admin, caseCode)).toMatchObject({ status: 'IN_STORE', variant: { productName: 'Stout' } });
      await expect(createPurchasedProduct(prisma, f.admin, { ...base, identity: { upc: upc(), sizeLabel: '16 oz', sku: 'STOUT-2' }, vendor: { ...vendorInput, caseUpc: caseCode } })).rejects.toThrow('UPC_ALREADY_EXISTS');
      await expect(createPurchasedProduct(prisma, f.admin, { ...base, identity: { upc: upc(), sizeLabel: '16 oz', sku: 'STOUT-3' }, vendor: { ...vendorInput, caseUpc: code } })).rejects.toThrow('UPC_ALREADY_EXISTS');
      const second = await createPurchasedProduct(prisma, f.admin, { ...base, identity: { upc: upc(), sizeLabel: '16 oz', sku: 'STOUT-4' }, vendor: { vendorId: vendor.id, caseCostMinor: '4800', unitsPerCase: 24, preferred: false } });
      expect(await prisma.vendorProductMapping.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: second.baseVariantId } })).toMatchObject({ caseUpc: null, minimumOrderQuantity: 24, preferred: false });
    } finally { await prisma.$disconnect(); }
  });
});
