import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PosError } from './pos-errors.js';
import { quoteCheckout } from './checkout.js';
import { recordAudit } from './audit.js';

export type RegisterActor = { organizationId: string; storeId: string; registerId: string; userId: string };
type HeldCart = { lines: Array<{ variantId: string; quantity: number }>; customerId?: string; ageVerified?: boolean };

function validCart(value: unknown): value is HeldCart {
  if (!value || typeof value !== 'object') return false;
  const cart = value as HeldCart;
  return Array.isArray(cart.lines) && cart.lines.length > 0 && cart.lines.every((line) => typeof line.variantId === 'string' && Number.isInteger(line.quantity) && line.quantity > 0);
}

export async function listQuickKeys(prisma: PrismaClient, actor: RegisterActor) {
  const now = new Date();
  const keys = await prisma.quickKey.findMany({
    where: { organizationId: actor.organizationId, storeId: actor.storeId, enabled: true, OR: [{ registerId: actor.registerId }, { registerId: null }] },
    include: { variant: { include: { product: true, barcodes: { take: 1 }, prices: {
      where: { OR: [{ storeId: actor.storeId }, { storeId: null }], effectiveFrom: { lte: now }, AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }] },
      orderBy: { effectiveFrom: 'desc' },
    } } } },
    orderBy: [{ groupName: 'asc' }, { position: 'asc' }],
  });
  const occupied = new Set(keys.filter((key) => key.registerId).map((key) => key.position));
  return keys.filter((key) => key.registerId || !occupied.has(key.position)).map((key) => ({ id: key.id, label: key.label, groupName: key.groupName, position: key.position, variantId: key.variantId, productName: key.variant.product.name, variantName: key.variant.name, sku: key.variant.sku, barcode: key.variant.barcodes[0]?.barcodeValue ?? null, priceMinor: (key.variant.prices.find((price) => price.storeId === actor.storeId) ?? key.variant.prices.find((price) => price.storeId === null))?.amountMinor.toString() ?? null, ageRestricted: key.variant.product.ageRestricted, active: key.variant.active && key.variant.product.active }));
}

export async function listQuickKeysAdmin(prisma: PrismaClient, actor: RegisterActor) {
  return prisma.quickKey.findMany({ where: { organizationId: actor.organizationId, storeId: actor.storeId, OR: [{ registerId: actor.registerId }, { registerId: null }] }, include: { variant: { include: { product: true } } }, orderBy: [{ groupName: 'asc' }, { position: 'asc' }] });
}

export async function saveQuickKey(prisma: PrismaClient, actor: RegisterActor, input: { id?: string; variantId: string; label: string; groupName?: string; position?: number; enabled?: boolean; registerSpecific?: boolean }) {
  const label = input.label.trim(); const groupName = input.groupName?.trim() || 'Favorites';
  if (!label || label.length > 40) throw new PosError('QUICK_KEY_LABEL_INVALID');
  if (input.position !== undefined && (!Number.isInteger(input.position) || input.position < 0 || input.position > 99)) throw new PosError('QUICK_KEY_POSITION_INVALID');
  const variant = await prisma.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId, active: true, product: { active: true } }, select: { id: true } });
  if (!variant) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
  const current = input.id ? await prisma.quickKey.findFirst({ where: { id: input.id, organizationId: actor.organizationId, storeId: actor.storeId } }) : null;
  if (input.id && !current) throw new PosError('QUICK_KEY_NOT_FOUND', 404);
  const registerId = input.registerSpecific === undefined ? (current ? current.registerId : actor.registerId) : input.registerSpecific ? actor.registerId : null;
  let position = input.position ?? current?.position;
  if (position === undefined) {
    const last = await prisma.quickKey.aggregate({ where: { organizationId: actor.organizationId, storeId: actor.storeId, registerId }, _max: { position: true } });
    position = (last._max.position ?? -1) + 1;
    if (position > 99) throw new PosError('QUICK_KEY_LIMIT_REACHED', 409);
  }
  const data = { variantId: input.variantId, label, groupName, position, enabled: input.enabled ?? current?.enabled ?? true, registerId };
  try {
    const key = current
      ? await prisma.quickKey.update({ where: { organizationId_id: { organizationId: actor.organizationId, id: current.id } }, data })
      : await prisma.quickKey.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId, ...data } });
    await recordAudit(prisma, { organizationId: actor.organizationId, action: current ? 'QUICK_KEY_UPDATED' : 'QUICK_KEY_CREATED', entityType: 'QuickKey', entityId: key.id, afterJson: { label, groupName, position, enabled: data.enabled, employeeId: actor.userId } });
    return key;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') throw new PosError('QUICK_KEY_POSITION_TAKEN', 409);
    throw error;
  }
}

