import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';

export async function writeAudit(tx: Prisma.TransactionClient | PrismaClient, actor: AdminActor, data: { action: string; entityType: string; entityId: string; storeId?: string; after?: Prisma.InputJsonValue }): Promise<void> {
  await tx.auditRecord.create({ data: { organizationId: actor.organizationId, userId: actor.userId, action: data.action, entityType: data.entityType, entityId: data.entityId,
    ...(data.storeId ? { storeId: data.storeId } : {}), ...(data.after === undefined ? {} : { afterJson: data.after }) } });
}

const requireName = (value: string | undefined): string => {
  const name = value?.trim() ?? '';
  if (!name || name.length > 60) throw new PosError('TAX_PROFILE_NAME_INVALID');
  return name;
};
const requireRate = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) throw new PosError('TAX_RATE_INVALID');
  return value;
};

/** Idempotently creates the two system profiles every organization needs: Standard State Tax (default, follows the store rate) and Non-Taxable. */
export async function ensureSystemTaxProfiles(prisma: PrismaClient, organizationId: string): Promise<void> {
  const existing = await prisma.taxProfile.findMany({ where: { organizationId, kind: { in: ['STANDARD', 'NON_TAXABLE'] } }, select: { kind: true } });
  const has = (kind: string) => existing.some((profile) => profile.kind === kind);
  const hasDefault = await prisma.taxProfile.count({ where: { organizationId, isDefault: true } }) > 0;
  if (!has('STANDARD')) await prisma.taxProfile.create({ data: { organizationId, name: 'Standard State Tax', kind: 'STANDARD', description: "Uses each store's standard tax rate.", isDefault: !hasDefault } });
  if (!has('NON_TAXABLE')) await prisma.taxProfile.create({ data: { organizationId, name: 'Non-Taxable', kind: 'NON_TAXABLE', rateBasisPoints: 0, description: 'No sales tax.' } });
}

export async function listTaxProfiles(prisma: PrismaClient, actor: AdminActor) {
  await ensureSystemTaxProfiles(prisma, actor.organizationId);
  const profiles = await prisma.taxProfile.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  const [productCounts, variantCounts, stores] = await Promise.all([
    prisma.product.groupBy({ by: ['taxProfileId'], where: { organizationId: actor.organizationId, taxProfileId: { not: null } }, _count: true }),
    prisma.productVariant.groupBy({ by: ['taxProfileId'], where: { organizationId: actor.organizationId, taxProfileId: { not: null } }, _count: true }),
    prisma.store.findMany({ where: { organizationId: actor.organizationId }, select: { id: true, name: true, taxRateBasisPoints: true }, orderBy: { name: 'asc' } }),
  ]);
  const used = (profileId: string) => (productCounts.find((row) => row.taxProfileId === profileId)?._count ?? 0) + (variantCounts.find((row) => row.taxProfileId === profileId)?._count ?? 0);
  return { profiles: profiles.map((profile) => ({ ...profile, referenceCount: used(profile.id) })), stores };
}

