import { Prisma, type PrismaClient } from '@prisma/client';
import { effectiveCost, unitCostFromCase, type CostBreakdown } from '@rjpos/domain-types';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { recordCostHistory } from './cost-history.js';
import { saveSpecialPrice } from './price-books.js';
import { normalizeUpc } from './purchasing.js';
import { writeAudit } from './tax-profiles.js';

/** Scan/search step of product creation: existing store product → master catalog → brand-new. Never creates anything. */
export async function lookupUpcForCreation(prisma: PrismaClient, actor: AdminActor, rawUpc: string) {
  const upc = normalizeUpc(rawUpc);
  let barcode = await prisma.barcode.findFirst({ where: { organizationId: actor.organizationId, barcodeValue: upc },
    include: { variant: { include: { product: { include: { category: true } } } } } });
  if (!barcode) {
    // A vendor case UPC identifies the same purchased product.
    const caseMapping = await prisma.vendorProductMapping.findFirst({ where: { organizationId: actor.organizationId, caseUpc: upc }, select: { variantId: true } });
    if (caseMapping) barcode = await prisma.barcode.findFirst({ where: { organizationId: actor.organizationId, variantId: caseMapping.variantId }, include: { variant: { include: { product: { include: { category: true } } } } } });
  }
  if (barcode) return { status: 'IN_STORE' as const, upc, variant: { id: barcode.variant.id, name: barcode.variant.name, sku: barcode.variant.sku, productId: barcode.variant.productId, productName: barcode.variant.product.name, brand: barcode.variant.product.brand, category: barcode.variant.product.category.name } };
  const master = await prisma.masterProduct.findUnique({ where: { upc } });
  if (master) return { status: 'MASTER_CATALOG' as const, upc, master: { id: master.id, name: master.name, brand: master.brand, category: master.category, sizeLabel: master.sizeLabel, packName: master.packName, referenceCostMinor: master.referenceCostMinor, referencePriceMinor: master.referencePriceMinor } };
  return { status: 'NEW' as const, upc };
}

export type SellingUnitInput = { name: string; unitsPerPack: number; sku?: string; upc?: string; priceMinor?: string };
export type PurchasedProductInput = {
  storeId: string;
  /** An explicitly incomplete draft: created inactive, vendor and pricing may be missing. */
  draft?: boolean;
  product: { name: string; categoryId: string; brand: string; description?: string; taxProfileId?: string | null; ageRestricted?: boolean; inventoryTracked?: boolean };
  identity: { upc: string; sizeLabel: string; sku?: string; size?: number; unit?: 'EACH' | 'ML' | 'LITER' };
  vendor?: { vendorId: string; vendorSku?: string; caseCostMinor: string; unitsPerCase: number; discountPerCaseMinor?: string; rebatePerCaseMinor?: string;
    /** Optional UPC printed on the vendor's case. */ caseUpc?: string; /** Minimum order in units; a whole number of cases. Defaults to one case. */ minimumOrderQuantity?: number; preferred?: boolean };
  sellingUnits: SellingUnitInput[];
  specialPrices?: Array<{ priceBookId: string; unitIndex: number; amountMinor: string; effectiveFrom?: Date | null; effectiveTo?: Date | null }>;
  inventory?: { openingQuantity: number; reason?: string; lowStockThreshold?: number; reorderTarget?: number };
};

const priceOf = (value: string | undefined, code: string): bigint | undefined => {
  if (value === undefined || value === '') return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new PosError(code);
  return BigInt(value);
};
const cleanSku = (value: string): string => {
  const result = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(result)) throw new PosError('SKU_INVALID');
  return result;
};

/**
 * Admin/Owner-controlled creation of a truly new, purchased product in one transaction: product, base variant (the
 * single unit), pack variants that draw from it, vendor mapping and case economics, store cost, standard prices, special
 * prices, opening inventory, and the first cost-history row. Purchase cost, standard price, and special prices stay in
 * separate tables. Scanning an existing UPC must use the existing product instead (UPC_ALREADY_EXISTS).
 */
