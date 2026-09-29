import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { writeAudit } from './tax-profiles.js';

const money = (value: string, code: string): bigint => {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new PosError(code);
  return BigInt(value);
};
const requireName = (value: string | undefined): string => {
  const name = value?.trim() ?? '';
  if (!name || name.length > 60) throw new PosError('PRICE_BOOK_NAME_INVALID');
  return name;
};

export const listPriceBooks = (prisma: PrismaClient, actor: AdminActor) =>
  prisma.priceBook.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { specialPrices: true } } } });

export async function createPriceBook(prisma: PrismaClient, actor: AdminActor, input: { name: string; description?: string; sortOrder?: number }) {
  const name = requireName(input.name);
  try {
    return await prisma.$transaction(async (tx) => {
      const book = await tx.priceBook.create({ data: { organizationId: actor.organizationId, name, description: input.description?.trim() || null, sortOrder: input.sortOrder ?? 0 } });
      await writeAudit(tx, actor, { action: 'PRICE_BOOK_CREATED', entityType: 'PriceBook', entityId: book.id, after: { name } });
      return book;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('PRICE_BOOK_NAME_TAKEN', 409);
    throw error;
  }
}

export async function updatePriceBook(prisma: PrismaClient, actor: AdminActor, id: string, input: { name?: string; description?: string | null; active?: boolean; sortOrder?: number }) {
  if (!await prisma.priceBook.findFirst({ where: { id, organizationId: actor.organizationId } })) throw new PosError('PRICE_BOOK_NOT_FOUND', 404);
  try {
    return await prisma.$transaction(async (tx) => {
      const book = await tx.priceBook.update({ where: { id }, data: {
        ...(input.name === undefined ? {} : { name: requireName(input.name) }), ...(input.description === undefined ? {} : { description: input.description?.trim() || null }),
        ...(input.active === undefined ? {} : { active: input.active }), ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }) } });
      await writeAudit(tx, actor, { action: 'PRICE_BOOK_UPDATED', entityType: 'PriceBook', entityId: id, after: { name: book.name, active: book.active } });
      return book;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('PRICE_BOOK_NAME_TAKEN', 409);
    throw error;
  }
}

export const listSpecialPrices = (prisma: PrismaClient, actor: AdminActor, filter: { variantId?: string; productId?: string; storeId?: string }) =>
  prisma.specialPrice.findMany({ where: { organizationId: actor.organizationId, ...(filter.variantId ? { variantId: filter.variantId } : {}),
    ...(filter.productId ? { variant: { productId: filter.productId } } : {}), ...(filter.storeId ? { storeId: filter.storeId } : {}) },
  include: { priceBook: { select: { id: true, name: true, active: true } }, variant: { select: { id: true, name: true, sku: true } } }, orderBy: [{ priceBook: { sortOrder: 'asc' } }, { createdAt: 'desc' }], take: 200 });

const FAR = 8_640_000_000_000_000;
type Tx = Prisma.TransactionClient;

/**
 * Creates or updates a special (channel) price. The standard store price is never touched. Active windows for the same
 * book, store, and variant may not overlap. Sales snapshot the price actually charged, so edits never rewrite history.
 */
export async function saveSpecialPrice(prisma: PrismaClient | Tx, actor: AdminActor, input: {
  id?: string; priceBookId: string; storeId: string; variantId: string; amountMinor: string; active?: boolean; effectiveFrom?: Date | null; effectiveTo?: Date | null;
}) {
  const amountMinor = money(input.amountMinor, 'SPECIAL_PRICE_INVALID');
  const from = input.effectiveFrom ?? null; const to = input.effectiveTo ?? null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && to <= from)) throw new PosError('SPECIAL_PRICE_WINDOW_INVALID');
  const run = async (tx: Tx) => {
    const [book, store, variant] = await Promise.all([
      tx.priceBook.findFirst({ where: { id: input.priceBookId, organizationId: actor.organizationId } }),
      tx.store.findFirst({ where: { id: input.storeId, organizationId: actor.organizationId } }),
      tx.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId } }),
    ]);
    if (!book) throw new PosError('PRICE_BOOK_NOT_FOUND', 404);
    if (!store) throw new PosError('STORE_NOT_FOUND', 404);
    if (!variant) throw new PosError('VARIANT_NOT_FOUND', 404);
    const active = input.active ?? true;
    if (active) {
      const others = await tx.specialPrice.findMany({ where: { organizationId: actor.organizationId, priceBookId: input.priceBookId, storeId: input.storeId, variantId: input.variantId, active: true, ...(input.id ? { id: { not: input.id } } : {}) } });
      const start = from?.getTime() ?? -FAR; const end = to?.getTime() ?? FAR;
      if (others.some((other) => start < (other.effectiveTo?.getTime() ?? FAR) && (other.effectiveFrom?.getTime() ?? -FAR) < end)) throw new PosError('SPECIAL_PRICE_OVERLAP', 409);
    }
    const data = { priceBookId: input.priceBookId, storeId: input.storeId, variantId: input.variantId, amountMinor, active, effectiveFrom: from, effectiveTo: to };
    const saved = input.id
      ? await tx.specialPrice.update({ where: { organizationId_id: { organizationId: actor.organizationId, id: input.id } }, data })
      : await tx.specialPrice.create({ data: { organizationId: actor.organizationId, ...data } });
    await writeAudit(tx, actor, { action: input.id ? 'SPECIAL_PRICE_UPDATED' : 'SPECIAL_PRICE_CREATED', entityType: 'SpecialPrice', entityId: saved.id, storeId: input.storeId,
      after: { priceBook: book.name, variantId: input.variantId, amountMinor: amountMinor.toString(), active } });
    return saved;
  };
  return 'specialPrice' in prisma && '$transaction' in prisma ? (prisma as PrismaClient).$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }) : run(prisma as Tx);
}
