import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { recordAudit } from './audit.js';
import { postOpeningBalance } from './inventory.js';
import { PosError } from './pos-errors.js';
import { normalizeMainCatalogUpc, parseCsv } from './purchasing.js';

export type DemoStoreSeedSummary = {
  csvRows: number;
  productsAdded: number;
  alreadyInStore: number;
  pricesInitialized: number;
  costsInitialized: number;
  openingBalancesCreated: number;
  openingBalancesAlreadyPosted: number;
  zeroQuantityProducts: number;
  missingFromMasterCatalog: number;
  duplicateRows: number;
  invalidRows: Array<{ row: number; code: string }>;
  quantityTreatedAsZero: Array<{ row: number; upc: string; quantity: string }>;
};

const CHUNK = 250;
// Non-alcohol departments in CategorizedItemList.csv. Everything else is treated as age restricted.
const UNRESTRICTED_DEPARTMENTS = new Set(['soda', 'water']);

/**
 * DEVELOPMENT/DEMO ONLY. Adds every master-catalog product listed in the CSV to one store, using the CSV's
 * PRICEPERUNIT as the store price, CURRENTCOST as the store cost, and TOTALQTY as an opening balance posted
 * through the inventory ledger. Idempotent: existing barcodes, prices, costs, and opening balances are left alone.
 */
