import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdminActor } from './back-office.js';
import { PosError } from './pos-errors.js';
import { writeAudit } from './tax-profiles.js';

const BARCODE = /^[A-Za-z0-9._-]{4,64}$/;

async function assertFree(tx: Prisma.TransactionClient | PrismaClient, organizationId: string, value: string, exceptMappingId?: string): Promise<void> {
  const [barcodes, cases] = await Promise.all([
    tx.barcode.count({ where: { organizationId, barcodeValue: value } }),
    tx.vendorProductMapping.count({ where: { organizationId, caseUpc: value, ...(exceptMappingId ? { id: { not: exceptMappingId } } : {}) } }),
  ]);
  if (barcodes + cases > 0) throw new PosError('UPC_ALREADY_EXISTS', 409);
}

/** An additional UPC that sells the same variant (for example a retired or regional package UPC). Never duplicates an existing code. */
export async function addAlternateBarcode(prisma: PrismaClient, actor: AdminActor, input: { variantId: string; barcodeValue: string }) {
  const value = input.barcodeValue?.trim();
  if (!value || !BARCODE.test(value)) throw new PosError('UPC_INVALID');
  const variant = await prisma.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId } });
  if (!variant) throw new PosError('VARIANT_NOT_FOUND', 404);
  await assertFree(prisma, actor.organizationId, value);
  try {
    return await prisma.$transaction(async (tx) => {
      const barcode = await tx.barcode.create({ data: { organizationId: actor.organizationId, variantId: variant.id, barcodeValue: value, kind: 'ALTERNATE' } });
      await writeAudit(tx, actor, { action: 'ALTERNATE_BARCODE_ADDED', entityType: 'ProductVariant', entityId: variant.id, after: { barcodeValue: value } });
      return barcode;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('UPC_ALREADY_EXISTS', 409);
    throw error;
  }
}

/** Only alternate UPCs can be removed; the primary UPC identifies the product. */
export async function removeAlternateBarcode(prisma: PrismaClient, actor: AdminActor, barcodeId: string) {
  const barcode = await prisma.barcode.findFirst({ where: { id: barcodeId, organizationId: actor.organizationId } });
  if (!barcode) throw new PosError('BARCODE_NOT_FOUND', 404);
  if (barcode.kind !== 'ALTERNATE') throw new PosError('PRIMARY_BARCODE_PROTECTED', 409);
  await prisma.$transaction(async (tx) => {
    await tx.barcode.delete({ where: { id: barcode.id } });
    await writeAudit(tx, actor, { action: 'ALTERNATE_BARCODE_REMOVED', entityType: 'ProductVariant', entityId: barcode.variantId, after: { barcodeValue: barcode.barcodeValue } });
  });
  return { id: barcode.id, removed: true as const };
}

/** Sets or clears the UPC printed on a vendor's case for a product. It must be unused anywhere else. */
export async function setVendorCaseUpc(prisma: PrismaClient, actor: AdminActor, mappingId: string, caseUpc: string | null) {
  const mapping = await prisma.vendorProductMapping.findFirst({ where: { id: mappingId, organizationId: actor.organizationId } });
  if (!mapping) throw new PosError('VENDOR_MAPPING_NOT_FOUND', 404);
  const value = caseUpc?.trim() || null;
  if (value) { if (!BARCODE.test(value)) throw new PosError('UPC_INVALID'); await assertFree(prisma, actor.organizationId, value, mapping.id); }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.vendorProductMapping.update({ where: { id: mapping.id }, data: { caseUpc: value } });
    await writeAudit(tx, actor, { action: 'CASE_UPC_SET', entityType: 'VendorProductMapping', entityId: mapping.id, after: { caseUpc: value } });
    return updated;
  });
}
