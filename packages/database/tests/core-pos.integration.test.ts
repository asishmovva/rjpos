import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import {
  adjustInventory,
  checkoutCash,
  checkoutTerminal,
  closeRegisterSession,
  getReceipt,
  lookupCatalog,
  openRegisterSession,
  postOpeningBalance,
  refundOrder,
  searchOrders,
  voidOrder,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const suite = describe.sequential;

async function fixture(options: { stock?: number; active?: boolean; price?: bigint | null; ageRestricted?: boolean } = {}) {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const organizationId = randomUUID();
  const storeId = randomUUID();
  const registerId = randomUUID();
  const employeeId = randomUUID();
  const categoryId = randomUUID();
  const productId = randomUUID();
  const variantId = randomUUID();
  const suffix = variantId.slice(0, 8);
  await prisma.organization.create({ data: { id: organizationId, name: `Test Org ${suffix}` } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Store', taxRateBasisPoints: 625 } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Core', lastName: 'Tester' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Register', code: `R-${suffix}` } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'Spirits' } });
  await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'Test Vodka', brand: 'Test Brand',
    active: options.active ?? true, ageRestricted: options.ageRestricted ?? false, inventoryTracked: true, taxCategory: 'STANDARD' } });
  await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: '750 ml', sku: `SKU-${suffix}`, active: options.active ?? true } });
  const barcode = `0${variantId.replaceAll('-', '').slice(0, 11)}`;
  await prisma.barcode.create({ data: { organizationId, variantId, barcodeValue: barcode } });
  if (options.price !== null) await prisma.price.create({ data: { organizationId, storeId, variantId,
    amountMinor: options.price ?? 1000n, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  await prisma.inventoryLevel.create({ data: { organizationId, storeId, variantId, onHand: options.stock ?? 10 } });
  return { prisma, organizationId, storeId, registerId, employeeId, productId, variantId, barcode };
}

async function open(f: Awaited<ReturnType<typeof fixture>>) {
  return openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
    registerId: f.registerId, employeeId: f.employeeId, openingCashMinor: 5000n });
}

function cashInput(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, key = randomUUID(), quantity = 1) {
  return { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId,
    registerSessionId: sessionId, employeeId: f.employeeId, idempotencyKey: key,
    lines: [{ variantId: f.variantId, quantity }], tenderedMinor: 2000n };
}

