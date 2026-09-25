import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import {
  addMasterProductToStore,
  checkoutCash,
  createPurchaseOrder,
  createVendor,
  getPurchaseOrder,
  importMasterCatalogCsv,
  listPurchaseOrders,
  listVendorMappings,
  listVendors,
  lookupMasterProduct,
  normalizeUpc,
  openRegisterSession,
  receivePurchaseOrder,
  saveVendorMapping,
  transitionPurchaseOrder,
  updateDraftPurchaseOrder,
  updateVendor,
} from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();
const suite = describe.sequential;
let upcSequence = 0;
const upc = () => `${String(Date.now()).slice(-10)}${String(upcSequence++).padStart(2, '0')}`;

async function fixture() {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const organizationId = randomUUID();
  const storeId = randomUUID();
  const registerId = randomUUID();
  const employeeId = randomUUID();
  const categoryId = randomUUID();
  const productId = randomUUID();
  const variantId = randomUUID();
  const suffix = organizationId.slice(0, 8);
  await prisma.organization.create({ data: { id: organizationId, name: `Phase 4 ${suffix}` } });
  await prisma.store.create({ data: { id: storeId, organizationId, name: 'Purchasing Store' } });
  await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Purchasing', lastName: 'Manager' } });
  await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
  await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'Register', code: `P4-${suffix}` } });
  await prisma.category.create({ data: { id: categoryId, organizationId, name: `Phase 4 ${suffix}` } });
  await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'Purchase Test Product' } });
  await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: 'Each', sku: `P4-${suffix}` } });
  return { prisma, organizationId, storeId, registerId, employeeId, categoryId, productId, variantId,
    actor: { organizationId, userId: employeeId, storeId } };
}

