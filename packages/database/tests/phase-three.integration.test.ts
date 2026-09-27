import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import {
  adjustLoyalty,
  checkoutCash,
  checkoutMixed,
  clockIn,
  clockOut,
  configureLoyalty,
  correctShift,
  createCustomer,
  disableGiftCard,
  getCurrentShift,
  getCustomerDetail,
  issueGiftCard,
  listCustomers,
  listShifts,
  lookupGiftCard,
  openRegisterSession,
  refundOrder,
  reloadGiftCard,
  updateCustomer,
  voidOrder,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const suite = describe.sequential;

async function fixture() {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const organizationId = randomUUID(); const storeId = randomUUID(); const registerId = randomUUID(); const employeeId = randomUUID();
  const categoryId = randomUUID(); const productId = randomUUID(); const variantId = randomUUID(); const suffix = organizationId.slice(0, 8);
  await prisma.organization.create({ data: { id: organizationId, name: `Phase 3 ${suffix}` } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Customer Store', taxRateBasisPoints: 0 } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Casey', lastName: 'Cashier' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Register', code: `R-${suffix}` } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: `Category ${suffix}` } });
  await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'Loyalty Item', taxCategory: 'EXEMPT' } });
  await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: 'Each', sku: `P3-${suffix}` } });
  await prisma.price.create({ data: { organizationId, storeId, variantId, amountMinor: 1000n, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  await prisma.inventoryLevel.create({ data: { organizationId, storeId, variantId, onHand: 30 } });
  const actor = { organizationId, userId: employeeId, storeId, registerId };
  return { prisma, organizationId, storeId, registerId, employeeId, variantId, actor };
}

async function session(f: Awaited<ReturnType<typeof fixture>>) {
  return openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
    registerId: f.registerId, employeeId: f.employeeId, openingCashMinor: 10000n });
}

function input(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, customerId?: string) {
  return { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId,
    registerSessionId: sessionId, employeeId: f.employeeId, idempotencyKey: randomUUID(),
    lines: [{ variantId: f.variantId, quantity: 1 }], ...(customerId ? { customerId } : {}) };
}

