import type { Prisma, PrismaClient } from '@prisma/client';
import { PosError } from './pos-errors.js';
import { getChannelReport } from './sales-channels.js';
import type { AdminActor } from './back-office.js';

export const REPORT_KINDS = ['sales', 'products', 'inventory', 'purchasing', 'employees', 'customers', 'gift-cards', 'promotions', 'channels'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportFilters = { from?: string; to?: string; storeId?: string; timezone?: string; page?: number; pageSize?: number };
type JsonRow = Record<string, string | number | boolean | null>;
const MAX_ROWS = 5_000;

const money = (value: bigint | null | undefined) => (value ?? 0n).toString();
const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);

function timezoneOffset(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - date.getTime();
}

function zonedMidnight(value: string, timezone: string, addDays = 0): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PosError('REPORT_DATE_INVALID');
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(year, month - 1, day + addDays));
  try {
    const first = new Date(guess.getTime() - timezoneOffset(guess, timezone));
    return new Date(guess.getTime() - timezoneOffset(first, timezone));
  } catch { throw new PosError('REPORT_TIMEZONE_INVALID'); }
}

export async function normalizeReportFilters(prisma: PrismaClient, actor: AdminActor, input: ReportFilters) {
  if (actor.storeId && input.storeId && actor.storeId !== input.storeId) throw new PosError('REPORT_STORE_FORBIDDEN');
  const requestedStoreId = input.storeId ?? actor.storeId;
  const store = requestedStoreId
    ? await prisma.store.findFirst({ where: { id: requestedStoreId, organizationId: actor.organizationId }, select: { id: true, timezone: true } })
    : undefined;
  if (requestedStoreId && !store) throw new PosError('REPORT_STORE_NOT_FOUND');
  const timezone = input.timezone ?? store?.timezone ?? 'UTC';
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const from = zonedMidnight(input.from ?? today, timezone);
  const to = zonedMidnight(input.to ?? today, timezone, 1);
  if (to <= from) throw new PosError('REPORT_RANGE_INVALID');
  return { from, to, timezone, ...(store ? { storeId: store.id } : {}), page: Math.max(1, input.page ?? 1), pageSize: Math.min(250, Math.max(1, input.pageSize ?? 50)) };
}

function paginate(rows: JsonRow[], page: number, pageSize: number) {
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: rows.length };
}

function addGrouped(map: Map<string, JsonRow>, key: string, label: string, values: Record<string, bigint | number>) {
  const current = map.get(key) ?? { key, label };
  for (const [field, value] of Object.entries(values)) current[field] = typeof value === 'bigint' ? money(BigInt(String(current[field] ?? '0')) + value) : Number(current[field] ?? 0) + value;
  map.set(key, current);
}

async function salesReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const where: Prisma.OrderWhereInput = { organizationId, createdAt: { gte: filters.from, lt: filters.to }, ...(filters.storeId ? { storeId: filters.storeId } : {}) };
  const orders = await prisma.order.findMany({ where, take: MAX_ROWS, orderBy: { createdAt: 'desc' }, include: { store: true, register: true, session: { include: { employee: true } }, payments: true, refunds: { where: { status: 'SUCCEEDED' } } } });
  const completed = orders.filter((order) => ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.status));
  const voided = orders.filter((order) => order.status === 'VOIDED');
  const refundsMinor = sum(completed.flatMap((order) => order.refunds.map((refund) => refund.amountMinor)));
  const totalMinor = sum(completed.map((order) => order.totalMinor));
  const breakdowns: Record<string, JsonRow[]> = {};
  for (const dimension of ['day', 'store', 'register', 'cashier', 'paymentMethod'] as const) {
    const grouped = new Map<string, JsonRow>();
    for (const order of completed) {
      const values = dimension === 'paymentMethod' ? order.payments.filter((payment) => ['CAPTURED', 'REFUNDED'].includes(payment.status)).map((payment) => ({ key: payment.kind, label: payment.kind, amount: payment.capturedMinor })) : [{
        key: dimension === 'day' ? new Intl.DateTimeFormat('en-CA', { timeZone: filters.timezone }).format(order.createdAt) : dimension === 'store' ? order.storeId : dimension === 'register' ? order.registerId : order.session.employeeId,
        label: dimension === 'day' ? new Intl.DateTimeFormat('en-CA', { timeZone: filters.timezone }).format(order.createdAt) : dimension === 'store' ? order.store.name : dimension === 'register' ? order.register.name : `${order.session.employee.firstName} ${order.session.employee.lastName}`,
        amount: order.totalMinor,
      }];
      for (const value of values) addGrouped(grouped, value.key, value.label, { salesMinor: value.amount, transactions: 1 });
    }
    breakdowns[dimension] = [...grouped.values()];
  }
  return { summary: { grossSalesMinor: money(sum(completed.map((order) => order.subtotalMinor))), discountsMinor: money(sum(completed.map((order) => order.discountMinor))), taxMinor: money(sum(completed.map((order) => order.taxMinor))), netSalesMinor: money(totalMinor - refundsMinor), refundsMinor: money(refundsMinor), voidsMinor: money(sum(voided.map((order) => order.totalMinor))), voidCount: voided.length, transactionCount: completed.length, averageTransactionMinor: money(completed.length ? totalMinor / BigInt(completed.length) : 0n) }, breakdowns, truncated: orders.length === MAX_ROWS };
}

