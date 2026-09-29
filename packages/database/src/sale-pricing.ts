import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

type TaxedVariant = {
  taxProfile: { kind: 'STANDARD' | 'NON_TAXABLE' | 'CUSTOM'; rateBasisPoints: number | null; name: string } | null;
  product: { taxCategory: string; taxProfile: { kind: 'STANDARD' | 'NON_TAXABLE' | 'CUSTOM'; rateBasisPoints: number | null; name: string } | null };
};
type TaxProfileRow = { kind: 'STANDARD' | 'NON_TAXABLE' | 'CUSTOM'; rateBasisPoints: number | null; name: string };

export const variantTaxInclude = { taxProfile: true, product: { include: { taxProfile: true } } } as const;

/** The organization's default tax profile (normally "Standard State Tax", which follows the store rate). */
export function loadDefaultTaxProfile(tx: Tx, organizationId: string): Promise<TaxProfileRow | null> {
  return tx.taxProfile.findFirst({ where: { organizationId, isDefault: true }, select: { kind: true, rateBasisPoints: true, name: true } });
}

/**
 * Tax rate for one sellable line: variant profile → product profile → legacy EXEMPT category → organization default.
 * The result is snapshotted on the order item, so later profile edits never change past sales.
 */
export function resolveLineTax(variant: TaxedVariant, defaultProfile: TaxProfileRow | null, storeRateBasisPoints: number): { rateBasisPoints: number; profileName: string | null } {
  const explicit = variant.taxProfile ?? variant.product.taxProfile;
  if (!explicit && variant.product.taxCategory === 'EXEMPT') return { rateBasisPoints: 0, profileName: 'Non-Taxable' };
  const profile = explicit ?? defaultProfile;
  if (!profile) return { rateBasisPoints: storeRateBasisPoints, profileName: null };
  const rateBasisPoints = profile.kind === 'STANDARD' ? storeRateBasisPoints : profile.kind === 'NON_TAXABLE' ? 0 : profile.rateBasisPoints ?? 0;
  return { rateBasisPoints, profileName: profile.name };
}

/** Active special prices for a price book that apply at `now`; when several match, the most recently effective wins. */
export async function loadSpecialPrices(tx: Tx, input: { organizationId: string; storeId: string; priceBookId: string; variantIds: string[]; now: Date }): Promise<{ priceBookName: string; prices: Map<string, bigint> } | null> {
  const book = await tx.priceBook.findFirst({ where: { id: input.priceBookId, organizationId: input.organizationId, active: true }, select: { name: true } });
  if (!book) return null;
  const rows = await tx.specialPrice.findMany({ where: {
    organizationId: input.organizationId, storeId: input.storeId, priceBookId: input.priceBookId, active: true, variantId: { in: input.variantIds },
    AND: [{ OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: input.now } }] }, { OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.now } }] }],
  }, orderBy: [{ effectiveFrom: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }] });
  return { priceBookName: book.name, prices: new Map(rows.map((row) => [row.variantId, row.amountMinor])) };
}
