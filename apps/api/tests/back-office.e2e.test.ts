import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadTestEnvironment } from '@rjpos/config';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import { BackOfficeController } from '../src/back-office.js';
import { CorePosController } from '../src/core-pos.js';
import { rolePermissions, TenantContextService, type TenantRequest } from '../src/tenant-context.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();

describe('Phase 2 API + PostgreSQL administrative E2E', () => {
  it('creates a sellable item through admin controllers, sells it through Core POS, and finds it in inventory/orders/audit', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const organizationId = randomUUID(); const storeId = randomUUID(); const registerId = randomUUID(); const employeeId = randomUUID();
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'API E2E' } });
      await prisma.store.create({ data: { id: storeId, organizationId, name: 'API Store', taxRateBasisPoints: 625 } });
      await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'API', lastName: 'Owner' } });
      await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
      await prisma.register.create({ data: { id: registerId, organizationId, storeId, name: 'API Register', code: `API-${registerId.slice(0, 6)}` } });
      const request = { tenantContext: { organizationId, storeId, registerId, userId: employeeId, permissions: new Set(rolePermissions.OWNER) } } as TenantRequest;
      const tenants = new TenantContextService();
      const admin = new BackOfficeController(prisma, tenants);
      const pos = new CorePosController(prisma, new SimulatedTerminalProvider(), tenants);
      const category = await admin.addCategory(request, { name: 'API Spirits' });
      const product = await admin.addProduct(request, { categoryId: category.id, name: 'API Vodka', ageRestricted: true, inventoryTracked: true });
      const variant = await admin.addVariant(request, product.id, { name: '750 ml', sku: `API-${product.id.slice(0, 8)}`, barcode: `APIUPC${product.id.replaceAll('-', '').slice(0, 12)}`, lowStockThreshold: 2 });
      await admin.addPrice(request, { variantId: variant.id, storeId, amountMinor: '1599', effectiveFrom: new Date(Date.now() - 1000).toISOString() });
      const opening = await admin.openingBalance(request, { storeId, variantId: variant.id, quantity: 8, reason: 'API E2E opening count' });
      expect(opening).toMatchObject({ level: { onHand: 8 }, movement: { type: 'INITIAL', quantityDelta: 8 } });
      expect((await pos.lookup(request, variant.barcodes[0]?.barcodeValue))[0]).toMatchObject({ variantId: variant.id, priceMinor: '1599' });
      const session = await pos.open(request, { openingCashMinor: '0' });
      const sale = await pos.cash(request, { registerSessionId: session.id, idempotencyKey: randomUUID(), lines: [{ variantId: variant.id, quantity: 1 }], ageVerified: true, tenderedMinor: '2000' });
      expect((await admin.inventory(request, { storeId })).items[0]).toMatchObject({ onHand: 7, available: 7 });
      expect((await admin.orders(request, { search: sale.orderNumber })).items).toHaveLength(1);
      expect((await admin.audit(request, {})).items.map(({ action }) => action)).toEqual(expect.arrayContaining(['PRODUCT_CREATED', 'PRODUCT_PRICE_SCHEDULED', 'INVENTORY_OPENING_BALANCE', 'SALE_COMPLETED']));
    } finally { await prisma.$disconnect(); }
  });
});
