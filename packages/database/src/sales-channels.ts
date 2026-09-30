import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { writeAudit } from './tax-profiles.js';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_]{1,31}$/;
const slug = (name: string): string => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);

export const listSalesChannels = (prisma: PrismaClient, organizationId: string) =>
  prisma.salesChannel.findMany({ where: { organizationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { priceBook: { select: { id: true, name: true, active: true } } } });

async function checkPriceBook(prisma: PrismaClient | Prisma.TransactionClient, organizationId: string, priceBookId: string | null | undefined): Promise<void> {
  if (priceBookId && !await prisma.priceBook.findFirst({ where: { id: priceBookId, organizationId } })) throw new PosError('PRICE_BOOK_NOT_FOUND', 404);
}

/** Channels are labels on orders (and optionally a price book). There is no marketplace API integration. */
export async function createSalesChannel(prisma: PrismaClient, actor: AdminActor, input: { name: string; code?: string; priceBookId?: string | null; sortOrder?: number }) {
  const name = input.name?.trim();
  if (!name || name.length > 40) throw new PosError('SALES_CHANNEL_NAME_INVALID');
  const code = (input.code?.trim().toUpperCase() || slug(name));
  if (!CODE_PATTERN.test(code)) throw new PosError('SALES_CHANNEL_CODE_INVALID');
  await checkPriceBook(prisma, actor.organizationId, input.priceBookId);
  try {
    return await prisma.$transaction(async (tx) => {
      const channel = await tx.salesChannel.create({ data: { organizationId: actor.organizationId, name, code, priceBookId: input.priceBookId ?? null, sortOrder: input.sortOrder ?? 10 } });
      await writeAudit(tx, actor, { action: 'SALES_CHANNEL_CREATED', entityType: 'SalesChannel', entityId: channel.id, after: { name, code, priceBookId: input.priceBookId ?? null } });
      return channel;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('SALES_CHANNEL_EXISTS', 409);
    throw error;
  }
}

export async function updateSalesChannel(prisma: PrismaClient, actor: AdminActor, id: string, input: { name?: string; priceBookId?: string | null; active?: boolean; sortOrder?: number }) {
  const current = await prisma.salesChannel.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!current) throw new PosError('SALES_CHANNEL_NOT_FOUND', 404);
  if (input.active === false && current.isDefault) throw new PosError('SALES_CHANNEL_DEFAULT_REQUIRED', 409);
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 40)) throw new PosError('SALES_CHANNEL_NAME_INVALID');
  await checkPriceBook(prisma, actor.organizationId, input.priceBookId);
  try {
    return await prisma.$transaction(async (tx) => {
      const channel = await tx.salesChannel.update({ where: { id }, data: { ...(input.name === undefined ? {} : { name: input.name.trim() }), ...(input.priceBookId === undefined ? {} : { priceBookId: input.priceBookId }),
        ...(input.active === undefined ? {} : { active: input.active }), ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }) } });
      await writeAudit(tx, actor, { action: 'SALES_CHANNEL_UPDATED', entityType: 'SalesChannel', entityId: id, after: { name: channel.name, priceBookId: channel.priceBookId, active: channel.active } });
      return channel;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('SALES_CHANNEL_EXISTS', 409);
    throw error;
  }
}

const SOLD = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const CAPTURED = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

export type ChannelReportRow = {
  channel: string; orders: number; grossMinor: string; discountsMinor: string; taxMinor: string; revenueMinor: string; refundsMinor: string; netMinor: string;
  tenders: { cashMinor: string; cardMinor: string; giftCardMinor: string; otherMinor: string };
};