suite('Phase 3 workforce, customers, loyalty, and gift cards with PostgreSQL', () => {
  it('enforces one active shift, concurrent clock-in, clock-out, corrections, inactive state, and tenant isolation', async () => {
    const f = await fixture();
    try {
      const race = await Promise.allSettled([clockIn(f.prisma, f.actor, {}), clockIn(f.prisma, f.actor, {})]);
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(race.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect((await getCurrentShift(f.prisma, f.actor))?.employeeId).toBe(f.employeeId);
      const ended = await clockOut(f.prisma, f.actor, {});
      await expect(clockOut(f.prisma, f.actor, {})).rejects.toThrow('EMPLOYEE_NOT_CLOCKED_IN');
      const corrected = await correctShift(f.prisma, f.actor, ended.id, { clockedInAt: new Date('2026-09-23T10:00:00Z'),
        clockedOutAt: new Date('2026-09-23T18:30:00Z'), reason: 'Manager corrected missed punch' });
      expect(corrected.correctionReason).toBe('Manager corrected missed punch');
      expect((await listShifts(f.prisma, f.actor, { employeeId: f.employeeId })).items[0]?.workedSeconds).toBe(30600);
      expect((await listShifts(f.prisma, { ...f.actor, organizationId: randomUUID() }, {})).total).toBe(0);
      await f.prisma.employee.update({ where: { id: f.employeeId }, data: { status: 'INACTIVE' } });
      await expect(clockIn(f.prisma, f.actor, {})).rejects.toThrow('EMPLOYEE_INACTIVE');
      expect(await f.prisma.auditRecord.count({ where: { organizationId: f.organizationId, action: 'SHIFT_CORRECTED' } })).toBe(1);
    } finally { await f.prisma.$disconnect(); }
  });

  it('creates, edits, searches, deactivates, isolates, and preserves customer purchase detail', async () => {
    const f = await fixture();
    try {
      const customer = await createCustomer(f.prisma, f.actor, { name: 'Jamie Customer', email: ' Jamie@Example.com ', phone: '(555) 123-4567', notes: 'Prefers email' });
      await expect(createCustomer(f.prisma, f.actor, { name: 'Duplicate', email: 'jamie@example.com' })).rejects.toThrow('CUSTOMER_CONTACT_CONFLICT');
      expect((await listCustomers(f.prisma, f.actor, { search: 'jamie' })).items).toHaveLength(1);
      await updateCustomer(f.prisma, f.actor, customer.id, { name: 'Jamie Updated', phone: null });
      const registerSession = await session(f);
      const sale = await checkoutCash(f.prisma, { ...input(f, registerSession.id, customer.id), tenderedMinor: 1000n });
      const detail = await getCustomerDetail(f.prisma, f.actor, customer.id);
      expect(detail.orders[0]).toMatchObject({ id: sale.orderId, customerId: customer.id });
      expect(detail.orders[0]?.items[0]?.productNameSnapshot).toBe('Loyalty Item');
      await updateCustomer(f.prisma, f.actor, customer.id, { active: false });
      await expect(checkoutCash(f.prisma, { ...input(f, registerSession.id, customer.id), tenderedMinor: 1000n })).rejects.toThrow('CUSTOMER_INACTIVE');
      await expect(getCustomerDetail(f.prisma, { ...f.actor, organizationId: randomUUID() }, customer.id)).rejects.toThrow('CUSTOMER_NOT_FOUND');
    } finally { await f.prisma.$disconnect(); }
  });

  it('earns and redeems configurable loyalty points and reverses them idempotently on refund and void', async () => {
    const f = await fixture(); const provider = new SimulatedTerminalProvider();
    try {
      const customer = await createCustomer(f.prisma, f.actor, { name: 'Loyal Customer' });
      await configureLoyalty(f.prisma, f.actor, { enabled: true, pointsEarned: 1, spendMinor: 100n, redeemMinorPerPoint: 10n });
      const registerSession = await session(f);
      const first = await checkoutCash(f.prisma, { ...input(f, registerSession.id, customer.id), tenderedMinor: 1000n });
      expect((await getCustomerDetail(f.prisma, f.actor, customer.id)).pointsBalance).toBe(10);
      const receiptOrder = await f.prisma.order.findUniqueOrThrow({ where: { id: first.orderId }, include: { items: true } });
      const refunded = await refundOrder(f.prisma, provider, { organizationId: f.organizationId, orderId: first.orderId,
        employeeId: f.employeeId, reason: 'Return', idempotencyKey: randomUUID(), items: [{ orderItemId: receiptOrder.items[0]!.id, quantity: 1 }] });
      expect(refunded.status).toBe('SUCCEEDED');
      expect((await getCustomerDetail(f.prisma, f.actor, customer.id)).pointsBalance).toBe(0);
      await adjustLoyalty(f.prisma, f.actor, customer.id, { points: 30, reason: 'Service recovery' });
      await expect(checkoutMixed(f.prisma, provider, input(f, registerSession.id, customer.id),
        { loyaltyPoints: 101, remainder: { kind: 'CASH', tenderedMinor: 0n } })).rejects.toThrow('LOYALTY_POINTS_INSUFFICIENT');
      const secondInput = input(f, registerSession.id, customer.id);
      const second = await checkoutMixed(f.prisma, provider, secondInput, { loyaltyPoints: 20, remainder: { kind: 'CASH', tenderedMinor: 800n } });
      expect(second.status).toBe('COMPLETED');
      const duplicate = await checkoutMixed(f.prisma, provider, secondInput, { loyaltyPoints: 20, remainder: { kind: 'CASH', tenderedMinor: 800n } });
      expect(duplicate.orderId).toBe(second.orderId);
      await voidOrder(f.prisma, { organizationId: f.organizationId, orderId: second.orderId, employeeId: f.employeeId,
        reason: 'Cancelled sale', idempotencyKey: randomUUID() }, provider);
      expect((await getCustomerDetail(f.prisma, f.actor, customer.id)).pointsBalance).toBe(30);
    } finally { await f.prisma.$disconnect(); }
  });

  it('issues, reloads, looks up, partially redeems, disables, and tenant-isolates secure gift cards', async () => {
    const f = await fixture(); const provider = new SimulatedTerminalProvider();
    try {
      const issued = await issueGiftCard(f.prisma, f.actor, { amountMinor: 1000n });
      expect(issued.code).toMatch(/^RJ-[A-F0-9]{32}$/);
      expect((await lookupGiftCard(f.prisma, f.organizationId, issued.code)).balanceMinor).toBe('1000');
      await reloadGiftCard(f.prisma, f.actor, issued.code, { amountMinor: 500n, reason: 'Customer reload' });
      const registerSession = await session(f);
      const saleInput = input(f, registerSession.id);
      const sale = await checkoutMixed(f.prisma, provider, saleInput, { giftCards: [{ code: issued.code, amountMinor: 400n }],
        remainder: { kind: 'CASH', tenderedMinor: 600n } });
      expect((await checkoutMixed(f.prisma, provider, saleInput, { giftCards: [{ code: issued.code, amountMinor: 400n }],
        remainder: { kind: 'CASH', tenderedMinor: 600n } })).orderId).toBe(sale.orderId);
      expect(sale.payments?.map((payment) => payment.kind).sort()).toEqual(['CASH', 'GIFT_CARD']);
      expect((await lookupGiftCard(f.prisma, f.organizationId, issued.code)).balanceMinor).toBe('1100');
      await expect(checkoutMixed(f.prisma, provider, input(f, registerSession.id), { giftCards: [{ code: issued.code, amountMinor: 1200n }],
        remainder: { kind: 'CASH', tenderedMinor: 0n } })).rejects.toThrow('GIFT_CARD_FUNDS_INSUFFICIENT');
      await expect(lookupGiftCard(f.prisma, randomUUID(), issued.code)).rejects.toThrow('GIFT_CARD_NOT_FOUND');
      await disableGiftCard(f.prisma, f.actor, issued.id, 'Reported lost');
      await expect(checkoutMixed(f.prisma, provider, input(f, registerSession.id), { giftCards: [{ code: issued.code, amountMinor: 100n }],
        remainder: { kind: 'CASH', tenderedMinor: 900n } })).rejects.toThrow('GIFT_CARD_DISABLED');
    } finally { await f.prisma.$disconnect(); }
  });

  it('serializes concurrent final-balance redemption and keeps the ledger nonnegative', async () => {
    const f = await fixture(); const provider = new SimulatedTerminalProvider();
    try {
      const issued = await issueGiftCard(f.prisma, f.actor, { amountMinor: 500n });
      const registerSession = await session(f);
      const race = await Promise.allSettled([
        checkoutMixed(f.prisma, provider, input(f, registerSession.id), { giftCards: [{ code: issued.code, amountMinor: 500n }], remainder: { kind: 'CASH', tenderedMinor: 500n } }),
        checkoutMixed(f.prisma, provider, input(f, registerSession.id), { giftCards: [{ code: issued.code, amountMinor: 500n }], remainder: { kind: 'CASH', tenderedMinor: 500n } }),
      ]);
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await lookupGiftCard(f.prisma, f.organizationId, issued.code)).balanceMinor).toBe('0');
    } finally { await f.prisma.$disconnect(); }
  });

  it('serializes concurrent loyalty redemption and permits only one use of the final points', async () => {
    const f = await fixture(); const provider = new SimulatedTerminalProvider();
    try {
      const customer = await createCustomer(f.prisma, f.actor, { name: 'Concurrent Loyalty' });
      await configureLoyalty(f.prisma, f.actor, { enabled: true, pointsEarned: 1, spendMinor: 100000n, redeemMinorPerPoint: 10n });
      await adjustLoyalty(f.prisma, f.actor, customer.id, { points: 10, reason: 'Opening award' });
      const registerSession = await session(f);
      const race = await Promise.allSettled([
        checkoutMixed(f.prisma, provider, input(f, registerSession.id, customer.id), { loyaltyPoints: 10, remainder: { kind: 'CASH', tenderedMinor: 900n } }),
        checkoutMixed(f.prisma, provider, input(f, registerSession.id, customer.id), { loyaltyPoints: 10, remainder: { kind: 'CASH', tenderedMinor: 900n } }),
      ]);
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await getCustomerDetail(f.prisma, f.actor, customer.id)).pointsBalance).toBe(0);
    } finally { await f.prisma.$disconnect(); }
  });

  it('settles final partial-refund rounding exactly across loyalty, gift card, and terminal ledgers', async () => {
    const f = await fixture(); const provider = new SimulatedTerminalProvider();
    try {
      const customer = await createCustomer(f.prisma, f.actor, { name: 'Rounding Customer' });
      await configureLoyalty(f.prisma, f.actor, { enabled: true, pointsEarned: 1, spendMinor: 100n, redeemMinorPerPoint: 10n });
      const issued = await issueGiftCard(f.prisma, f.actor, { amountMinor: 1000n });
      const registerSession = await session(f);
      const saleInput = { ...input(f, registerSession.id, customer.id), lines: [{ variantId: f.variantId, quantity: 3 }] };
      const sale = await checkoutMixed(f.prisma, provider, saleInput, {
        giftCards: [{ code: issued.code, amountMinor: 1000n }], remainder: { kind: 'TERMINAL' },
      });
      const order = await f.prisma.order.findUniqueOrThrow({ where: { id: sale.orderId }, include: { items: true } });
      expect((await getCustomerDetail(f.prisma, f.actor, customer.id)).pointsBalance).toBe(30);
      await refundOrder(f.prisma, provider, { organizationId: f.organizationId, orderId: sale.orderId,
        employeeId: f.employeeId, reason: 'First partial', idempotencyKey: randomUUID(),
        items: [{ orderItemId: order.items[0]!.id, quantity: 1 }] });
      expect((await lookupGiftCard(f.prisma, f.organizationId, issued.code)).balanceMinor).toBe('333');
      expect((await getCustomerDetail(f.prisma, f.actor, customer.id)).pointsBalance).toBe(20);
      await refundOrder(f.prisma, provider, { organizationId: f.organizationId, orderId: sale.orderId,
        employeeId: f.employeeId, reason: 'Final partial', idempotencyKey: randomUUID(),
        items: [{ orderItemId: order.items[0]!.id, quantity: 2 }] });
      expect((await lookupGiftCard(f.prisma, f.organizationId, issued.code)).balanceMinor).toBe('1000');
      expect((await getCustomerDetail(f.prisma, f.actor, customer.id)).pointsBalance).toBe(0);
      const providerRefunds = await f.prisma.refundAttempt.aggregate({ where: { organizationId: f.organizationId,
        status: 'SUCCEEDED', refund: { orderId: sale.orderId } }, _sum: { requestedMinor: true } });
      expect(providerRefunds._sum.requestedMinor).toBe(2000n);
    } finally { await f.prisma.$disconnect(); }
  });

  it('supports gift-card plus simulated-terminal split tender and cancels held value when the terminal declines', async () => {
    const f = await fixture(); const provider = new SimulatedTerminalProvider();
    try {
      const issued = await issueGiftCard(f.prisma, f.actor, { amountMinor: 1000n });
      const registerSession = await session(f);
      provider.setOutcome('APPROVED');
      const approved = await checkoutMixed(f.prisma, provider, input(f, registerSession.id), {
        giftCards: [{ code: issued.code, amountMinor: 200n }], remainder: { kind: 'TERMINAL' },
      });
      expect(approved.status).toBe('COMPLETED');
      expect((await lookupGiftCard(f.prisma, f.organizationId, issued.code)).balanceMinor).toBe('800');
      const approvedOrder = await f.prisma.order.findUniqueOrThrow({ where: { id: approved.orderId }, include: { items: true } });
      await refundOrder(f.prisma, provider, { organizationId: f.organizationId, orderId: approved.orderId,
        employeeId: f.employeeId, reason: 'Split tender return', idempotencyKey: randomUUID(),
        items: [{ orderItemId: approvedOrder.items[0]!.id, quantity: 1 }] });
      expect((await lookupGiftCard(f.prisma, f.organizationId, issued.code)).balanceMinor).toBe('1000');
      provider.setOutcome('DECLINED');
      const declined = await checkoutMixed(f.prisma, provider, input(f, registerSession.id), {
        giftCards: [{ code: issued.code, amountMinor: 300n }], remainder: { kind: 'TERMINAL' },
      });
      expect(declined.status).toBe('VOIDED');
      expect((await lookupGiftCard(f.prisma, f.organizationId, issued.code)).balanceMinor).toBe('1000');
      expect((await f.prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: f.variantId } })).onHand).toBe(30);
    } finally { await f.prisma.$disconnect(); }
  });
});