export async function createPurchasedProduct(prisma: PrismaClient, actor: AdminActor, input: PurchasedProductInput) {
  const draft = input.draft === true;
  if (actor.storeId && actor.storeId !== input.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
  const name = input.product.name?.trim(); const brand = input.product.brand?.trim(); const sizeLabel = input.identity.sizeLabel?.trim();
  if (!name) throw new PosError('PRODUCT_NAME_REQUIRED');
  if (!input.product.categoryId) throw new PosError('CATEGORY_REQUIRED');
  if (!brand) throw new PosError('BRAND_REQUIRED');
  if (!sizeLabel) throw new PosError('SIZE_REQUIRED');
  const baseUpc = normalizeUpc(input.identity.upc);
  if (!input.vendor && !draft) throw new PosError('VENDOR_REQUIRED');
  if (input.sellingUnits.length === 0) throw new PosError('SELLING_UNIT_REQUIRED');
  const base = input.sellingUnits.filter((unit) => unit.unitsPerPack === 1);
  if (base.length !== 1) throw new PosError('SINGLE_UNIT_REQUIRED');
  for (const unit of input.sellingUnits) {
    if (!unit.name?.trim()) throw new PosError('SELLING_UNIT_NAME_REQUIRED');
    if (!Number.isSafeInteger(unit.unitsPerPack) || unit.unitsPerPack < 1) throw new PosError('UNITS_PER_PACK_INVALID');
    if (!draft && priceOf(unit.priceMinor, 'PRICE_INVALID') === undefined) throw new PosError('PRICE_REQUIRED');
  }
  if (new Set(input.sellingUnits.map((unit) => unit.unitsPerPack)).size !== input.sellingUnits.length) throw new PosError('DUPLICATE_PACK_SIZE');
  const baseSku = cleanSku(base[0]!.sku ?? input.identity.sku ?? `P-${baseUpc}`);
  const upcs = input.sellingUnits.map((unit) => (unit.unitsPerPack === 1 ? baseUpc : unit.upc?.trim() ? normalizeUpc(unit.upc) : null));
  const givenUpcs = upcs.filter((value): value is string => value !== null);
  if (new Set(givenUpcs).size !== givenUpcs.length) throw new PosError('DUPLICATE_UPC_IN_REQUEST');
  const skus = input.sellingUnits.map((unit) => (unit.unitsPerPack === 1 ? baseSku : cleanSku(unit.sku ?? `${baseSku}-${unit.unitsPerPack}PK`)));
  if (new Set(skus).size !== skus.length) throw new PosError('DUPLICATE_SKU_IN_REQUEST');

  let cost: CostBreakdown | null = null;
  if (input.vendor) {
    const caseCost = priceOf(input.vendor.caseCostMinor, 'CASE_COST_INVALID');
    if (caseCost === undefined || (caseCost <= 0n && !draft)) throw new PosError('CASE_COST_REQUIRED');
    if (!Number.isSafeInteger(input.vendor.unitsPerCase) || input.vendor.unitsPerCase < 1) throw new PosError('UNITS_PER_CASE_INVALID');
    try {
      cost = effectiveCost({ baseCaseCostMinor: caseCost, unitsPerCase: input.vendor.unitsPerCase,
        discountPerCaseMinor: priceOf(input.vendor.discountPerCaseMinor, 'DISCOUNT_INVALID') ?? 0n, rebatePerCaseMinor: priceOf(input.vendor.rebatePerCaseMinor, 'REBATE_INVALID') ?? 0n });
    } catch (error) { throw new PosError(error instanceof Error ? error.message : 'COST_INVALID'); }
  }
  const openingQuantity = input.inventory?.openingQuantity ?? 0;
  if (!Number.isSafeInteger(openingQuantity) || openingQuantity < 0) throw new PosError('INVENTORY_QUANTITY_INVALID');
  const lowStockThreshold = input.inventory?.lowStockThreshold ?? 0;
  const reorderTarget = input.inventory?.reorderTarget ?? lowStockThreshold;
  if (!Number.isSafeInteger(lowStockThreshold) || lowStockThreshold < 0 || !Number.isSafeInteger(reorderTarget) || reorderTarget < lowStockThreshold) throw new PosError('REORDER_SETTINGS_INVALID');
  const caseUpc = input.vendor?.caseUpc?.trim() ? normalizeUpc(input.vendor.caseUpc) : null;
  if (caseUpc && (caseUpc === baseUpc || givenUpcs.includes(caseUpc))) throw new PosError('DUPLICATE_UPC_IN_REQUEST');
  const minimumOrderQuantity = input.vendor?.minimumOrderQuantity ?? cost?.unitsPerCase ?? 1;
  if (!Number.isSafeInteger(minimumOrderQuantity) || minimumOrderQuantity < 1 || (cost && minimumOrderQuantity % cost.unitsPerCase !== 0)) throw new PosError('MINIMUM_ORDER_INVALID');

  const [category, store, vendor, taxProfile, employee] = await Promise.all([
    prisma.category.findFirst({ where: { id: input.product.categoryId, organizationId: actor.organizationId, active: true } }),
    prisma.store.findFirst({ where: { id: input.storeId, organizationId: actor.organizationId, status: 'ACTIVE' } }),
    input.vendor ? prisma.vendor.findFirst({ where: { id: input.vendor.vendorId, organizationId: actor.organizationId, active: true } }) : Promise.resolve(true),
    input.product.taxProfileId ? prisma.taxProfile.findFirst({ where: { id: input.product.taxProfileId, organizationId: actor.organizationId, active: true } }) : Promise.resolve(true),
    prisma.employee.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId, status: 'ACTIVE', stores: { some: { storeId: input.storeId } } } }),
  ]);
  if (!category) throw new PosError('CATEGORY_NOT_FOUND', 404);
  if (!store) throw new PosError('STORE_NOT_FOUND', 404);
  if (!vendor) throw new PosError('VENDOR_NOT_FOUND', 404);
  if (!taxProfile) throw new PosError('TAX_PROFILE_NOT_FOUND', 404);
  if (!employee) throw new PosError('EMPLOYEE_STORE_ACCESS_DENIED', 403);
  const existing = await prisma.barcode.findMany({ where: { organizationId: actor.organizationId, barcodeValue: { in: givenUpcs } }, include: { variant: { include: { product: true } } } });
  if (existing.length) throw new PosError('UPC_ALREADY_EXISTS', 409);
  if (caseUpc && (await prisma.barcode.count({ where: { organizationId: actor.organizationId, barcodeValue: caseUpc } }) + await prisma.vendorProductMapping.count({ where: { organizationId: actor.organizationId, caseUpc } })) > 0) throw new PosError('UPC_ALREADY_EXISTS', 409);
  const master = await prisma.masterProduct.findUnique({ where: { upc: baseUpc }, select: { id: true } });
  const specials = input.specialPrices ?? [];
  for (const special of specials) if (!Number.isInteger(special.unitIndex) || special.unitIndex < 0 || special.unitIndex >= input.sellingUnits.length) throw new PosError('SPECIAL_PRICE_UNIT_INVALID');

  try {
    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: { organizationId: actor.organizationId, categoryId: category.id, name, brand, description: input.product.description?.trim() || null,
        ageRestricted: input.product.ageRestricted ?? false, inventoryTracked: input.product.inventoryTracked ?? true, active: !draft, draft,
        ...(input.product.taxProfileId ? { taxProfileId: input.product.taxProfileId } : {}) } });
      const unitCost = cost?.effectiveUnitCostMinor ?? null;
      const created: Array<{ id: string; name: string; sku: string; unitsPerPack: number; barcode: string | null }> = [];
      let baseVariantId = '';
      // The single unit is created first so pack variants can point at it.
      const order = [...input.sellingUnits.keys()].sort((left, right) => (input.sellingUnits[left]!.unitsPerPack === 1 ? -1 : 0) - (input.sellingUnits[right]!.unitsPerPack === 1 ? -1 : 0));
      const idByIndex = new Map<number, string>();
      for (const index of order) {
        const unit = input.sellingUnits[index]!; const isBase = unit.unitsPerPack === 1;
        const variant = await tx.productVariant.create({ data: { organizationId: actor.organizationId, productId: product.id, name: isBase ? `${sizeLabel}${unit.name.trim() && unit.name.trim().toLowerCase() !== 'single' ? ` ${unit.name.trim()}` : ''}`.trim() : `${sizeLabel} ${unit.name.trim()}`.trim(), sku: skus[index]!,
          active: !draft, ...(input.identity.size === undefined ? {} : { size: new Prisma.Decimal(input.identity.size) }), unit: input.identity.unit ?? 'EACH',
          ...(unitCost === null ? {} : { costMinor: unitCost }), ...(isBase && master ? { masterProductId: master.id } : {}), ...(isBase ? { lowStockThreshold } : {}),
          ...(isBase ? {} : { baseVariantId, unitsPerPack: unit.unitsPerPack }) } });
        if (isBase) baseVariantId = variant.id;
        idByIndex.set(index, variant.id);
        const upc = upcs[index] ?? null;
        if (upc) await tx.barcode.create({ data: { organizationId: actor.organizationId, variantId: variant.id, barcodeValue: upc } });
        const price = priceOf(unit.priceMinor, 'PRICE_INVALID');
        if (price !== undefined) await tx.price.create({ data: { organizationId: actor.organizationId, storeId: input.storeId, variantId: variant.id, amountMinor: price, effectiveFrom: new Date() } });
        created.push({ id: variant.id, name: variant.name, sku: variant.sku, unitsPerPack: unit.unitsPerPack, barcode: upc });
      }
      let mappingId: string | null = null;
      if (input.vendor && cost) {
        // Stock, cost, and the vendor mapping live on the base variant; packs are just other ways to sell it.
        const mapping = await tx.vendorProductMapping.create({ data: { organizationId: actor.organizationId, vendorId: input.vendor.vendorId, variantId: baseVariantId,
          vendorSku: input.vendor.vendorSku?.trim() || null, vendorCostMinor: unitCostFromCase(cost.baseCaseCostMinor, cost.unitsPerCase), caseCostMinor: cost.baseCaseCostMinor,
          casePackQuantity: cost.unitsPerCase, minimumOrderQuantity, preferred: input.vendor.preferred ?? true, caseUpc } });
        mappingId = mapping.id;
        await tx.storeProductCost.create({ data: { organizationId: actor.organizationId, storeId: input.storeId, variantId: baseVariantId, amountMinor: cost.effectiveUnitCostMinor } });
        await recordCostHistory(tx, { organizationId: actor.organizationId, storeId: input.storeId, variantId: baseVariantId, vendorId: input.vendor.vendorId, source: 'PRODUCT_CREATED', cost, createdByEmployeeId: actor.userId, notes: 'Initial cost at product creation' });
      }
      for (const special of specials) await saveSpecialPrice(tx, actor, { priceBookId: special.priceBookId, storeId: input.storeId, variantId: idByIndex.get(special.unitIndex)!, amountMinor: special.amountMinor, effectiveFrom: special.effectiveFrom ?? null, effectiveTo: special.effectiveTo ?? null });
      if (product.inventoryTracked && (openingQuantity > 0 || lowStockThreshold > 0 || reorderTarget > 0)) {
        const level = await tx.inventoryLevel.create({ data: { organizationId: actor.organizationId, storeId: input.storeId, variantId: baseVariantId, onHand: openingQuantity, lowStockThreshold, reorderTarget } });
        if (openingQuantity > 0) {
        const movement = await tx.inventoryMovement.create({ data: { organizationId: actor.organizationId, storeId: input.storeId, variantId: baseVariantId, employeeId: actor.userId,
          quantityDelta: openingQuantity, type: 'INITIAL', referenceType: 'OPENING_BALANCE', reason: input.inventory?.reason?.trim() || 'Opening inventory at product creation', resultingOnHand: level.onHand } });
        await writeAudit(tx, actor, { action: 'INVENTORY_OPENING_BALANCE', entityType: 'InventoryMovement', entityId: movement.id, storeId: input.storeId, after: { variantId: baseVariantId, quantity: openingQuantity } });
        }
      }
      await writeAudit(tx, actor, { action: 'PURCHASED_PRODUCT_CREATED', entityType: 'Product', entityId: product.id, storeId: input.storeId,
        after: { name, draft, upc: baseUpc, vendorId: input.vendor?.vendorId ?? null, unitsPerCase: cost?.unitsPerCase ?? null, effectiveUnitCostMinor: unitCost?.toString() ?? null, variants: created.map((variant) => variant.sku) } });
      return { productId: product.id, baseVariantId, variants: created, vendorMappingId: mappingId, draft, effectiveUnitCostMinor: unitCost };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = JSON.stringify(error.meta?.target ?? '');
      throw new PosError(/sku/i.test(target) ? 'SKU_ALREADY_EXISTS' : /barcode/i.test(target) ? 'UPC_ALREADY_EXISTS' : 'PRODUCT_CREATE_CONFLICT', 409);
    }
    throw error;
  }
}

