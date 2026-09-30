import { Prisma, type PrismaClient, type VendorClaimKind } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { writeAudit } from './tax-profiles.js';

type LineInput = { variantId: string; quantity: number; unitCostMinor?: string; reason?: string };
const money = (value: string | undefined, code: string): bigint | null => {
  if (value === undefined || value === '') return null;
  if (!/^(0|[1-9]\d{0,14})$/.test(value)) throw new PosError(code);
  return BigInt(value);
};
const claimInclude = { vendor: { select: { id: true, name: true } }, lines: { include: { variant: { select: { id: true, name: true, sku: true, product: { select: { name: true } } } } } } } as const;

/**
 * Vendor returns and discrepancy claims (shortage, damage, price difference). A claim starts as a DRAFT with an expected
 * credit. Only RETURN claims move stock, and only when submitted; credits are recorded when the vendor actually issues them.
 */
export async function createVendorClaim(prisma: PrismaClient, actor: AdminActor, input: {
  storeId?: string; vendorId: string; kind: VendorClaimKind; reason: string; purchaseOrderId?: string; invoiceDocumentId?: string; lines: LineInput[];
}) {
  const storeId = input.storeId ?? actor.storeId;
  if (!storeId || (actor.storeId && actor.storeId !== storeId)) throw new PosError('STORE_ACCESS_DENIED', 403);
  if (!['RETURN', 'SHORTAGE', 'DAMAGE', 'PRICE_DIFFERENCE'].includes(input.kind)) throw new PosError('VENDOR_CLAIM_KIND_INVALID');
  const reason = input.reason?.trim(); if (!reason) throw new PosError('VENDOR_CLAIM_REASON_REQUIRED');
  if (!input.lines?.length || input.lines.length > 200) throw new PosError('VENDOR_CLAIM_LINES_REQUIRED');
  if (new Set(input.lines.map((line) => line.variantId)).size !== input.lines.length) throw new PosError('VENDOR_CLAIM_LINE_DUPLICATE');
  const [store, vendor, employee] = await Promise.all([
    prisma.store.findFirst({ where: { id: storeId, organizationId: actor.organizationId } }),
    prisma.vendor.findFirst({ where: { id: input.vendorId, organizationId: actor.organizationId } }),
    prisma.employee.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId, status: 'ACTIVE' } }),
  ]);
  if (!store) throw new PosError('STORE_NOT_FOUND', 404); if (!vendor) throw new PosError('VENDOR_NOT_FOUND', 404); if (!employee) throw new PosError('EMPLOYEE_NOT_FOUND', 403);
  const variants = await prisma.productVariant.findMany({ where: { organizationId: actor.organizationId, id: { in: input.lines.map((line) => line.variantId) } }, include: { product: true, vendorMappings: { where: { vendorId: input.vendorId, active: true }, take: 1 }, storeCosts: { where: { storeId } } } });
  if (variants.length !== input.lines.length) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
  const lines = input.lines.map((line) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new PosError('VENDOR_CLAIM_QUANTITY_INVALID');
    const variant = variants.find((candidate) => candidate.id === line.variantId)!;
    if (input.kind === 'RETURN' && (variant.baseVariantId || !variant.product.inventoryTracked)) throw new PosError('VENDOR_RETURN_VARIANT_INVALID', 409);
    const unitCost = money(line.unitCostMinor, 'VENDOR_CLAIM_COST_INVALID') ?? variant.storeCosts[0]?.amountMinor ?? variant.vendorMappings[0]?.vendorCostMinor ?? variant.costMinor ?? 0n;
    return { variantId: line.variantId, quantity: line.quantity, unitCostMinor: unitCost, reason: line.reason?.trim() || null };
  });
  const expectedCreditMinor = lines.reduce((sum, line) => sum + line.unitCostMinor * BigInt(line.quantity), 0n);
  return prisma.$transaction(async (tx) => {
    const created = await tx.vendorClaim.create({ data: { organizationId: actor.organizationId, storeId, vendorId: input.vendorId, kind: input.kind, reason, expectedCreditMinor,
      purchaseOrderId: input.purchaseOrderId ?? null, invoiceDocumentId: input.invoiceDocumentId ?? null, createdByEmployeeId: actor.userId } });
    await tx.vendorClaimLine.createMany({ data: lines.map((line) => ({ organizationId: actor.organizationId, claimId: created.id, ...line })) });
    const claim = await tx.vendorClaim.findUniqueOrThrow({ where: { id: created.id }, include: claimInclude });
    await writeAudit(tx, actor, { action: 'VENDOR_CLAIM_CREATED', entityType: 'VendorClaim', entityId: claim.id, storeId, after: { kind: input.kind, vendor: vendor.name, expectedCreditMinor: expectedCreditMinor.toString(), lines: lines.length } });
    return claim;
  });
}

