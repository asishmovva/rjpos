import type { Prisma, PrismaClient } from '@prisma/client';

export type CatalogLookupInput = {
  organizationId: string;
  storeId: string;
  barcode?: string;
  sku?: string;
  search?: string;
};

export type CatalogLookupResult = {
  variantId: string;
  productId: string;
  productName: string;
  brand: string | null;
  variantName: string;
  sku: string;
  barcode: string | null;
  size: string | null;
  unit: string;
  priceMinor: string | null;
  currency: string;
  active: boolean;
  ageRestricted: boolean;
  inventoryTracked: boolean;
  taxCategory: string;
};

type CatalogClient = PrismaClient | Prisma.TransactionClient;

function normalizeLookupValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export async function lookupCatalog(
  prisma: CatalogClient,
  input: CatalogLookupInput,
): Promise<CatalogLookupResult[]> {
  const barcode = normalizeLookupValue(input.barcode);
  const sku = normalizeLookupValue(input.sku);
  const search = normalizeLookupValue(input.search);
  if (!barcode && !sku && !search) throw new Error('CATALOG_QUERY_REQUIRED');

  const now = new Date();
  const variants = await prisma.productVariant.findMany({
    where: {
      organizationId: input.organizationId,
      ...(barcode ? { barcodes: { some: { barcodeValue: barcode } } } : {}),
      ...(sku ? { sku } : {}),
      ...(search
        ? {
            OR: [
              { sku: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { product: { name: { contains: search, mode: 'insensitive' } } },
              { product: { brand: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      product: true,
      barcodes: true,
      prices: {
        where: {
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          AND: [{ OR: [{ storeId: input.storeId }, { storeId: null }] }],
        },
        orderBy: { effectiveFrom: 'desc' },
      },
    },
    orderBy: [{ product: { name: 'asc' } }, { name: 'asc' }],
    take: barcode || sku ? 2 : 20,
  });

  return variants.map((variant) => {
    const price =
      variant.prices.find((candidate) => candidate.storeId === input.storeId) ??
      variant.prices.find((candidate) => candidate.storeId === null);
    return {
      variantId: variant.id,
      productId: variant.productId,
      productName: variant.product.name,
      brand: variant.product.brand,
      variantName: variant.name,
      sku: variant.sku,
      barcode:
        variant.barcodes.find((candidate) => candidate.barcodeValue === barcode)
          ?.barcodeValue ??
        variant.barcodes[0]?.barcodeValue ??
        null,
      size: variant.size?.toString() ?? null,
      unit: variant.unit,
      priceMinor: price?.amountMinor.toString() ?? null,
      currency: price?.currency ?? 'USD',
      active: variant.active && variant.product.active,
      ageRestricted: variant.product.ageRestricted,
      inventoryTracked: variant.product.inventoryTracked,
      taxCategory: variant.product.taxCategory,
    };
  });
}
