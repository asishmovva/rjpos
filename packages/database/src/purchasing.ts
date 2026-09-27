import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type PurchaseOrderStatus } from '@prisma/client';
import { PosError } from './pos-errors.js';
import type { AdminActor } from './back-office.js';

type Tx = Prisma.TransactionClient;
type PageInput = { page?: number; pageSize?: number };
type PurchasingActor = AdminActor & { storeId?: string };

const required = (value: string | undefined, code: string): string => {
  const result = value?.trim() ?? '';
  if (!result) throw new PosError(code);
  return result;
};

const pageArgs = (input: PageInput) => {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize ?? 25)));
  return { page, pageSize, skip: (page - 1) * pageSize };
};

const money = (value: string, code: string): bigint => {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new PosError(code);
  return BigInt(value);
};

async function withUniqueConflict<T>(operation: () => Promise<T>, code: string): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError(code, 409);
    throw error;
  }
}

export function normalizeUpc(value: string): string {
  const upc = value.trim().replace(/[\s-]/g, '');
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(upc)) throw new PosError('MASTER_UPC_INVALID');
  return upc;
}

function normalizeMainCatalogUpc(value: string): string {
  const upc = value.trim().replace(/[\s-]/g, '');
  if (/^\d{1,7}$/.test(upc) || /^\d{9,11}$/.test(upc)) return normalizeUpc(upc.padStart(12, '0'));
  return normalizeUpc(upc);
}

export async function lookupMasterProduct(prisma: PrismaClient, actor: PurchasingActor, rawUpc: string) {
  const upc = normalizeUpc(rawUpc);
  const inStore = await prisma.barcode.findFirst({
    where: { organizationId: actor.organizationId, barcodeValue: upc },
    include: { variant: { include: { product: true } } },
  });
  if (inStore) return { status: 'IN_STORE' as const, upc, product: inStore.variant.product, variant: inStore.variant };
  const master = await prisma.masterProduct.findUnique({ where: { upc } });
  return master ? { status: 'MASTER_ONLY' as const, upc, product: master } : { status: 'NOT_FOUND' as const, upc };
}