suite('Phase 4 master catalog, vendors, purchase orders, and receiving with PostgreSQL', () => {
  it('normalizes UPCs, imports idempotently, reports invalid/duplicate/conflicting identities, and adds store catalog without stock', async () => {
    const f = await fixture();
    const productUpc = upc();
    try {
      expect(normalizeUpc(` ${productUpc.slice(0, 6)}-${productUpc.slice(6)} `)).toBe(productUpc);
      const firstCsv = [
        'upc,name,brand,size,unit,category,description',
        `${productUpc},Dry Gin,Juniper Co,750,ML,Spirits,Small batch`,
        `${productUpc},Dry Gin,Juniper Co,750,ML,Spirits,Duplicate row`,
        '123,Malformed,Brand,750,ML,Spirits,Bad UPC',
      ].join('\n');
      const first = await importMasterCatalogCsv(f.prisma, f.actor, firstCsv);
      expect(first).toMatchObject({ added: 1, updated: 0, skipped: 0, invalid: 1, duplicate: 1 });
      expect(first.issues.map((issue) => issue.code)).toContain('MASTER_UPC_DUPLICATE_IN_FILE');
      expect((await importMasterCatalogCsv(f.prisma, f.actor, firstCsv)).skipped).toBe(1);
      const updated = await importMasterCatalogCsv(f.prisma, f.actor,
        `upc,name,brand,size,unit,category,description\n${productUpc},Dry Gin,Juniper Co,750,ML,New Category,Updated metadata`);
      expect(updated.updated).toBe(1);
      const conflict = await importMasterCatalogCsv(f.prisma, f.actor,
        `upc,name,brand,size,unit\n${productUpc},Different Identity,Juniper Co,750,ML`);
      expect(conflict.skipped).toBe(1);
      expect(conflict.issues[0]?.code).toBe('MASTER_UPC_IDENTITY_CONFLICT');
      expect((await f.prisma.masterProduct.findUniqueOrThrow({ where: { upc: productUpc } })).name).toBe('Dry Gin');

      const found = await lookupMasterProduct(f.prisma, f.actor, productUpc);
      expect(found.status).toBe('MASTER_ONLY');
      if (found.status !== 'MASTER_ONLY') throw new Error('Master product lookup did not find the imported product');
      const added = await addMasterProductToStore(f.prisma, f.actor, productUpc, {
        categoryId: f.categoryId, sku: `MASTER-${f.organizationId.slice(0, 8)}`, storeId: f.storeId, lowStockThreshold: 4,
      });
      expect(added.status).toBe('ADDED');
      expect(added.inventoryCreated).toBe(false);
      expect(added.variant.lowStockThreshold).toBe(4);
      expect(await f.prisma.price.count({ where: { organizationId: f.organizationId, variant: { masterProductId: found.product.id } } })).toBe(0);
      expect(await f.prisma.storeProductCost.count({ where: { organizationId: f.organizationId, variant: { masterProductId: found.product.id } } })).toBe(0);
      expect(await f.prisma.inventoryLevel.count({ where: { organizationId: f.organizationId, variant: { masterProductId: found.product.id } } })).toBe(0);
      expect((await lookupMasterProduct(f.prisma, f.actor, productUpc)).status).toBe('IN_STORE');
      const duplicate = await addMasterProductToStore(f.prisma, f.actor, productUpc, {
        categoryId: f.categoryId, sku: `DUP-${f.organizationId.slice(0, 8)}`, storeId: f.storeId,
      });
      expect(duplicate.status).toBe('IN_STORE');
      expect(await f.prisma.product.count({ where: { organizationId: f.organizationId, variants: { some: { masterProductId: found.product.id } } } })).toBe(1);

      const sourceUpc = upc().slice(1);
      const sourceCsv = [
        'ITEMNAME,DEPNAME,MAINUPC,SIZENAME,PACKNAME,CURRENTCOST,PRICEPERUNIT,TOTALQTY',
        `Light Lager,Beer,${sourceUpc},12 OZ,6-Pack,8.66,10.99,500`,
      ].join('\n');
      const sourceImport = await importMasterCatalogCsv(f.prisma, f.actor, sourceCsv);
      expect(sourceImport).toMatchObject({ added: 1, invalid: 0, duplicate: 0 });
      const sourceMaster = await f.prisma.masterProduct.findUniqueOrThrow({ where: { upc: `0${sourceUpc}` } });
      expect(sourceMaster).toMatchObject({
        name: 'Light Lager', category: 'Beer', sizeLabel: '12 OZ', packName: '6-Pack',
        referenceCostMinor: 866n, referencePriceMinor: 1099n,
      });
      expect((await importMasterCatalogCsv(f.prisma, f.actor, sourceCsv)).skipped).toBe(1);
      const sourcePriceUpdate = sourceCsv.replace('10.99,500', '11.99,900');
      expect((await importMasterCatalogCsv(f.prisma, f.actor, sourcePriceUpdate)).updated).toBe(1);
      expect((await f.prisma.masterProduct.findUniqueOrThrow({ where: { upc: `0${sourceUpc}` } })).referencePriceMinor).toBe(1199n);
      const sourceAdded = await addMasterProductToStore(f.prisma, f.actor, `0${sourceUpc}`, {
        categoryId: f.categoryId, sku: `SHEET-${f.organizationId.slice(0, 8)}`, storeId: f.storeId,
      });
      expect(sourceAdded.status).toBe('ADDED');
      if (sourceAdded.status !== 'ADDED') throw new Error('Source catalog product was not added to the store');
      expect(sourceAdded.variant.name).toBe('12 OZ 6-Pack');
      expect(await f.prisma.price.count({ where: { organizationId: f.organizationId, variantId: sourceAdded.variant.id } })).toBe(0);
      expect(await f.prisma.storeProductCost.count({ where: { organizationId: f.organizationId, variantId: sourceAdded.variant.id } })).toBe(0);
      expect(await f.prisma.inventoryLevel.count({ where: { organizationId: f.organizationId, variantId: sourceAdded.variant.id } })).toBe(0);
    } finally { await f.prisma.$disconnect(); }
  });

  it('isolates vendors and mappings, preserves PO costs, serializes receipts, and posts received inventory to the ledger', async () => {
    const f = await fixture();
    try {
      const vendor = await createVendor(f.prisma, f.actor, {
        name: `Vendor ${f.organizationId.slice(0, 8)}`, email: 'orders@example.test', accountReference: 'ACCT-1',
      });
      expect((await listVendors(f.prisma, { ...f.actor, organizationId: randomUUID() }, {})).total).toBe(0);
      const edited = await updateVendor(f.prisma, f.actor, vendor.id, { phone: '+15555550123' });
      expect(edited.phone).toBe('+15555550123');
      await updateVendor(f.prisma, f.actor, vendor.id, { active: false });
      await expect(createPurchaseOrder(f.prisma, f.actor, {
        vendorId: vendor.id, poNumber: 'P4-INACTIVE', lines: [{ variantId: f.variantId, quantity: 1, unitCostMinor: '100' }],
      })).rejects.toThrow('VENDOR_NOT_FOUND');
      await updateVendor(f.prisma, f.actor, vendor.id, { active: true });
      const mapping = await saveVendorMapping(f.prisma, f.actor, {
        vendorId: vendor.id, variantId: f.variantId, vendorSku: 'VSKU-1', vendorCostMinor: '1000',
        casePackQuantity: 1, minimumOrderQuantity: 1, preferred: true,
      });
      expect((await listVendorMappings(f.prisma, { ...f.actor, organizationId: randomUUID() }, {})).total).toBe(0);
      await expect(saveVendorMapping(f.prisma, { ...f.actor, organizationId: randomUUID() }, {
        id: mapping.id, vendorId: vendor.id, variantId: f.variantId, vendorCostMinor: '1000',
      })).rejects.toThrow('VENDOR_NOT_FOUND');

      const draft = await createPurchaseOrder(f.prisma, f.actor, {
        storeId: f.storeId, vendorId: vendor.id, poNumber: `P4-${f.organizationId.slice(0, 8)}`, notes: 'Initial',
        lines: [{ variantId: f.variantId, quantity: 5 }],
      });
      expect(draft.status).toBe('DRAFT');
      expect(draft.lines[0]?.unitCostMinor).toBe(1000n);
      await saveVendorMapping(f.prisma, f.actor, { id: mapping.id, vendorId: vendor.id, variantId: f.variantId, vendorCostMinor: '1200' });
      const editedDraft = await updateDraftPurchaseOrder(f.prisma, f.actor, draft.id, { notes: 'Edited draft' });
      expect(editedDraft.lines[0]?.unitCostMinor).toBe(1000n);
      await expect(getPurchaseOrder(f.prisma, { ...f.actor, organizationId: randomUUID() }, draft.id)).rejects.toThrow('PURCHASE_ORDER_NOT_FOUND');
      await expect(receivePurchaseOrder(f.prisma, { ...f.actor, storeId: randomUUID() }, draft.id, {
        idempotencyKey: `wrong-store-${randomUUID()}`, lines: [{ purchaseOrderLineId: draft.lines[0]!.id, deliveredQuantity: 1 }],
      })).rejects.toThrow('STORE_ACCESS_DENIED');
      await expect(createPurchaseOrder(f.prisma, { ...f.actor, organizationId: randomUUID() }, {
        storeId: f.storeId, vendorId: vendor.id, poNumber: 'CROSS-TENANT', lines: [{ variantId: f.variantId, quantity: 1 }],
      })).rejects.toThrow('STORE_NOT_FOUND');
      await expect(listPurchaseOrders(f.prisma, { ...f.actor, storeId: randomUUID() }, {})).resolves.toMatchObject({ total: 0 });

      await transitionPurchaseOrder(f.prisma, f.actor, draft.id, 'SUBMIT');
      await expect(transitionPurchaseOrder(f.prisma, f.actor, draft.id, 'SUBMIT')).rejects.toThrow('PURCHASE_ORDER_TRANSITION_INVALID');
      const lineId = draft.lines[0]!.id;
      const firstReceiptInput = {
        idempotencyKey: `receipt-${randomUUID()}`,
        vendorReferenceNumber: 'INV-1',
        lines: [{ purchaseOrderLineId: lineId, deliveredQuantity: 2, damagedQuantity: 1, unitCostMinor: '1100' }],
      };
      const firstReceipt = await receivePurchaseOrder(f.prisma, f.actor, draft.id, firstReceiptInput);
      expect((await receivePurchaseOrder(f.prisma, f.actor, draft.id, firstReceiptInput)).id).toBe(firstReceipt.id);
      await expect(receivePurchaseOrder(f.prisma, f.actor, draft.id, {
        ...firstReceiptInput, lines: [{ purchaseOrderLineId: lineId, deliveredQuantity: 1 }],
      })).rejects.toThrow('RECEIPT_IDEMPOTENCY_CONFLICT');
      expect((await f.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('PARTIALLY_RECEIVED');
      await expect(receivePurchaseOrder(f.prisma, f.actor, draft.id, {
        idempotencyKey: `too-many-${randomUUID()}`, lines: [{ purchaseOrderLineId: lineId, deliveredQuantity: 4 }],
      })).rejects.toThrow('RECEIPT_OVER_ORDERED_QUANTITY');
      await expect(receivePurchaseOrder(f.prisma, f.actor, draft.id, {
        idempotencyKey: `negative-${randomUUID()}`, lines: [{ purchaseOrderLineId: lineId, deliveredQuantity: -1 }],
      })).rejects.toThrow('RECEIPT_QUANTITY_INVALID');

      const concurrent = await Promise.allSettled([
        receivePurchaseOrder(f.prisma, f.actor, draft.id, { idempotencyKey: `race-a-${randomUUID()}`, lines: [{ purchaseOrderLineId: lineId, deliveredQuantity: 3, rejectedQuantity: 1 }] }),
        receivePurchaseOrder(f.prisma, f.actor, draft.id, { idempotencyKey: `race-b-${randomUUID()}`, lines: [{ purchaseOrderLineId: lineId, deliveredQuantity: 3, rejectedQuantity: 1 }] }),
      ]);
      expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect((await f.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('RECEIVED');
      const level = await f.prisma.inventoryLevel.findUniqueOrThrow({
        where: { organizationId_storeId_variantId: { organizationId: f.organizationId, storeId: f.storeId, variantId: f.variantId } },
      });
      expect(level.onHand).toBe(3);
      const movements = await f.prisma.inventoryMovement.findMany({ where: { organizationId: f.organizationId, type: 'PURCHASE_RECEIPT' } });
      expect(movements.reduce((sum, movement) => sum + movement.quantityDelta, 0)).toBe(3);
      expect(movements.every((movement) => movement.referenceType === 'PURCHASE_RECEIPT')).toBe(true);
      expect(await f.prisma.auditRecord.count({ where: { organizationId: f.organizationId, action: 'PURCHASE_ORDER_RECEIVED' } })).toBe(2);
      expect(await f.prisma.outboxEvent.count({ where: { organizationId: f.organizationId, eventType: 'PURCHASE_ORDER_RECEIPT_POSTED' } })).toBe(2);
      expect(await f.prisma.purchaseReceiptLine.findFirstOrThrow({ where: { receiptId: firstReceipt.id } })).toMatchObject({
        deliveredQuantity: 2, damagedQuantity: 1, unitCostMinor: 1100n,
      });
      expect((await f.prisma.vendorProductMapping.findUniqueOrThrow({ where: { id: mapping.id } })).vendorCostMinor).toBe(1200n);
      expect((await f.prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: lineId } })).unitCostMinor).toBe(1000n);

      await f.prisma.price.create({ data: { organizationId: f.organizationId, storeId: f.storeId, variantId: f.variantId,
        amountMinor: 500n, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
      const session = await openRegisterSession(f.prisma, { organizationId: f.organizationId, storeId: f.storeId,
        registerId: f.registerId, employeeId: f.employeeId, openingCashMinor: 0n });
      await checkoutCash(f.prisma, { organizationId: f.organizationId, storeId: f.storeId, registerId: f.registerId,
        registerSessionId: session.id, employeeId: f.employeeId, idempotencyKey: randomUUID(),
        lines: [{ variantId: f.variantId, quantity: 1 }], tenderedMinor: 500n });
      const afterSale = await f.prisma.inventoryLevel.findUniqueOrThrow({
        where: { organizationId_storeId_variantId: { organizationId: f.organizationId, storeId: f.storeId, variantId: f.variantId } },
      });
      expect(afterSale.onHand).toBe(2);

      const cancelDraft = await createPurchaseOrder(f.prisma, f.actor, {
        storeId: f.storeId, vendorId: vendor.id, poNumber: `CANCEL-${f.organizationId.slice(0, 8)}`,
        lines: [{ variantId: f.variantId, quantity: 1, unitCostMinor: '1200' }],
      });
      await transitionPurchaseOrder(f.prisma, f.actor, cancelDraft.id, 'CANCEL');
      await expect(receivePurchaseOrder(f.prisma, f.actor, cancelDraft.id, {
        idempotencyKey: `cancel-${randomUUID()}`, lines: [{ purchaseOrderLineId: cancelDraft.lines[0]!.id, deliveredQuantity: 1 }],
      })).rejects.toThrow('PURCHASE_ORDER_NOT_RECEIVABLE');

      const fullOrder = await createPurchaseOrder(f.prisma, f.actor, {
        storeId: f.storeId, vendorId: vendor.id, poNumber: `FULL-${f.organizationId.slice(0, 8)}`,
        lines: [{ variantId: f.variantId, quantity: 2, unitCostMinor: '1200' }],
      });
      await transitionPurchaseOrder(f.prisma, f.actor, fullOrder.id, 'SUBMIT');
      await receivePurchaseOrder(f.prisma, f.actor, fullOrder.id, {
        idempotencyKey: `full-${randomUUID()}`, lines: [{ purchaseOrderLineId: fullOrder.lines[0]!.id, deliveredQuantity: 2 }],
      });
      expect((await f.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: fullOrder.id } })).status).toBe('RECEIVED');
    } finally { await f.prisma.$disconnect(); }
  });
});
