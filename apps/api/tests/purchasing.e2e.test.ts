import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import { CorePosController } from '../src/core-pos.js';
import { PurchasingController } from '../src/purchasing.js';
import { rolePermissions, TenantContextService, type TenantRequest } from '../src/tenant-context.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();

describe('Phase 4 purchasing-to-register PostgreSQL E2E', () => {
  it('imports master UPC, adds product, purchases, partially receives, completes receipt, and sells received stock', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const organizationId = randomUUID();
    const storeId = randomUUID();
    const registerId = randomUUID();
    const employeeId = randomUUID();
    const categoryId = randomUUID();
    const upc = `${String(Date.now()).slice(-10)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
    const request = { tenantContext: {
      organizationId, storeId, registerId, userId: employeeId, permissions: new Set(rolePermissions.OWNER),
    } } as unknown as TenantRequest;
    const cashierRequest = { tenantContext: {
      organizationId, storeId, registerId, userId: employeeId, permissions: new Set(rolePermissions.CASHIER),
    } } as unknown as TenantRequest;
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Phase 4 E2E' } });
      await prisma.store.create({ data: { id: storeId, organizationId, name: 'E2E Store', taxRateBasisPoints: 0 } });
      await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'E2E', lastName: 'Owner' } });
      await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
      await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'E2E Register', code: `P4-${registerId.slice(0, 6)}` } });
      await prisma.category.create({ data: { id: categoryId, organizationId, name: `E2E ${categoryId.slice(0, 6)}` } });
      const tenants = new TenantContextService();
      const purchasing = new PurchasingController(prisma, tenants);
      const pos = new CorePosController(prisma, new SimulatedTerminalProvider(), tenants);

      const imported = await purchasing.importCatalog(request, { csv: `upc,name,brand,size,unit,category\n${upc},E2E Gin,Test Brand,750,ML,Spirits` });
      expect(imported.added).toBe(1);
      const found = await purchasing.lookupUpc(request, upc);
      expect(found.status).toBe('MASTER_ONLY');
      const storeProduct = await purchasing.addMasterToStore(request, upc, {
        categoryId, sku: `E2E-${organizationId.slice(0, 8)}`, storeId, priceMinor: '2000', costMinor: '900',
      });
      expect(storeProduct.status).toBe('ADDED');
      if (storeProduct.status !== 'ADDED') throw new Error('Product was not added to the tenant catalog');
      const variantId = storeProduct.variant.id;
      expect((await prisma.storeProductCost.findUniqueOrThrow({
        where: { organizationId_storeId_variantId: { organizationId, storeId, variantId } },
      })).amountMinor).toBe(900n);
      expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).costMinor).toBeNull();
      expect(await prisma.inventoryLevel.count({ where: { organizationId, storeId, variantId } })).toBe(0);

      const vendor = await purchasing.addVendor(request, { name: `E2E Vendor ${organizationId.slice(0, 8)}` });
      await purchasing.saveMapping(request, { vendorId: vendor.id, variantId, vendorCostMinor: '1100' });
      const order = await purchasing.createPurchaseOrder(request, {
        storeId, vendorId: vendor.id, poNumber: `E2E-${organizationId.slice(0, 8)}`,
        lines: [{ variantId, quantity: 5 }],
      });
      await purchasing.submitPurchaseOrder(request, order.id);
      const lineId = order.lines[0]!.id;
      const firstReceipt = await purchasing.receive(request, order.id, {
        idempotencyKey: randomUUID(), vendorReferenceNumber: 'INV-1',
        lines: [{ purchaseOrderLineId: lineId, deliveredQuantity: 2 }],
      });
      expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PARTIALLY_RECEIVED');
      expect((await prisma.inventoryLevel.findUniqueOrThrow({
        where: { organizationId_storeId_variantId: { organizationId, storeId, variantId } },
      })).onHand).toBe(2);
      await purchasing.receive(request, order.id, {
        idempotencyKey: randomUUID(), vendorReferenceNumber: 'INV-2',
        lines: [{ purchaseOrderLineId: lineId, deliveredQuantity: 3 }],
      });
      expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('RECEIVED');
      expect(await prisma.purchaseReceipt.count({ where: { id: firstReceipt.id } })).toBe(1);
      expect((await prisma.inventoryLevel.findUniqueOrThrow({
        where: { organizationId_storeId_variantId: { organizationId, storeId, variantId } },
      })).onHand).toBe(5);

      const registerProduct = await pos.lookup(request, upc);
      expect(registerProduct).toHaveLength(1);
      expect(registerProduct[0]).toMatchObject({ variantId, priceMinor: '2000', barcode: upc });
      const session = await pos.open(request, { openingCashMinor: '0' });
      await pos.cash(request, { registerSessionId: session.id, idempotencyKey: randomUUID(),
        lines: [{ variantId, quantity: 1 }], tenderedMinor: '2000' });
      expect((await prisma.inventoryLevel.findUniqueOrThrow({
        where: { organizationId_storeId_variantId: { organizationId, storeId, variantId } },
      })).onHand).toBe(4);
      await expect(purchasing.vendors(cashierRequest, {})).rejects.toThrow();
    } finally { await prisma.$disconnect(); }
  });
});