async function productReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const items = await prisma.orderItem.findMany({ where: { organizationId, order: { createdAt: { gte: filters.from, lt: filters.to }, status: { in: ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'] }, ...(filters.storeId ? { storeId: filters.storeId } : {}) } }, take: MAX_ROWS, include: { order: true, refundItems: { where: { refund: { status: 'SUCCEEDED' } } }, variant: { include: { product: { include: { category: true } } } } } });
  const grouped = new Map<string, JsonRow>();
  for (const item of items) {
    const refundedQuantity = item.refundItems.reduce((total, refund) => total + refund.quantity, 0);
    const refundedMinor = sum(item.refundItems.map((refund) => refund.amountMinor));
    addGrouped(grouped, item.variantId, `${item.productNameSnapshot} — ${item.variantNameSnapshot}`, { quantitySold: item.quantity, revenueMinor: item.totalMinor, discountsMinor: item.discountMinor, refundedQuantity, refundsMinor: refundedMinor });
    const row = grouped.get(item.variantId)!;
    row.sku = item.skuSnapshot; row.category = item.variant.product.category.name; row.brand = item.variant.product.brand;
  }
  const rows = [...grouped.values()].sort((a, b) => BigInt(String(b.revenueMinor)) > BigInt(String(a.revenueMinor)) ? 1 : -1);
  return { ...paginate(rows, filters.page, filters.pageSize), topSellers: rows.slice(0, 10), bottomSellers: [...rows].reverse().slice(0, 10), truncated: items.length === MAX_ROWS };
}

async function inventoryReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const where = { organizationId, ...(filters.storeId ? { storeId: filters.storeId } : {}) };
  const [levels, movements] = await Promise.all([
    prisma.inventoryLevel.findMany({ where, take: MAX_ROWS, include: { store: true, variant: { include: { product: true, storeCosts: { ...(filters.storeId ? { where: { storeId: filters.storeId } } : {}), orderBy: { createdAt: 'desc' }, take: 1 } } } } }),
    prisma.inventoryMovement.findMany({ where: { ...where, createdAt: { gte: filters.from, lt: filters.to } }, take: MAX_ROWS, orderBy: { createdAt: 'desc' }, include: { store: true, variant: { include: { product: true } } } }),
  ]);
  const rows = levels.map((level) => { const cost = level.variant.storeCosts[0]?.amountMinor ?? level.variant.costMinor ?? 0n; return { store: level.store.name, product: level.variant.product.name, variant: level.variant.name, sku: level.variant.sku, onHand: level.onHand, reserved: level.reserved, available: level.onHand - level.reserved, lowStock: level.onHand - level.reserved <= level.lowStockThreshold, unitCostMinor: money(cost), valuationMinor: money(cost * BigInt(level.onHand)) }; });
  const movementRows = movements.map((movement) => ({ occurredAt: movement.createdAt.toISOString(), store: movement.store.name, product: movement.variant.product.name, variant: movement.variant.name, type: movement.type, quantityDelta: movement.quantityDelta, resultingOnHand: movement.resultingOnHand, referenceType: movement.referenceType, referenceId: movement.referenceId }));
  return { summary: { valuationMinor: money(sum(rows.map((row) => BigInt(row.valuationMinor)))), onHand: rows.reduce((total, row) => total + row.onHand, 0), reserved: rows.reduce((total, row) => total + row.reserved, 0), available: rows.reduce((total, row) => total + row.available, 0), lowStockCount: rows.filter((row) => row.lowStock).length }, levels: paginate(rows, filters.page, filters.pageSize), movements: paginate(movementRows, filters.page, filters.pageSize), movementTotals: Object.fromEntries([...new Set(movementRows.map((row) => row.type))].map((type) => [type, movementRows.filter((row) => row.type === type).reduce((total, row) => total + row.quantityDelta, 0)])) };
}

async function purchasingReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const orders = await prisma.purchaseOrder.findMany({ where: { organizationId, createdAt: { gte: filters.from, lt: filters.to }, ...(filters.storeId ? { storeId: filters.storeId } : {}) }, take: MAX_ROWS, include: { vendor: true, store: true, lines: true, receipts: { include: { lines: true } } }, orderBy: { createdAt: 'desc' } });
  const orderTotal = (order: (typeof orders)[number]) => sum(order.lines.map((line) => line.unitCostMinor * BigInt(line.orderedQuantity)));
  const rows = orders.map((order) => ({ poNumber: order.poNumber, vendor: order.vendor.name, store: order.store.name, status: order.status, orderedQuantity: order.lines.reduce((total, line) => total + line.orderedQuantity, 0), receivedQuantity: order.lines.reduce((total, line) => total + line.receivedQuantity, 0), totalMinor: money(orderTotal(order)), receiptCount: order.receipts.length, createdAt: order.createdAt.toISOString() }));
  const byVendor = new Map<string, JsonRow>();
  for (const order of orders) addGrouped(byVendor, order.vendorId, order.vendor.name, { purchaseTotalMinor: orderTotal(order), purchaseOrders: 1, receivedQuantity: order.lines.reduce((total, line) => total + line.receivedQuantity, 0) });
  return { summary: { purchaseTotalMinor: money(sum(orders.map(orderTotal))), outstandingCount: orders.filter((order) => ['SUBMITTED', 'PARTIALLY_RECEIVED'].includes(order.status)).length, partiallyReceivedCount: orders.filter((order) => order.status === 'PARTIALLY_RECEIVED').length }, orders: paginate(rows, filters.page, filters.pageSize), byVendor: [...byVendor.values()] };
}

async function employeeReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const [sessions, shifts] = await Promise.all([
    prisma.registerSession.findMany({ where: { organizationId, openedAt: { gte: filters.from, lt: filters.to }, ...(filters.storeId ? { storeId: filters.storeId } : {}) }, take: MAX_ROWS, include: { employee: true, register: true, store: true, orders: { include: { refunds: { where: { status: 'SUCCEEDED' } } } } }, orderBy: { openedAt: 'desc' } }),
    prisma.employeeShift.findMany({ where: { organizationId, clockedInAt: { gte: filters.from, lt: filters.to }, ...(filters.storeId ? { storeId: filters.storeId } : {}) }, take: MAX_ROWS, include: { employee: true, store: true, register: true } }),
  ]);
  const rows = sessions.map((session) => ({ cashier: `${session.employee.firstName} ${session.employee.lastName}`, register: session.register.name, store: session.store.name, status: session.status, salesMinor: money(sum(session.orders.filter((order) => order.status !== 'VOIDED').map((order) => order.totalMinor))), refundsMinor: money(sum(session.orders.flatMap((order) => order.refunds.map((refund) => refund.amountMinor)))), voids: session.orders.filter((order) => order.status === 'VOIDED').length, openingCashMinor: money(session.openingCashMinor), expectedCashMinor: money(session.expectedCashMinor), actualCashMinor: money(session.actualCashMinor), differenceMinor: money(session.differenceMinor), openedAt: session.openedAt.toISOString(), closedAt: session.closedAt?.toISOString() ?? null }));
  const shiftRows = shifts.map((shift) => { const start = shift.correctedClockedInAt ?? shift.clockedInAt; const end = shift.correctedClockedOutAt ?? shift.clockedOutAt; return { employee: `${shift.employee.firstName} ${shift.employee.lastName}`, store: shift.store.name, register: shift.register?.name ?? null, clockedInAt: start.toISOString(), clockedOutAt: end?.toISOString() ?? null, workedSeconds: end ? Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000)) : 0 }; });
  return { registerSessions: paginate(rows, filters.page, filters.pageSize), shifts: paginate(shiftRows, filters.page, filters.pageSize) };
}