/** Sales by channel for a period: revenue, refunds, tax, discounts, and tender mix. Grouped by the channel name recorded on each order. */
export async function getChannelReport(prisma: PrismaClient, actor: AdminActor, input: { storeId?: string; from: Date; to: Date }): Promise<{ from: string; to: string; rows: ChannelReportRow[]; totals: ChannelReportRow }> {
  if (Number.isNaN(input.from.getTime()) || Number.isNaN(input.to.getTime()) || input.to <= input.from) throw new PosError('REPORT_RANGE_INVALID');
  const storeId = input.storeId ?? actor.storeId;
  if (actor.storeId && storeId && actor.storeId !== storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
  const storeFilter = storeId ? Prisma.sql`AND o."storeId" = ${storeId}::uuid` : Prisma.empty;
  const base = Prisma.sql`o."organizationId" = ${actor.organizationId}::uuid AND o."createdAt" >= ${input.from} AND o."createdAt" < ${input.to} ${storeFilter}`;
  const [orders, payments, refunds] = await Promise.all([
    prisma.$queryRaw<Array<{ channel: string; orders: bigint; gross: bigint; discounts: bigint; tax: bigint; total: bigint }>>`
      SELECT o."channelNameSnapshot" AS channel, COUNT(*)::bigint AS orders, COALESCE(SUM(o."subtotalMinor"), 0)::bigint AS gross, COALESCE(SUM(o."discountMinor"), 0)::bigint AS discounts, COALESCE(SUM(o."taxMinor"), 0)::bigint AS tax, COALESCE(SUM(o."totalMinor"), 0)::bigint AS total
      FROM "Order" o WHERE ${base} AND o."status"::text = ANY(${SOLD}) GROUP BY 1`,
    prisma.$queryRaw<Array<{ channel: string; kind: string; amount: bigint }>>`
      SELECT o."channelNameSnapshot" AS channel, p."kind"::text AS kind, COALESCE(SUM(p."capturedMinor"), 0)::bigint AS amount
      FROM "Payment" p JOIN "Order" o ON o."id" = p."orderId" AND o."organizationId" = p."organizationId"
      WHERE ${base} AND o."status"::text = ANY(${SOLD}) AND p."status"::text = ANY(${CAPTURED}) GROUP BY 1, 2`,
    prisma.$queryRaw<Array<{ channel: string; amount: bigint }>>`
      SELECT o."channelNameSnapshot" AS channel, COALESCE(SUM(r."amountMinor"), 0)::bigint AS amount
      FROM "Refund" r JOIN "Order" o ON o."id" = r."orderId" AND o."organizationId" = r."organizationId"
      WHERE ${base} AND r."status"::text = 'SUCCEEDED' GROUP BY 1`,
  ]);
  const names = [...new Set([...orders.map((row) => row.channel), ...refunds.map((row) => row.channel)])].sort();
  const tender = (channel: string, kind: string) => payments.find((row) => row.channel === channel && row.kind === kind)?.amount ?? 0n;
  const build = (channel: string): ChannelReportRow => {
    const order = orders.find((row) => row.channel === channel); const refunded = refunds.find((row) => row.channel === channel)?.amount ?? 0n;
    const gross = order?.gross ?? 0n; const discounts = order?.discounts ?? 0n;
    return { channel, orders: Number(order?.orders ?? 0n), grossMinor: gross.toString(), discountsMinor: discounts.toString(), taxMinor: (order?.tax ?? 0n).toString(), revenueMinor: (order?.total ?? 0n).toString(),
      refundsMinor: refunded.toString(), netMinor: (gross - discounts - refunded).toString(),
      tenders: { cashMinor: tender(channel, 'CASH').toString(), cardMinor: tender(channel, 'TERMINAL').toString(), giftCardMinor: tender(channel, 'GIFT_CARD').toString(), otherMinor: tender(channel, 'LOYALTY').toString() } };
  };
  const rows = names.map(build);
  const sum = (pick: (row: ChannelReportRow) => string) => rows.reduce((total, row) => total + BigInt(pick(row)), 0n).toString();
  const totals: ChannelReportRow = { channel: 'All channels', orders: rows.reduce((total, row) => total + row.orders, 0), grossMinor: sum((row) => row.grossMinor), discountsMinor: sum((row) => row.discountsMinor), taxMinor: sum((row) => row.taxMinor),
    revenueMinor: sum((row) => row.revenueMinor), refundsMinor: sum((row) => row.refundsMinor), netMinor: sum((row) => row.netMinor),
    tenders: { cashMinor: sum((row) => row.tenders.cashMinor), cardMinor: sum((row) => row.tenders.cardMinor), giftCardMinor: sum((row) => row.tenders.giftCardMinor), otherMinor: sum((row) => row.tenders.otherMinor) } };
  return { from: input.from.toISOString(), to: input.to.toISOString(), rows, totals };
}
