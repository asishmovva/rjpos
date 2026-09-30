import { adminRequest } from './admin-client';

const body = (method: 'POST' | 'PATCH' | 'DELETE', value?: unknown): RequestInit => ({ method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });

export type TaxProfile = { id: string; name: string; kind: 'STANDARD' | 'NON_TAXABLE' | 'CUSTOM'; rateBasisPoints: number | null; description: string | null; active: boolean; isDefault: boolean; referenceCount: number };
export type TaxStore = { id: string; name: string; taxRateBasisPoints: number };
export type PriceBook = { id: string; name: string; description: string | null; active: boolean; sortOrder: number; _count?: { specialPrices: number } };
export type SpecialPrice = { id: string; priceBookId: string; storeId: string; variantId: string; amountMinor: string; active: boolean; effectiveFrom: string | null; effectiveTo: string | null;
  priceBook: { id: string; name: string; active: boolean }; variant?: { id: string; name: string; sku: string }; store?: { id: string; name: string } };
export type VendorDealKind = 'DISCOUNT_PER_CASE' | 'DEAL_CASE_PRICE' | 'QUANTITY_BREAK' | 'REBATE' | 'ALLOWANCE';
export type VendorDeal = { id: string; vendorId: string; variantId: string | null; name: string; kind: VendorDealKind; amountMinor: string | null; dealCaseCostMinor: string | null; minimumCases: number | null;
  startsAt: string | null; endsAt: string | null; active: boolean; notes: string | null; vendor?: { id: string; name: string } };
export type UpcLookup =
  | { status: 'NEW'; upc: string }
  | { status: 'IN_STORE'; upc: string; variant: { id: string; name: string; sku: string; productId: string; productName: string; brand: string | null; category: string } }
  | { status: 'MASTER_CATALOG'; upc: string; master: { id: string; name: string; brand: string | null; category: string | null; sizeLabel: string | null; packName: string | null; referenceCostMinor: string | null; referencePriceMinor: string | null } };

export type PurchasedProductRequest = {
  storeId: string; draft?: boolean;
  product: { name: string; categoryId: string; brand: string; description?: string; taxProfileId?: string | null; ageRestricted?: boolean };
  identity: { upc: string; sizeLabel: string; sku?: string };
  vendor?: { vendorId: string; vendorSku?: string; caseCostMinor: string; unitsPerCase: number; discountPerCaseMinor?: string; rebatePerCaseMinor?: string; caseUpc?: string; minimumOrderQuantity?: number; preferred?: boolean };
  sellingUnits: Array<{ name: string; unitsPerPack: number; sku?: string; upc?: string; priceMinor?: string }>;
  specialPrices?: Array<{ priceBookId: string; unitIndex: number; amountMinor: string }>;
  inventory?: { openingQuantity: number; lowStockThreshold?: number; reorderTarget?: number };
};

export const costingApi = {
  taxProfiles: () => adminRequest<{ profiles: TaxProfile[]; stores: TaxStore[] }>('/tax-profiles'),
  createTaxProfile: (value: { name: string; rateBasisPoints: number; description?: string }) => adminRequest<TaxProfile>('/tax-profiles', body('POST', value)),
  updateTaxProfile: (id: string, value: Record<string, unknown>) => adminRequest<TaxProfile>(`/tax-profiles/${id}`, body('PATCH', value)),
  deleteTaxProfile: (id: string) => adminRequest<{ deleted: true }>(`/tax-profiles/${id}`, body('DELETE')),
  assignTaxProfile: (value: { productId?: string; variantId?: string; taxProfileId: string | null }) => adminRequest<{ taxProfileId: string | null }>('/tax-assignments', body('POST', value)),
  priceBooks: () => adminRequest<PriceBook[]>('/price-books'),
  createPriceBook: (value: { name: string; description?: string }) => adminRequest<PriceBook>('/price-books', body('POST', value)),
  updatePriceBook: (id: string, value: Record<string, unknown>) => adminRequest<PriceBook>(`/price-books/${id}`, body('PATCH', value)),
  specialPrices: (query: { productId?: string; variantId?: string }) => adminRequest<SpecialPrice[]>(`/special-prices?${new URLSearchParams(query as Record<string, string>).toString()}`),
  saveSpecialPrice: (value: Record<string, unknown>) => adminRequest<SpecialPrice>('/special-prices', body('POST', value)),
  vendorDeals: (query: { vendorId?: string; variantId?: string }) => adminRequest<VendorDeal[]>(`/vendor-deals?${new URLSearchParams(query as Record<string, string>).toString()}`),
  createVendorDeal: (value: Record<string, unknown>) => adminRequest<VendorDeal>('/vendor-deals', body('POST', value)),
  updateVendorDeal: (id: string, value: Record<string, unknown>) => adminRequest<VendorDeal>(`/vendor-deals/${id}`, body('PATCH', value)),
  upcLookup: (upc: string) => adminRequest<UpcLookup>(`/product-costing/upc-lookup?upc=${encodeURIComponent(upc)}`),
  createPurchasedProduct: (value: PurchasedProductRequest) => adminRequest<{ productId: string; baseVariantId: string; draft: boolean; effectiveUnitCostMinor: string | null; variants: Array<{ id: string; name: string; sku: string; unitsPerPack: number }> }>('/product-costing/purchased', body('POST', value)),
  productDetail: (id: string) => adminRequest<ProductDetail>(`/product-costing/${id}/detail`),
  invoiceReview: (id: string) => adminRequest<InvoiceReview>(`/invoices/${id}/review`),
};

