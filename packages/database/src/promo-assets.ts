import type { PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { writeAudit } from './tax-profiles.js';

const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_ACTIVE = 12;
export type PromoInput = { title: string; subtitle?: string | null; imageData?: string | null; active?: boolean; sortOrder?: number; startsAt?: string | null; endsAt?: string | null };

function clean(input: Partial<PromoInput>, creating: boolean) {
  const data: { title?: string; subtitle?: string | null; imageData?: string | null; active?: boolean; sortOrder?: number; startsAt?: Date | null; endsAt?: Date | null } = {};
  if (input.title !== undefined || creating) {
    const title = input.title?.trim() ?? '';
    if (!title || title.length > 80) throw new PosError('PROMO_TITLE_INVALID');
    data.title = title;
  }
  if (input.subtitle !== undefined) { const subtitle = input.subtitle?.trim() || null; if (subtitle && subtitle.length > 160) throw new PosError('PROMO_SUBTITLE_INVALID'); data.subtitle = subtitle; }
  if (input.imageData !== undefined) {
    if (input.imageData !== null && (input.imageData.length > 900_000 || !IMAGE.test(input.imageData))) throw new PosError('PROMO_IMAGE_INVALID');
    data.imageData = input.imageData;
  }
  if (input.active !== undefined) data.active = input.active === true;
  if (input.sortOrder !== undefined) { if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 9999) throw new PosError('PROMO_ORDER_INVALID'); data.sortOrder = input.sortOrder; }
  for (const key of ['startsAt', 'endsAt'] as const) {
    if (input[key] === undefined) continue;
    if (input[key] === null || input[key] === '') { data[key] = null; continue; }
    const value = new Date(input[key]!); if (Number.isNaN(value.getTime())) throw new PosError('PROMO_DATE_INVALID');
    data[key] = value;
  }
  return data;
}

export const listPromoAssets = (prisma: PrismaClient, actor: AdminActor) =>
  prisma.promoAsset.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });

/** What the register sends to the customer display: active and inside their date window, in display order. */
export async function activePromoAssets(prisma: PrismaClient, organizationId: string, now = new Date()) {
  return prisma.promoAsset.findMany({
    where: { organizationId, active: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: MAX_ACTIVE, select: { id: true, title: true, subtitle: true, imageData: true },
  });
}

export async function savePromoAsset(prisma: PrismaClient, actor: AdminActor, id: string | null, input: Partial<PromoInput>) {
  const data = clean(input, id === null);
  return prisma.$transaction(async (tx) => {
    if (id === null) {
      if (await tx.promoAsset.count({ where: { organizationId: actor.organizationId } }) >= 50) throw new PosError('PROMO_LIMIT_REACHED', 409);
      const created = await tx.promoAsset.create({ data: { organizationId: actor.organizationId, title: data.title!, ...data } });
      await writeAudit(tx, actor, { action: 'PROMO_ASSET_CREATED', entityType: 'PromoAsset', entityId: created.id, after: { title: created.title, active: created.active } });
      return created;
    }
    const current = await tx.promoAsset.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!current) throw new PosError('PROMO_NOT_FOUND', 404);
    const startsAt = data.startsAt === undefined ? current.startsAt : data.startsAt; const endsAt = data.endsAt === undefined ? current.endsAt : data.endsAt;
    if (startsAt && endsAt && endsAt <= startsAt) throw new PosError('PROMO_DATE_INVALID');
    const updated = await tx.promoAsset.update({ where: { id }, data });
    await writeAudit(tx, actor, { action: 'PROMO_ASSET_UPDATED', entityType: 'PromoAsset', entityId: id, after: { title: updated.title, active: updated.active, sortOrder: updated.sortOrder, previousTitle: current.title, previousActive: current.active } });
    return updated;
  });
}

export async function deletePromoAsset(prisma: PrismaClient, actor: AdminActor, id: string) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.promoAsset.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!current) throw new PosError('PROMO_NOT_FOUND', 404);
    await tx.promoAsset.delete({ where: { id } });
    await writeAudit(tx, actor, { action: 'PROMO_ASSET_DELETED', entityType: 'PromoAsset', entityId: id, after: { title: current.title } });
    return { id, deleted: true as const };
  });
}