suite('Phase 1 Core POS with PostgreSQL', () => {
  it('looks up UPC, SKU, name, brand and enforces tenant/inactive states', async () => {
    const f = await fixture();
    try {
      expect((await lookupCatalog(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, barcode: f.barcode }))[0]?.variantId).toBe(f.variantId);
      expect((await lookupCatalog(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, sku: `SKU-${f.variantId.slice(0, 8)}` }))).toHaveLength(1);
      expect((await lookupCatalog(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, search: 'Test Brand' }))).toHaveLength(1);
      expect(await lookupCatalog(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, barcode: 'unknown' })).toEqual([]);
      expect(await lookupCatalog(f.prisma, { organizationId: randomUUID(), storeId: f.storeId, barcode: f.barcode })).toEqual([]);
      await f.prisma.product.update({ where: { id: f.productId }, data: { active: false } });
      expect((await lookupCatalog(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, barcode: f.barcode }))[0]?.active).toBe(false);
    } finally { await f.prisma.$disconnect(); }
  });

  it('posts ledger-backed opening balance and adjustment and prevents negative inventory', async () => {
    const f = await fixture({ stock: 0 });
    try {
      const opened = await postOpeningBalance(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
        variantId: f.variantId, employeeId: f.employeeId, quantity: 5, reason: 'Initial count' });
      expect(opened).toMatchObject({ level: { onHand: 5 }, movement: { type: 'INITIAL', quantityDelta: 5 } });
      const adjusted = await adjustInventory(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
        variantId: f.variantId, employeeId: f.employeeId, quantity: -2, reason: 'Damage' });
      expect(adjusted).toMatchObject({ level: { onHand: 3 }, movement: { type: 'ADJUSTMENT_OUT', quantityDelta: -2 } });
      await expect(adjustInventory(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
        variantId: f.variantId, employeeId: f.employeeId, quantity: -4, reason: 'Invalid' })).rejects.toThrow('INVENTORY_WOULD_BE_NEGATIVE');
      const level = await f.prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: f.variantId } });
      expect(level.onHand).toBe(3);
      expect(await f.prisma.inventoryMovement.count({ where: { organizationId: f.organizationId, variantId: f.variantId } })).toBe(2);
    } finally { await f.prisma.$disconnect(); }
  });

  it('enforces register session transitions and database-level duplicate-open protection', async () => {
    const f = await fixture();
    try {
      const session = await open(f);
      await expect(open(f)).rejects.toThrow();
      const closed = await closeRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
        registerId: f.registerId, sessionId: session.id, employeeId: f.employeeId, countedCashMinor: 5001n });
      expect(closed).toMatchObject({ status: 'CLOSED', expectedCashMinor: 5000n, differenceMinor: 1n });
      await expect(closeRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
        registerId: f.registerId, sessionId: session.id, employeeId: f.employeeId, countedCashMinor: 5001n })).rejects.toThrow('REGISTER_SESSION_NOT_OPEN');
    } finally { await f.prisma.$disconnect(); }
  });

  it('completes one atomic cash sale, freezes totals, returns change, and is idempotent', async () => {
    const f = await fixture();
    try {
      const session = await open(f);
      const input = cashInput(f, session.id, randomUUID(), 1);
      const first = await checkoutCash(f.prisma, input);
      const duplicate = await checkoutCash(f.prisma, input);
      expect(duplicate.orderId).toBe(first.orderId);
      expect(first).toMatchObject({ status: 'COMPLETED', paymentStatus: 'CAPTURED', subtotalMinor: '1000', taxMinor: '63', totalMinor: '1063', changeDueMinor: '937' });
      expect(await f.prisma.order.count({ where: { organizationId: f.organizationId } })).toBe(1);
      expect(await f.prisma.inventoryMovement.count({ where: { organizationId: f.organizationId, type: 'SALE' } })).toBe(1);
      expect(await f.prisma.auditRecord.count({ where: { organizationId: f.organizationId, action: 'SALE_COMPLETED' } })).toBe(1);
      expect(await f.prisma.outboxEvent.count({ where: { organizationId: f.organizationId, eventType: 'SALE_COMPLETED' } })).toBe(1);
    } finally { await f.prisma.$disconnect(); }
  });

  it('rejects insufficient tender, missing price, unavailable inventory, age acknowledgment, and closed sessions', async () => {
    const f = await fixture({ stock: 0, ageRestricted: true });
    try {
      const session = await open(f);
      const base = cashInput(f, session.id);
      await expect(checkoutCash(f.prisma, { ...base, tenderedMinor: 10n })).rejects.toThrow('AGE_VERIFICATION_REQUIRED');
      await expect(checkoutCash(f.prisma, { ...base, idempotencyKey: randomUUID(), ageVerified: true, tenderedMinor: 10n })).rejects.toThrow('INSUFFICIENT_INVENTORY');
      await f.prisma.inventoryLevel.updateMany({ where: { organizationId: f.organizationId }, data: { onHand: 1 } });
      await expect(checkoutCash(f.prisma, { ...base, idempotencyKey: randomUUID(), ageVerified: true, tenderedMinor: 10n })).rejects.toThrow('INSUFFICIENT_TENDER');
      await closeRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
        registerId: f.registerId, sessionId: session.id, employeeId: f.employeeId, countedCashMinor: 5000n });
      await expect(checkoutCash(f.prisma, { ...base, idempotencyKey: randomUUID(), ageVerified: true })).rejects.toThrow('REGISTER_SESSION_NOT_OPEN');
    } finally { await f.prisma.$disconnect(); }

    const noPrice = await fixture({ price: null });
    try {
      const session = await open(noPrice);
      await expect(checkoutCash(noPrice.prisma, cashInput(noPrice, session.id))).rejects.toThrow('PRICE_NOT_FOUND');
    } finally { await noPrice.prisma.$disconnect(); }
  });

  it('preserves UNKNOWN terminal state and never retries automatically', async () => {
    const f = await fixture();
    const provider = new SimulatedTerminalProvider('TIMEOUT');
    try {
      const session = await open(f);
      const result = await checkoutTerminal(f.prisma, provider, cashInput(f, session.id));
      expect(result).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNKNOWN' });
      expect(provider.authorizeCallCount).toBe(1);
      const attempt = await f.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
      expect(attempt.nextReconciliationAt).not.toBeNull();
      expect((await f.prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId } })).reserved).toBe(1);
    } finally { await f.prisma.$disconnect(); }
  });

  it('exposes completed sales through receipt and searchable history', async () => {
    const f = await fixture();
    try {
      const result = await checkoutCash(f.prisma, cashInput(f, (await open(f)).id));
      const receipt = await getReceipt(f.prisma, f.organizationId, result.orderId) as { orderNumber: string; items: unknown[]; payments: unknown[] };
      expect(receipt).toMatchObject({ orderNumber: result.orderNumber });
      expect(receipt.items).toHaveLength(1);
      expect(receipt.payments).toHaveLength(1);
      expect(await searchOrders(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, query: result.orderNumber })).toHaveLength(1);
    } finally { await f.prisma.$disconnect(); }
  });

  it('creates partial/full refund compensation without changing original sale items', async () => {
    const f = await fixture({ stock: 5 });
    const provider = new SimulatedTerminalProvider();
    try {
      const sale = await checkoutCash(f.prisma, { ...cashInput(f, (await open(f)).id, randomUUID(), 2), tenderedMinor: 3000n });
      const order = await f.prisma.order.findUniqueOrThrow({ where: { id: sale.orderId }, include: { items: true } });
      const partialInput = { organizationId: f.organizationId, orderId: sale.orderId, employeeId: f.employeeId,
        reason: 'Customer return', idempotencyKey: randomUUID(), items: [{ orderItemId: order.items[0]!.id, quantity: 1 }] };
      const partial = await refundOrder(f.prisma, provider, partialInput);
      const duplicate = await refundOrder(f.prisma, provider, partialInput);
      expect(duplicate.refundId).toBe(partial.refundId);
      expect((await f.prisma.order.findUniqueOrThrow({ where: { id: sale.orderId } })).status).toBe('PARTIALLY_REFUNDED');
      const full = await refundOrder(f.prisma, provider, { ...partialInput, idempotencyKey: randomUUID() });
      expect(full.status).toBe('SUCCEEDED');
      expect((await f.prisma.order.findUniqueOrThrow({ where: { id: sale.orderId } })).status).toBe('REFUNDED');
      expect((await f.prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0]!.id } })).quantity).toBe(2);
      expect(await f.prisma.inventoryMovement.count({ where: { organizationId: f.organizationId, type: 'SALE_RETURN' } })).toBe(2);
    } finally { await f.prisma.$disconnect(); }
  });

  it('does not mark a terminal refund successful when its provider fails', async () => {
    const f = await fixture();
    const provider = new SimulatedTerminalProvider('APPROVED');
    try {
      const session = await open(f);
      const sale = await checkoutTerminal(f.prisma, provider, cashInput(f, session.id));
      const item = await f.prisma.orderItem.findFirstOrThrow({ where: { orderId: sale.orderId } });
      provider.setOutcome('DECLINED');
      const refund = await refundOrder(f.prisma, provider, { organizationId: f.organizationId, orderId: sale.orderId,
        employeeId: f.employeeId, reason: 'Return', idempotencyKey: randomUUID(), items: [{ orderItemId: item.id, quantity: 1 }] });
      expect(refund.status).toBe('FAILED');
      expect((await f.prisma.order.findUniqueOrThrow({ where: { id: sale.orderId } })).status).toBe('COMPLETED');
    } finally { await f.prisma.$disconnect(); }
  });

  it('voids with idempotent inventory compensation and immutable item history', async () => {
    const f = await fixture();
    try {
      const sale = await checkoutCash(f.prisma, cashInput(f, (await open(f)).id));
      const key = randomUUID();
      expect(await voidOrder(f.prisma, { organizationId: f.organizationId, orderId: sale.orderId,
        employeeId: f.employeeId, reason: 'Mistake', idempotencyKey: key })).toMatchObject({ status: 'VOIDED' });
      await expect(voidOrder(f.prisma, { organizationId: f.organizationId, orderId: sale.orderId,
        employeeId: f.employeeId, reason: 'Different request', idempotencyKey: key })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
      expect(await f.prisma.inventoryMovement.count({ where: { organizationId: f.organizationId, type: 'VOID_REVERSAL' } })).toBe(1);
      expect((await f.prisma.orderItem.findFirstOrThrow({ where: { orderId: sale.orderId } })).quantity).toBe(1);
    } finally { await f.prisma.$disconnect(); }
  });

  it('allows exactly one concurrent final-stock sale', async () => {
    const f = await fixture({ stock: 1 });
    try {
      const session = await open(f);
      const results = await Promise.allSettled([
        checkoutCash(f.prisma, cashInput(f, session.id, randomUUID())),
        checkoutCash(f.prisma, cashInput(f, session.id, randomUUID())),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await f.prisma.order.count({ where: { organizationId: f.organizationId, status: 'COMPLETED' } })).toBe(1);
      expect((await f.prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId } })).onHand).toBe(0);
    } finally { await f.prisma.$disconnect(); }
  });

  it('does not duplicate a sale under a simultaneous idempotency-key race', async () => {
    const f = await fixture();
    try {
      const input = cashInput(f, (await open(f)).id, randomUUID());
      const results = await Promise.allSettled([checkoutCash(f.prisma, input), checkoutCash(f.prisma, input)]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
      expect(await f.prisma.order.count({ where: { organizationId: f.organizationId, status: 'COMPLETED' } })).toBe(1);
    } finally { await f.prisma.$disconnect(); }
  });

  it('serializes register close against checkout without accepting a sale on a closed session', async () => {
    const f = await fixture();
    try {
      const session = await open(f);
      const [sale, close] = await Promise.allSettled([
        checkoutCash(f.prisma, cashInput(f, session.id, randomUUID())),
        closeRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
          registerId: f.registerId, sessionId: session.id, employeeId: f.employeeId, countedCashMinor: 5000n }),
      ]);
      expect([sale.status, close.status]).toContain('fulfilled');
      const storedSession = await f.prisma.registerSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(storedSession.status).toBe('CLOSED');
      if (sale.status === 'fulfilled') expect(storedSession.expectedCashMinor).toBe(6063n);
      else expect(await f.prisma.order.count({ where: { organizationId: f.organizationId, status: 'COMPLETED' } })).toBe(0);
    } finally { await f.prisma.$disconnect(); }
  });

  it('runs the backend-backed open → lookup → sale → receipt → history → refund → close workflow', async () => {
    const f = await fixture({ stock: 8 });
    try {
      const session = await open(f);
      const [product] = await lookupCatalog(f.prisma, { organizationId: f.organizationId,
        storeId: f.storeId, barcode: f.barcode });
      expect(product?.variantId).toBe(f.variantId);
      const sale = await checkoutCash(f.prisma, { ...cashInput(f, session.id, randomUUID(), 2), tenderedMinor: 3000n });
      const receipt = await getReceipt(f.prisma, f.organizationId, sale.orderId) as { items: Array<{ id: string }> };
      expect(await searchOrders(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
        query: sale.orderNumber })).toHaveLength(1);
      await refundOrder(f.prisma, new SimulatedTerminalProvider(), { organizationId: f.organizationId,
        orderId: sale.orderId, employeeId: f.employeeId, reason: 'E2E return', idempotencyKey: randomUUID(),
        items: [{ orderItemId: receipt.items[0]!.id, quantity: 2 }] });
      const level = await f.prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: f.variantId } });
      expect(level.onHand).toBe(8);
      const closed = await closeRegisterSession(f.prisma, { organizationId: f.organizationId,
        storeId: f.storeId, registerId: f.registerId, sessionId: session.id,
        employeeId: f.employeeId, countedCashMinor: 5000n });
      expect(closed).toMatchObject({ status: 'CLOSED', expectedCashMinor: 5000n, differenceMinor: 0n });
    } finally { await f.prisma.$disconnect(); }
  });
}, 30_000);