export type ProductDetail = {
  product: { id: string; name: string; brand: string | null; active: boolean; draft: boolean; ageRestricted: boolean; taxProfileId: string | null; category: { name: string }; taxProfile: TaxProfile | null;
    variants: Array<{ id: string; name: string; sku: string; active: boolean; unitsPerPack: number; baseVariantId: string | null; costMinor: string | null; baseVariant: { id: string; name: string; sku: string } | null; taxProfile: TaxProfile | null; barcodes: Array<{ barcodeValue: string }> }> };
  prices: Array<{ id: string; variantId: string; storeId: string | null; amountMinor: string; effectiveFrom: string }>;
  specialPrices: SpecialPrice[];
  mappings: Array<{ id: string; vendorId: string; variantId: string; vendorSku: string | null; caseUpc: string | null; minimumOrderQuantity: number; vendorCostMinor: string; caseCostMinor: string | null; casePackQuantity: number; preferred: boolean; active: boolean; vendor: { id: string; name: string } }>;
  levels: Array<{ id: string; variantId: string; onHand: number; reserved: number; store: { id: string; name: string } }>;
  storeCosts: Array<{ id: string; variantId: string; amountMinor: string; store: { id: string; name: string } }>;
  purchaseHistory: Array<{ id: string; orderedQuantity: number; receivedQuantity: number; unitCostMinor: string; unitsPerCase: number | null; caseCostMinor: string | null; discountPerCaseMinor: string | null; createdAt: string; purchaseOrder: { id: string; poNumber: string; status: string; vendor: { id: string; name: string } } }>;
  receivingHistory: Array<{ id: string; deliveredQuantity: number; damagedQuantity: number; rejectedQuantity: number; unitCostMinor: string; receipt: { id: string; receivedAt: string; vendorReferenceNumber: string | null } }>;
  invoices: Array<{ id: string; quantity: number; caseQuantity: number; caseCostMinor: string | null; discountPerCaseMinor: string | null; unitCostMinor: string; lineTotalMinor: string; invoiceDocument: { id: string; invoiceNumber: string | null; invoiceDate: string | null; reviewStatus: string; vendor: { id: string; name: string } | null } }>;
  costHistory: Array<{ id: string; source: string; occurredAt: string; vendorId: string | null; casesOrdered: number | null; casesReceived: number | null; unitsPerCase: number; baseCaseCostMinor: string; discountPerCaseMinor: string; rebatePerCaseMinor: string; effectiveCaseCostMinor: string; effectiveUnitCostMinor: string; unitsReceived: number | null; unitsDamaged: number; unitsRejected: number; unitsShort: number; notes: string | null }>;
  vendorDeals: VendorDeal[];
  audit: Array<{ id: string; action: string; entityType: string; createdAt: string; afterJson: unknown }>;
};

export type ReviewedCost = { cases: number; unitsPerCase: number; baseCaseCostMinor: string; discountPerCaseMinor: string; rebatePerCaseMinor: string; payableCaseCostMinor: string; effectiveCaseCostMinor: string; effectiveUnitCostMinor: string; totalUnits: number; calculatedLineTotalMinor: string;
  discrepancies: Array<{ code: string; message: string; expectedMinor?: string; actualMinor?: string }> };
export type InvoiceReview = {
  invoiceId: string; hasDiscrepancies: boolean;
  lines: Array<{ lineId: string; ignored: boolean; review: ReviewedCost | null; error: string | null; availableDeals: Array<{ id: string; name: string; kind: string }>; dealPreview: ReviewedCost | null }>;
  totals: { linesSubtotalMinor: string; expectedTotalMinor: string | null; discrepancies: Array<{ code: string; message: string; expectedMinor: string; actualMinor: string }> };
};

export type DayTotals = {
  storeName: string; businessDate: string; timezone: string; generatedAt: string; transactionCount: number;
  grossSalesMinor: string; discountsMinor: string; refundsMinor: string; netSalesMinor: string; taxMinor: string; totalCollectedMinor: string; refundCount: number;
  voids: { count: number; totalMinor: string };
  tenders: { cashMinor: string; cardMinor: string; giftCardMinor: string; otherMinor: string };
  cash: { cashSalesMinor: string; cashRefundsMinor: string; paidInMinor: string; paidOutMinor: string; safeDropsMinor: string; adjustmentsNetMinor: string; drawerOpens: number };
  registerDifferenceMinor: string;
  registerSessions: Array<{ registerName: string; status: string; openedAt: string; closedAt: string | null; expectedCashMinor: string | null; countedCashMinor: string | null; differenceMinor: string | null }>;
  openRegisters: Array<{ registerName: string; status: string; openedAt: string }>;
};
export const dayCloseApi = {
  preview: (storeId: string, date: string) => adminRequest<{ finalized: { id: string; closedAt: string } | null; totals: DayTotals }>(`/day-close/preview?${new URLSearchParams({ storeId, date }).toString()}`),
  finalize: (value: { storeId: string; businessDate: string; acknowledgeOpenRegisters: boolean }) => adminRequest<{ id: string; businessDate: string; totals: DayTotals }>('/day-close', body('POST', value)),
  history: (storeId: string) => adminRequest<Array<{ id: string; businessDate: string; closedAt: string; openRegisterCount: number; totals: DayTotals }>>(`/day-close?${new URLSearchParams({ storeId }).toString()}`),
};