async function customerReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const [customers, loyalty, balances] = await Promise.all([
    prisma.customer.findMany({ where: { organizationId }, take: MAX_ROWS, include: { orders: { where: { createdAt: { gte: filters.from, lt: filters.to }, ...(filters.storeId ? { storeId: filters.storeId } : {}) } } } }),
    prisma.loyaltyTransaction.findMany({ where: { organizationId, status: 'POSTED', createdAt: { gte: filters.from, lt: filters.to }, ...(filters.storeId ? { order: { storeId: filters.storeId } } : {}) }, take: MAX_ROWS }),
    prisma.loyaltyTransaction.groupBy({ by: ['customerId'], where: { organizationId, status: 'POSTED' }, _sum: { points: true } }),
  ]);
  const balanceMap = new Map(balances.map((balance) => [balance.customerId, balance._sum.points ?? 0]));
  const rows = customers.map((customer) => ({ customer: customer.name, orders: customer.orders.length, purchasesMinor: money(sum(customer.orders.filter((order) => order.status !== 'VOIDED').map((order) => order.totalMinor))), currentPointsBalance: balanceMap.get(customer.id) ?? 0 }));
  const typeTotals = (...types: Array<(typeof loyalty)[number]['type']>) => loyalty.filter((entry) => types.includes(entry.type)).reduce((total, entry) => total + entry.points, 0);
  return { summary: { customers: customers.length, earnedPoints: typeTotals('EARN'), redeemedPoints: typeTotals('REDEEM'), adjustedPoints: typeTotals('ADJUSTMENT_IN', 'ADJUSTMENT_OUT'), outstandingPoints: balances.reduce((total, balance) => total + (balance._sum.points ?? 0), 0) }, customers: paginate(rows, filters.page, filters.pageSize) };
}

