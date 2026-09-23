import type { PrismaClient } from '@prisma/client';

export async function findProductForOrganization(prisma: PrismaClient, organizationId: string, productId: string) {
  return prisma.product.findFirst({ where: { organizationId, id: productId } });
}

export async function updateProductForOrganization(prisma: PrismaClient, organizationId: string, productId: string, name: string) {
  const result = await prisma.product.updateMany({ where: { organizationId, id: productId }, data: { name } });
  if (result.count !== 1) throw new Error('PRODUCT_NOT_FOUND');
  return prisma.product.findFirstOrThrow({ where: { organizationId, id: productId } });
}

export async function requireRegisterContext(prisma: PrismaClient, organizationId: string, storeId: string, registerId: string): Promise<void> {
  const register = await prisma.register.findFirst({ where: { organizationId, storeId, id: registerId } });
  if (!register) throw new Error('TENANT_ACCESS_DENIED');
}