export async function seedDemoStoreCatalog(
  prisma: PrismaClient,
  actor: { organizationId: string; storeId: string; employeeId: string },
  csv: string,
): Promise<DemoStoreSeedSummary> {
  const rows = parseCsv(csv);
  const header = (rows[0]?.fields ?? []).map((field) => field.trim().replace(/^﻿/, '').toLowerCase());
  const column = (name: string) => header.indexOf(name);
  if (column('mainupc') < 0 || column('totalqty') < 0) throw new PosError('DEMO_CSV_HEADERS_REQUIRED');
  const summary: DemoStoreSeedSummary = {
    csvRows: rows.length - 1, productsAdded: 0, alreadyInStore: 0, pricesInitialized: 0, costsInitialized: 0,
    openingBalancesCreated: 0, openingBalancesAlreadyPosted: 0, zeroQuantityProducts: 0,
    missingFromMasterCatalog: 0, duplicateRows: 0, invalidRows: [], quantityTreatedAsZero: [],
  };
  const quantityByUpc = new Map<string, number>();
  for (const row of rows.slice(1)) {
    try {
      const upc = normalizeMainCatalogUpc(row.fields[column('mainupc')] ?? '');
      const quantityText = (row.fields[column('totalqty')] ?? '').trim();
      if (!/^-?\d{1,9}(\.\d+)?$/.test(quantityText)) throw new PosError('DEMO_QUANTITY_INVALID');
      if (quantityByUpc.has(upc)) { summary.duplicateRows += 1; continue; }
      // Negative or fractional counts are source-data errors; stock is never invented, so they open at zero.
      const quantity = Number(quantityText);
      if (!Number.isInteger(quantity) || quantity < 0) summary.quantityTreatedAsZero.push({ row: row.line, upc, quantity: quantityText });
      quantityByUpc.set(upc, Number.isInteger(quantity) && quantity > 0 ? quantity : 0);
    } catch (error) {
      summary.invalidRows.push({ row: row.line, code: error instanceof PosError ? error.code : 'DEMO_ROW_INVALID' });
    }
  }

  const store = await prisma.store.findFirst({ where: { id: actor.storeId, organizationId: actor.organizationId } });
  if (!store) throw new PosError('STORE_NOT_FOUND', 404);
  const categoryIds = new Map<string, string>();
  const categoryFor = async (name: string) => {
    const cached = categoryIds.get(name);
    if (cached) return cached;
    const category = await prisma.category.upsert({
      where: { organizationId_name: { organizationId: actor.organizationId, name } },
      update: {}, create: { organizationId: actor.organizationId, name }, select: { id: true },
    });
    categoryIds.set(name, category.id);
    return category.id;
  };

  const upcs = [...quantityByUpc.keys()];
  for (let offset = 0; offset < upcs.length; offset += CHUNK) {
    const chunk = upcs.slice(offset, offset + CHUNK);
    const [masters, barcodes] = await Promise.all([
      prisma.masterProduct.findMany({ where: { upc: { in: chunk } } }),
      prisma.barcode.findMany({ where: { organizationId: actor.organizationId, barcodeValue: { in: chunk } }, select: { barcodeValue: true, variantId: true } }),
    ]);
    const variantByUpc = new Map(barcodes.map((barcode) => [barcode.barcodeValue, barcode.variantId]));
    summary.missingFromMasterCatalog += chunk.length - masters.length;
    const created: Array<{ master: (typeof masters)[number]; productId: string; variantId: string; categoryId: string }> = [];
    for (const master of masters) {
      if (variantByUpc.has(master.upc)) { summary.alreadyInStore += 1; continue; }
      created.push({ master, productId: randomUUID(), variantId: randomUUID(), categoryId: await categoryFor(master.category?.trim() || 'Uncategorized') });
    }
    if (created.length) {
      await prisma.$transaction(async (tx) => {
        await tx.product.createMany({ data: created.map(({ master, productId, categoryId }) => ({
          id: productId, organizationId: actor.organizationId, categoryId, name: master.name, brand: master.brand,
          ageRestricted: !UNRESTRICTED_DEPARTMENTS.has((master.category ?? '').trim().toLowerCase()),
        })) });
        await tx.productVariant.createMany({ data: created.map(({ master, productId, variantId }) => ({
          id: variantId, organizationId: actor.organizationId, productId, masterProductId: master.id,
          name: [master.sizeLabel, master.packName].filter(Boolean).join(' ') || 'Each', sku: `M-${master.upc}`,
          size: master.size, unit: master.unit,
        })) });
        await tx.barcode.createMany({ data: created.map(({ master, variantId }) => ({ organizationId: actor.organizationId, variantId, barcodeValue: master.upc })) });
      });
      for (const item of created) variantByUpc.set(item.master.upc, item.variantId);
      summary.productsAdded += created.length;
    }

    const variantIds = [...variantByUpc.values()];
    const [prices, costs, openings] = await Promise.all([
      prisma.price.findMany({ where: { organizationId: actor.organizationId, storeId: actor.storeId, variantId: { in: variantIds } }, select: { variantId: true } }),
      prisma.storeProductCost.findMany({ where: { organizationId: actor.organizationId, storeId: actor.storeId, variantId: { in: variantIds } }, select: { variantId: true } }),
      prisma.inventoryMovement.findMany({ where: { organizationId: actor.organizationId, storeId: actor.storeId, type: 'INITIAL', variantId: { in: variantIds } }, select: { variantId: true } }),
    ]);
    const hasPrice = new Set(prices.map((row) => row.variantId));
    const hasCost = new Set(costs.map((row) => row.variantId));
    const hasOpening = new Set(openings.map((row) => row.variantId));
    const newPrices = []; const newCosts = [];
    for (const master of masters) {
      const variantId = variantByUpc.get(master.upc);
      if (!variantId) continue;
      if (master.referencePriceMinor !== null && !hasPrice.has(variantId)) newPrices.push({ organizationId: actor.organizationId, storeId: actor.storeId, variantId, amountMinor: master.referencePriceMinor, effectiveFrom: new Date() });
      if (master.referenceCostMinor !== null && !hasCost.has(variantId)) newCosts.push({ organizationId: actor.organizationId, storeId: actor.storeId, variantId, amountMinor: master.referenceCostMinor });
    }
    if (newPrices.length) summary.pricesInitialized += (await prisma.price.createMany({ data: newPrices })).count;
    if (newCosts.length) summary.costsInitialized += (await prisma.storeProductCost.createMany({ data: newCosts, skipDuplicates: true })).count;

    for (const master of masters) {
      const variantId = variantByUpc.get(master.upc);
      if (!variantId) continue;
      const quantity = quantityByUpc.get(master.upc)!;
      if (hasOpening.has(variantId)) { summary.openingBalancesAlreadyPosted += 1; continue; }
      try {
        await postOpeningBalance(prisma, { organizationId: actor.organizationId, storeId: actor.storeId, employeeId: actor.employeeId, variantId, quantity, reason: 'Development demo opening balance from CategorizedItemList.csv TOTALQTY' });
        summary.openingBalancesCreated += 1;
        if (quantity === 0) summary.zeroQuantityProducts += 1;
      } catch (error) {
        if (error instanceof PosError && error.code === 'OPENING_BALANCE_ALREADY_POSTED') summary.openingBalancesAlreadyPosted += 1;
        else throw error;
      }
    }
  }
  await recordAudit(prisma, { organizationId: actor.organizationId, action: 'DEMO_STORE_CATALOG_SEEDED', entityType: 'Store', entityId: actor.storeId, afterJson: { ...summary, invalidRows: summary.invalidRows.length, quantityTreatedAsZero: summary.quantityTreatedAsZero.length } });
  return summary;
}
