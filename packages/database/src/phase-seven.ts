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

export async function saveQuickKey(prisma: PrismaClient, actor: RegisterActor, input: { id?: string; variantId: string; label: string; groupName?: string; position: number; enabled?: boolean; registerSpecific?: boolean }) {
  const label = input.label.trim(); const groupName = input.groupName?.trim() || 'Favorites';
  if (!label || label.length > 40) throw new PosError('QUICK_KEY_LABEL_INVALID');
  if (!Number.isInteger(input.position) || input.position < 0 || input.position > 99) throw new PosError('QUICK_KEY_POSITION_INVALID');
  const variant = await prisma.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId, active: true, product: { active: true } }, select: { id: true } });
  if (!variant) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
  const data = { variantId: input.variantId, label, groupName, position: input.position, enabled: input.enabled ?? true, registerId: input.registerSpecific === false ? null : actor.registerId };
  const key = input.id
    ? await prisma.quickKey.update({ where: { organizationId_id: { organizationId: actor.organizationId, id: input.id } }, data })
    : await prisma.quickKey.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId, ...data } });
  await recordAudit(prisma, { organizationId: actor.organizationId, action: input.id ? 'QUICK_KEY_UPDATED' : 'QUICK_KEY_CREATED', entityType: 'QuickKey', entityId: key.id, afterJson: { label, groupName, position: input.position, enabled: data.enabled } });
  return key;
}

export async function holdTransaction(prisma: PrismaClient, actor: RegisterActor, input: { idempotencyKey: string; label?: string; cart: HeldCart }) {
  if (!input.idempotencyKey.trim()) throw new PosError('IDEMPOTENCY_KEY_REQUIRED');
  if (!validCart(input.cart)) throw new PosError('HELD_CART_INVALID');
  await quoteCheckout(prisma, { organizationId: actor.organizationId, storeId: actor.storeId, lines: input.cart.lines });
  if (input.cart.customerId && !(await prisma.customer.findFirst({ where: { id: input.cart.customerId, organizationId: actor.organizationId, active: true } }))) throw new PosError('CUSTOMER_NOT_FOUND', 404);
  const requestFingerprint = createHash('sha256').update(JSON.stringify({ label: input.label?.trim() || '', cart: input.cart })).digest('hex');
  const existing = await prisma.heldTransaction.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey: input.idempotencyKey } } });
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) throw new PosError('IDEMPOTENCY_KEY_REUSED', 409);
    return existing;
  }
  return prisma.$transaction(async (tx) => {
    const held = await tx.heldTransaction.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId, employeeId: actor.userId, ...(input.cart.customerId ? { customerId: input.cart.customerId } : {}), label: input.label?.trim() || `Held ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`, cartJson: input.cart as unknown as Prisma.InputJsonValue, idempotencyKey: input.idempotencyKey, requestFingerprint } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, userId: actor.userId, storeId: actor.storeId, registerId: actor.registerId, action: 'TRANSACTION_HELD', entityType: 'HeldTransaction', entityId: held.id, afterJson: { lineCount: input.cart.lines.length } } });
    return held;
  });
}

export async function listHeldTransactions(prisma: PrismaClient, actor: RegisterActor) {
  return prisma.heldTransaction.findMany({ where: { organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId, status: 'HELD' }, include: { employee: { select: { firstName: true, lastName: true } }, customer: { select: { name: true } } }, orderBy: { heldAt: 'desc' }, take: 100 });
}

export async function resumeHeldTransaction(prisma: PrismaClient, actor: RegisterActor, heldId: string) {
  const candidate = await prisma.heldTransaction.findFirst({ where: { id: heldId, organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId } });
  if (!candidate) throw new PosError('HELD_TRANSACTION_NOT_FOUND', 404);
  if (!validCart(candidate.cartJson)) throw new PosError('HELD_CART_INVALID');
  if (candidate.status === 'CANCELLED') throw new PosError('HELD_TRANSACTION_CANCELLED', 409);
  const quote = await quoteCheckout(prisma, { organizationId: actor.organizationId, storeId: actor.storeId, lines: candidate.cartJson.lines });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "HeldTransaction" WHERE id = ${heldId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
    const held = await tx.heldTransaction.findFirst({ where: { id: heldId, organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId } });
    if (!held) throw new PosError('HELD_TRANSACTION_NOT_FOUND', 404);
    if (!validCart(held.cartJson)) throw new PosError('HELD_CART_INVALID');
    if (held.status === 'CANCELLED') throw new PosError('HELD_TRANSACTION_CANCELLED', 409);
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