/** Everything the product detail screen shows, bounded per section. */
export async function getProductDetail(prisma: PrismaClient, actor: AdminActor, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, organizationId: actor.organizationId },
    include: { category: true, taxProfile: true, variants: { include: { barcodes: true, taxProfile: true, baseVariant: { select: { id: true, name: true, sku: true } } }, orderBy: [{ unitsPerPack: 'asc' }, { name: 'asc' }] } } });
  if (!product) throw new PosError('PRODUCT_NOT_FOUND', 404);
  const variantIds = product.variants.map((variant) => variant.id);
  const baseIds = [...new Set(product.variants.map((variant) => variant.baseVariantId ?? variant.id))];
  const org = actor.organizationId; const now = new Date();
  const [prices, specialPrices, mappings, levels, orderLines, receiptLines, invoiceLines, costHistory, deals, audits, storeCosts] = await Promise.all([
    prisma.price.findMany({ where: { organizationId: org, variantId: { in: variantIds }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, orderBy: { effectiveFrom: 'desc' } }),
    prisma.specialPrice.findMany({ where: { organizationId: org, variantId: { in: variantIds } }, include: { priceBook: { select: { id: true, name: true, active: true } }, store: { select: { id: true, name: true } } }, orderBy: [{ priceBook: { sortOrder: 'asc' } }, { createdAt: 'desc' }], take: 100 }),
    prisma.vendorProductMapping.findMany({ where: { organizationId: org, variantId: { in: baseIds } }, include: { vendor: { select: { id: true, name: true } } }, orderBy: [{ preferred: 'desc' }, { updatedAt: 'desc' }] }),
    prisma.inventoryLevel.findMany({ where: { organizationId: org, variantId: { in: baseIds } }, include: { store: { select: { id: true, name: true } } } }),
    prisma.purchaseOrderLine.findMany({ where: { organizationId: org, variantId: { in: baseIds } }, include: { purchaseOrder: { select: { id: true, poNumber: true, status: true, createdAt: true, vendor: { select: { id: true, name: true } } } } }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.purchaseReceiptLine.findMany({ where: { organizationId: org, purchaseOrderLine: { variantId: { in: baseIds } } }, include: { receipt: { select: { id: true, receivedAt: true, vendorReferenceNumber: true } }, purchaseOrderLine: { select: { purchaseOrderId: true, variantId: true } } }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.invoiceLine.findMany({ where: { organizationId: org, variantId: { in: baseIds } }, include: { invoiceDocument: { select: { id: true, invoiceNumber: true, invoiceDate: true, reviewStatus: true, vendor: { select: { id: true, name: true } } } } }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.productCostHistory.findMany({ where: { organizationId: org, variantId: { in: baseIds } }, orderBy: { occurredAt: 'desc' }, take: 50 }),
    prisma.vendorDeal.findMany({ where: { organizationId: org, OR: [{ variantId: { in: baseIds } }, { variantId: null, vendor: { mappings: { some: { variantId: { in: baseIds } } } } }] }, include: { vendor: { select: { id: true, name: true } } }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }], take: 50 }),
    prisma.auditRecord.findMany({ where: { organizationId: org, entityId: { in: [productId, ...variantIds] } }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.storeProductCost.findMany({ where: { organizationId: org, variantId: { in: baseIds } }, include: { store: { select: { id: true, name: true } } } }),
  ]);
  return { product, prices, specialPrices, mappings, levels, storeCosts, purchaseHistory: orderLines, receivingHistory: receiptLines, invoices: invoiceLines, costHistory, vendorDeals: deals, audit: audits };
}
