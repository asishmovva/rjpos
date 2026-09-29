import type { PrismaClient, VendorDealKind } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { writeAudit } from './tax-profiles.js';

const money = (value: string | undefined, code: string): bigint | null => {
  if (value === undefined || value === '') return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new PosError(code);
  return BigInt(value);
};

export const listVendorDeals = (prisma: PrismaClient, actor: AdminActor, filter: { vendorId?: string; variantId?: string; activeOnly?: boolean }) =>
  prisma.vendorDeal.findMany({ where: { organizationId: actor.organizationId, ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
    ...(filter.variantId ? { OR: [{ variantId: filter.variantId }, { variantId: null }] } : {}), ...(filter.activeOnly ? { active: true } : {}) },
  include: { vendor: { select: { id: true, name: true } }, variant: { select: { id: true, name: true, sku: true } } }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }], take: 200 });

/**
 * Deals never change a vendor's base case cost; they are applied when costing a purchase and recorded, component by
 * component, in the cost history. Vendor-wide deals (no variant) apply to every product from that vendor.
 */
export async function createVendorDeal(prisma: PrismaClient, actor: AdminActor, input: {
  vendorId: string; variantId?: string | null; name: string; kind: VendorDealKind; amountMinor?: string; dealCaseCostMinor?: string; minimumCases?: number | null;
  startsAt?: Date | null; endsAt?: Date | null; notes?: string;
}) {
  const name = input.name?.trim();
  if (!name || name.length > 80) throw new PosError('VENDOR_DEAL_NAME_INVALID');
  const amountMinor = money(input.amountMinor, 'VENDOR_DEAL_AMOUNT_INVALID');
  const dealCaseCostMinor = money(input.dealCaseCostMinor, 'VENDOR_DEAL_AMOUNT_INVALID');
  if (input.kind === 'DEAL_CASE_PRICE' ? dealCaseCostMinor === null : !amountMinor || amountMinor <= 0n) throw new PosError('VENDOR_DEAL_AMOUNT_REQUIRED');
  if (input.kind === 'QUANTITY_BREAK' && !(Number.isSafeInteger(input.minimumCases) && (input.minimumCases ?? 0) >= 2)) throw new PosError('VENDOR_DEAL_MINIMUM_CASES_REQUIRED');
  if (input.minimumCases != null && (!Number.isSafeInteger(input.minimumCases) || input.minimumCases < 1)) throw new PosError('VENDOR_DEAL_MINIMUM_CASES_INVALID');
  if ((input.startsAt && Number.isNaN(input.startsAt.getTime())) || (input.endsAt && Number.isNaN(input.endsAt.getTime())) || (input.startsAt && input.endsAt && input.endsAt <= input.startsAt)) throw new PosError('VENDOR_DEAL_WINDOW_INVALID');
  const [vendor, variant] = await Promise.all([
    prisma.vendor.findFirst({ where: { id: input.vendorId, organizationId: actor.organizationId } }),
    input.variantId ? prisma.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId } }) : Promise.resolve(true),
  ]);
  if (!vendor) throw new PosError('VENDOR_NOT_FOUND', 404);
  if (!variant) throw new PosError('VARIANT_NOT_FOUND', 404);
  return prisma.$transaction(async (tx) => {
    const deal = await tx.vendorDeal.create({ data: { organizationId: actor.organizationId, vendorId: input.vendorId, variantId: input.variantId ?? null, name, kind: input.kind,
      amountMinor, dealCaseCostMinor, minimumCases: input.minimumCases ?? null, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, notes: input.notes?.trim() || null } });
    await writeAudit(tx, actor, { action: 'VENDOR_DEAL_CREATED', entityType: 'VendorDeal', entityId: deal.id, after: { vendor: vendor.name, name, kind: input.kind } });
    return deal;
  });
}

export async function updateVendorDeal(prisma: PrismaClient, actor: AdminActor, id: string, input: { name?: string; active?: boolean; startsAt?: Date | null; endsAt?: Date | null; notes?: string | null }) {
  if (!await prisma.vendorDeal.findFirst({ where: { id, organizationId: actor.organizationId } })) throw new PosError('VENDOR_DEAL_NOT_FOUND', 404);
  return prisma.$transaction(async (tx) => {
    const deal = await tx.vendorDeal.update({ where: { id }, data: { ...(input.name === undefined ? {} : { name: input.name.trim() }), ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }), ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }), ...(input.notes === undefined ? {} : { notes: input.notes?.trim() || null }) } });
    await writeAudit(tx, actor, { action: 'VENDOR_DEAL_UPDATED', entityType: 'VendorDeal', entityId: id, after: { active: deal.active } });
    return deal;
  });
}

/** Deals in force for a vendor and variant at `at` (vendor-wide plus variant-specific). */
export const activeVendorDeals = (prisma: PrismaClient, input: { organizationId: string; vendorId: string; variantId: string; at: Date }) =>
  prisma.vendorDeal.findMany({ where: { organizationId: input.organizationId, vendorId: input.vendorId, active: true, OR: [{ variantId: input.variantId }, { variantId: null }],
    AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: input.at } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: input.at } }] }] } });