/** Reassigns positions 0..n-1 in the given order (same scope only) inside one transaction. */
export async function reorderQuickKeys(prisma: PrismaClient, actor: RegisterActor, orderedIds: string[]) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0 || orderedIds.length > 100 || new Set(orderedIds).size !== orderedIds.length) throw new PosError('QUICK_KEY_ORDER_INVALID');
  return prisma.$transaction(async (tx) => {
    const keys = await tx.quickKey.findMany({ where: { id: { in: orderedIds }, organizationId: actor.organizationId, storeId: actor.storeId } });
    if (keys.length !== orderedIds.length || new Set(keys.map((key) => key.registerId)).size !== 1) throw new PosError('QUICK_KEY_ORDER_INVALID');
    // Two passes avoid transient collisions on the (store, register, position) unique constraint.
    for (const [index, id] of orderedIds.entries()) await tx.quickKey.update({ where: { organizationId_id: { organizationId: actor.organizationId, id } }, data: { position: 100 + index } });
    for (const [index, id] of orderedIds.entries()) await tx.quickKey.update({ where: { organizationId_id: { organizationId: actor.organizationId, id } }, data: { position: index } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, userId: actor.userId, storeId: actor.storeId, action: 'QUICK_KEYS_REORDERED', entityType: 'QuickKey', entityId: orderedIds[0]!, afterJson: { count: orderedIds.length } } });
    return { reordered: orderedIds.length };
  });
}

export async function holdTransaction(prisma: PrismaClient, actor: RegisterActor, input: { idempotencyKey: string; label?: string; note?: string; cart: HeldCart }) {
  if (!input.idempotencyKey.trim()) throw new PosError('IDEMPOTENCY_KEY_REQUIRED');
  if (!validCart(input.cart)) throw new PosError('HELD_CART_INVALID');
  await quoteCheckout(prisma, { organizationId: actor.organizationId, storeId: actor.storeId, lines: input.cart.lines });
  if (input.cart.customerId && !(await prisma.customer.findFirst({ where: { id: input.cart.customerId, organizationId: actor.organizationId, active: true } }))) throw new PosError('CUSTOMER_NOT_FOUND', 404);
  const requestFingerprint = createHash('sha256').update(JSON.stringify({ label: input.label?.trim() || '', note: input.note?.trim() || '', cart: input.cart })).digest('hex');
  const existing = await prisma.heldTransaction.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey: input.idempotencyKey } } });
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) throw new PosError('IDEMPOTENCY_KEY_REUSED', 409);
    return existing;
  }
  return prisma.$transaction(async (tx) => {
    const held = await tx.heldTransaction.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId, employeeId: actor.userId, ...(input.cart.customerId ? { customerId: input.cart.customerId } : {}), note: input.note?.trim().slice(0, 200) || null, label: input.label?.trim().slice(0, 60) || `Held ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`, cartJson: input.cart as unknown as Prisma.InputJsonValue, idempotencyKey: input.idempotencyKey, requestFingerprint } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, userId: actor.userId, storeId: actor.storeId, registerId: actor.registerId, action: 'TRANSACTION_HELD', entityType: 'HeldTransaction', entityId: held.id, afterJson: { lineCount: input.cart.lines.length } } });
    return held;
  });
}

export const HELD_SALE_TTL_HOURS = Number(process.env.RJPOS_HELD_SALE_TTL_HOURS ?? 24);

/**
 * Stale holds (older than the TTL) are marked EXPIRED so they never resume with old prices or pile up. A hold reserves no
 * stock and takes no payment, so expiring it is always safe. Runs whenever the held list is read and from the cleanup endpoint.
 */
