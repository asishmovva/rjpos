import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import { describe, expect, it } from 'vitest';
import {
  applyInvoiceOcrResult, assignTaxProfile, checkoutCash, confirmInvoiceDocument, createInvoiceDocument, createPriceBook, createPurchaseOrder, createPurchasedProduct, createTaxProfile,
  createVendorDeal, deleteTaxProfile, ensureSystemTaxProfiles, getInvoiceReview, getProductDetail, listTaxProfiles, lookupUpcForCreation, openRegisterSession, postOpeningBalance,
  quoteCheckout, refundOrder, saveSpecialPrice, updateInvoiceLine, updateTaxProfile, voidOrder,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const upc = () => String(Math.floor(1e11 + Math.random() * 9e11));

async function fixture(prisma: PrismaClient, taxRateBasisPoints = 1000) {
  const organizationId = randomUUID(); const storeId = randomUUID(); const registerId = randomUUID(); const employeeId = randomUUID(); const categoryId = randomUUID();
  await prisma.organization.create({ data: { id: organizationId, name: 'Costing' } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Cost Store', taxRateBasisPoints } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Cost', lastName: 'Admin' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Front', code: `C-${organizationId.slice(0, 6)}` } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: 'General' } });
  const actor = { organizationId, userId: employeeId, storeId };
  const session = await openRegisterSession(prisma, { organizationId, storeId, registerId, employeeId, openingCashMinor: 0n });
  const scope = { organizationId, storeId, registerId, registerSessionId: session.id, employeeId };
  const variant = async (name: string, priceMinor: bigint, extra: { taxProfileId?: string; inventoryTracked?: boolean; baseVariantId?: string; unitsPerPack?: number } = {}) => {
    const product = await prisma.product.create({ data: { organizationId, categoryId, name, inventoryTracked: extra.inventoryTracked ?? false, ...(extra.taxProfileId ? { taxProfileId: extra.taxProfileId } : {}) } });
    const created = await prisma.productVariant.create({ data: { organizationId, productId: product.id, name: 'Each', sku: `S-${randomUUID().slice(0, 8)}`,
      ...(extra.baseVariantId ? { baseVariantId: extra.baseVariantId, unitsPerPack: extra.unitsPerPack ?? 1 } : {}) } });
    await prisma.price.create({ data: { organizationId, storeId, variantId: created.id, amountMinor: priceMinor, effectiveFrom: new Date('2026-01-01') } });
    return created;
  };
  return { organizationId, storeId, registerId, employeeId, categoryId, actor, scope, variant };
}
const cash = (scope: Record<string, string>, lines: Array<{ variantId: string; quantity: number }>, extra: Record<string, unknown> = {}) =>
  ({ ...scope, idempotencyKey: randomUUID(), lines, tenderedMinor: 100_000n, ...extra }) as never;

describe.sequential('Tax profiles', () => {
  it('taxes standard, non-taxable, and custom profiles per line in a mixed cart, and preserves historical rates when a profile changes', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      await ensureSystemTaxProfiles(prisma, f.organizationId);
      const { profiles } = await listTaxProfiles(prisma, f.actor);
      expect(profiles.map((profile) => [profile.name, profile.kind, profile.isDefault])).toEqual([['Standard State Tax', 'STANDARD', true], ['Non-Taxable', 'NON_TAXABLE', false]]);
      const nonTaxable = profiles.find((profile) => profile.kind === 'NON_TAXABLE')!;
      const tobacco = await createTaxProfile(prisma, f.actor, { name: 'Tobacco', rateBasisPoints: 3_000, description: 'Configured, not hardcoded' });
      const standard = await f.variant('Standard item', 1_000n);
      const exempt = await f.variant('Exempt item', 1_000n, { taxProfileId: nonTaxable.id });
      const smokes = await f.variant('Tobacco item', 1_000n, { taxProfileId: tobacco.id });
      const lines = [{ variantId: standard.id, quantity: 1 }, { variantId: exempt.id, quantity: 1 }, { variantId: smokes.id, quantity: 1 }];
      const quote = await quoteCheckout(prisma, { organizationId: f.organizationId, storeId: f.storeId, lines });
      expect(quote.lines.map((line) => [line.taxRateBasisPoints, line.taxMinor])).toEqual([[1_000, '100'], [0, '0'], [3_000, '300']]);
      const sale = await checkoutCash(prisma, cash(f.scope, lines));
      expect(sale).toMatchObject({ taxMinor: '400', totalMinor: '3400' });
      const items = await prisma.orderItem.findMany({ where: { orderId: sale.orderId }, orderBy: { productNameSnapshot: 'asc' } });
      expect(items.map((item) => [item.productNameSnapshot, item.taxRateBasisPointsSnapshot, item.taxProfileNameSnapshot, item.taxMinor])).toEqual([
        ['Exempt item', 0, 'Non-Taxable', 0n], ['Standard item', 1_000, 'Standard State Tax', 100n], ['Tobacco item', 3_000, 'Tobacco', 300n]]);
      // Changing the profile changes future sales only.
      await updateTaxProfile(prisma, f.actor, tobacco.id, { rateBasisPoints: 5_000 });
      const later = await checkoutCash(prisma, cash(f.scope, [{ variantId: smokes.id, quantity: 1 }]));
      expect(later.taxMinor).toBe('500');
      expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: sale.orderId, productNameSnapshot: 'Tobacco item' } })).taxRateBasisPointsSnapshot).toBe(3_000);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: sale.orderId } })).taxMinor).toBe(400n);
      // Store standard rate edits also apply to the Standard profile going forward.
      await prisma.store.update({ where: { id: f.storeId }, data: { taxRateBasisPoints: 200 } });
      expect((await checkoutCash(prisma, cash(f.scope, [{ variantId: standard.id, quantity: 1 }]))).taxMinor).toBe('20');
    } finally { await prisma.$disconnect(); }
  });

  it('protects system profiles, blocks deleting referenced profiles, and only assigns active ones', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const { profiles } = await listTaxProfiles(prisma, f.actor);
      const standard = profiles.find((profile) => profile.kind === 'STANDARD')!;
      await expect(updateTaxProfile(prisma, f.actor, standard.id, { rateBasisPoints: 700 })).rejects.toThrow('TAX_PROFILE_RATE_FIXED');
      await expect(updateTaxProfile(prisma, f.actor, standard.id, { active: false })).rejects.toThrow('TAX_PROFILE_DEFAULT_REQUIRED');
      await expect(deleteTaxProfile(prisma, f.actor, standard.id)).rejects.toThrow('TAX_PROFILE_PROTECTED');
      await expect(createTaxProfile(prisma, f.actor, { name: 'Bad', rateBasisPoints: 10_001 })).rejects.toThrow('TAX_RATE_INVALID');
      const tax1 = await createTaxProfile(prisma, f.actor, { name: 'Tax 1', rateBasisPoints: 250 });
      await expect(createTaxProfile(prisma, f.actor, { name: 'Tax 1', rateBasisPoints: 250 })).rejects.toThrow('TAX_PROFILE_NAME_TAKEN');
      const item = await f.variant('Referenced', 500n);
      await assignTaxProfile(prisma, f.actor, { variantId: item.id, taxProfileId: tax1.id });
      await expect(deleteTaxProfile(prisma, f.actor, tax1.id)).rejects.toThrow('TAX_PROFILE_IN_USE');
      await expect(prisma.taxProfile.delete({ where: { id: tax1.id } })).rejects.toThrow();
      await updateTaxProfile(prisma, f.actor, tax1.id, { active: false });
      await expect(assignTaxProfile(prisma, f.actor, { productId: (await prisma.productVariant.findUniqueOrThrow({ where: { id: item.id } })).productId, taxProfileId: tax1.id })).rejects.toThrow('TAX_PROFILE_NOT_FOUND');
      // A deactivated profile keeps applying to products that already use it.
      expect((await quoteCheckout(prisma, { organizationId: f.organizationId, storeId: f.storeId, lines: [{ variantId: item.id, quantity: 1 }] })).lines[0]).toMatchObject({ taxRateBasisPoints: 250 });
      const spare = await createTaxProfile(prisma, f.actor, { name: 'Unused', rateBasisPoints: 100 });
      await expect(deleteTaxProfile(prisma, f.actor, spare.id)).resolves.toMatchObject({ deleted: true });
      await updateTaxProfile(prisma, f.actor, tax1.id, { active: true });
      await updateTaxProfile(prisma, f.actor, tax1.id, { makeDefault: true });
      expect((await listTaxProfiles(prisma, f.actor)).profiles.filter((profile) => profile.isDefault).map((profile) => profile.name)).toEqual(['Tax 1']);
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Pack variants share base-unit inventory', () => {
  it('sells, refunds, and voids packs against the base variant without duplicating stock', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const single = await f.variant('Corona', 250n, { inventoryTracked: true });
      const product = await prisma.productVariant.findUniqueOrThrow({ where: { id: single.id } });
      const six = await prisma.productVariant.create({ data: { organizationId: f.organizationId, productId: product.productId, name: '6-Pack', sku: `S-${randomUUID().slice(0, 8)}`, baseVariantId: single.id, unitsPerPack: 6 } });
      await prisma.price.create({ data: { organizationId: f.organizationId, storeId: f.storeId, variantId: six.id, amountMinor: 1_400n, effectiveFrom: new Date('2026-01-01') } });
      await postOpeningBalance(prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: single.id, quantity: 30, reason: 'Opening' });
      await expect(postOpeningBalance(prisma, { organizationId: f.organizationId, storeId: f.storeId, employeeId: f.employeeId, variantId: six.id, quantity: 6, reason: 'Nope' })).rejects.toThrow('PACK_VARIANT_HAS_NO_OWN_STOCK');
      const vendor = await prisma.vendor.create({ data: { organizationId: f.organizationId, name: 'V' } });
      await expect(createPurchaseOrder(prisma, f.actor, { vendorId: vendor.id, poNumber: 'PO-1', lines: [{ variantId: six.id, quantity: 6, unitCostMinor: '100' }] })).rejects.toThrow('PACK_VARIANT_NOT_PURCHASABLE');
      const level = () => prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: { organizationId: f.organizationId, storeId: f.storeId, variantId: single.id } } });
      const sale = await checkoutCash(prisma, cash(f.scope, [{ variantId: six.id, quantity: 2 }, { variantId: single.id, quantity: 1 }]));
      expect(await level()).toMatchObject({ onHand: 17, reserved: 0 });
      expect(await prisma.inventoryLevel.count({ where: { organizationId: f.organizationId, variantId: six.id } })).toBe(0);
      const movements = await prisma.inventoryMovement.findMany({ where: { organizationId: f.organizationId, type: 'SALE' } });
      expect(movements.map((movement) => [movement.variantId, movement.quantityDelta])).toEqual([[single.id, -13]]);
      const items = await prisma.orderItem.findMany({ where: { orderId: sale.orderId } });
      const refundInput = { organizationId: f.organizationId, orderId: sale.orderId, employeeId: f.employeeId, reason: 'Return one pack', idempotencyKey: randomUUID(), items: [{ orderItemId: items.find((item) => item.variantId === six.id)!.id, quantity: 1 }] };
      await refundOrder(prisma, new SimulatedTerminalProvider(), refundInput);
      expect(await level()).toMatchObject({ onHand: 23 });
      await expect(checkoutCash(prisma, cash(f.scope, [{ variantId: six.id, quantity: 4 }]))).rejects.toThrow('INSUFFICIENT_INVENTORY');
      const second = await checkoutCash(prisma, cash(f.scope, [{ variantId: six.id, quantity: 3 }]));
      expect(await level()).toMatchObject({ onHand: 5 });
      await voidOrder(prisma, { organizationId: f.organizationId, orderId: second.orderId, employeeId: f.employeeId, reason: 'Mistake', idempotencyKey: randomUUID() }, new SimulatedTerminalProvider());
      expect(await level()).toMatchObject({ onHand: 23 });
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Special (price-book) pricing', () => {
  it('charges a named price book without touching the standard price and snapshots what was charged', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma, 0);
      const item = await f.variant('Channel item', 1_999n);
      const doorDash = await createPriceBook(prisma, f.actor, { name: 'DoorDash' });
      const uber = await createPriceBook(prisma, f.actor, { name: 'Uber Eats' });
      await expect(createPriceBook(prisma, f.actor, { name: 'DoorDash' })).rejects.toThrow('PRICE_BOOK_NAME_TAKEN');
      const special = await saveSpecialPrice(prisma, f.actor, { priceBookId: doorDash.id, storeId: f.storeId, variantId: item.id, amountMinor: '2399' });
      await expect(saveSpecialPrice(prisma, f.actor, { priceBookId: doorDash.id, storeId: f.storeId, variantId: item.id, amountMinor: '2500' })).rejects.toThrow('SPECIAL_PRICE_OVERLAP');
      await saveSpecialPrice(prisma, f.actor, { priceBookId: uber.id, storeId: f.storeId, variantId: item.id, amountMinor: '2449' });
      const lines = [{ variantId: item.id, quantity: 1 }];
      expect((await quoteCheckout(prisma, { organizationId: f.organizationId, storeId: f.storeId, lines })).totalMinor).toBe('1999');
      expect((await quoteCheckout(prisma, { organizationId: f.organizationId, storeId: f.storeId, lines, priceBookId: doorDash.id })).totalMinor).toBe('2399');
      expect((await quoteCheckout(prisma, { organizationId: f.organizationId, storeId: f.storeId, lines, priceBookId: uber.id })).totalMinor).toBe('2449');
      const sale = await checkoutCash(prisma, cash(f.scope, lines, { priceBookId: doorDash.id }));
      expect(sale.totalMinor).toBe('2399');
      // Editing or deactivating the special price later cannot change the completed order.
      await saveSpecialPrice(prisma, f.actor, { id: special.id, priceBookId: doorDash.id, storeId: f.storeId, variantId: item.id, amountMinor: '2999', active: false });
      expect(await prisma.orderItem.findFirstOrThrow({ where: { orderId: sale.orderId } })).toMatchObject({ unitPriceMinor: 2_399n, priceBookNameSnapshot: 'DoorDash' });
      // With the special price inactive the line falls back to the standard price; the standard price row is untouched.
      expect((await quoteCheckout(prisma, { organizationId: f.organizationId, storeId: f.storeId, lines, priceBookId: doorDash.id })).totalMinor).toBe('1999');
      expect((await prisma.price.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: item.id } })).amountMinor).toBe(1_999n);
      await expect(quoteCheckout(prisma, { organizationId: f.organizationId, storeId: f.storeId, lines, priceBookId: randomUUID() })).rejects.toThrow('PRICE_BOOK_NOT_FOUND');
      const standardOrder = await checkoutCash(prisma, cash(f.scope, lines));
      expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: standardOrder.orderId } })).priceBookNameSnapshot).toBeNull();
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Purchased product creation', () => {
  it('creates a product with case economics, pack variants, special prices, opening stock, and cost history; and never duplicates a UPC', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const vendor = await prisma.vendor.create({ data: { organizationId: f.organizationId, name: 'Distributor' } });
      const book = await createPriceBook(prisma, f.actor, { name: 'DoorDash' });
      const code = upc(); const sixPackUpc = upc();
      expect(await lookupUpcForCreation(prisma, f.actor, code)).toMatchObject({ status: 'NEW' });
      const input = { storeId: f.storeId, product: { name: 'Corona Extra', categoryId: f.categoryId, brand: 'Corona', ageRestricted: true },
        identity: { upc: code, sizeLabel: '12 oz', sku: 'CORONA-1' },
        vendor: { vendorId: vendor.id, vendorSku: 'DIST-9', caseCostMinor: '3600', unitsPerCase: 24 },
        sellingUnits: [{ name: 'Single', unitsPerPack: 1, priceMinor: '250' }, { name: '6-Pack', unitsPerPack: 6, upc: sixPackUpc, priceMinor: '1400' }, { name: 'Case', unitsPerPack: 24, priceMinor: '5000' }],
        specialPrices: [{ priceBookId: book.id, unitIndex: 0, amountMinor: '299' }], inventory: { openingQuantity: 48 } };
      const created = await createPurchasedProduct(prisma, f.actor, input);
      expect(created.effectiveUnitCostMinor).toBe(150n);
      expect(created.variants.map((variant) => [variant.unitsPerPack, variant.sku])).toEqual([[1, 'CORONA-1'], [6, 'CORONA-1-6PK'], [24, 'CORONA-1-24PK']]);
      const detail = await getProductDetail(prisma, f.actor, created.productId);
      expect(detail.product.variants.map((variant) => [variant.unitsPerPack, variant.baseVariantId === null ? 'base' : 'pack'])).toEqual([[1, 'base'], [6, 'pack'], [24, 'pack']]);
      expect(detail.mappings[0]).toMatchObject({ vendorCostMinor: 150n, caseCostMinor: 3600n, casePackQuantity: 24, vendorSku: 'DIST-9' });
      expect(detail.levels.map((level) => [level.variantId, level.onHand])).toEqual([[created.baseVariantId, 48]]);
      expect(detail.prices).toHaveLength(3);
      expect(detail.specialPrices).toHaveLength(1);
      expect(detail.costHistory[0]).toMatchObject({ source: 'PRODUCT_CREATED', unitsPerCase: 24, baseCaseCostMinor: 3600n, effectiveCaseCostMinor: 3600n, effectiveUnitCostMinor: 150n });
      // Vendor and case cost are required unless it is an explicit draft.
      await expect(createPurchasedProduct(prisma, f.actor, { ...input, identity: { ...input.identity, upc: upc(), sku: 'X-2' }, vendor: undefined })).rejects.toThrow('VENDOR_REQUIRED');
      await expect(createPurchasedProduct(prisma, f.actor, { ...input, identity: { ...input.identity, upc: upc(), sku: 'X-3' }, sellingUnits: [{ name: '6-Pack', unitsPerPack: 6, priceMinor: '1' }] })).rejects.toThrow('SINGLE_UNIT_REQUIRED');
      // UPC uniqueness, for the single and for any pack.
      expect(await lookupUpcForCreation(prisma, f.actor, code)).toMatchObject({ status: 'IN_STORE', variant: { productName: 'Corona Extra' } });
      await expect(createPurchasedProduct(prisma, f.actor, { ...input, identity: { ...input.identity, sku: 'CORONA-2' } })).rejects.toThrow('UPC_ALREADY_EXISTS');
      await expect(createPurchasedProduct(prisma, f.actor, { ...input, identity: { ...input.identity, upc: upc(), sku: 'CORONA-3' } })).rejects.toThrow('UPC_ALREADY_EXISTS');
      expect(await prisma.barcode.count({ where: { organizationId: f.organizationId, barcodeValue: code } })).toBe(1);
      // A draft may omit vendor and prices; it stays inactive.
      const draft = await createPurchasedProduct(prisma, f.actor, { storeId: f.storeId, draft: true, product: { name: 'Draft item', categoryId: f.categoryId, brand: 'B' }, identity: { upc: upc(), sizeLabel: '750 ml', sku: 'DRAFT-1' }, sellingUnits: [{ name: 'Single', unitsPerPack: 1 }] });
      expect(await prisma.product.findUniqueOrThrow({ where: { id: draft.productId } })).toMatchObject({ draft: true, active: false });
      // The base variant sells like any other: pack sale draws from the single's stock.
      const sale = await checkoutCash(prisma, cash(f.scope, [{ variantId: created.variants[1]!.id, quantity: 2 }], { ageVerified: true }));
      expect(sale.status).toBe('COMPLETED');
      expect((await prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: { organizationId: f.organizationId, storeId: f.storeId, variantId: created.baseVariantId } } })).onHand).toBe(36);
    } finally { await prisma.$disconnect(); }
  });
});

