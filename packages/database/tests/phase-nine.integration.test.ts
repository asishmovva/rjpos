import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { describe, expect, it } from 'vitest';
import {
  addAlternateBarcode, applyBulkOperation, cancelVendorClaim, checkoutCash, commitCsvImport, createSalesChannel, createVendorClaim, exportCsv, getChannelReport, holdTransaction, listAuditView, listHeldTransactions,
  openRegisterSession, postOpeningBalance, previewBulkOperation, previewCsvImport, quoteCheckout, recordVendorCredit, removeAlternateBarcode, resumeHeldTransaction, setVendorCaseUpc, submitVendorClaim, updateSalesChannel,
  velocitySuggestions,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const upc = () => String(Math.floor(1e11 + Math.random() * 9e11));
const newPrisma = () => new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });

async function fixture(prisma: PrismaClient) {
  const organizationId = randomUUID(); const storeId = randomUUID(); const registerId = randomUUID(); const employeeId = randomUUID(); const categoryId = randomUUID();
  await prisma.organization.create({ data: { id: organizationId, name: 'Phase 9' } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Phase 9 Store', taxRateBasisPoints: 0 } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Phase', lastName: 'Nine' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Front', code: `P9-${organizationId.slice(0, 6)}` } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'General' } });
  const scope = { organizationId, storeId, registerId, employeeId };
  const actor = { organizationId, storeId, registerId, userId: employeeId };
  const admin = { organizationId, userId: employeeId, storeId };
  const variant = async (name: string, priceMinor: bigint, tracked = true) => {
    const product = await prisma.product.create({ data: { organizationId, categoryId, name, inventoryTracked: tracked } });
    const created = await prisma.productVariant.create({ data: { organizationId, productId: product.id, name: 'Each', sku: `S-${randomUUID().slice(0, 8).toUpperCase()}` } });
    await prisma.barcode.create({ data: { organizationId, variantId: created.id, barcodeValue: upc() } });
    await prisma.price.create({ data: { organizationId, storeId, variantId: created.id, amountMinor: priceMinor, effectiveFrom: new Date('2026-01-01') } });
    return { ...created, productId: product.id };
  };
  return { ...scope, categoryId, scope, actor, admin, variant };
}
const sale = (scope: Record<string, string>, sessionId: string, lines: Array<{ variantId: string; quantity: number }>, tendered: bigint, channelId?: string) =>
  ({ ...scope, registerSessionId: sessionId, idempotencyKey: randomUUID(), lines, tenderedMinor: tendered, ...(channelId ? { channelId } : {}) }) as never;

describe.sequential('Held sales', () => {
  it('lists age and register, expires stale holds, and refuses to resume an expired hold', async () => {
    const prisma = newPrisma();
    try {
      const f = await fixture(prisma);
      const item = await f.variant('Soda', 200n, false);
      const held = await holdTransaction(prisma, f.actor, { idempotencyKey: randomUUID(), label: 'Bob', note: 'back in 5', cart: { lines: [{ variantId: item.id, quantity: 2 }] } });
      const listed = await listHeldTransactions(prisma, f.actor);
      expect(listed[0]).toMatchObject({ id: held.id, label: 'Bob', note: 'back in 5', lineCount: 1 });
      await prisma.heldTransaction.update({ where: { id: held.id }, data: { heldAt: new Date(Date.now() - 48 * 3_600_000) } });
      expect(await listHeldTransactions(prisma, f.actor)).toHaveLength(0);
      expect((await prisma.heldTransaction.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('EXPIRED');
      await expect(resumeHeldTransaction(prisma, f.actor, held.id)).rejects.toMatchObject({ code: 'HELD_TRANSACTION_EXPIRED' });
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Sales channels', () => {
  it('prices a sale from the channel price book, snapshots the channel, and reports revenue by channel', async () => {
    const prisma = newPrisma();
    try {
      const f = await fixture(prisma);
      const item = await f.variant('Chips', 1_000n, false);
      const book = await prisma.priceBook.create({ data: { organizationId: f.organizationId, name: 'DoorDash' } });
      await prisma.specialPrice.create({ data: { organizationId: f.organizationId, priceBookId: book.id, storeId: f.storeId, variantId: item.id, amountMinor: 1_300n } });
      const channel = await createSalesChannel(prisma, f.admin, { name: 'DoorDash Marketplace', priceBookId: book.id });
      const walkIn = await createSalesChannel(prisma, f.admin, { name: 'Walk-In Test' });
      const quote = await quoteCheckout(prisma, { organizationId: f.organizationId, storeId: f.storeId, lines: [{ variantId: item.id, quantity: 1 }], channelId: channel.id } as never);
      expect(BigInt(quote.totalMinor)).toBe(1_300n);
      const session = await openRegisterSession(prisma, { ...f.scope, openingCashMinor: 0n });
      await checkoutCash(prisma, sale(f.scope, session.id, [{ variantId: item.id, quantity: 1 }], 1_300n, channel.id));
      await checkoutCash(prisma, sale(f.scope, session.id, [{ variantId: item.id, quantity: 2 }], 2_000n, walkIn.id));
      const order = await prisma.order.findFirstOrThrow({ where: { organizationId: f.organizationId, salesChannelId: channel.id } });
      expect(order.channelNameSnapshot).toBe('DoorDash Marketplace');
      const report = await getChannelReport(prisma, f.admin, { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });
      const row = report.rows.find((candidate) => candidate.channel === 'DoorDash Marketplace');
      expect(row).toMatchObject({ orders: 1 });
      expect(report.rows.find((candidate) => candidate.channel === 'Walk-In Test')).toMatchObject({ orders: 1 });
      await expect(updateSalesChannel(prisma, f.admin, channel.id, { active: false })).resolves.toMatchObject({ active: false });
      await expect(createSalesChannel(prisma, f.admin, { name: 'doordash marketplace' })).rejects.toBeTruthy();
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Bulk operations', () => {
  it('previews and applies price, category, and active changes without touching stock, and skips unsafe rows', async () => {
    const prisma = newPrisma();
    try {
      const f = await fixture(prisma);
      const a = await f.variant('Alpha', 1_000n); const b = await f.variant('Beta', 500n);
      await postOpeningBalance(prisma, { ...f.scope, variantId: a.id, quantity: 7, reason: 'Opening' });
      const target = await prisma.category.create({ data: { organizationId: f.organizationId, name: 'Snacks' } });
      const ids = [a.productId, b.productId];
      const preview = await previewBulkOperation(prisma, f.admin, { productIds: ids, operation: { type: 'PRICE', storeId: f.storeId, mode: 'PERCENT', value: '1000' } });
      expect(preview.applicable).toBe(2);
      expect(preview.changes.map((change) => change.after).sort()).toEqual(['$10.00'.replace('10.00', '5.50'), '$11.00'].sort());
      await applyBulkOperation(prisma, f.admin, { productIds: ids, operation: { type: 'PRICE', storeId: f.storeId, mode: 'PERCENT', value: '1000' } });
      const current = await prisma.price.findMany({ where: { organizationId: f.organizationId, variantId: a.id }, orderBy: { effectiveFrom: 'asc' } });
      expect(current.at(-1)?.amountMinor).toBe(1_100n);
      await applyBulkOperation(prisma, f.admin, { productIds: ids, operation: { type: 'CATEGORY', categoryId: target.id } });
      expect((await prisma.product.findUniqueOrThrow({ where: { id: a.productId } })).categoryId).toBe(target.id);
      await applyBulkOperation(prisma, f.admin, { productIds: [b.productId], operation: { type: 'ACTIVE', active: false } });
      expect((await prisma.product.findUniqueOrThrow({ where: { id: b.productId } })).active).toBe(false);
      const level = await prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: a.id } });
      expect(level.onHand).toBe(7);
      await expect(applyBulkOperation(prisma, f.admin, { productIds: [], operation: { type: 'ACTIVE', active: true } })).rejects.toMatchObject({ code: 'BULK_SELECTION_REQUIRED' });
      const audit = await prisma.auditRecord.count({ where: { organizationId: f.organizationId, action: 'BULK_OPERATION' } });
      expect(audit).toBe(3);
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Vendor claims and alternate UPCs', () => {
  it('removes stock only for submitted returns, records credits, and protects primary and duplicate UPCs', async () => {
    const prisma = newPrisma();
    try {
      const f = await fixture(prisma);
      const item = await f.variant('Wine', 2_000n);
      await postOpeningBalance(prisma, { ...f.scope, variantId: item.id, quantity: 6, reason: 'Opening' });
      const vendor = await prisma.vendor.create({ data: { organizationId: f.organizationId, name: 'Acme Wine' } });
      const claim = await createVendorClaim(prisma, f.admin, { vendorId: vendor.id, kind: 'RETURN', reason: 'Corked', lines: [{ variantId: item.id, quantity: 2, unitCostMinor: '1000' }] });
      expect(claim.expectedCreditMinor).toBe(2_000n);
      const onHand = async () => (await prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.id } })).onHand;
      expect(await onHand()).toBe(6);
      await submitVendorClaim(prisma, f.admin, claim.id);
      expect(await onHand()).toBe(4);
      await expect(submitVendorClaim(prisma, f.admin, claim.id)).rejects.toMatchObject({ code: 'VENDOR_CLAIM_NOT_DRAFT' });
      await expect(cancelVendorClaim(prisma, f.admin, claim.id)).rejects.toMatchObject({ code: 'VENDOR_CLAIM_TRANSITION_INVALID' });
      expect(await recordVendorCredit(prisma, f.admin, claim.id, { creditedMinor: '1800', creditReference: 'CM-9' })).toMatchObject({ status: 'CREDITED', creditedMinor: 1_800n });
      const shortage = await createVendorClaim(prisma, f.admin, { vendorId: vendor.id, kind: 'SHORTAGE', reason: 'Short by 1', lines: [{ variantId: item.id, quantity: 1, unitCostMinor: '1000' }] });
      await submitVendorClaim(prisma, f.admin, shortage.id);
      expect(await onHand()).toBe(4);

      const alt = await addAlternateBarcode(prisma, f.admin, { variantId: item.id, barcodeValue: 'ALT-12345' });
      await expect(addAlternateBarcode(prisma, f.admin, { variantId: item.id, barcodeValue: 'ALT-12345' })).rejects.toMatchObject({ code: 'UPC_ALREADY_EXISTS' });
      const primary = await prisma.barcode.findFirstOrThrow({ where: { variantId: item.id, kind: 'PRIMARY' } });
      await expect(removeAlternateBarcode(prisma, f.admin, primary.id)).rejects.toMatchObject({ code: 'PRIMARY_BARCODE_PROTECTED' });
      await removeAlternateBarcode(prisma, f.admin, alt.id);
      const mapping = await prisma.vendorProductMapping.create({ data: { organizationId: f.organizationId, vendorId: vendor.id, variantId: item.id, vendorSku: 'W-1', vendorCostMinor: 1_000n } });
      await expect(setVendorCaseUpc(prisma, f.admin, mapping.id, primary.barcodeValue)).rejects.toMatchObject({ code: 'UPC_ALREADY_EXISTS' });
      expect((await setVendorCaseUpc(prisma, f.admin, mapping.id, 'CASE-99881')).caseUpc).toBe('CASE-99881');
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Velocity suggestions', () => {
  it('suggests from recent sales net of stock, rounded to the case pack', async () => {
    const prisma = newPrisma();
    try {
      const f = await fixture(prisma);
      const item = await f.variant('Seltzer', 300n);
      await postOpeningBalance(prisma, { ...f.scope, variantId: item.id, quantity: 30, reason: 'Opening' });
      const vendor = await prisma.vendor.create({ data: { organizationId: f.organizationId, name: 'Fizz Co' } });
      await prisma.vendorProductMapping.create({ data: { organizationId: f.organizationId, vendorId: vendor.id, variantId: item.id, vendorSku: 'F-1', vendorCostMinor: 100n, casePackQuantity: 12, preferred: true } });
      const session = await openRegisterSession(prisma, { ...f.scope, openingCashMinor: 0n });
      await checkoutCash(prisma, sale(f.scope, session.id, [{ variantId: item.id, quantity: 28 }], 8_400n));
      const [suggestion] = await velocitySuggestions(prisma, f.admin, { lookbackDays: 28, coverDays: 14, leadTimeDays: 3 });
      expect(suggestion).toMatchObject({ variantId: item.id, soldUnits: 28, available: 2, vendorName: 'Fizz Co', casePackQuantity: 12 });
      expect(suggestion!.suggestedUnits % 12).toBe(0);
      expect(suggestion!.suggestedUnits).toBeGreaterThanOrEqual(suggestion!.targetUnits - 2);
      await expect(velocitySuggestions(prisma, f.admin, { lookbackDays: 0 })).rejects.toMatchObject({ code: 'VELOCITY_PARAMETER_INVALID' });
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('CSV tools', () => {
  it('previews before committing, rejects bad files atomically, protects stock, and exports formula-safe CSV', async () => {
    const prisma = newPrisma();
    try {
      const f = await fixture(prisma);
      const item = await f.variant('=HYPERLINK Cola', 250n);
      const code = upc();
      const good = `upc,product_name,category\r\n${code},Imported Water,General\r\n`;
      const previewed = await previewCsvImport(prisma, f.admin, 'products', good);
      expect(previewed).toMatchObject({ create: 1, errors: 0 });
      expect(await prisma.barcode.count({ where: { barcodeValue: code } })).toBe(0);
      await commitCsvImport(prisma, f.admin, 'products', good);
      const created = await prisma.productVariant.findFirstOrThrow({ where: { organizationId: f.organizationId, barcodes: { some: { barcodeValue: code } } }, include: { product: true } });
      expect(created.product).toMatchObject({ active: false, draft: true });
      const bad = `upc,product_name,category\r\n${upc()},Fine,Missing Category\r\n${upc()},,General\r\n`;
      expect((await previewCsvImport(prisma, f.admin, 'products', bad)).errors).toBe(2);
      await expect(commitCsvImport(prisma, f.admin, 'products', bad)).rejects.toMatchObject({ code: 'CSV_IMPORT_HAS_ERRORS' });
      expect(await prisma.product.count({ where: { organizationId: f.organizationId, name: 'Fine' } })).toBe(0);

      const inventory = `sku,quantity\r\n${item.sku},12\r\n`;
      await commitCsvImport(prisma, f.admin, 'inventory', inventory);
      expect((await prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.id } })).onHand).toBe(12);
      const again = await previewCsvImport(prisma, f.admin, 'inventory', `sku,quantity\r\n${item.sku},99\r\n`);
      expect(again.errors).toBe(1);
      expect((await prisma.inventoryLevel.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.id } })).onHand).toBe(12);

      const pricing = await commitCsvImport(prisma, f.admin, 'pricing', `sku,price\r\n${item.sku},3.75\r\n`);
      expect(pricing.update).toBe(1);
      const prices = await prisma.price.findMany({ where: { organizationId: f.organizationId, variantId: item.id }, orderBy: { effectiveFrom: 'asc' } });
      expect(prices.at(-1)?.amountMinor).toBe(375n);
      expect((await previewCsvImport(prisma, f.admin, 'pricing', `sku,price\r\n${item.sku},abc\r\n`)).errors).toBe(1);

      const customers = await commitCsvImport(prisma, f.admin, 'customers', 'name,email,phone\r\nAnn Lee,ann@example.com,\r\n');
      expect(customers.create).toBe(1);
      expect((await previewCsvImport(prisma, f.admin, 'customers', 'name,email\r\nAnn L,ANN@example.com\r\n')).update).toBe(1);
      await commitCsvImport(prisma, f.admin, 'vendors', 'name,email\r\nNew Vendor,v@example.com\r\n');
      await expect(previewCsvImport(prisma, f.admin, 'vendors', 'nothing,here\r\nx,y\r\n')).rejects.toMatchObject({ code: 'CSV_HEADERS_REQUIRED' });

      const exported = await exportCsv(prisma, f.admin, 'products');
      expect(exported).toContain("\"'=HYPERLINK Cola\"");
      expect(await prisma.auditRecord.count({ where: { organizationId: f.organizationId, action: 'CSV_IMPORT' } })).toBe(5);
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Audit viewer', () => {
  it('names users and stores, shows old and new values, and hides sensitive fields', async () => {
    const prisma = newPrisma();
    try {
      const f = await fixture(prisma);
      await prisma.auditRecord.create({ data: { organizationId: f.organizationId, userId: f.employeeId, storeId: f.storeId, registerId: f.registerId, action: 'PRICE_CHANGED', entityType: 'Price', entityId: randomUUID(), beforeJson: { amountMinor: '100', pinHash: 'abc' }, afterJson: { amountMinor: '150', pinHash: 'def' } } });
      const view = await listAuditView(prisma, f.admin, {});
      expect(view.items[0]).toMatchObject({ actionLabel: 'price changed', user: { name: 'Phase Nine' }, store: { name: 'Phase 9 Store' }, register: { name: 'Front' } });
      expect(view.items[0]!.changes).toEqual(expect.arrayContaining([{ field: 'amountMinor', before: '100', after: '150' }, { field: 'pinHash', before: '[hidden]', after: '[hidden]' }]));
    } finally { await prisma.$disconnect(); }
  });
});