export async function expireStaleHeldTransactions(prisma: PrismaClient, scope: { organizationId: string; storeId: string }, ttlHours = HELD_SALE_TTL_HOURS): Promise<number> {
  const hours = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 24;
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const result = await prisma.heldTransaction.updateMany({ where: { organizationId: scope.organizationId, storeId: scope.storeId, status: 'HELD', heldAt: { lt: cutoff } }, data: { status: 'EXPIRED', expiredAt: new Date() } });
  if (result.count) await recordAudit(prisma, { organizationId: scope.organizationId, action: 'HELD_TRANSACTIONS_EXPIRED', entityType: 'Store', entityId: scope.storeId, afterJson: { count: result.count, ttlHours: hours } });
  return result.count;
}

export async function listHeldTransactions(prisma: PrismaClient, actor: RegisterActor) {
  await expireStaleHeldTransactions(prisma, actor);
  const rows = await prisma.heldTransaction.findMany({ where: { organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId, status: 'HELD' }, include: { employee: { select: { firstName: true, lastName: true } }, customer: { select: { name: true } }, register: { select: { name: true } } }, orderBy: { heldAt: 'desc' }, take: 100 });
  return rows.map((row) => ({ ...row, ageVerified: Boolean((row.cartJson as { ageVerified?: boolean } | null)?.ageVerified), lineCount: ((row.cartJson as { lines?: unknown[] } | null)?.lines ?? []).length }));
}

export async function resumeHeldTransaction(prisma: PrismaClient, actor: RegisterActor, heldId: string) {
  const candidate = await prisma.heldTransaction.findFirst({ where: { id: heldId, organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId } });
  if (!candidate) throw new PosError('HELD_TRANSACTION_NOT_FOUND', 404);
  if (!validCart(candidate.cartJson)) throw new PosError('HELD_CART_INVALID');
  if (candidate.status === 'CANCELLED') throw new PosError('HELD_TRANSACTION_CANCELLED', 409);
  if (candidate.status === 'EXPIRED' || (candidate.status === 'HELD' && candidate.heldAt.getTime() < Date.now() - HELD_SALE_TTL_HOURS * 3_600_000)) throw new PosError('HELD_TRANSACTION_EXPIRED', 409);
  const quote = await quoteCheckout(prisma, { organizationId: actor.organizationId, storeId: actor.storeId, lines: candidate.cartJson.lines });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "HeldTransaction" WHERE id = ${heldId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
    const held = await tx.heldTransaction.findFirst({ where: { id: heldId, organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId } });
    if (!held) throw new PosError('HELD_TRANSACTION_NOT_FOUND', 404);
    if (!validCart(held.cartJson)) throw new PosError('HELD_CART_INVALID');
    if (held.status === 'CANCELLED') throw new PosError('HELD_TRANSACTION_CANCELLED', 409);
    if (held.status === 'EXPIRED') throw new PosError('HELD_TRANSACTION_EXPIRED', 409);
    if (held.status === 'HELD') {
      await tx.heldTransaction.update({ where: { id: held.id }, data: { status: 'RESUMED', resumedAt: new Date(), resumedByEmployeeId: actor.userId } });
      await tx.auditRecord.create({ data: { organizationId: actor.organizationId, userId: actor.userId, storeId: actor.storeId, registerId: actor.registerId, action: 'TRANSACTION_RESUMED', entityType: 'HeldTransaction', entityId: held.id } });
    }
    return { id: held.id, cart: held.cartJson, quote, pricingRevalidated: true };
  });
}

export async function cancelHeldTransaction(prisma: PrismaClient, actor: RegisterActor, heldId: string) {
  const result = await prisma.heldTransaction.updateMany({ where: { id: heldId, organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId, status: 'HELD' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  if (!result.count) throw new PosError('HELD_TRANSACTION_NOT_FOUND', 404);
  await recordAudit(prisma, { organizationId: actor.organizationId, action: 'HELD_TRANSACTION_CANCELLED', entityType: 'HeldTransaction', entityId: heldId });
  return { id: heldId, status: 'CANCELLED' as const };
}