async function giftCardReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const [cards, transactions] = await Promise.all([prisma.giftCard.findMany({ where: { organizationId }, take: MAX_ROWS }), prisma.giftCardTransaction.findMany({ where: { organizationId, status: 'POSTED', createdAt: { gte: filters.from, lt: filters.to } }, take: MAX_ROWS })]);
  const total = (type: (typeof transactions)[number]['type']) => sum(transactions.filter((entry) => entry.type === type).map((entry) => entry.amountMinor));
  const liability = sum(await Promise.all(cards.map(async (card) => (await prisma.giftCardTransaction.aggregate({ where: { organizationId, giftCardId: card.id, status: 'POSTED' }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n)));
  return { summary: { cards: cards.length, issuedMinor: money(total('ISSUE')), reloadedMinor: money(total('RELOAD')), redeemedMinor: money(-total('REDEEM')), refundedMinor: money(total('REFUND')), outstandingLiabilityMinor: money(liability) } };
}

/** Sales by order channel (walk-in, DoorDash, phone, ...): revenue, refunds, tax, discounts, and tender mix. */
async function channelsReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const report = await getChannelReport(prisma, { organizationId, userId: 'report', ...(filters.storeId ? { storeId: filters.storeId } : {}) }, { from: filters.from, to: filters.to, ...(filters.storeId ? { storeId: filters.storeId } : {}) });
  const flat = (row: (typeof report.rows)[number]) => ({ channel: row.channel, orders: row.orders, grossMinor: row.grossMinor, discountsMinor: row.discountsMinor, taxMinor: row.taxMinor, revenueMinor: row.revenueMinor, refundsMinor: row.refundsMinor, netMinor: row.netMinor,
    cashMinor: row.tenders.cashMinor, cardMinor: row.tenders.cardMinor, giftCardMinor: row.tenders.giftCardMinor, otherTenderMinor: row.tenders.otherMinor });
  const { channel: _channel, ...totals } = flat(report.totals);
  return { summary: totals, channels: report.rows.map(flat) };
}

async function promotionReport(prisma: PrismaClient, organizationId: string, filters: Awaited<ReturnType<typeof normalizeReportFilters>>) {
  const items = await prisma.orderItem.findMany({ where: { organizationId, promotionId: { not: null }, order: { createdAt: { gte: filters.from, lt: filters.to }, status: { in: ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'] }, ...(filters.storeId ? { storeId: filters.storeId } : {}) } }, take: MAX_ROWS });
  const grouped = new Map<string, JsonRow>();
  for (const item of items) addGrouped(grouped, item.promotionId!, item.promotionNameSnapshot ?? 'Historical promotion', { unitsAffected: item.quantity, ordersAffected: 0, discountMinor: item.discountMinor, revenueMinor: item.totalMinor });
  for (const row of grouped.values()) row.ordersAffected = new Set(items.filter((item) => item.promotionId === row.key).map((item) => item.orderId)).size;
  return { promotions: paginate([...grouped.values()], filters.page, filters.pageSize) };
}

export async function getReport(prisma: PrismaClient, actor: AdminActor, kind: ReportKind, input: ReportFilters = {}) {
  if (!REPORT_KINDS.includes(kind)) throw new PosError('REPORT_KIND_INVALID');
  const filters = await normalizeReportFilters(prisma, actor, input);
  const data = kind === 'sales' ? await salesReport(prisma, actor.organizationId, filters)
    : kind === 'products' ? await productReport(prisma, actor.organizationId, filters)
    : kind === 'inventory' ? await inventoryReport(prisma, actor.organizationId, filters)
    : kind === 'purchasing' ? await purchasingReport(prisma, actor.organizationId, filters)
    : kind === 'employees' ? await employeeReport(prisma, actor.organizationId, filters)
    : kind === 'customers' ? await customerReport(prisma, actor.organizationId, filters)
    : kind === 'gift-cards' ? await giftCardReport(prisma, actor.organizationId, filters)
    : kind === 'channels' ? await channelsReport(prisma, actor.organizationId, filters)
    : await promotionReport(prisma, actor.organizationId, filters);
  return { kind, filters: { from: filters.from.toISOString(), toExclusive: filters.to.toISOString(), timezone: filters.timezone, storeId: filters.storeId ?? null }, data };
}

function flattenRows(report: Awaited<ReturnType<typeof getReport>>): JsonRow[] {
  const data = report.data as Record<string, unknown>;
  for (const value of Object.values(data)) {
    if (value && typeof value === 'object' && 'items' in value && Array.isArray((value as { items: unknown[] }).items)) return (value as { items: JsonRow[] }).items;
    if (Array.isArray(value)) return value as JsonRow[];
  }
  if (data.summary && typeof data.summary === 'object') return [data.summary as JsonRow];
  return [];
}

const csvCell = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""').replace(/^[-=+@]/, "'$&") + '"';
export function reportCsv(report: Awaited<ReturnType<typeof getReport>>): string {
  const rows = flattenRows(report).slice(0, MAX_ROWS);
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const metadata = '# from=' + report.filters.from + ',toExclusive=' + report.filters.toExclusive + ',timezone=' + report.filters.timezone;
  return ['# report=' + report.kind, metadata, headers.map(csvCell).join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\r\n');
}

export async function accountingExport(prisma: PrismaClient, actor: AdminActor, input: ReportFilters = {}) {
  const [sales, inventory, purchasing] = await Promise.all([getReport(prisma, actor, 'sales', input), getReport(prisma, actor, 'inventory', input), getReport(prisma, actor, 'purchasing', input)]);
  return { schemaVersion: '1.0', provider: 'provider-neutral', generatedAt: new Date().toISOString(), filters: sales.filters, sales: sales.data, inventory: (inventory.data as { summary: unknown }).summary, purchasing: (purchasing.data as { summary: unknown }).summary };
}
