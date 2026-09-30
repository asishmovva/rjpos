import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';

const SOLD = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
const CAPTURED = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function tzOffsetMs(timestamp: number, timeZone: string): number {
  const whole = timestamp - (timestamp % 1000);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(whole));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second')) - whole;
}
/** UTC instant of local midnight for a calendar date in a time zone (two passes settle daylight-saving shifts). */
export function zonedMidnightUtc(businessDate: string, timeZone: string): Date {
  const [year, month, day] = businessDate.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day);
  let instant = guess - tzOffsetMs(guess, timeZone);
  instant = guess - tzOffsetMs(instant, timeZone);
  return new Date(instant);
}
const addDays = (businessDate: string, days: number): string => new Date(Date.parse(`${businessDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const todayInTimeZone = (timeZone: string, now = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

function requireDate(value: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new PosError('BUSINESS_DATE_INVALID');
  return value;
}

async function requireStore(prisma: PrismaClient | Prisma.TransactionClient, actor: AdminActor, storeId: string) {
  if (actor.storeId && actor.storeId !== storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
  const store = await prisma.store.findFirst({ where: { id: storeId, organizationId: actor.organizationId } });
  if (!store) throw new PosError('STORE_NOT_FOUND', 404);
  return store;
}

async function computeDayTotals(tx: Prisma.TransactionClient, input: { organizationId: string; storeId: string; storeName: string; businessDate: string; timeZone: string }) {
  const start = zonedMidnightUtc(input.businessDate, input.timeZone); const end = zonedMidnightUtc(addDays(input.businessDate, 1), input.timeZone);
  const org = input.organizationId; const window = { gte: start, lt: end };
  const orderScope = { organizationId: org, storeId: input.storeId, createdAt: window };
  const [sold, voids, payments, refunds, cashRefunds, movements, sessions, openSessions] = await Promise.all([
    tx.order.aggregate({ where: { ...orderScope, status: { in: [...SOLD] } }, _sum: { subtotalMinor: true, discountMinor: true, taxMinor: true, totalMinor: true }, _count: true }),
    tx.order.aggregate({ where: { ...orderScope, status: 'VOIDED' }, _sum: { totalMinor: true }, _count: true }),
    tx.payment.groupBy({ by: ['kind'], where: { organizationId: org, status: { in: [...CAPTURED] }, order: { ...orderScope, status: { in: [...SOLD] } } }, _sum: { capturedMinor: true } }),
    tx.refund.aggregate({ where: { organizationId: org, status: 'SUCCEEDED', createdAt: window, order: { storeId: input.storeId } }, _sum: { amountMinor: true }, _count: true }),
    tx.refund.aggregate({ where: { organizationId: org, status: 'SUCCEEDED', createdAt: window, order: { storeId: input.storeId }, payment: { kind: 'CASH' } }, _sum: { amountMinor: true } }),
    tx.cashMovement.groupBy({ by: ['kind'], where: { organizationId: org, storeId: input.storeId, createdAt: window }, _sum: { amountMinor: true }, _count: true }),
    tx.registerSession.findMany({ where: { organizationId: org, storeId: input.storeId, OR: [{ openedAt: window }, { closedAt: window }] }, include: { register: { select: { name: true } } }, orderBy: { openedAt: 'asc' } }),
    tx.registerSession.findMany({ where: { organizationId: org, storeId: input.storeId, status: { in: ['OPEN', 'CLOSING'] } }, include: { register: { select: { name: true } } } }),
  ]);
  const byKind = (kind: string) => payments.find((row) => row.kind === kind)?._sum.capturedMinor ?? 0n;
  const move = (kind: string) => movements.find((row) => row.kind === kind);
  const gross = sold._sum.subtotalMinor ?? 0n; const discounts = sold._sum.discountMinor ?? 0n; const refundTotal = refunds._sum.amountMinor ?? 0n;
  const cashSales = byKind('CASH'); const cashRefundTotal = cashRefunds._sum.amountMinor ?? 0n;
  const closedInWindow = sessions.filter((session) => session.closedAt && session.closedAt >= start && session.closedAt < end);
  const adjustmentsIn = move('ADJUSTMENT_IN')?._sum.amountMinor ?? 0n; const adjustmentsOut = move('ADJUSTMENT_OUT')?._sum.amountMinor ?? 0n;
  return {
    storeName: input.storeName, businessDate: input.businessDate, timezone: input.timeZone, windowStart: start.toISOString(), windowEnd: end.toISOString(), generatedAt: new Date().toISOString(),
    transactionCount: sold._count,
    // Net sales = gross (item subtotals) − discounts − refunds as paid out (refunds include the tax that was refunded).
    grossSalesMinor: gross.toString(), discountsMinor: discounts.toString(), refundsMinor: refundTotal.toString(), netSalesMinor: (gross - discounts - refundTotal).toString(),
    taxMinor: (sold._sum.taxMinor ?? 0n).toString(), totalCollectedMinor: (sold._sum.totalMinor ?? 0n).toString(), refundCount: refunds._count,
    voids: { count: voids._count, totalMinor: (voids._sum.totalMinor ?? 0n).toString() },
    tenders: { cashMinor: cashSales.toString(), cardMinor: byKind('TERMINAL').toString(), giftCardMinor: byKind('GIFT_CARD').toString(), otherMinor: byKind('LOYALTY').toString() },
    cash: { cashSalesMinor: cashSales.toString(), cashRefundsMinor: cashRefundTotal.toString(), paidInMinor: (move('PAID_IN')?._sum.amountMinor ?? 0n).toString(), paidOutMinor: (move('PAID_OUT')?._sum.amountMinor ?? 0n).toString(),
      safeDropsMinor: (move('SAFE_DROP')?._sum.amountMinor ?? 0n).toString(), adjustmentsNetMinor: (adjustmentsIn - adjustmentsOut).toString(), drawerOpens: move('NO_SALE')?._count ?? 0 },
    registerDifferenceMinor: closedInWindow.reduce((sum, session) => sum + (session.differenceMinor ?? 0n), 0n).toString(),
    registerSessions: sessions.map((session) => ({ registerName: session.register.name, status: session.status, openedAt: session.openedAt.toISOString(), closedAt: session.closedAt?.toISOString() ?? null,
      expectedCashMinor: session.expectedCashMinor?.toString() ?? null, countedCashMinor: session.actualCashMinor?.toString() ?? null, differenceMinor: session.differenceMinor?.toString() ?? null })),
    openRegisters: openSessions.map((session) => ({ registerName: session.register.name, status: session.status, openedAt: session.openedAt.toISOString() })),
  };
}
export type DayTotals = Awaited<ReturnType<typeof computeDayTotals>>;

/** Read-only Z report for a store and business date (in the store's time zone). */
export async function previewDayClose(prisma: PrismaClient, actor: AdminActor, input: { storeId: string; businessDate: string }) {
  const store = await requireStore(prisma, actor, input.storeId);
  const businessDate = requireDate(input.businessDate);
  const existing = await prisma.dayClose.findUnique({ where: { organizationId_storeId_businessDate: { organizationId: actor.organizationId, storeId: store.id, businessDate: new Date(`${businessDate}T00:00:00Z`) } } });
  const totals = existing ? existing.totalsJson as DayTotals : await prisma.$transaction((tx) => computeDayTotals(tx, { organizationId: actor.organizationId, storeId: store.id, storeName: store.name, businessDate, timeZone: store.timezone }));
  return { finalized: existing ? { id: existing.id, closedAt: existing.closedAt, closedByEmployeeId: existing.closedByEmployeeId } : null, totals };
}

/**
 * Finalizes the store's day. One close per store and business date (enforced by a unique index), the snapshot is stored
 * once and protected from updates/deletes by a trigger, and finalizing with registers still open needs explicit acknowledgement.
 */
export async function finalizeDayClose(prisma: PrismaClient, actor: AdminActor, input: { storeId: string; businessDate: string; acknowledgeOpenRegisters?: boolean }) {
  const store = await requireStore(prisma, actor, input.storeId);
  const businessDate = requireDate(input.businessDate);
  if (businessDate > todayInTimeZone(store.timezone)) throw new PosError('BUSINESS_DATE_IN_FUTURE');
  try {
    return await prisma.$transaction(async (tx) => {
      const totals = await computeDayTotals(tx, { organizationId: actor.organizationId, storeId: store.id, storeName: store.name, businessDate, timeZone: store.timezone });
      if (totals.openRegisters.length > 0 && !input.acknowledgeOpenRegisters) throw new PosError('OPEN_REGISTERS_REQUIRE_ACKNOWLEDGEMENT', 409);
      const close = await tx.dayClose.create({ data: { organizationId: actor.organizationId, storeId: store.id, businessDate: new Date(`${businessDate}T00:00:00Z`), timezone: store.timezone,
        closedByEmployeeId: actor.userId, openRegisterCount: totals.openRegisters.length, openRegistersAcknowledged: totals.openRegisters.length > 0, totalsJson: totals as unknown as Prisma.InputJsonValue } });
      await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: store.id, userId: actor.userId, action: 'DAY_CLOSED', entityType: 'DayClose', entityId: close.id,
        afterJson: { businessDate, netSalesMinor: totals.netSalesMinor, openRegisterCount: totals.openRegisters.length } } });
      return { id: close.id, businessDate, closedAt: close.closedAt, totals };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('DAY_ALREADY_CLOSED', 409);
    throw error;
  }
}

export async function listDayCloses(prisma: PrismaClient, actor: AdminActor, storeId: string) {
  const store = await requireStore(prisma, actor, storeId);
  const rows = await prisma.dayClose.findMany({ where: { organizationId: actor.organizationId, storeId: store.id }, orderBy: { businessDate: 'desc' }, take: 60,
    include: { store: { select: { name: true } } } });
  return rows.map((row) => ({ id: row.id, businessDate: row.businessDate.toISOString().slice(0, 10), closedAt: row.closedAt, closedByEmployeeId: row.closedByEmployeeId, openRegisterCount: row.openRegisterCount, totals: row.totalsJson as DayTotals }));
}
