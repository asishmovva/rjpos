import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { recordAudit, findProductForOrganization, requireRegisterContext, updateProductForOrganization } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
const suite = describe;

suite('tenant isolation and audit immutability', () => {
  it('prevents organization A from reading or mutating organization B data', async () => {
    if (!url) throw new Error('TEST_DATABASE_URL is required for Phase 0 verification');
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    const orgA = '00000000-0000-0000-0000-000000000001';
    const orgB = '00000000-0000-0000-0000-000000000012';
    const category = '00000000-0000-0000-0000-000000000023';
    const product = '00000000-0000-0000-0000-000000000024';
    try {
      await prisma.organization.upsert({ where: { id: orgB }, update: {}, create: { id: orgB, name: 'Other Organization' } });
      await prisma.category.upsert({ where: { organizationId_name: { organizationId: orgB, name: 'Other' } }, update: {}, create: { id: category, organizationId: orgB, name: 'Other' } });
      await prisma.product.upsert({ where: { id: product }, update: {}, create: { id: product, organizationId: orgB, categoryId: category, name: 'Private Product' } });
      expect(await findProductForOrganization(prisma, orgA, product)).toBeNull();
      await expect(updateProductForOrganization(prisma, orgA, product, 'Injected')).rejects.toThrow('PRODUCT_NOT_FOUND');
      expect((await prisma.product.findUniqueOrThrow({ where: { id: product } })).name).toBe('Private Product');
      await expect(requireRegisterContext(prisma, orgA, '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000017')).resolves.toBeUndefined();
      await expect(requireRegisterContext(prisma, orgB, '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000017')).rejects.toThrow('TENANT_ACCESS_DENIED');
    } finally { await prisma.$disconnect(); }
  });

  it('records sensitive actions and rejects direct audit mutation', async () => {
    if (!url) throw new Error('TEST_DATABASE_URL is required for Phase 0 verification');
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    const organizationId = '00000000-0000-0000-0000-000000000001';
    try {
      const audit = await prisma.auditRecord.create({ data: { organizationId, action: 'PERMISSION_CHANGED', entityType: 'Employee', entityId: '00000000-0000-0000-0000-000000000008', afterJson: { permission: 'product.read' } } });
      await expect(prisma.auditRecord.update({ where: { id: audit.id }, data: { action: 'TAMPERED' } })).rejects.toThrow('AUDIT_IMMUTABLE');
      await expect(prisma.auditRecord.delete({ where: { id: audit.id } })).rejects.toThrow('AUDIT_IMMUTABLE');
    } finally { await prisma.$disconnect(); }
  });
});