export async function createTaxProfile(prisma: PrismaClient, actor: AdminActor, input: { name: string; rateBasisPoints: number; description?: string }) {
  const name = requireName(input.name); const rateBasisPoints = requireRate(input.rateBasisPoints);
  try {
    return await prisma.$transaction(async (tx) => {
      const profile = await tx.taxProfile.create({ data: { organizationId: actor.organizationId, name, kind: 'CUSTOM', rateBasisPoints, description: input.description?.trim() || null } });
      await writeAudit(tx, actor, { action: 'TAX_PROFILE_CREATED', entityType: 'TaxProfile', entityId: profile.id, after: { name, rateBasisPoints } });
      return profile;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('TAX_PROFILE_NAME_TAKEN', 409);
    throw error;
  }
}

/**
 * Edits affect future sales only: order items snapshot the rate and profile name at sale time. Standard and Non-Taxable
 * are system profiles (their rate cannot be edited here); the default profile cannot be deactivated.
 */
export async function updateTaxProfile(prisma: PrismaClient, actor: AdminActor, id: string, input: { name?: string; rateBasisPoints?: number; description?: string | null; active?: boolean; makeDefault?: boolean }) {
  const current = await prisma.taxProfile.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!current) throw new PosError('TAX_PROFILE_NOT_FOUND', 404);
  if (input.rateBasisPoints !== undefined && current.kind !== 'CUSTOM') throw new PosError('TAX_PROFILE_RATE_FIXED', 409);
  if (input.active === false && (current.isDefault || input.makeDefault)) throw new PosError('TAX_PROFILE_DEFAULT_REQUIRED', 409);
  if (input.makeDefault && (!current.active || input.active === false)) throw new PosError('TAX_PROFILE_INACTIVE', 409);
  try {
    return await prisma.$transaction(async (tx) => {
      if (input.makeDefault && !current.isDefault) await tx.taxProfile.updateMany({ where: { organizationId: actor.organizationId, isDefault: true }, data: { isDefault: false } });
      const profile = await tx.taxProfile.update({ where: { id }, data: {
        ...(input.name === undefined ? {} : { name: requireName(input.name) }),
        ...(input.rateBasisPoints === undefined ? {} : { rateBasisPoints: requireRate(input.rateBasisPoints) }),
        ...(input.description === undefined ? {} : { description: input.description?.trim() || null }),
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.makeDefault ? { isDefault: true } : {}),
      } });
      await writeAudit(tx, actor, { action: 'TAX_PROFILE_UPDATED', entityType: 'TaxProfile', entityId: id,
        after: { name: profile.name, rateBasisPoints: profile.rateBasisPoints, active: profile.active, isDefault: profile.isDefault, previousRateBasisPoints: current.rateBasisPoints } });
      return profile;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('TAX_PROFILE_NAME_TAKEN', 409);
    throw error;
  }
}

/** Only an unreferenced custom profile can be deleted; otherwise deactivate it. The foreign keys are the backstop. */
export async function deleteTaxProfile(prisma: PrismaClient, actor: AdminActor, id: string) {
  const current = await prisma.taxProfile.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!current) throw new PosError('TAX_PROFILE_NOT_FOUND', 404);
  if (current.kind !== 'CUSTOM' || current.isDefault) throw new PosError('TAX_PROFILE_PROTECTED', 409);
  const [products, variants] = await Promise.all([
    prisma.product.count({ where: { organizationId: actor.organizationId, taxProfileId: id } }),
    prisma.productVariant.count({ where: { organizationId: actor.organizationId, taxProfileId: id } }),
  ]);
  if (products + variants > 0) throw new PosError('TAX_PROFILE_IN_USE', 409);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.taxProfile.delete({ where: { id } });
      await writeAudit(tx, actor, { action: 'TAX_PROFILE_DELETED', entityType: 'TaxProfile', entityId: id, after: { name: current.name } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') throw new PosError('TAX_PROFILE_IN_USE', 409);
    throw error;
  }
  return { id, deleted: true as const };
}

/** Points a product (or one variant) at a tax profile; null means "use the organization default". Only active profiles can be assigned. */
export async function assignTaxProfile(prisma: PrismaClient, actor: AdminActor, input: { productId?: string; variantId?: string; taxProfileId: string | null }) {
  if (!input.productId === !input.variantId) throw new PosError('TAX_TARGET_INVALID');
  if (input.taxProfileId && !await prisma.taxProfile.findFirst({ where: { id: input.taxProfileId, organizationId: actor.organizationId, active: true } })) throw new PosError('TAX_PROFILE_NOT_FOUND', 404);
  return prisma.$transaction(async (tx) => {
    if (input.productId) {
      const result = await tx.product.updateMany({ where: { id: input.productId, organizationId: actor.organizationId }, data: { taxProfileId: input.taxProfileId } });
      if (!result.count) throw new PosError('PRODUCT_NOT_FOUND', 404);
    } else {
      const result = await tx.productVariant.updateMany({ where: { id: input.variantId!, organizationId: actor.organizationId }, data: { taxProfileId: input.taxProfileId } });
      if (!result.count) throw new PosError('VARIANT_NOT_FOUND', 404);
    }
    await writeAudit(tx, actor, { action: 'TAX_PROFILE_ASSIGNED', entityType: input.productId ? 'Product' : 'ProductVariant', entityId: (input.productId ?? input.variantId)!, after: { taxProfileId: input.taxProfileId } });
    return { taxProfileId: input.taxProfileId };
  });
}