export async function searchMasterProducts(prisma: PrismaClient, rawSearch: string, input: PageInput = {}) {
  const search = rawSearch.trim();
  const { page, pageSize, skip } = pageArgs(input);
  const where: Prisma.MasterProductWhereInput = search
    ? { OR: [{ upc: { contains: search } }, { name: { contains: search, mode: 'insensitive' } }, { brand: { contains: search, mode: 'insensitive' } }] }
    : {};
  const [items, total] = await Promise.all([
    prisma.masterProduct.findMany({ where, orderBy: { name: 'asc' }, skip, take: pageSize }),
    prisma.masterProduct.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function addMasterProductToStore(prisma: PrismaClient, actor: PurchasingActor, rawUpc: string, input: {
  categoryId: string; sku: string; variantName?: string; storeId?: string; priceMinor?: string; costMinor?: string;
  inventoryTracked?: boolean; lowStockThreshold?: number;
}) {
  const upc = normalizeUpc(rawUpc);
  const sku = required(input.sku, 'SKU_REQUIRED').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(sku)) throw new PosError('SKU_INVALID');
  const storeId = input.storeId ?? actor.storeId;
  if (!storeId || (actor.storeId && actor.storeId !== storeId)) throw new PosError('STORE_ACCESS_DENIED', 403);
  const priceMinor = input.priceMinor === undefined ? undefined : money(input.priceMinor, 'PRICE_AMOUNT_INVALID');
  const costMinor = input.costMinor === undefined ? undefined : money(input.costMinor, 'PRODUCT_COST_INVALID');
  const lowStockThreshold = input.lowStockThreshold ?? 0;
  if (!Number.isSafeInteger(lowStockThreshold) || lowStockThreshold < 0) throw new PosError('LOW_STOCK_THRESHOLD_INVALID');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "MasterProduct" WHERE "upc" = ${upc} FOR UPDATE`;
    const current = await tx.barcode.findFirst({
      where: { organizationId: actor.organizationId, barcodeValue: upc },
      include: { variant: { include: { product: true } } },
    });
    if (current) return { status: 'IN_STORE' as const, product: current.variant.product, variant: current.variant };
    const master = await tx.masterProduct.findUnique({ where: { upc } });
    if (!master) throw new PosError('MASTER_PRODUCT_NOT_FOUND', 404);
    const [category, store] = await Promise.all([
      tx.category.findFirst({ where: { id: input.categoryId, organizationId: actor.organizationId, active: true } }),
      tx.store.findFirst({ where: { id: storeId, organizationId: actor.organizationId, status: 'ACTIVE' } }),
    ]);
    if (!category) throw new PosError('CATEGORY_NOT_FOUND', 404);
    if (!store) throw new PosError('STORE_NOT_FOUND', 404);
    const description = master.metadata && typeof master.metadata === 'object' && !Array.isArray(master.metadata)
      && typeof master.metadata.description === 'string' ? master.metadata.description : undefined;
    const product = await tx.product.create({ data: {
      organizationId: actor.organizationId, categoryId: category.id, name: master.name,
      brand: master.brand, inventoryTracked: input.inventoryTracked ?? true, ...(description ? { description } : {}),
    } });
    const variant = await tx.productVariant.create({ data: {
      organizationId: actor.organizationId, productId: product.id, masterProductId: master.id,
      name: input.variantName?.trim() || (master.sizeLabel
        ? [master.sizeLabel, master.packName].filter(Boolean).join(' ')
        : master.size ? `${master.size.toString()} ${master.unit.toLowerCase()}` : 'Each'),
      sku, size: master.size, unit: master.unit, lowStockThreshold,
    } });
    await tx.barcode.create({ data: { organizationId: actor.organizationId, variantId: variant.id, barcodeValue: upc } });
    if (costMinor !== undefined) await tx.storeProductCost.create({ data: { organizationId: actor.organizationId, storeId, variantId: variant.id, amountMinor: costMinor } });
    if (priceMinor !== undefined) await tx.price.create({ data: {
      organizationId: actor.organizationId, storeId, variantId: variant.id, amountMinor: priceMinor, effectiveFrom: new Date(),
    } });
    await audit(tx, actor, { action: 'MASTER_PRODUCT_ADDED_TO_STORE', entityType: 'Product', entityId: product.id, storeId,
      metadata: { masterProductId: master.id, upc, priceConfigured: priceMinor !== undefined,
        storeCostConfigured: costMinor !== undefined, inventoryCreated: false, lowStockThreshold } });
    return { status: 'ADDED' as const, product, variant, inventoryCreated: false };
  });
}

type CsvRecord = { line: number; fields: string[] };

function parseCsv(csv: string): CsvRecord[] {
  const rows: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') {
        const following = csv[index + 1];
        if (following !== undefined && ![',', '\r', '\n'].includes(following) && !/\s/.test(following)) {
          throw new PosError('MASTER_CSV_MALFORMED_QUOTE');
        }
        quoted = false;
      }
      else { field += character; if (character === '\n') line += 1; }
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === '"') throw new PosError('MASTER_CSV_MALFORMED_QUOTE');
    else if (character === ',') { fields.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
      fields.push(field); field = '';
      if (fields.some((cell) => cell.trim())) rows.push({ line: rowLine, fields });
      fields = []; line += 1; rowLine = line;
    } else field += character;
  }
  if (quoted) throw new PosError('MASTER_CSV_UNCLOSED_QUOTE');
  fields.push(field);
  if (fields.some((cell) => cell.trim())) rows.push({ line: rowLine, fields });
  return rows;
}

type MasterCsvRow = {
  upc: string; name: string; brand: string | null; size: Prisma.Decimal | null; unit: 'EACH' | 'ML' | 'LITER';
  sizeLabel: string | null; packName: string | null; category: string | null;
  referenceCostMinor: bigint | null; referencePriceMinor: bigint | null; metadata: Prisma.InputJsonObject | undefined;
  hasBrand: boolean; hasSize: boolean; hasUnit: boolean; hasSizeLabel: boolean; hasPackName: boolean;
  hasCategory: boolean; hasDescription: boolean; hasReferenceCost: boolean; hasReferencePrice: boolean;
};

function parseReferenceMoney(value: string, code: string): bigint | null {
  if (!value) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new PosError(code);
  const amount = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (amount > 9_223_372_036_854_775_807n) throw new PosError(code);
  return amount;
}

function readCsvRow(fields: string[], columns: Map<string, number>): MasterCsvRow {
  const get = (column: string) => fields[columns.get(column) ?? -1]?.trim() ?? '';
  const upc = columns.has('mainupc') ? normalizeMainCatalogUpc(get('mainupc')) : normalizeUpc(get('upc'));
  const name = required(get('name'), 'MASTER_NAME_REQUIRED');
  const brand = get('brand') || null;
  const sizeText = get('size');
  if (sizeText && !/^\d{1,9}(?:\.\d{1,3})?$/.test(sizeText)) throw new PosError('MASTER_SIZE_INVALID');
  const sizeNumber = sizeText ? Number(sizeText) : undefined;
  if (sizeNumber !== undefined && (!Number.isFinite(sizeNumber) || sizeNumber <= 0)) throw new PosError('MASTER_SIZE_INVALID');
  const rawUnit = get('unit').toUpperCase();
  const unit = rawUnit === 'ML' ? 'ML' : rawUnit === 'L' || rawUnit === 'LITER' ? 'LITER' : rawUnit === '' || rawUnit === 'EACH' ? 'EACH' : null;
  if (!unit) throw new PosError('MASTER_UNIT_INVALID');
  const category = get('category') || null;
  const sizeLabel = get('size_label') || null;
  const packName = get('pack_name') || null;
  const referenceCostText = get('reference_cost');
  const referencePriceText = get('reference_price');
  const referenceCostMinor = parseReferenceMoney(referenceCostText, 'MASTER_REFERENCE_COST_INVALID');
  const referencePriceMinor = parseReferenceMoney(referencePriceText, 'MASTER_REFERENCE_PRICE_INVALID');
  const description = get('description') || null;
  const metadata = description ? { description } : undefined;
  return { upc, name, brand, size: sizeNumber === undefined ? null : new Prisma.Decimal(sizeNumber), unit,
    sizeLabel, packName, category, referenceCostMinor, referencePriceMinor, metadata,
    hasBrand: columns.has('brand') && get('brand') !== '', hasSize: columns.has('size') && sizeText !== '',
    hasUnit: columns.has('unit') && get('unit') !== '', hasSizeLabel: columns.has('size_label') && sizeLabel !== null,
    hasPackName: columns.has('pack_name') && packName !== null,
    hasCategory: columns.has('category') && get('category') !== '', hasDescription: columns.has('description') && description !== null,
    hasReferenceCost: columns.has('reference_cost') && referenceCostText !== '',
    hasReferencePrice: columns.has('reference_price') && referencePriceText !== '' };
}

export async function importMasterCatalogCsv(prisma: PrismaClient, actor: PurchasingActor, csv: string) {
  if (typeof csv !== 'string' || !csv.trim()) throw new PosError('MASTER_CSV_EMPTY');
  const rows = parseCsv(csv);
  if (!rows.length) throw new PosError('MASTER_CSV_EMPTY');
  const aliases = new Map([
    ['itemname', 'name'], ['depname', 'category'], ['sizename', 'size_label'], ['packname', 'pack_name'],
    ['currentcost', 'reference_cost'], ['priceperunit', 'reference_price'],
  ]);
  const header = rows[0]!.fields.map((field, index) => {
    const normalized = field.trim().replace(index === 0 ? /^\uFEFF/ : /$^/, '').toLowerCase();
    return aliases.get(normalized) ?? normalized;
  });
  if (new Set(header).size !== header.length) throw new PosError('MASTER_CSV_DUPLICATE_HEADERS');
  const columns = new Map(header.map((name, index) => [name, index]));
  if ((!columns.has('upc') && !columns.has('mainupc')) || !columns.has('name')) throw new PosError('MASTER_CSV_HEADERS_REQUIRED');
  const summary = { added: 0, updated: 0, skipped: 0, invalid: 0, duplicate: 0, issues: [] as Array<{ row: number; code: string; upc?: string }> };
  const seen = new Set<string>();
  const validRows: Array<{ csvRow: CsvRecord; parsed: MasterCsvRow }> = [];
  for (const csvRow of rows.slice(1)) {
    let parsed: MasterCsvRow;
    try {
      if (csvRow.fields.length !== header.length) throw new PosError('MASTER_ROW_COLUMN_COUNT_INVALID');
      parsed = readCsvRow(csvRow.fields, columns);
    }
    catch (error) {
      summary.invalid += 1;
      summary.issues.push({ row: csvRow.line, code: error instanceof PosError ? error.code : 'MASTER_ROW_INVALID' });
      continue;
    }
    if (seen.has(parsed.upc)) {
      summary.duplicate += 1;
      summary.issues.push({ row: csvRow.line, code: 'MASTER_UPC_DUPLICATE_IN_FILE', upc: parsed.upc });
      continue;
    }
    seen.add(parsed.upc);
    validRows.push({ csvRow, parsed });
  }
  const batchSize = 300;
  for (let offset = 0; offset < validRows.length; offset += batchSize) {
    const batch = validRows.slice(offset, offset + batchSize);
    const created = await prisma.masterProduct.createManyAndReturn({
      data: batch.map(({ parsed }) => ({
        upc: parsed.upc, name: parsed.name, brand: parsed.brand, size: parsed.size, unit: parsed.unit,
        sizeLabel: parsed.sizeLabel, packName: parsed.packName, category: parsed.category,
        referenceCostMinor: parsed.referenceCostMinor, referencePriceMinor: parsed.referencePriceMinor,
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      })),
      skipDuplicates: true,
      select: { upc: true },
    });
    const inserted = new Set(created.map(({ upc }) => upc));
    summary.added += inserted.size;
    const existingProducts = await prisma.masterProduct.findMany({
      where: { upc: { in: batch.map(({ parsed }) => parsed.upc) } },
    });
    const existingByUpc = new Map(existingProducts.map((product) => [product.upc, product]));
    for (const { csvRow, parsed } of batch) {
      if (inserted.has(parsed.upc)) continue;
      const existing = existingByUpc.get(parsed.upc);
      if (!existing) throw new PosError('MASTER_CATALOG_IMPORT_RACE', 409);
      const sameIdentity = existing.name.trim().toLowerCase() === parsed.name.trim().toLowerCase()
        && (!parsed.hasBrand || (existing.brand ?? '').trim().toLowerCase() === (parsed.brand ?? '').trim().toLowerCase())
        && (!parsed.hasSize || (existing.size?.toString() ?? '') === (parsed.size?.toString() ?? ''))
        && (!parsed.hasUnit || existing.unit === parsed.unit)
        && (!parsed.hasSizeLabel || (existing.sizeLabel ?? '').trim().toLowerCase() === (parsed.sizeLabel ?? '').trim().toLowerCase())
        && (!parsed.hasPackName || (existing.packName ?? '').trim().toLowerCase() === (parsed.packName ?? '').trim().toLowerCase());
      if (!sameIdentity) {
        summary.skipped += 1;
        summary.issues.push({ row: csvRow.line, code: 'MASTER_UPC_IDENTITY_CONFLICT', upc: parsed.upc });
        continue;
      }
      const changed = (parsed.hasCategory && existing.category !== parsed.category)
        || (parsed.hasDescription && JSON.stringify(existing.metadata) !== JSON.stringify(parsed.metadata ?? null))
        || (parsed.hasReferenceCost && existing.referenceCostMinor !== parsed.referenceCostMinor)
        || (parsed.hasReferencePrice && existing.referencePriceMinor !== parsed.referencePriceMinor);
      if (!changed) { summary.skipped += 1; continue; }
      await prisma.masterProduct.update({ where: { upc: parsed.upc }, data: {
        ...(parsed.hasCategory ? { category: parsed.category } : {}),
        ...(parsed.hasDescription ? { metadata: parsed.metadata ?? Prisma.DbNull } : {}),
        ...(parsed.hasReferenceCost ? { referenceCostMinor: parsed.referenceCostMinor } : {}),
        ...(parsed.hasReferencePrice ? { referencePriceMinor: parsed.referencePriceMinor } : {}),
      } });
      summary.updated += 1;
    }
  }
  await audit(prisma, actor, { action: 'MASTER_CATALOG_IMPORTED', entityType: 'MasterCatalog', entityId: 'GLOBAL',
    metadata: { added: summary.added, updated: summary.updated, skipped: summary.skipped, invalid: summary.invalid, duplicate: summary.duplicate } });
  return summary;
}

export async function listVendors(prisma: PrismaClient, actor: PurchasingActor, input: PageInput & { search?: string; active?: boolean }) {
  const { page, pageSize, skip } = pageArgs(input);
  const where: Prisma.VendorWhereInput = {
    organizationId: actor.organizationId,
    ...(input.active === undefined ? {} : { active: input.active }),
    ...(input.search?.trim() ? { name: { contains: input.search.trim(), mode: 'insensitive' } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.vendor.findMany({ where, include: { _count: { select: { mappings: true, purchaseOrders: true } } }, orderBy: { name: 'asc' }, skip, take: pageSize }),
    prisma.vendor.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function createVendor(prisma: PrismaClient, actor: PurchasingActor, input: {
  name: string; contactName?: string; email?: string; phone?: string; address?: Prisma.InputJsonObject; accountReference?: string; notes?: string;
}) {
  const name = required(input.name, 'VENDOR_NAME_REQUIRED');
  return withUniqueConflict(() => prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.create({ data: { organizationId: actor.organizationId, name,
      contactName: input.contactName?.trim() || null, email: input.email?.trim() || null, phone: input.phone?.trim() || null,
      ...(input.address ? { addressJson: input.address } : {}),
      accountReference: input.accountReference?.trim() || null, notes: input.notes?.trim() || null } });
    await audit(tx, actor, { action: 'VENDOR_CREATED', entityType: 'Vendor', entityId: vendor.id });
    return vendor;
  }), 'VENDOR_NAME_CONFLICT');
}

export async function updateVendor(prisma: PrismaClient, actor: PurchasingActor, vendorId: string, input: {
  name?: string; contactName?: string | null; email?: string | null; phone?: string | null; address?: Prisma.InputJsonObject | null;
  accountReference?: string | null; notes?: string | null; active?: boolean;
}) {
  return withUniqueConflict(() => prisma.$transaction(async (tx) => {
    const before = await tx.vendor.findFirst({ where: { id: vendorId, organizationId: actor.organizationId } });
    if (!before) throw new PosError('VENDOR_NOT_FOUND', 404);
    const vendor = await tx.vendor.update({ where: { id: vendorId }, data: {
      ...(input.name === undefined ? {} : { name: required(input.name, 'VENDOR_NAME_REQUIRED') }),
      ...(input.contactName === undefined ? {} : { contactName: input.contactName?.trim() || null }),
      ...(input.email === undefined ? {} : { email: input.email?.trim() || null }),
      ...(input.phone === undefined ? {} : { phone: input.phone?.trim() || null }),
      ...(input.address === undefined ? {} : { addressJson: input.address ?? Prisma.DbNull }),
      ...(input.accountReference === undefined ? {} : { accountReference: input.accountReference?.trim() || null }),
      ...(input.notes === undefined ? {} : { notes: input.notes?.trim() || null }),
      ...(input.active === undefined ? {} : { active: input.active }),
    } });
    await audit(tx, actor, { action: input.active === false ? 'VENDOR_DEACTIVATED' : 'VENDOR_UPDATED',
      entityType: 'Vendor', entityId: vendor.id, before: { name: before.name, active: before.active }, after: { name: vendor.name, active: vendor.active } });
    return vendor;
  }), 'VENDOR_UPDATE_CONFLICT');
}

export async function listVendorMappings(prisma: PrismaClient, actor: PurchasingActor, input: PageInput & { vendorId?: string; search?: string }) {
  const { page, pageSize, skip } = pageArgs(input);
  const where: Prisma.VendorProductMappingWhereInput = { organizationId: actor.organizationId,
    ...(input.vendorId ? { vendorId: input.vendorId } : {}),
    ...(input.search?.trim() ? { variant: { OR: [
      { sku: { contains: input.search.trim(), mode: 'insensitive' } },
      { product: { name: { contains: input.search.trim(), mode: 'insensitive' } } },
      { barcodes: { some: { barcodeValue: { contains: input.search.trim() } } } },
    ] } } : {}) };
  const [items, total] = await Promise.all([
    prisma.vendorProductMapping.findMany({ where, include: { vendor: true, variant: { include: { product: true, barcodes: true } } }, orderBy: [{ preferred: 'desc' }, { updatedAt: 'desc' }], skip, take: pageSize }),
    prisma.vendorProductMapping.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function saveVendorMapping(prisma: PrismaClient, actor: PurchasingActor, input: {
  id?: string; vendorId: string; variantId: string; vendorSku?: string; vendorCostMinor: string; casePackQuantity?: number; minimumOrderQuantity?: number; preferred?: boolean; active?: boolean;
}) {
  const vendorCostMinor = money(input.vendorCostMinor, 'VENDOR_COST_INVALID');
  return withUniqueConflict(() => prisma.$transaction(async (tx) => {
    const [vendor, variant] = await Promise.all([
      tx.vendor.findFirst({ where: { id: input.vendorId, organizationId: actor.organizationId, active: true } }),
      tx.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId, active: true } }),
    ]);
    if (!vendor) throw new PosError('VENDOR_NOT_FOUND', 404);
    if (!variant) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
    const existing = input.id ? await tx.vendorProductMapping.findFirst({
      where: { id: input.id, organizationId: actor.organizationId, vendorId: vendor.id, variantId: variant.id },
    }) : null;
    if (input.id && !existing) throw new PosError('VENDOR_MAPPING_NOT_FOUND', 404);
    const casePackQuantity = input.casePackQuantity ?? existing?.casePackQuantity ?? 1;
    const minimumOrderQuantity = input.minimumOrderQuantity ?? existing?.minimumOrderQuantity ?? 1;
    if (!Number.isSafeInteger(casePackQuantity) || casePackQuantity < 1 || !Number.isSafeInteger(minimumOrderQuantity) || minimumOrderQuantity < 1) throw new PosError('VENDOR_PACK_INVALID');
    const active = input.active ?? existing?.active ?? true;
    if (input.preferred === true && !active) throw new PosError('VENDOR_PREFERRED_INACTIVE');
    const preferred = active ? input.preferred ?? existing?.preferred ?? false : false;
    if (preferred) await tx.vendorProductMapping.updateMany({ where: { organizationId: actor.organizationId, variantId: variant.id }, data: { preferred: false } });
    const data = { vendorSku: input.vendorSku === undefined ? existing?.vendorSku ?? null : input.vendorSku.trim() || null,
      vendorCostMinor, casePackQuantity, minimumOrderQuantity, preferred, active };
    const mapping = input.id
      ? await tx.vendorProductMapping.updateMany({ where: { id: input.id, organizationId: actor.organizationId }, data })
        .then(async (result) => result.count ? tx.vendorProductMapping.findUniqueOrThrow({ where: { id: input.id! } }) : null)
      : await tx.vendorProductMapping.create({ data: { organizationId: actor.organizationId, vendorId: vendor.id, variantId: variant.id, ...data } });
    if (!mapping) throw new PosError('VENDOR_MAPPING_NOT_FOUND', 404);
    await audit(tx, actor, { action: input.active === false ? 'VENDOR_MAPPING_DEACTIVATED' : 'VENDOR_MAPPING_SAVED',
      entityType: 'VendorProductMapping', entityId: mapping.id, metadata: { vendorId: vendor.id, variantId: variant.id } });
    return mapping;
  }), 'VENDOR_MAPPING_CONFLICT');
}

export async function listPurchaseOrders(prisma: PrismaClient, actor: PurchasingActor, input: PageInput & { search?: string; status?: string; storeId?: string }) {
  const { page, pageSize, skip } = pageArgs(input);
  if (actor.storeId && input.storeId && actor.storeId !== input.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
  const storeId = input.storeId ?? actor.storeId;
  const statuses = ['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];
  if (input.status && !statuses.includes(input.status)) throw new PosError('PURCHASE_ORDER_STATUS_INVALID');
  const status = input.status as PurchaseOrderStatus | undefined;
  const where: Prisma.PurchaseOrderWhereInput = { organizationId: actor.organizationId,
    ...(storeId ? { storeId } : {}), ...(status ? { status } : {}),
    ...(input.search?.trim() ? { OR: [{ poNumber: { contains: input.search.trim(), mode: 'insensitive' } }, { vendor: { name: { contains: input.search.trim(), mode: 'insensitive' } } }] } : {}) };
  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({ where, include: { vendor: true, store: true, lines: true, _count: { select: { receipts: true } } }, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return { items: items.map((order) => ({ ...order, totalMinor: order.lines.reduce((sum, line) => sum + line.unitCostMinor * BigInt(line.orderedQuantity), 0n).toString() })), total, page, pageSize };
}

async function addOrderLines(tx: Tx, actor: PurchasingActor, purchaseOrderId: string, vendorId: string, lines: Array<{
  variantId: string; quantity: number; vendorProductMappingId?: string; unitCostMinor?: string;
}>) {
  if (!lines.length) throw new PosError('PURCHASE_ORDER_LINES_REQUIRED');
  const distinct = new Set(lines.map((line) => line.variantId));
  if (distinct.size !== lines.length) throw new PosError('PURCHASE_ORDER_LINE_DUPLICATE');
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new PosError('PURCHASE_ORDER_QUANTITY_INVALID');
    const variant = await tx.productVariant.findFirst({ where: { id: line.variantId, organizationId: actor.organizationId, active: true },
      include: { product: true } });
    if (!variant) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
    const mapping = line.vendorProductMappingId
      ? await tx.vendorProductMapping.findFirst({ where: { id: line.vendorProductMappingId, organizationId: actor.organizationId, vendorId, variantId: variant.id, active: true } })
      : await tx.vendorProductMapping.findFirst({ where: { organizationId: actor.organizationId, vendorId, variantId: variant.id, active: true } });
    if (line.vendorProductMappingId && !mapping) throw new PosError('VENDOR_MAPPING_NOT_FOUND', 404);
    const cost = line.unitCostMinor === undefined
      ? mapping?.vendorCostMinor
      : money(line.unitCostMinor, 'PURCHASE_ORDER_COST_INVALID');
    if (cost === undefined) throw new PosError('PURCHASE_ORDER_COST_REQUIRED');
    const minimum = mapping?.minimumOrderQuantity ?? 1;
    if (line.quantity < minimum) throw new PosError('PURCHASE_ORDER_MINIMUM_NOT_MET');
    if (mapping && line.quantity % mapping.casePackQuantity !== 0) throw new PosError('PURCHASE_ORDER_CASE_PACK_INVALID');
    await tx.purchaseOrderLine.create({ data: { organizationId: actor.organizationId, purchaseOrderId, variantId: variant.id,
      productNameSnapshot: variant.product.name, variantNameSnapshot: variant.name, skuSnapshot: variant.sku,
      vendorSkuSnapshot: mapping?.vendorSku ?? null, orderedQuantity: line.quantity, unitCostMinor: cost } });
  }
}

export async function createPurchaseOrder(prisma: PrismaClient, actor: PurchasingActor, input: {
  storeId?: string; vendorId: string; poNumber: string; notes?: string;
  lines: Array<{ variantId: string; quantity: number; vendorProductMappingId?: string; unitCostMinor?: string }>;
}) {
  const storeId = input.storeId ?? actor.storeId;
  if (!storeId || (actor.storeId && actor.storeId !== storeId)) throw new PosError('STORE_ACCESS_DENIED', 403);
  const poNumber = required(input.poNumber, 'PURCHASE_ORDER_NUMBER_REQUIRED');
  return withUniqueConflict(() => prisma.$transaction(async (tx) => {
    const [store, vendor, employee] = await Promise.all([
      tx.store.findFirst({ where: { id: storeId, organizationId: actor.organizationId, status: 'ACTIVE' } }),
      tx.vendor.findFirst({ where: { id: input.vendorId, organizationId: actor.organizationId, active: true } }),
      tx.employee.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId, status: 'ACTIVE' } }),
    ]);
    if (!store) throw new PosError('STORE_NOT_FOUND', 404);
    if (!vendor) throw new PosError('VENDOR_NOT_FOUND', 404);
    if (!employee) throw new PosError('PURCHASE_ORDER_CREATOR_NOT_FOUND', 403);
    const order = await tx.purchaseOrder.create({ data: { organizationId: actor.organizationId, storeId, vendorId: vendor.id,
      createdByEmployeeId: employee.id, poNumber, notes: input.notes?.trim() || null } });
    await addOrderLines(tx, actor, order.id, vendor.id, input.lines);
    await audit(tx, actor, { action: 'PURCHASE_ORDER_CREATED', entityType: 'PurchaseOrder', entityId: order.id, storeId,
      after: { poNumber, vendorId: vendor.id } });
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { vendor: true, store: true, lines: true } });
  }), 'PURCHASE_ORDER_NUMBER_CONFLICT');
}

export async function updateDraftPurchaseOrder(prisma: PrismaClient, actor: PurchasingActor, purchaseOrderId: string, input: {
  vendorId?: string; poNumber?: string; notes?: string | null; lines?: Array<{ variantId: string; quantity: number; vendorProductMappingId?: string; unitCostMinor?: string }>;
}) {
  return withUniqueConflict(() => prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; storeId: string }>>`
      SELECT "id", "status", "storeId" FROM "PurchaseOrder"
      WHERE "id" = ${purchaseOrderId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE
    `;
    const lockedOrder = rows[0];
    if (!lockedOrder) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
    if (actor.storeId && actor.storeId !== lockedOrder.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
    if (lockedOrder.status !== 'DRAFT') throw new PosError('PURCHASE_ORDER_NOT_DRAFT', 409);
    const order = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId }, include: { lines: true } });
    const vendorId = input.vendorId ?? order.vendorId;
    if (input.vendorId && !await tx.vendor.findFirst({ where: { id: vendorId, organizationId: actor.organizationId, active: true } })) throw new PosError('VENDOR_NOT_FOUND', 404);
    const updated = await tx.purchaseOrder.update({ where: { id: order.id }, data: {
      vendorId, ...(input.poNumber === undefined ? {} : { poNumber: required(input.poNumber, 'PURCHASE_ORDER_NUMBER_REQUIRED') }),
      ...(input.notes === undefined ? {} : { notes: input.notes?.trim() || null }),
    } });
    if (input.lines) {
      await tx.purchaseOrderLine.deleteMany({ where: { organizationId: actor.organizationId, purchaseOrderId: order.id } });
      await addOrderLines(tx, actor, order.id, vendorId, input.lines);
    }
    await audit(tx, actor, { action: 'PURCHASE_ORDER_DRAFT_UPDATED', entityType: 'PurchaseOrder', entityId: order.id, storeId: order.storeId });
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: updated.id }, include: { vendor: true, store: true, lines: true } });
  }), 'PURCHASE_ORDER_UPDATE_CONFLICT');
}

export async function transitionPurchaseOrder(prisma: PrismaClient, actor: PurchasingActor, purchaseOrderId: string, transition: 'SUBMIT' | 'CANCEL') {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; storeId: string }>>`
      SELECT "id", "status", "storeId" FROM "PurchaseOrder"
      WHERE "id" = ${purchaseOrderId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE
    `;
    const order = rows[0];
    if (!order) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
    if (actor.storeId && actor.storeId !== order.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
    let status: 'SUBMITTED' | 'CANCELLED';
    if (transition === 'SUBMIT') {
      if (order.status !== 'DRAFT') throw new PosError('PURCHASE_ORDER_TRANSITION_INVALID', 409);
      if (!await tx.purchaseOrderLine.count({ where: { organizationId: actor.organizationId, purchaseOrderId } })) throw new PosError('PURCHASE_ORDER_LINES_REQUIRED');
      status = 'SUBMITTED';
    } else {
      if (!['DRAFT', 'SUBMITTED'].includes(order.status)) throw new PosError('PURCHASE_ORDER_TRANSITION_INVALID', 409);
      status = 'CANCELLED';
    }
    const updated = await tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: {
      status, ...(status === 'SUBMITTED' ? { submittedAt: new Date() } : { cancelledAt: new Date() }),
    } });
    await audit(tx, actor, { action: `PURCHASE_ORDER_${status}`, entityType: 'PurchaseOrder', entityId: updated.id, storeId: updated.storeId });
    return updated;
  });
}

type ReceiptLineInput = { purchaseOrderLineId: string; deliveredQuantity: number; damagedQuantity?: number; rejectedQuantity?: number; unitCostMinor?: string };

export async function receivePurchaseOrder(prisma: PrismaClient, actor: PurchasingActor, purchaseOrderId: string, input: {
  idempotencyKey: string; vendorReferenceNumber?: string; notes?: string; lines: ReceiptLineInput[];
}) {
  const idempotencyKey = required(input.idempotencyKey, 'RECEIPT_IDEMPOTENCY_KEY_REQUIRED');
  if (!input.lines.length) throw new PosError('RECEIPT_LINES_REQUIRED');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    purchaseOrderId,
    vendorReferenceNumber: input.vendorReferenceNumber?.trim() ?? '',
    notes: input.notes?.trim() ?? '',
    lines: input.lines.map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId, deliveredQuantity: line.deliveredQuantity,
      damagedQuantity: line.damagedQuantity ?? 0, rejectedQuantity: line.rejectedQuantity ?? 0,
      unitCostMinor: line.unitCostMinor ?? null,
    })).sort((a, b) => a.purchaseOrderLineId.localeCompare(b.purchaseOrderLineId)),
  })).digest('hex');
  return withUniqueConflict(() => prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; storeId: string }>>`
      SELECT "id", "status", "storeId" FROM "PurchaseOrder"
      WHERE "id" = ${purchaseOrderId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE
    `;
    const order = rows[0];
    if (!order) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
    if (actor.storeId && actor.storeId !== order.storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
    const prior = await tx.purchaseReceipt.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey } }, include: { lines: true } });
    if (prior) {
      if (prior.purchaseOrderId !== purchaseOrderId || prior.requestFingerprint !== fingerprint) throw new PosError('RECEIPT_IDEMPOTENCY_CONFLICT', 409);
      return prior;
    }
    if (order.status !== 'SUBMITTED' && order.status !== 'PARTIALLY_RECEIVED') throw new PosError('PURCHASE_ORDER_NOT_RECEIVABLE', 409);
    const duplicateLines = new Set(input.lines.map((line) => line.purchaseOrderLineId));
    if (duplicateLines.size !== input.lines.length) throw new PosError('RECEIPT_LINE_DUPLICATE');
    const [purchaseOrder, receiver] = await Promise.all([
      tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId }, include: { lines: true } }),
      tx.employee.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId, status: 'ACTIVE',
        stores: { some: { storeId: order.storeId } } } }),
    ]);
    if (!receiver) throw new PosError('RECEIPT_RECEIVER_STORE_ACCESS_DENIED', 403);
    const byId = new Map(purchaseOrder.lines.map((line) => [line.id, line]));
    for (const line of input.lines) {
      const orderLine = byId.get(line.purchaseOrderLineId);
      if (!orderLine) throw new PosError('PURCHASE_ORDER_LINE_NOT_FOUND', 404);
      if (!Number.isSafeInteger(line.deliveredQuantity) || line.deliveredQuantity <= 0
        || !Number.isSafeInteger(line.damagedQuantity ?? 0) || (line.damagedQuantity ?? 0) < 0
        || !Number.isSafeInteger(line.rejectedQuantity ?? 0) || (line.rejectedQuantity ?? 0) < 0
        || (line.damagedQuantity ?? 0) + (line.rejectedQuantity ?? 0) > line.deliveredQuantity) {
        throw new PosError('RECEIPT_QUANTITY_INVALID');
      }
      if (line.deliveredQuantity > orderLine.orderedQuantity - orderLine.receivedQuantity) throw new PosError('RECEIPT_OVER_ORDERED_QUANTITY', 409);
      if (line.unitCostMinor !== undefined) money(line.unitCostMinor, 'RECEIPT_COST_INVALID');
    }
    const receipt = await tx.purchaseReceipt.create({ data: { organizationId: actor.organizationId, purchaseOrderId,
      receivedByEmployeeId: receiver.id, idempotencyKey, requestFingerprint: fingerprint,
      vendorReferenceNumber: input.vendorReferenceNumber?.trim() || null, notes: input.notes?.trim() || null } });
    for (const line of input.lines) {
      const orderLine = byId.get(line.purchaseOrderLineId)!;
      const accepted = line.deliveredQuantity - (line.damagedQuantity ?? 0) - (line.rejectedQuantity ?? 0);
      const unitCostMinor = line.unitCostMinor === undefined ? orderLine.unitCostMinor : BigInt(line.unitCostMinor);
      const receiptLine = await tx.purchaseReceiptLine.create({ data: { organizationId: actor.organizationId, receiptId: receipt.id,
        purchaseOrderLineId: orderLine.id, deliveredQuantity: line.deliveredQuantity, damagedQuantity: line.damagedQuantity ?? 0,
        rejectedQuantity: line.rejectedQuantity ?? 0, unitCostMinor } });
      await tx.purchaseOrderLine.update({ where: { id: orderLine.id }, data: { receivedQuantity: { increment: line.deliveredQuantity } } });
      if (accepted > 0) {
        const level = await tx.inventoryLevel.upsert({
          where: { organizationId_storeId_variantId: { organizationId: actor.organizationId, storeId: order.storeId, variantId: orderLine.variantId } },
          create: { organizationId: actor.organizationId, storeId: order.storeId, variantId: orderLine.variantId, onHand: accepted },
          update: { onHand: { increment: accepted } },
        });
        await tx.inventoryMovement.create({ data: { organizationId: actor.organizationId, storeId: order.storeId, variantId: orderLine.variantId,
          quantityDelta: accepted, type: 'PURCHASE_RECEIPT', referenceType: 'PURCHASE_RECEIPT', referenceId: receipt.id,
          reason: `Purchase order ${purchaseOrder.poNumber}`, resultingOnHand: level.onHand, employeeId: receiver.id } });
      }
      await tx.outboxEvent.create({ data: { organizationId: actor.organizationId, aggregateType: 'PurchaseReceipt',
        aggregateId: receipt.id, eventType: 'PURCHASE_RECEIPT_LINE_RECORDED',
        payload: { receiptId: receipt.id, receiptLineId: receiptLine.id, purchaseOrderId, variantId: orderLine.variantId,
          deliveredQuantity: line.deliveredQuantity, acceptedQuantity: accepted, damagedQuantity: line.damagedQuantity ?? 0,
          rejectedQuantity: line.rejectedQuantity ?? 0, unitCostMinor: unitCostMinor.toString() } } });
    }
    const updatedLines = await tx.purchaseOrderLine.findMany({ where: { organizationId: actor.organizationId, purchaseOrderId } });
    const allReceived = updatedLines.every((line) => line.receivedQuantity === line.orderedQuantity);
    const anyReceived = updatedLines.some((line) => line.receivedQuantity > 0);
    const status = allReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'SUBMITTED';
    await tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: {
      status, ...(allReceived ? { receivedAt: new Date() } : {}),
    } });
    await audit(tx, actor, { action: 'PURCHASE_ORDER_RECEIVED', entityType: 'PurchaseOrder', entityId: purchaseOrderId, storeId: order.storeId,
      metadata: { receiptId: receipt.id, lineCount: input.lines.length } });
    await tx.outboxEvent.create({ data: { organizationId: actor.organizationId, aggregateType: 'PurchaseOrder', aggregateId: purchaseOrderId,
      eventType: 'PURCHASE_ORDER_RECEIPT_POSTED', payload: { purchaseOrderId, receiptId: receipt.id, status } } });
    return tx.purchaseReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { lines: true } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }), 'RECEIPT_IDEMPOTENCY_CONFLICT');
}

export async function getPurchaseOrder(prisma: PrismaClient, actor: PurchasingActor, purchaseOrderId: string) {
  const order = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, organizationId: actor.organizationId,
    ...(actor.storeId ? { storeId: actor.storeId } : {}) },
    include: { vendor: true, store: true, createdBy: true, lines: { include: { variant: { include: { product: true } }, receiptLines: { include: { receipt: { include: { receivedBy: true } } } } } },
      receipts: { include: { receivedBy: true, lines: true }, orderBy: { receivedAt: 'desc' } } } });
  if (!order) throw new PosError('PURCHASE_ORDER_NOT_FOUND', 404);
  const totalMinor = order.lines.reduce((sum, line) => sum + line.unitCostMinor * BigInt(line.orderedQuantity), 0n);
  return { ...order, totalMinor: totalMinor.toString() };
}

export async function listReceivingHistory(prisma: PrismaClient, actor: PurchasingActor, input: PageInput & { purchaseOrderId?: string }) {
  const { page, pageSize, skip } = pageArgs(input);
  const where: Prisma.PurchaseReceiptWhereInput = { organizationId: actor.organizationId,
    ...(actor.storeId ? { purchaseOrder: { storeId: actor.storeId } } : {}),
    ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}) };
  const [items, total] = await Promise.all([
    prisma.purchaseReceipt.findMany({ where, include: { purchaseOrder: { include: { vendor: true, store: true } },
      receivedBy: true, lines: { include: { purchaseOrderLine: true } } }, orderBy: { receivedAt: 'desc' }, skip, take: pageSize }),
    prisma.purchaseReceipt.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

async function audit(client: Tx | PrismaClient, actor: PurchasingActor, data: {
  action: string; entityType: string; entityId: string; storeId?: string; before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue; metadata?: Prisma.InputJsonValue;
}) {
  return client.auditRecord.create({ data: { organizationId: actor.organizationId, userId: actor.userId, action: data.action,
    entityType: data.entityType, entityId: data.entityId, ...(data.storeId || actor.storeId ? { storeId: data.storeId ?? actor.storeId } : {}),
    ...(data.before === undefined ? {} : { beforeJson: data.before }), ...(data.after === undefined ? {} : { afterJson: data.after }),
    ...(data.metadata === undefined ? {} : { metadataJson: data.metadata }) } });
}
