import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { describe, expect, it } from 'vitest';
import { applyInvoiceOcrResult, confirmInvoiceDocument, createInvoiceDocument } from '../src/index.js';

const { TEST_DATABASE_URL } = loadTestEnvironment();

describe.sequential('assisted invoice receiving with PostgreSQL', () => {
  it('keeps OCR as a draft and posts stock only after explicit reviewed confirmation', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const organizationId = randomUUID(); const storeId = randomUUID(); const employeeId = randomUUID();
    const categoryId = randomUUID(); const productId = randomUUID(); const variantId = randomUUID(); const vendorId = randomUUID();
    const upc = `${Date.now().toString().slice(-11)}7`;
    const actor = { organizationId, storeId, userId: employeeId };
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Invoice test' } });
      await prisma.store.create({ data: { id: storeId, organizationId, name: 'Invoice Store' } });
      await prisma.employee.create({ data: { id: employeeId, organizationId, firstName: 'Invoice', lastName: 'Manager' } });
      await prisma.employeeStore.create({ data: { organizationId, employeeId, storeId } });
      await prisma.category.create({ data: { id: categoryId, organizationId, name: 'Invoice category' } });
      await prisma.product.create({ data: { id: productId, organizationId, categoryId, name: 'Invoice product' } });
      await prisma.productVariant.create({ data: { id: variantId, organizationId, productId, name: 'Each', sku: `INV-${organizationId.slice(0, 6)}` } });
      await prisma.barcode.create({ data: { organizationId, variantId, barcodeValue: upc } });
      await prisma.vendor.create({ data: { id: vendorId, organizationId, name: 'Invoice Vendor' } });
      const content = Buffer.from('invoice-image-placeholder');
      const document = await createInvoiceDocument(prisma, actor, { vendorId, originalFilename: 'invoice.png', mimeType: 'image/png', content,
        documentHash: createHash('sha256').update(content).digest('hex') });
      await applyInvoiceOcrResult(prisma, actor, document.id, { provider: 'TEST_FIXTURE', invoiceNumber: `I-${organizationId.slice(0, 6)}`,
        totalMinor: '2000', lines: [{ description: 'Invoice product', upc, quantity: 2, unitCostMinor: '1000', lineTotalMinor: '2000' }] });
      expect(await prisma.inventoryMovement.count({ where: { organizationId } })).toBe(0);
      expect(await prisma.purchaseOrder.count({ where: { organizationId } })).toBe(0);
      const confirmed = await confirmInvoiceDocument(prisma, actor, document.id);
      expect(confirmed.reviewStatus).toBe('CONFIRMED');
      expect(await prisma.inventoryLevel.findUnique({ where: { organizationId_storeId_variantId: { organizationId, storeId, variantId } } })).toMatchObject({ onHand: 2 });
      expect(await prisma.inventoryMovement.count({ where: { organizationId, type: 'PURCHASE_RECEIPT' } })).toBe(1);
      expect(await prisma.auditRecord.findFirst({ where: { organizationId, action: 'INVOICE_CONFIRMED' } })).toBeTruthy();
    } finally { await prisma.$disconnect(); }
  });
});