describe.sequential('Vendor deals, invoice review, and cost history', () => {
  it('applies deals to POs, keeps the base cost, reviews invoice discrepancies, gates confirmation, and updates vendor cost only when explicitly reviewed', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const f = await fixture(prisma);
      const vendor = await prisma.vendor.create({ data: { organizationId: f.organizationId, name: 'Deal Vendor' } });
      const code = upc();
      const created = await createPurchasedProduct(prisma, f.actor, { storeId: f.storeId, product: { name: 'Vodka', categoryId: f.categoryId, brand: 'B' }, identity: { upc: code, sizeLabel: '750 ml', sku: 'VODKA-1' },
        vendor: { vendorId: vendor.id, caseCostMinor: '18000', unitsPerCase: 12 }, sellingUnits: [{ name: 'Single', unitsPerPack: 1, priceMinor: '1999' }] });
      await createVendorDeal(prisma, f.actor, { vendorId: vendor.id, variantId: created.baseVariantId, name: '$10 off per case', kind: 'DISCOUNT_PER_CASE', amountMinor: '1000' });
      await expect(createVendorDeal(prisma, f.actor, { vendorId: vendor.id, name: 'Bad', kind: 'REBATE' })).rejects.toThrow('VENDOR_DEAL_AMOUNT_REQUIRED');
      const po = await createPurchaseOrder(prisma, f.actor, { vendorId: vendor.id, poNumber: 'PO-DEAL', lines: [{ variantId: created.baseVariantId, quantity: 60 }] });
      expect(po.lines[0]).toMatchObject({ unitCostMinor: 1_417n, unitsPerCase: 12, caseCostMinor: 18_000n, discountPerCaseMinor: 1_000n });
      expect((await prisma.vendorProductMapping.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: created.baseVariantId } })).caseCostMinor).toBe(18_000n);

      const document = await createInvoiceDocument(prisma, f.actor, { storeId: f.storeId, vendorId: vendor.id, originalFilename: 'inv.json', mimeType: 'application/json', content: Buffer.from('{}'), documentHash: randomUUID() });
      const processed = await applyInvoiceOcrResult(prisma, f.actor, document.id, { provider: 'TEST', vendorName: 'Deal Vendor', invoiceNumber: 'INV-1', poReference: 'PO-DEAL', subtotalMinor: '85000', discountMinor: '0', taxMinor: '0', feesMinor: '500', totalMinor: '85500', rawText: 'RAW OCR',
        lines: [{ description: 'Vodka', upc: code, quantity: 5, caseQuantity: 12, caseCostMinor: '18000', discountPerCaseMinor: '1000', lineTotalMinor: '85000', size: '750 ml', confidence: 0.91, rawText: 'VODKA 12/750' }] });
      expect(processed.rawText).toBe('RAW OCR'); expect(processed.poReference).toBe('PO-DEAL');
      let review = await getInvoiceReview(prisma, f.actor, document.id);
      expect(review.lines[0]!.review).toMatchObject({ cases: 5, unitsPerCase: 12, baseCaseCostMinor: 18_000n, discountPerCaseMinor: 1_000n, effectiveCaseCostMinor: 17_000n, effectiveUnitCostMinor: 1_417n, totalUnits: 60 });
      expect(review.lines[0]!.availableDeals).toHaveLength(1);
      expect(review.hasDiscrepancies).toBe(false);
      // A wrong printed total is flagged and blocks confirmation until acknowledged.
      await updateInvoiceLine(prisma, f.actor, document.id, processed.lines[0]!.id, { discountPerCaseMinor: '500' });
      review = await getInvoiceReview(prisma, f.actor, document.id);
      expect(review.lines[0]!.review!.discrepancies.map((item) => item.code)).toContain('LINE_TOTAL_MISMATCH');
      expect(review.hasDiscrepancies).toBe(true);
      await expect(confirmInvoiceDocument(prisma, f.actor, document.id)).rejects.toThrow('INVOICE_DISCREPANCIES_REQUIRE_ACKNOWLEDGEMENT');
      await updateInvoiceLine(prisma, f.actor, document.id, processed.lines[0]!.id, { discountPerCaseMinor: '1000', casesReceived: 4 });
      review = await getInvoiceReview(prisma, f.actor, document.id);
      expect(review.lines[0]!.review!.discrepancies.map((item) => item.code)).toEqual(['CASES_RECEIVED_DIFFER']);
      const priceBefore = (await prisma.price.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: created.baseVariantId } })).amountMinor;
      await confirmInvoiceDocument(prisma, f.actor, document.id, false, true);
      // Not silently overwritten: vendor mapping cost, retail price untouched; 4 cases × 12 = 48 received.
      expect(await prisma.vendorProductMapping.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: created.baseVariantId } })).toMatchObject({ vendorCostMinor: 1_500n, caseCostMinor: 18_000n });
      expect((await prisma.price.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: created.baseVariantId } })).amountMinor).toBe(priceBefore);
      expect((await prisma.inventoryLevel.findUniqueOrThrow({ where: { organizationId_storeId_variantId: { organizationId: f.organizationId, storeId: f.storeId, variantId: created.baseVariantId } } })).onHand).toBe(48);
      const history = await prisma.productCostHistory.findMany({ where: { organizationId: f.organizationId, variantId: created.baseVariantId }, orderBy: { occurredAt: 'asc' } });
      expect(history.map((row) => row.source)).toEqual(['PRODUCT_CREATED', 'INVOICE_CONFIRMED']);
      expect(history[1]).toMatchObject({ unitsPerCase: 12, baseCaseCostMinor: 18_000n, discountPerCaseMinor: 1_000n, effectiveCaseCostMinor: 17_000n, effectiveUnitCostMinor: 1_417n, unitsReceived: 48, casesReceived: 4, unitsShort: 12 });
      await expect(prisma.productCostHistory.update({ where: { id: history[0]!.id }, data: { baseCaseCostMinor: 1n } })).rejects.toThrow(/append-only/);
      await expect(prisma.productCostHistory.delete({ where: { id: history[0]!.id } })).rejects.toThrow(/append-only/);

      // A second invoice with the explicit "update vendor cost" choice changes the current cost, and history keeps the earlier one.
      const second = await createInvoiceDocument(prisma, f.actor, { storeId: f.storeId, vendorId: vendor.id, originalFilename: 'inv2.json', mimeType: 'application/json', content: Buffer.from('{2}'), documentHash: randomUUID() });
      const processed2 = await applyInvoiceOcrResult(prisma, f.actor, second.id, { provider: 'TEST', invoiceNumber: 'INV-2', subtotalMinor: '20400', totalMinor: '20400',
        lines: [{ description: 'Vodka', upc: code, quantity: 1, caseQuantity: 12, caseCostMinor: '20400', lineTotalMinor: '20400' }] });
      await updateInvoiceLine(prisma, f.actor, second.id, processed2.lines[0]!.id, { updateVendorCost: true });
      await confirmInvoiceDocument(prisma, f.actor, second.id, false, true); // a changed vendor price is a discrepancy the reviewer must accept
      expect(await prisma.vendorProductMapping.findFirstOrThrow({ where: { organizationId: f.organizationId, variantId: created.baseVariantId } })).toMatchObject({ vendorCostMinor: 1_700n, caseCostMinor: 20_400n });
      const all = await prisma.productCostHistory.findMany({ where: { organizationId: f.organizationId, variantId: created.baseVariantId }, orderBy: { occurredAt: 'asc' } });
      expect(all.map((row) => row.baseCaseCostMinor)).toEqual([18_000n, 18_000n, 20_400n]);
    } finally { await prisma.$disconnect(); }
  });
});