export async function submitVendorClaim(prisma: PrismaClient, actor: AdminActor, id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "VendorClaim" WHERE id = ${id}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
    const claim = await tx.vendorClaim.findFirst({ where: { id, organizationId: actor.organizationId }, include: { lines: true } });
    if (!claim) throw new PosError('VENDOR_CLAIM_NOT_FOUND', 404);
    if (actor.storeId && actor.storeId !== claim.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
    if (claim.status !== 'DRAFT') throw new PosError('VENDOR_CLAIM_NOT_DRAFT', 409);
    if (claim.kind === 'RETURN') {
      // Stock leaves inventory through the ledger; it cannot go negative.
      for (const line of [...claim.lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
        await tx.$queryRaw`SELECT id FROM "InventoryLevel" WHERE "organizationId" = ${actor.organizationId}::uuid AND "storeId" = ${claim.storeId}::uuid AND "variantId" = ${line.variantId}::uuid FOR UPDATE`;
        const level = await tx.inventoryLevel.findUnique({ where: { organizationId_storeId_variantId: { organizationId: actor.organizationId, storeId: claim.storeId, variantId: line.variantId } } });
        if (!level || level.onHand - level.reserved < line.quantity) throw new PosError('INSUFFICIENT_INVENTORY', 409);
        const updated = await tx.inventoryLevel.update({ where: { id: level.id }, data: { onHand: { decrement: line.quantity } } });
        await tx.inventoryMovement.create({ data: { organizationId: actor.organizationId, storeId: claim.storeId, variantId: line.variantId, employeeId: actor.userId, quantityDelta: -line.quantity,
          type: 'VENDOR_RETURN', referenceType: 'VENDOR_CLAIM', referenceId: claim.id, reason: `Vendor return: ${claim.reason}`.slice(0, 200), resultingOnHand: updated.onHand } });
      }
    }
    const updated = await tx.vendorClaim.update({ where: { id }, data: { status: 'SUBMITTED', submittedAt: new Date() }, include: claimInclude });
    await writeAudit(tx, actor, { action: 'VENDOR_CLAIM_SUBMITTED', entityType: 'VendorClaim', entityId: id, storeId: claim.storeId, after: { kind: claim.kind, stockRemoved: claim.kind === 'RETURN' } });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Records the credit the vendor actually issued, which may differ from the expected amount. */
export async function recordVendorCredit(prisma: PrismaClient, actor: AdminActor, id: string, input: { creditedMinor: string; creditReference?: string }) {
  const credited = money(input.creditedMinor, 'VENDOR_CREDIT_INVALID');
  if (credited === null) throw new PosError('VENDOR_CREDIT_INVALID');
  return transition(prisma, actor, id, ['SUBMITTED'], { status: 'CREDITED', creditedMinor: credited, creditReference: input.creditReference?.trim().slice(0, 80) || null, resolvedAt: new Date() }, 'VENDOR_CLAIM_CREDITED');
}
export async function rejectVendorClaim(prisma: PrismaClient, actor: AdminActor, id: string, reason: string) {
  if (!reason?.trim()) throw new PosError('VENDOR_CLAIM_REASON_REQUIRED');
  return transition(prisma, actor, id, ['SUBMITTED'], { status: 'REJECTED', resolvedAt: new Date(), creditReference: reason.trim().slice(0, 80) }, 'VENDOR_CLAIM_REJECTED');
}
export async function cancelVendorClaim(prisma: PrismaClient, actor: AdminActor, id: string) {
  return transition(prisma, actor, id, ['DRAFT'], { status: 'CANCELLED', resolvedAt: new Date() }, 'VENDOR_CLAIM_CANCELLED');
}
async function transition(prisma: PrismaClient, actor: AdminActor, id: string, from: string[], data: Prisma.VendorClaimUncheckedUpdateInput, action: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "VendorClaim" WHERE id = ${id}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
    const claim = await tx.vendorClaim.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!claim) throw new PosError('VENDOR_CLAIM_NOT_FOUND', 404);
    if (actor.storeId && actor.storeId !== claim.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
    if (!from.includes(claim.status)) throw new PosError('VENDOR_CLAIM_TRANSITION_INVALID', 409);
    const updated = await tx.vendorClaim.update({ where: { id }, data, include: claimInclude });
    await writeAudit(tx, actor, { action, entityType: 'VendorClaim', entityId: id, storeId: claim.storeId, after: { status: updated.status, expectedCreditMinor: claim.expectedCreditMinor.toString(), creditedMinor: updated.creditedMinor?.toString() ?? null } });
    return updated;
  });
}

export const listVendorClaims = (prisma: PrismaClient, actor: AdminActor, filter: { status?: string; vendorId?: string }) =>
  prisma.vendorClaim.findMany({ where: { organizationId: actor.organizationId, ...(actor.storeId ? { storeId: actor.storeId } : {}), ...(filter.status ? { status: filter.status as never } : {}), ...(filter.vendorId ? { vendorId: filter.vendorId } : {}) },
    include: claimInclude, orderBy: { createdAt: 'desc' }, take: 100 });
