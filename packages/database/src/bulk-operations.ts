import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { writeAudit } from './tax-profiles.js';

type Tx = Prisma.TransactionClient;

export type BulkOperation =
  | { type: 'PRICE'; storeId: string; mode: 'PERCENT' | 'AMOUNT' | 'SET'; value: string }
  | { type: 'TAX_PROFILE'; taxProfileId: string | null }
  | { type: 'CATEGORY'; categoryId: string }
  | { type: 'VENDOR'; vendorId: string; preferred?: boolean }
  | { type: 'ACTIVE'; active: boolean }
  | { type: 'THRESHOLDS'; storeId: string; lowStockThreshold?: number; reorderTarget?: number };

export type BulkChange = { id: string; label: string; before: string; after: string; skip?: string };
export type BulkPlan = { type: BulkOperation['type']; changes: BulkChange[]; applicable: number; skipped: number };

const MAX_PRODUCTS = 500;
const money = (minor: bigint) => `$${minor < 0n ? '-' : ''}${(minor < 0n ? -minor : minor) / 100n}.${((minor < 0n ? -minor : minor) % 100n).toString().padStart(2, '0')}`;

type Planned = { changes: BulkChange[]; run: (tx: Tx) => Promise<void> };

async function plan(tx: Tx, actor: AdminActor, productIds: string[], operation: BulkOperation, now: Date): Promise<Planned> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) throw new PosError('BULK_SELECTION_REQUIRED');
  if (ids.length > MAX_PRODUCTS) throw new PosError('BULK_SELECTION_TOO_LARGE');
  const org = actor.organizationId;
  const products = await tx.product.findMany({ where: { organizationId: org, id: { in: ids } }, include: { category: true, taxProfile: true, variants: { orderBy: [{ unitsPerPack: 'asc' }, { name: 'asc' }] } } });
  if (products.length !== ids.length) throw new PosError('PRODUCT_NOT_FOUND', 404);
  const changes: BulkChange[] = []; const runs: Array<(tx: Tx) => Promise<void>> = [];
  const add = (change: BulkChange, run?: (tx: Tx) => Promise<void>) => { changes.push(change); if (run && !change.skip) runs.push(run); };

  if (operation.type === 'PRICE') {
    if (actor.storeId && actor.storeId !== operation.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
    if (!await tx.store.findFirst({ where: { id: operation.storeId, organizationId: org } })) throw new PosError('STORE_NOT_FOUND', 404);
    const valid = operation.mode === 'SET' ? /^\d{1,12}$/.test(operation.value) : /^-?\d{1,12}$/.test(operation.value);
    if (!valid || !['PERCENT', 'AMOUNT', 'SET'].includes(operation.mode)) throw new PosError('BULK_PRICE_VALUE_INVALID');
    const value = BigInt(operation.value);
    if (operation.mode === 'PERCENT' && (value < -10_000n || value > 100_000n)) throw new PosError('BULK_PRICE_VALUE_INVALID');
    const variantIds = products.flatMap((product) => product.variants.map((variant) => variant.id));
    const prices = await tx.price.findMany({ where: { organizationId: org, storeId: operation.storeId, variantId: { in: variantIds }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, orderBy: { effectiveFrom: 'asc' } });
    for (const product of products) for (const variant of product.variants) {
      const label = `${product.name} · ${variant.name}`;
      const mine = prices.filter((price) => price.variantId === variant.id);
      const current = mine.find((price) => price.effectiveFrom <= now); const future = mine.find((price) => price.effectiveFrom > now);
      if (!current) { add({ id: variant.id, label, before: '—', after: '—', skip: 'No current price in this store' }); continue; }
      if (future) { add({ id: variant.id, label, before: money(current.amountMinor), after: '—', skip: 'A future price is already scheduled' }); continue; }
      const next = operation.mode === 'SET' ? value : operation.mode === 'AMOUNT' ? current.amountMinor + value : current.amountMinor + (current.amountMinor * value + (value < 0n ? -5_000n : 5_000n)) / 10_000n;
      if (next < 0n) { add({ id: variant.id, label, before: money(current.amountMinor), after: '—', skip: 'Result would be negative' }); continue; }
      if (next === current.amountMinor) { add({ id: variant.id, label, before: money(current.amountMinor), after: money(next), skip: 'No change' }); continue; }
      add({ id: variant.id, label, before: money(current.amountMinor), after: money(next) }, async (client) => {
        // Close the current price and start the new one at the same instant; earlier orders keep the price they were charged.
        await client.price.update({ where: { id: current.id }, data: { effectiveTo: now } });
        await client.price.create({ data: { organizationId: org, storeId: operation.storeId, variantId: variant.id, amountMinor: next, currency: current.currency, effectiveFrom: now } });
      });
    }
  } else if (operation.type === 'TAX_PROFILE') {
    const profile = operation.taxProfileId ? await tx.taxProfile.findFirst({ where: { id: operation.taxProfileId, organizationId: org, active: true } }) : null;
    if (operation.taxProfileId && !profile) throw new PosError('TAX_PROFILE_NOT_FOUND', 404);
    for (const product of products) {
      const before = product.taxProfile?.name ?? 'Default'; const after = profile?.name ?? 'Default';
      add({ id: product.id, label: product.name, before, after, ...(product.taxProfileId === (operation.taxProfileId ?? null) ? { skip: 'No change' } : {}) },
        (client) => client.product.update({ where: { id: product.id }, data: { taxProfileId: operation.taxProfileId } }).then(() => undefined));
    }
  } else if (operation.type === 'CATEGORY') {
    const category = await tx.category.findFirst({ where: { id: operation.categoryId, organizationId: org, active: true } });
    if (!category) throw new PosError('CATEGORY_NOT_FOUND', 404);
    for (const product of products) add({ id: product.id, label: product.name, before: product.category.name, after: category.name, ...(product.categoryId === category.id ? { skip: 'No change' } : {}) },
      (client) => client.product.update({ where: { id: product.id }, data: { categoryId: category.id } }).then(() => undefined));
  } else if (operation.type === 'ACTIVE') {
    for (const product of products) {
      const skip = product.active === operation.active ? 'No change' : operation.active && product.draft ? 'Incomplete draft: finish it from the product page' : undefined;
      add({ id: product.id, label: product.name, before: product.active ? 'Active' : 'Inactive', after: operation.active ? 'Active' : 'Inactive', ...(skip ? { skip } : {}) },
        (client) => client.product.update({ where: { id: product.id }, data: { active: operation.active } }).then(() => undefined));
    }
  } else if (operation.type === 'VENDOR') {
    const vendor = await tx.vendor.findFirst({ where: { id: operation.vendorId, organizationId: org, active: true } });
    if (!vendor) throw new PosError('VENDOR_NOT_FOUND', 404);
    const bases = products.flatMap((product) => product.variants.filter((variant) => !variant.baseVariantId).map((variant) => ({ product, variant })));
    const [mappings, storeCosts] = await Promise.all([
      tx.vendorProductMapping.findMany({ where: { organizationId: org, variantId: { in: bases.map(({ variant }) => variant.id) }, active: true } }),
      tx.storeProductCost.findMany({ where: { organizationId: org, variantId: { in: bases.map(({ variant }) => variant.id) } } }),
    ]);
    for (const { product, variant } of bases) {
      const label = `${product.name} · ${variant.name}`;
      const linked = mappings.find((mapping) => mapping.variantId === variant.id && mapping.vendorId === vendor.id);
      if (linked) {
        if (operation.preferred && !linked.preferred) add({ id: variant.id, label, before: 'Linked', after: 'Preferred vendor' }, async (client) => { await client.vendorProductMapping.updateMany({ where: { organizationId: org, variantId: variant.id }, data: { preferred: false } }); await client.vendorProductMapping.update({ where: { id: linked.id }, data: { preferred: true } }); });
        else add({ id: variant.id, label, before: 'Linked', after: 'Linked', skip: 'No change' });
        continue;
      }
      const cost = storeCosts.find((row) => row.variantId === variant.id)?.amountMinor ?? variant.costMinor;
      if (cost === null || cost === undefined) { add({ id: variant.id, label, before: 'No link', after: '—', skip: 'No cost known: add this vendor from the product page' }); continue; }
      const makePreferred = operation.preferred === true || !mappings.some((mapping) => mapping.variantId === variant.id);
      add({ id: variant.id, label, before: 'No link', after: `${vendor.name} at ${money(cost)} per unit${makePreferred ? ' (preferred)' : ''}` }, async (client) => {
        if (makePreferred) await client.vendorProductMapping.updateMany({ where: { organizationId: org, variantId: variant.id }, data: { preferred: false } });
        await client.vendorProductMapping.create({ data: { organizationId: org, vendorId: vendor.id, variantId: variant.id, vendorCostMinor: cost, casePackQuantity: 1, minimumOrderQuantity: 1, preferred: makePreferred } });
      });
    }
  } else if (operation.type === 'THRESHOLDS') {
    if (actor.storeId && actor.storeId !== operation.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
    const { lowStockThreshold: low, reorderTarget: target } = operation;
    if (low === undefined && target === undefined) throw new PosError('BULK_THRESHOLD_VALUE_REQUIRED');
    for (const value of [low, target]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new PosError('BULK_THRESHOLD_VALUE_INVALID');
    const bases = products.flatMap((product) => product.variants.filter((variant) => !variant.baseVariantId).map((variant) => ({ product, variant })));
    const levels = await tx.inventoryLevel.findMany({ where: { organizationId: org, storeId: operation.storeId, variantId: { in: bases.map(({ variant }) => variant.id) } } });
    for (const { product, variant } of bases) {
      const level = levels.find((row) => row.variantId === variant.id); const label = `${product.name} · ${variant.name}`;
      if (!level) { add({ id: variant.id, label, before: '—', after: '—', skip: 'No stock record in this store' }); continue; }
      const nextLow = low ?? level.lowStockThreshold; const nextTarget = target ?? level.reorderTarget;
      const before = `low ${level.lowStockThreshold} / target ${level.reorderTarget}`; const after = `low ${nextLow} / target ${nextTarget}`;
      if (nextTarget < nextLow) { add({ id: variant.id, label, before, after, skip: 'Reorder target must be at least the low-stock threshold' }); continue; }
      if (nextLow === level.lowStockThreshold && nextTarget === level.reorderTarget) { add({ id: variant.id, label, before, after, skip: 'No change' }); continue; }
      add({ id: variant.id, label, before, after }, async (client) => {
        // Only the thresholds change; on-hand stock is never touched.
        await client.inventoryLevel.update({ where: { id: level.id }, data: { lowStockThreshold: nextLow, reorderTarget: nextTarget } });
        await client.productVariant.update({ where: { id: variant.id }, data: { lowStockThreshold: nextLow } });
      });
    }
  } else throw new PosError('BULK_OPERATION_INVALID');
  return { changes, run: async (client) => { for (const run of runs) await run(client); } };
}

const summarize = (type: BulkOperation['type'], changes: BulkChange[]): BulkPlan => ({ type, changes, applicable: changes.filter((change) => !change.skip).length, skipped: changes.filter((change) => change.skip).length });

/** Shows exactly what a bulk operation would change. Nothing is written. */
export async function previewBulkOperation(prisma: PrismaClient, actor: AdminActor, input: { productIds: string[]; operation: BulkOperation }): Promise<BulkPlan> {
  const planned = await prisma.$transaction((tx) => plan(tx, actor, input.productIds, input.operation, new Date()));
  return summarize(input.operation.type, planned.changes);
}

/**
 * Applies a reviewed bulk operation atomically (all or nothing) and audits it. Prices are scheduled, not overwritten, and
 * inventory quantities are never touched: only thresholds can change.
 */
export async function applyBulkOperation(prisma: PrismaClient, actor: AdminActor, input: { productIds: string[]; operation: BulkOperation }): Promise<BulkPlan & { operationId: string }> {
  const operationId = randomUUID();
  return prisma.$transaction(async (tx) => {
    const planned = await plan(tx, actor, input.productIds, input.operation, new Date());
    const summary = summarize(input.operation.type, planned.changes);
    await planned.run(tx);
    await writeAudit(tx, actor, { action: 'BULK_OPERATION', entityType: 'BulkOperation', entityId: operationId, ...(actor.storeId ? { storeId: actor.storeId } : {}),
      after: { type: input.operation.type, parameters: input.operation as unknown as Prisma.InputJsonValue, selected: input.productIds.length, applied: summary.applicable, skipped: summary.skipped, sample: planned.changes.filter((change) => !change.skip).slice(0, 20).map((change) => ({ label: change.label, before: change.before, after: change.after })) } });
    return { ...summary, operationId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
