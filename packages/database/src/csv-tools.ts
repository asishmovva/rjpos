import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { normalizeEmail, normalizePhone } from './phase-three.js';
import { PosError } from './pos-errors.js';
import { parseCsv } from './purchasing.js';
import { writeAudit } from './tax-profiles.js';

type Tx = Prisma.TransactionClient;
export const CSV_KINDS = ['products', 'pricing', 'vendors', 'inventory', 'customers'] as const;
export type CsvKind = (typeof CSV_KINDS)[number];
const MAX_ROWS = 5_000;
const EXPORT_LIMIT = 20_000;
const PREVIEW_ROWS = 200;

// ---- Export ----------------------------------------------------------------------------------------------------------
/** Quotes every cell and neutralizes spreadsheet formulas (leading = + - @) so an exported file cannot run code when opened. */
const cell = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""').replace(/^[=+\-@\t\r]/, "'$&")}"`;
const toCsv = (headers: string[], rows: Array<Record<string, unknown>>): string => [headers.map(cell).join(','), ...rows.map((row) => headers.map((header) => cell(row[header])).join(','))].join('\r\n');
const dollars = (minor: bigint | null | undefined): string => (minor === null || minor === undefined ? '' : `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`);

export async function exportCsv(prisma: PrismaClient, actor: AdminActor, kind: CsvKind, input: { storeId?: string } = {}): Promise<string> {
  if (!CSV_KINDS.includes(kind)) throw new PosError('CSV_KIND_INVALID');
  const org = actor.organizationId; const storeId = input.storeId ?? actor.storeId;
  if (actor.storeId && storeId && actor.storeId !== storeId) throw new PosError('STORE_ACCESS_DENIED', 403);
  if (kind === 'vendors') {
    const vendors = await prisma.vendor.findMany({ where: { organizationId: org }, orderBy: { name: 'asc' }, take: EXPORT_LIMIT });
    return toCsv(['name', 'contact_name', 'email', 'phone', 'account_reference', 'notes', 'active'], vendors.map((vendor) => ({ name: vendor.name, contact_name: vendor.contactName, email: vendor.email, phone: vendor.phone, account_reference: vendor.accountReference, notes: vendor.notes, active: vendor.active })));
  }
  if (kind === 'customers') {
    const customers = await prisma.customer.findMany({ where: { organizationId: org }, orderBy: { name: 'asc' }, take: EXPORT_LIMIT });
    return toCsv(['name', 'email', 'phone', 'notes', 'active'], customers.map((customer) => ({ name: customer.name, email: customer.email, phone: customer.phone, notes: customer.notes, active: customer.active })));
  }
  const variants = await prisma.productVariant.findMany({ where: { organizationId: org }, take: EXPORT_LIMIT, orderBy: [{ product: { name: 'asc' } }, { unitsPerPack: 'asc' }],
    include: { product: { include: { category: true, taxProfile: true } }, taxProfile: true, barcodes: { where: { kind: 'PRIMARY' }, take: 1 }, baseVariant: { select: { sku: true } },
      vendorMappings: { where: { active: true }, orderBy: { preferred: 'desc' }, take: 1, include: { vendor: true } },
      ...(storeId ? { prices: { where: { storeId, effectiveFrom: { lte: new Date() }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] }, orderBy: { effectiveFrom: 'desc' as const }, take: 1 } } : {}) } });
  const ident = (variant: (typeof variants)[number]) => ({ upc: variant.barcodes[0]?.barcodeValue ?? '', sku: variant.sku, product_name: variant.product.name, variant_name: variant.name });
  if (kind === 'products') {
    return toCsv(['upc', 'sku', 'product_name', 'variant_name', 'brand', 'category', 'tax_profile', 'active', 'units_per_pack', 'base_sku', 'vendor', 'vendor_sku', 'case_cost', 'units_per_case', 'price'],
      variants.map((variant) => { const mapping = variant.vendorMappings[0]; const priced = (variant as unknown as { prices?: Array<{ amountMinor: bigint }> }).prices?.[0];
        return { ...ident(variant), brand: variant.product.brand, category: variant.product.category.name, tax_profile: (variant.taxProfile ?? variant.product.taxProfile)?.name ?? '', active: variant.active && variant.product.active,
          units_per_pack: variant.unitsPerPack, base_sku: variant.baseVariant?.sku ?? '', vendor: mapping?.vendor.name ?? '', vendor_sku: mapping?.vendorSku ?? '', case_cost: dollars(mapping?.caseCostMinor), units_per_case: mapping?.casePackQuantity ?? '', price: dollars(priced?.amountMinor) }; }));
  }
  if (kind === 'pricing') {
    const special = await prisma.specialPrice.findMany({ where: { organizationId: org, active: true, ...(storeId ? { storeId } : {}) }, include: { priceBook: true, store: true, variant: { include: { product: true, barcodes: { where: { kind: 'PRIMARY' }, take: 1 } } } }, take: EXPORT_LIMIT });
    const store = storeId ? await prisma.store.findFirst({ where: { id: storeId, organizationId: org } }) : null;
    return toCsv(['upc', 'sku', 'product_name', 'variant_name', 'store', 'price_book', 'price'], [
      ...variants.map((variant) => ({ ...ident(variant), store: store?.name ?? '', price_book: '', price: dollars((variant as unknown as { prices?: Array<{ amountMinor: bigint }> }).prices?.[0]?.amountMinor) })),
      ...special.map((row) => ({ upc: row.variant.barcodes[0]?.barcodeValue ?? '', sku: row.variant.sku, product_name: row.variant.product.name, variant_name: row.variant.name, store: row.store.name, price_book: row.priceBook.name, price: dollars(row.amountMinor) })),
    ]);
  }
  const levels = await prisma.inventoryLevel.findMany({ where: { organizationId: org, ...(storeId ? { storeId } : {}) }, include: { store: true, variant: { include: { product: true, barcodes: { where: { kind: 'PRIMARY' }, take: 1 } } } }, take: EXPORT_LIMIT, orderBy: { variant: { product: { name: 'asc' } } } });
  return toCsv(['upc', 'sku', 'product_name', 'variant_name', 'store', 'on_hand', 'reserved', 'low_stock_threshold', 'reorder_target'], levels.map((level) => ({ upc: level.variant.barcodes[0]?.barcodeValue ?? '', sku: level.variant.sku, product_name: level.variant.product.name, variant_name: level.variant.name,
    store: level.store.name, on_hand: level.onHand, reserved: level.reserved, low_stock_threshold: level.lowStockThreshold, reorder_target: level.reorderTarget })));
}

// ---- Import (validate → preview → commit) ---------------------------------------------------------------------------------
export type ImportRow = { line: number; action: 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR'; key: string; message?: string };
export type ImportPreview = { kind: CsvKind; total: number; create: number; update: number; skip: number; errors: number; rows: ImportRow[]; truncated: boolean };
type Record_ = Record<string, string>;
type Options = { storeId?: string; createCategories?: boolean };
type Planned = { row: ImportRow; run?: (tx: Tx) => Promise<void> };

function readRecords(csv: string, required: string[]): Array<{ line: number; values: Record_ }> {
  if (typeof csv !== 'string' || !csv.trim()) throw new PosError('CSV_EMPTY');
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  if (rows.length < 2) throw new PosError('CSV_EMPTY');
  const header = rows[0]!.fields.map((field) => field.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  if (new Set(header).size !== header.length) throw new PosError('CSV_DUPLICATE_HEADERS');
  const missing = required.filter((name) => !header.includes(name));
  if (missing.length) throw new PosError('CSV_HEADERS_REQUIRED');
  if (rows.length - 1 > MAX_ROWS) throw new PosError('CSV_TOO_MANY_ROWS');
  return rows.slice(1).map((row) => ({ line: row.line, values: Object.fromEntries(header.map((name, index) => [name, (row.fields[index] ?? '').trim()])) }));
}
const bool = (value: string | undefined): boolean | null => (value === undefined || value === '' ? null : /^(true|yes|1|active)$/i.test(value) ? true : /^(false|no|0|inactive)$/i.test(value) ? false : null);
const moneyOf = (value: string | undefined): bigint | null => {
  const match = /^\$?(\d{1,10})(?:\.(\d{1,2}))?$/.exec((value ?? '').trim());
  return match ? BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0') : null;
};
const err = (line: number, key: string, message: string): Planned => ({ row: { line, action: 'ERROR', key, message } });

async function planCustomers(tx: Tx, actor: AdminActor, records: ReturnType<typeof readRecords>): Promise<Planned[]> {
  const seen = new Set<string>(); const planned: Planned[] = [];
  for (const { line, values } of records) {
    const key = values.name || `line ${line}`;
    if (!values.name) { planned.push(err(line, key, 'Name is required')); continue; }
    let email: string | null; let phone: string | null;
    try { email = normalizeEmail(values.email); phone = normalizePhone(values.phone); } catch (error) { planned.push(err(line, key, error instanceof PosError ? error.code.replace(/_/g, ' ').toLowerCase() : 'Invalid contact')); continue; }
    const identity = email ?? phone ?? `name:${values.name.toLowerCase()}`;
    if (seen.has(identity)) { planned.push(err(line, key, 'Duplicate of another row in this file')); continue; }
    seen.add(identity);
    const existing = await tx.customer.findFirst({ where: { organizationId: actor.organizationId, OR: [...(email ? [{ emailNormalized: email }] : []), ...(phone ? [{ phoneNormalized: phone }] : []), ...(!email && !phone ? [{ name: { equals: values.name, mode: 'insensitive' as const } }] : [])] } });
    if (existing) {
      const changed = (values.notes && values.notes !== existing.notes) || (email && !existing.email) || (phone && !existing.phone) || values.name !== existing.name;
      planned.push(changed ? { row: { line, action: 'UPDATE', key }, run: async (client) => { await client.customer.update({ where: { id: existing.id }, data: { name: values.name!, ...(values.notes ? { notes: values.notes } : {}), ...(email && !existing.email ? { email: values.email!, emailNormalized: email } : {}), ...(phone && !existing.phone ? { phone: values.phone!, phoneNormalized: phone } : {}) } }); } } : { row: { line, action: 'SKIP', key, message: 'Already exists, no changes' } });
      continue;
    }
    planned.push({ row: { line, action: 'CREATE', key }, run: async (client) => { await client.customer.create({ data: { organizationId: actor.organizationId, name: values.name!, email: values.email || null, phone: values.phone || null, emailNormalized: email, phoneNormalized: phone, notes: values.notes || null, storeId: actor.storeId ?? null } }); } });
  }
  return planned;
}

async function planVendors(tx: Tx, actor: AdminActor, records: ReturnType<typeof readRecords>): Promise<Planned[]> {
  const seen = new Set<string>(); const planned: Planned[] = [];
  for (const { line, values } of records) {
    const key = values.name || `line ${line}`;
    if (!values.name || values.name.length > 80) { planned.push(err(line, key, 'Name is required (80 characters max)')); continue; }
    if (seen.has(values.name.toLowerCase())) { planned.push(err(line, key, 'Duplicate of another row in this file')); continue; }
    seen.add(values.name.toLowerCase());
    if (values.email && !/^[^\s@]+@[^\s@]+$/.test(values.email)) { planned.push(err(line, key, 'Email looks invalid')); continue; }
    const active = bool(values.active);
    const existing = await tx.vendor.findFirst({ where: { organizationId: actor.organizationId, name: { equals: values.name, mode: 'insensitive' } } });
    const data = { ...(values.contact_name ? { contactName: values.contact_name } : {}), ...(values.email ? { email: values.email } : {}), ...(values.phone ? { phone: values.phone } : {}), ...(values.account_reference ? { accountReference: values.account_reference } : {}), ...(values.notes ? { notes: values.notes } : {}), ...(active === null ? {} : { active }) };
    if (existing) {
      const changed = Object.entries(data).some(([field, value]) => (existing as Record<string, unknown>)[field] !== value);
      planned.push(changed ? { row: { line, action: 'UPDATE', key }, run: async (client) => { await client.vendor.update({ where: { id: existing.id }, data }); } } : { row: { line, action: 'SKIP', key, message: 'Already exists, no changes' } });
    } else planned.push({ row: { line, action: 'CREATE', key }, run: async (client) => { await client.vendor.create({ data: { organizationId: actor.organizationId, name: values.name!, ...data } }); } });
  }
  return planned;
}

async function findVariant(tx: Tx, org: string, values: Record_) {
  const include = { product: true, barcodes: { where: { kind: 'PRIMARY' as const }, take: 1 } };
  if (values.upc) { const barcode = await tx.barcode.findFirst({ where: { organizationId: org, barcodeValue: values.upc }, include: { variant: { include } } }); if (barcode) return barcode.variant; }
  if (values.sku) return tx.productVariant.findFirst({ where: { organizationId: org, sku: values.sku.toUpperCase() }, include });
  return null;
}
async function resolveStore(tx: Tx, actor: AdminActor, values: Record_, options: Options) {
  const stores = await tx.store.findMany({ where: { organizationId: actor.organizationId, ...(actor.storeId ? { id: actor.storeId } : {}) } });
  if (values.store) return stores.find((store) => store.name.toLowerCase() === values.store!.toLowerCase()) ?? null;
  return stores.find((store) => store.id === (options.storeId ?? actor.storeId)) ?? (stores.length === 1 ? stores[0]! : null);
}

async function planPricing(tx: Tx, actor: AdminActor, records: ReturnType<typeof readRecords>, options: Options): Promise<Planned[]> {
  const planned: Planned[] = []; const seen = new Set<string>(); const now = new Date();
  for (const { line, values } of records) {
    const key = values.upc || values.sku || `line ${line}`;
    const price = moneyOf(values.price);
    if (!values.upc && !values.sku) { planned.push(err(line, key, 'UPC or SKU is required')); continue; }
    if (price === null) { planned.push(err(line, key, 'Price must be a non-negative amount such as 12.99')); continue; }
    const [variant, store] = await Promise.all([findVariant(tx, actor.organizationId, values), resolveStore(tx, actor, values, options)]);
    if (!variant) { planned.push(err(line, key, 'No product with that UPC/SKU. Import does not create products from the pricing file.')); continue; }
    if (!store) { planned.push(err(line, key, 'Store not found')); continue; }
    const book = values.price_book && !/^standard$/i.test(values.price_book) ? await tx.priceBook.findFirst({ where: { organizationId: actor.organizationId, name: { equals: values.price_book, mode: 'insensitive' } } }) : null;
    if (values.price_book && !/^standard$/i.test(values.price_book) && !book) { planned.push(err(line, key, `Price book "${values.price_book}" does not exist`)); continue; }
    const dedupe = `${variant.id}|${store.id}|${book?.id ?? 'standard'}`;
    if (seen.has(dedupe)) { planned.push(err(line, key, 'Duplicate price for the same item, store, and price book in this file')); continue; }
    seen.add(dedupe);
    if (book) {
      const existing = await tx.specialPrice.findFirst({ where: { organizationId: actor.organizationId, priceBookId: book.id, storeId: store.id, variantId: variant.id, active: true, effectiveFrom: null, effectiveTo: null } });
      if (existing?.amountMinor === price) { planned.push({ row: { line, action: 'SKIP', key, message: 'Price unchanged' } }); continue; }
      planned.push({ row: { line, action: existing ? 'UPDATE' : 'CREATE', key }, run: async (client) => {
        if (existing) await client.specialPrice.update({ where: { id: existing.id }, data: { amountMinor: price } });
        else await client.specialPrice.create({ data: { organizationId: actor.organizationId, priceBookId: book.id, storeId: store.id, variantId: variant.id, amountMinor: price } });
      } });
      continue;
    }
    const current = await tx.price.findFirst({ where: { organizationId: actor.organizationId, storeId: store.id, variantId: variant.id, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, orderBy: { effectiveFrom: 'desc' } });
    const future = await tx.price.findFirst({ where: { organizationId: actor.organizationId, storeId: store.id, variantId: variant.id, effectiveFrom: { gt: now } } });
    if (future) { planned.push(err(line, key, 'A future price is already scheduled for this item')); continue; }
    if (current?.amountMinor === price) { planned.push({ row: { line, action: 'SKIP', key, message: 'Price unchanged' } }); continue; }
    planned.push({ row: { line, action: current ? 'UPDATE' : 'CREATE', key }, run: async (client) => {
      if (current) await client.price.update({ where: { id: current.id }, data: { effectiveTo: now } });
      await client.price.create({ data: { organizationId: actor.organizationId, storeId: store.id, variantId: variant.id, amountMinor: price, effectiveFrom: now } });
    } });
  }
  return planned;
}

async function planInventory(tx: Tx, actor: AdminActor, records: ReturnType<typeof readRecords>, options: Options): Promise<Planned[]> {
  const planned: Planned[] = []; const seen = new Set<string>();
  for (const { line, values } of records) {
    const key = values.upc || values.sku || `line ${line}`;
    if (!values.upc && !values.sku) { planned.push(err(line, key, 'UPC or SKU is required')); continue; }
    const wantsQuantity = (values.quantity ?? values.on_hand ?? '') !== '';
    const quantityText = values.quantity ?? values.on_hand ?? '';
    const quantity = wantsQuantity ? (/^\d{1,9}$/.test(quantityText) ? Number(quantityText) : null) : undefined;
    const low = values.low_stock_threshold === undefined || values.low_stock_threshold === '' ? undefined : /^\d{1,9}$/.test(values.low_stock_threshold) ? Number(values.low_stock_threshold) : null;
    const target = values.reorder_target === undefined || values.reorder_target === '' ? undefined : /^\d{1,9}$/.test(values.reorder_target) ? Number(values.reorder_target) : null;
    if (quantity === null || low === null || target === null) { planned.push(err(line, key, 'Quantity and thresholds must be whole numbers 0 or more')); continue; }
    if (quantity === undefined && low === undefined && target === undefined) { planned.push(err(line, key, 'Nothing to import: give a quantity (opening balance) or thresholds')); continue; }
    const [variant, store] = await Promise.all([findVariant(tx, actor.organizationId, values), resolveStore(tx, actor, values, options)]);
    if (!variant) { planned.push(err(line, key, 'No product with that UPC/SKU')); continue; }
    if (!store) { planned.push(err(line, key, 'Store not found')); continue; }
    if (variant.baseVariantId) { planned.push(err(line, key, 'Pack variants sell from their base unit; import the base item')); continue; }
    if (!variant.product.inventoryTracked) { planned.push(err(line, key, 'Inventory is not tracked for this product')); continue; }
    const dedupe = `${variant.id}|${store.id}`;
    if (seen.has(dedupe)) { planned.push(err(line, key, 'Duplicate row for the same item and store')); continue; }
    seen.add(dedupe);
    const [level, initial] = await Promise.all([
      tx.inventoryLevel.findUnique({ where: { organizationId_storeId_variantId: { organizationId: actor.organizationId, storeId: store.id, variantId: variant.id } } }),
      tx.inventoryMovement.findFirst({ where: { organizationId: actor.organizationId, storeId: store.id, variantId: variant.id, type: 'INITIAL' } }),
    ]);
    // Stock is never overwritten: a quantity is accepted only as the one-time opening balance.
    if (quantity !== undefined && initial) { planned.push(err(line, key, 'Opening balance already recorded. Use an inventory adjustment or stock count to change stock.')); continue; }
    const nextLow = low ?? level?.lowStockThreshold ?? 0; const nextTarget = target ?? level?.reorderTarget ?? nextLow;
    if (nextTarget < nextLow) { planned.push(err(line, key, 'Reorder target must be at least the low-stock threshold')); continue; }
    planned.push({ row: { line, action: level ? 'UPDATE' : 'CREATE', key, message: quantity !== undefined ? `opening balance ${quantity}` : 'thresholds only' }, run: async (client) => {
      const saved = await client.inventoryLevel.upsert({ where: { organizationId_storeId_variantId: { organizationId: actor.organizationId, storeId: store.id, variantId: variant.id } },
        create: { organizationId: actor.organizationId, storeId: store.id, variantId: variant.id, onHand: quantity ?? 0, lowStockThreshold: nextLow, reorderTarget: nextTarget },
        update: { lowStockThreshold: nextLow, reorderTarget: nextTarget, ...(quantity ? { onHand: { increment: quantity } } : {}) } });
      await client.productVariant.update({ where: { id: variant.id }, data: { lowStockThreshold: nextLow } });
      if (quantity !== undefined) await client.inventoryMovement.create({ data: { organizationId: actor.organizationId, storeId: store.id, variantId: variant.id, employeeId: actor.userId, quantityDelta: quantity, type: 'INITIAL', referenceType: 'CSV_IMPORT', reason: 'Opening balance from CSV import', resultingOnHand: saved.onHand } });
    } });
  }
  return planned;
}

async function planProducts(tx: Tx, actor: AdminActor, records: ReturnType<typeof readRecords>, options: Options): Promise<Planned[]> {
  const planned: Planned[] = []; const upcs = new Set<string>(); const skus = new Set<string>();
  const categories = new Map((await tx.category.findMany({ where: { organizationId: actor.organizationId } })).map((category) => [category.name.toLowerCase(), category]));
  const profiles = new Map((await tx.taxProfile.findMany({ where: { organizationId: actor.organizationId, active: true } })).map((profile) => [profile.name.toLowerCase(), profile]));
  const newCategories = new Set<string>();
  for (const { line, values } of records) {
    const key = values.upc || values.sku || `line ${line}`;
    if (!values.upc && !values.sku) { planned.push(err(line, key, 'UPC or SKU is required')); continue; }
    if (values.upc && upcs.has(values.upc)) { planned.push(err(line, key, 'Duplicate UPC in this file')); continue; }
    if (values.sku && skus.has(values.sku.toUpperCase())) { planned.push(err(line, key, 'Duplicate SKU in this file')); continue; }
    if (values.upc) upcs.add(values.upc); if (values.sku) skus.add(values.sku.toUpperCase());
    const profile = values.tax_profile ? profiles.get(values.tax_profile.toLowerCase()) : undefined;
    if (values.tax_profile && !profile) { planned.push(err(line, key, `Tax profile "${values.tax_profile}" not found or inactive`)); continue; }
    const active = bool(values.active);
    const category = values.category ? categories.get(values.category.toLowerCase()) : undefined;
    if (values.category && !category && !options.createCategories) { planned.push(err(line, key, `Category "${values.category}" does not exist (tick "create missing categories" to add it)`)); continue; }
    const variant = await findVariant(tx, actor.organizationId, values);
    const categoryFor = async (client: Tx) => {
      if (!values.category) return undefined;
      const existing = categories.get(values.category.toLowerCase()) ?? await client.category.findFirst({ where: { organizationId: actor.organizationId, name: { equals: values.category, mode: 'insensitive' } } });
      if (existing) return existing.id;
      const created = await client.category.create({ data: { organizationId: actor.organizationId, name: values.category } });
      categories.set(values.category.toLowerCase(), created); return created.id;
    };
    if (values.category && !category) newCategories.add(values.category);
    if (variant) {
      if (active === true && variant.product.draft) { planned.push(err(line, key, 'This is an incomplete draft. Finish it on the product page before activating.')); continue; }
      const product = variant.product;
      const changes = (values.product_name && values.product_name !== product.name) || (values.brand && values.brand !== product.brand) || (category && category.id !== product.categoryId) || (values.category && !category)
        || (profile && profile.id !== product.taxProfileId) || (active !== null && active !== product.active);
      planned.push(changes ? { row: { line, action: 'UPDATE', key }, run: async (client) => {
        const categoryId = await categoryFor(client);
        await client.product.update({ where: { id: product.id }, data: { ...(values.product_name ? { name: values.product_name } : {}), ...(values.brand ? { brand: values.brand } : {}), ...(categoryId ? { categoryId } : {}), ...(profile ? { taxProfileId: profile.id } : {}), ...(active === null ? {} : { active }) } });
      } } : { row: { line, action: 'SKIP', key, message: 'No changes' } });
      continue;
    }
    // New items are created as inactive drafts: vendor, cost, and price are completed on the product page.
    if (!values.upc) { planned.push(err(line, key, 'A UPC is required to create a new product')); continue; }
    if (!values.product_name) { planned.push(err(line, key, 'Product name is required to create a new product')); continue; }
    if (!values.category) { planned.push(err(line, key, 'Category is required to create a new product')); continue; }
    if (!/^[A-Za-z0-9._-]{4,64}$/.test(values.upc)) { planned.push(err(line, key, 'UPC format is invalid')); continue; }
    const sku = (values.sku || `P-${values.upc}`).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(sku)) { planned.push(err(line, key, 'SKU format is invalid')); continue; }
    if (await tx.productVariant.findFirst({ where: { organizationId: actor.organizationId, sku } })) { planned.push(err(line, key, 'SKU already belongs to another item')); continue; }
    planned.push({ row: { line, action: 'CREATE', key, message: 'created as an inactive draft' }, run: async (client) => {
      const categoryId = (await categoryFor(client))!;
      const product = await client.product.create({ data: { organizationId: actor.organizationId, categoryId, name: values.product_name!, brand: values.brand || null, active: false, draft: true, ...(profile ? { taxProfileId: profile.id } : {}) } });
      const created = await client.productVariant.create({ data: { organizationId: actor.organizationId, productId: product.id, name: values.variant_name || 'Each', sku, active: false } });
      await client.barcode.create({ data: { organizationId: actor.organizationId, variantId: created.id, barcodeValue: values.upc! } });
    } });
  }
  if (newCategories.size) planned.unshift({ row: { line: 0, action: 'SKIP', key: 'categories', message: `Will create categories: ${[...newCategories].join(', ')}` } });
  return planned;
}

const PLANNERS: Record<CsvKind, { required: string[]; plan: (tx: Tx, actor: AdminActor, records: ReturnType<typeof readRecords>, options: Options) => Promise<Planned[]> }> = {
  customers: { required: ['name'], plan: planCustomers }, vendors: { required: ['name'], plan: planVendors }, pricing: { required: ['price'], plan: planPricing },
  inventory: { required: [], plan: planInventory }, products: { required: [], plan: planProducts },
};

function preview(kind: CsvKind, planned: Planned[]): ImportPreview {
  const count = (action: ImportRow['action']) => planned.filter((item) => item.row.action === action && item.row.line > 0).length;
  const rows = planned.map((item) => item.row);
  const interesting = [...rows.filter((row) => row.action === 'ERROR'), ...rows.filter((row) => row.action !== 'ERROR')];
  return { kind, total: planned.filter((item) => item.row.line > 0).length, create: count('CREATE'), update: count('UPDATE'), skip: count('SKIP'), errors: count('ERROR'), rows: interesting.slice(0, PREVIEW_ROWS), truncated: interesting.length > PREVIEW_ROWS };
}

/** Validates a CSV against the database and reports what each row would do. Nothing is written. */
export async function previewCsvImport(prisma: PrismaClient, actor: AdminActor, kind: CsvKind, csv: string, options: Options = {}): Promise<ImportPreview> {
  if (!CSV_KINDS.includes(kind)) throw new PosError('CSV_KIND_INVALID');
  const records = readRecords(csv, PLANNERS[kind].required);
  return preview(kind, await prisma.$transaction((tx) => PLANNERS[kind].plan(tx, actor, records, options), { timeout: 60_000 }));
}

/**
 * Re-validates and commits a CSV in one transaction. By default any invalid row rejects the whole file; `skipInvalidRows`
 * commits only the valid rows. One audit record summarizes the import.
 */
export async function commitCsvImport(prisma: PrismaClient, actor: AdminActor, kind: CsvKind, csv: string, options: Options & { skipInvalidRows?: boolean } = {}) {
  if (!CSV_KINDS.includes(kind)) throw new PosError('CSV_KIND_INVALID');
  const records = readRecords(csv, PLANNERS[kind].required);
  const importId = randomUUID();
  return prisma.$transaction(async (tx) => {
    const planned = await PLANNERS[kind].plan(tx, actor, records, options);
    const summary = preview(kind, planned);
    if (summary.errors > 0 && !options.skipInvalidRows) throw new PosError('CSV_IMPORT_HAS_ERRORS', 409);
    for (const item of planned) if (item.run && item.row.action !== 'ERROR' && item.row.action !== 'SKIP') await item.run(tx);
    await writeAudit(tx, actor, { action: 'CSV_IMPORT', entityType: 'CsvImport', entityId: importId, after: { kind, created: summary.create, updated: summary.update, skipped: summary.skip, rejected: summary.errors } });
    return { importId, ...summary };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
}
