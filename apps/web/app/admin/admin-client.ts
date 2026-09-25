export const ADMIN_API = process.env.NEXT_PUBLIC_RJPOS_API_URL ?? 'http://127.0.0.1:3001/api/v1';

export type PageResult<T> = { items: T[]; page: number; pageSize: number; total: number };
export type Category = { id: string; name: string; active: boolean; _count?: { products: number } };
export type Product = { id: string; name: string; brand: string | null; active: boolean; category: Category; variants: Variant[] };
export type Variant = { id: string; name: string; sku: string; active: boolean; lowStockThreshold: number; barcodes: Array<{ barcodeValue: string }> };
export type Store = { id: string; name: string; status: string; timezone: string; taxRateBasisPoints: number; receiptFooter: string | null };
export type InventoryRow = { id: string; storeId: string; onHand: number; reserved: number; available: number; inventoryStatus: string; store: { name: string }; variant: Variant & { product: { name: string } } };
export type Employee = { id: string; firstName: string; lastName: string; status: string; roles: Array<{ role: { name: string } }>; stores: Array<{ store: Store }> };
export type OrderRow = { id: string; orderNumber: string; status: string; totalMinor: string; createdAt: string; store: Store; register: { name: string }; session: { employee: { firstName: string; lastName: string } }; payments: Array<{ kind: string; status: string }>; refunds: unknown[] };
export type RefundRow = { id: string; status: string; amountMinor: string; reason: string; createdAt: string; order: { orderNumber: string; store: Store }; employee: { firstName: string; lastName: string } };
export type MovementRow = { id: string; createdAt: string; type: string; quantityDelta: number; resultingOnHand: number | null; reason: string | null; referenceType: string | null; referenceId: string | null; store: { name: string }; employee: { firstName: string; lastName: string } | null; variant: Variant & { product: { name: string } } };
export type Dashboard = { salesMinor: string; transactions: number; refundMinor: string; openRegisters: number; lowStockProducts: number; asOf: string };
export type Shift = { id: string; clockedInAt: string; clockedOutAt: string | null; correctedClockedInAt: string | null; correctedClockedOutAt: string | null; correctionReason: string | null; workedSeconds: number; employee: { firstName: string; lastName: string }; store: { name: string }; register: { name: string } | null };
export type Customer = { id: string; name: string; email: string | null; phone: string | null; notes: string | null; active: boolean; pointsBalance?: number; orders?: OrderRow[]; loyaltyTransactions?: Array<{ id: string; type: string; points: number; reason: string | null; createdAt: string }> };
export type LoyaltyProgram = { enabled: boolean; pointsEarned: number; spendMinor: string; redeemMinorPerPoint: string } | null;
export type GiftCardDetail = { id: string; lastFour: string; status: string; balanceMinor: string; availableMinor: string; history: Array<{ id: string; type: string; status: string; amountMinor: string; reason: string | null; createdAt: string }> };
export type ProductRef = { id: string; name: string; brand: string | null };
export type VariantRef = { id: string; name: string; sku: string };
export type EmployeeRef = { id: string; firstName: string; lastName: string };
export type MasterProduct = { id: string; upc: string; name: string; brand: string | null; size: string | null; unit: string; sizeLabel: string | null; packName: string | null; category: string | null; referenceCostMinor: string | null; referencePriceMinor: string | null; metadata: unknown };
export type CatalogLookupResult =
  | { status: 'IN_STORE'; upc: string; product: ProductRef; variant: VariantRef }
  | { status: 'MASTER_ONLY'; upc: string; product: MasterProduct }
  | { status: 'NOT_FOUND'; upc: string };
export type MasterImportIssue = { row: number; code: string; upc?: string };
export type MasterImportSummary = { added: number; updated: number; skipped: number; invalid: number; duplicate: number; issues: MasterImportIssue[] };
export type AddToStoreResult =
  | { status: 'IN_STORE'; product: ProductRef; variant: VariantRef }
  | { status: 'ADDED'; product: ProductRef; variant: VariantRef; inventoryCreated: boolean };
export type VendorAddress = { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
export type Vendor = { id: string; name: string; contactName: string | null; email: string | null; phone: string | null; addressJson: VendorAddress | null; accountReference: string | null; notes: string | null; active: boolean; _count?: { mappings: number; purchaseOrders: number } };
export type VendorMapping = { id: string; vendorId: string; variantId: string; vendorSku: string | null; vendorCostMinor: string; casePackQuantity: number; minimumOrderQuantity: number; preferred: boolean; active: boolean; vendor: Vendor; variant: Variant & { product: ProductRef } };
export type PurchaseOrderLine = { id: string; variantId: string; productNameSnapshot: string; variantNameSnapshot: string; skuSnapshot: string; vendorSkuSnapshot: string | null; orderedQuantity: number; receivedQuantity: number; unitCostMinor: string };
export type PurchaseOrderRow = { id: string; poNumber: string; status: string; notes: string | null; storeId: string; vendorId: string; vendor: Vendor; store: Store; lines: PurchaseOrderLine[]; totalMinor: string; _count?: { receipts: number } };
export type PurchaseOrderRef = { id: string; poNumber: string; status: string; vendor: Vendor; store: Store };
export type PurchaseReceiptLine = { id: string; purchaseOrderLineId: string; deliveredQuantity: number; damagedQuantity: number; rejectedQuantity: number; unitCostMinor: string };
export type PurchaseReceiptRow = { id: string; purchaseOrderId: string; idempotencyKey: string; vendorReferenceNumber: string | null; notes: string | null; receivedAt: string; receivedBy: EmployeeRef; purchaseOrder?: PurchaseOrderRef; lines: PurchaseReceiptLine[] };
export type PurchaseOrderDetail = { id: string; poNumber: string; status: string; notes: string | null; storeId: string; vendorId: string; vendor: Vendor; store: Store; createdBy: EmployeeRef; lines: Array<PurchaseOrderLine & { variant: VariantRef & { product: ProductRef } }>; receipts: PurchaseReceiptRow[]; totalMinor: string };

function query(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
  const result = params.toString();
  return result ? `?${result}` : '';
}

export async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ADMIN_API}/admin${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-rjpos-role': 'OWNER', ...init?.headers } });
  const body = await response.json() as T & { error?: { code?: string }; requestId?: string };
  if (!response.ok) throw new Error(body.error?.code ?? `HTTP_${response.status}`);
  return body;
}

export async function phaseThreeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ADMIN_API}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-rjpos-role': 'OWNER', ...init?.headers } });
  const body = await response.json() as T & { error?: { code?: string } };
  if (!response.ok) throw new Error(body.error?.code ?? `HTTP_${response.status}`);
  return body;
}

const json = (method: 'POST' | 'PATCH', body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const adminApi = {
  dashboard: (storeId?: string) => adminRequest<Dashboard>(`/dashboard${query({ storeId })}`),
  categories: (search = '') => adminRequest<PageResult<Category>>(`/categories${query({ search, pageSize: 100 })}`),
  createCategory: (name: string) => adminRequest<Category>('/categories', json('POST', { name })),
  updateCategory: (id: string, body: { name?: string; active?: boolean }) => adminRequest<Category>(`/categories/${id}`, json('PATCH', body)),
  products: (search = '', page = 1) => adminRequest<PageResult<Product>>(`/products${query({ search, page, pageSize: 25 })}`),
  createProduct: (body: { categoryId: string; name: string; brand?: string; taxCategory?: string; ageRestricted?: boolean; inventoryTracked?: boolean }) => adminRequest<Product>('/products', json('POST', body)),
  updateProduct: (id: string, body: Record<string, unknown>) => adminRequest<Product>(`/products/${id}`, json('PATCH', body)),
  createVariant: (productId: string, body: { name: string; sku: string; barcode?: string; size?: string; unit?: string; costMinor?: string; lowStockThreshold?: number }) => adminRequest<Variant>(`/products/${productId}/variants`, json('POST', body)),
  updateVariant: (id: string, body: Record<string, unknown>) => adminRequest<Variant>(`/variants/${id}`, json('PATCH', body)),
  schedulePrice: (body: { variantId: string; storeId?: string; amountMinor: string; effectiveFrom: string; effectiveTo?: string }) => adminRequest('/prices', json('POST', body)),
  priceHistory: (variantId: string, storeId?: string) => adminRequest<Array<{ id: string; amountMinor: string; effectiveFrom: string; effectiveTo: string | null }>>(`/variants/${variantId}/prices${query({ storeId })}`),
  inventory: (search = '', lowStock = false) => adminRequest<PageResult<InventoryRow>>(`/inventory${query({ search, lowStock, pageSize: 100 })}`),
  movements: (variantId?: string) => adminRequest<PageResult<MovementRow>>(`/inventory/movements${query({ variantId, pageSize: 100 })}`),
  openingBalance: (body: { storeId: string; variantId: string; quantity: number; reason: string }) => adminRequest('/inventory/opening-balance', json('POST', body)),
  adjustInventory: (body: { storeId: string; variantId: string; quantityDelta: number; reason: string }) => adminRequest('/inventory/adjust', json('POST', body)),
  employees: () => adminRequest<PageResult<Employee>>('/employees?pageSize=100'),
  createEmployee: (body: { firstName: string; lastName: string; roleNames: string[]; storeIds: string[] }) => adminRequest<Employee>('/employees', json('POST', body)),
  updateEmployee: (id: string, body: Record<string, unknown>) => adminRequest<Employee>(`/employees/${id}`, json('PATCH', body)),
  stores: () => adminRequest<Store[]>('/stores'),
  createStore: (body: { name: string; timezone?: string; taxRateBasisPoints?: number }) => adminRequest<Store>('/stores', json('POST', body)),
  updateStore: (id: string, body: Record<string, unknown>) => adminRequest<Store>(`/stores/${id}`, json('PATCH', body)),
  registers: () => adminRequest<Array<{ id: string; name: string; code: string; status: string; store: Store; sessions: unknown[] }>>('/registers'),
  createRegister: (body: { storeId: string; name: string; code: string }) => adminRequest('/registers', json('POST', body)),
  updateRegister: (id: string, body: Record<string, unknown>) => adminRequest(`/registers/${id}`, json('PATCH', body)),
  orders: (search = '') => adminRequest<PageResult<OrderRow>>(`/orders${query({ search })}`),
  order: (id: string) => adminRequest<Record<string, unknown>>(`/orders/${id}`),
  refunds: (search = '') => adminRequest<PageResult<RefundRow>>(`/refunds${query({ search })}`),
  audit: () => adminRequest<PageResult<{ id: string; action: string; entityType: string; entityId: string; createdAt: string }>>('/audit?pageSize=100'),
  settings: () => adminRequest<Store[]>('/settings'),
  shifts: () => phaseThreeRequest<PageResult<Shift>>('/admin/shifts?pageSize=100'),
  correctShift: (id: string, body: { clockedInAt: string; clockedOutAt: string; reason: string }) => phaseThreeRequest(`/admin/shifts/${id}`, json('PATCH', body)),
  customers: (search = '') => phaseThreeRequest<PageResult<Customer>>(`/customers${query({ search, pageSize: 100 })}`),
  customer: (id: string) => phaseThreeRequest<Customer>(`/customers/${id}`),
  createCustomer: (body: { name: string; email?: string; phone?: string; notes?: string }) => phaseThreeRequest<Customer>('/customers', json('POST', body)),
  updateCustomer: (id: string, body: Record<string, unknown>) => phaseThreeRequest<Customer>(`/customers/${id}`, json('PATCH', body)),
  loyaltyProgram: () => phaseThreeRequest<LoyaltyProgram>('/loyalty/program'),
  configureLoyalty: (body: { enabled: boolean; pointsEarned: number; spendMinor: string; redeemMinorPerPoint: string }) => phaseThreeRequest('/admin/loyalty/program', json('PATCH', body)),
  adjustLoyalty: (customerId: string, body: { points: number; reason: string }) => phaseThreeRequest(`/admin/customers/${customerId}/loyalty-adjustments`, json('POST', body)),
  issueGiftCard: (body: { amountMinor: string; reason?: string }) => phaseThreeRequest<{ id: string; code: string; balanceMinor: string }>('/admin/gift-cards', json('POST', body)),
  giftCard: (code: string) => phaseThreeRequest<GiftCardDetail>(`/gift-cards/lookup${query({ code })}`),
  reloadGiftCard: (body: { code: string; amountMinor: string; reason: string }) => phaseThreeRequest('/admin/gift-cards/reload', json('POST', body)),
  disableGiftCard: (id: string, reason: string) => phaseThreeRequest(`/admin/gift-cards/${id}/disable`, json('POST', { reason })),
  masterCatalog: (search = '') => adminRequest<PageResult<MasterProduct>>(`/master-catalog${query({ search, pageSize: 100 })}`),
  lookupUpc: (upc: string) => phaseThreeRequest<CatalogLookupResult>(`/catalog/upc/${encodeURIComponent(upc)}`),
  importMasterCatalog: (csv: string) => adminRequest<MasterImportSummary>('/master-catalog/import', json('POST', { csv })),
  addMasterProductToStore: (upc: string, body: { categoryId: string; sku: string; variantName?: string; storeId?: string; priceMinor?: string; costMinor?: string; inventoryTracked?: boolean; lowStockThreshold?: number }) => adminRequest<AddToStoreResult>(`/master-catalog/${encodeURIComponent(upc)}/add-to-store`, json('POST', body)),
  vendors: (search = '', active?: boolean) => adminRequest<PageResult<Vendor>>(`/vendors${query({ search, active, pageSize: 100 })}`),
  createVendor: (body: { name: string; contactName?: string; email?: string; phone?: string; address?: VendorAddress; accountReference?: string; notes?: string }) => adminRequest<Vendor>('/vendors', json('POST', body)),
  updateVendor: (id: string, body: Record<string, unknown>) => adminRequest<Vendor>(`/vendors/${id}`, json('PATCH', body)),
  vendorMappings: (vendorId = '', search = '') => adminRequest<PageResult<VendorMapping>>(`/vendor-mappings${query({ vendorId, search, pageSize: 100 })}`),
  saveVendorMapping: (body: { id?: string; vendorId: string; variantId: string; vendorSku?: string; vendorCostMinor: string; casePackQuantity?: number; minimumOrderQuantity?: number; preferred?: boolean; active?: boolean }) => adminRequest<VendorMapping>('/vendor-mappings', json('POST', body)),
  purchaseOrders: (search = '', status = '', storeId = '') => adminRequest<PageResult<PurchaseOrderRow>>(`/purchase-orders${query({ search, status, storeId, pageSize: 100 })}`),
  purchaseOrder: (id: string) => adminRequest<PurchaseOrderDetail>(`/purchase-orders/${id}`),
  createPurchaseOrder: (body: { storeId?: string; vendorId: string; poNumber: string; notes?: string; lines: Array<{ variantId: string; quantity: number; vendorProductMappingId?: string; unitCostMinor?: string }> }) => adminRequest<PurchaseOrderDetail>('/purchase-orders', json('POST', body)),
  updatePurchaseOrder: (id: string, body: { vendorId?: string; poNumber?: string; notes?: string | null; lines?: Array<{ variantId: string; quantity: number; vendorProductMappingId?: string; unitCostMinor?: string }> }) => adminRequest<PurchaseOrderDetail>(`/purchase-orders/${id}`, json('PATCH', body)),
  submitPurchaseOrder: (id: string) => adminRequest<{ id: string; status: string }>(`/purchase-orders/${id}/submit`, json('POST', {})),
  cancelPurchaseOrder: (id: string) => adminRequest<{ id: string; status: string }>(`/purchase-orders/${id}/cancel`, json('POST', {})),
  receivePurchaseOrder: (id: string, body: { idempotencyKey: string; vendorReferenceNumber?: string; notes?: string; lines: Array<{ purchaseOrderLineId: string; deliveredQuantity: number; damagedQuantity?: number; rejectedQuantity?: number; unitCostMinor?: string }> }) => adminRequest<PurchaseReceiptRow>(`/purchase-orders/${id}/receipts`, json('POST', body)),
  receivingHistory: (purchaseOrderId = '') => adminRequest<PageResult<PurchaseReceiptRow>>(`/receiving-history${query({ purchaseOrderId, pageSize: 100 })}`),
};

export async function createCatalogFlow(input: {
  categoryId?: string; categoryName?: string; productName: string; brand?: string; variantName: string; sku: string; barcode: string;
  storeId: string; priceMinor: string; openingQuantity: number; reason: string; lowStockThreshold: number;
}) {
  const category = input.categoryId ? { id: input.categoryId, name: '', active: true } : await adminApi.createCategory(input.categoryName ?? '');
  const product = await adminApi.createProduct({ categoryId: category.id, name: input.productName, brand: input.brand, ageRestricted: true, inventoryTracked: true });
  const variant = await adminApi.createVariant(product.id, { name: input.variantName, sku: input.sku, barcode: input.barcode, lowStockThreshold: input.lowStockThreshold });
  await adminApi.schedulePrice({ variantId: variant.id, storeId: input.storeId, amountMinor: input.priceMinor, effectiveFrom: new Date().toISOString() });
  await adminApi.openingBalance({ storeId: input.storeId, variantId: variant.id, quantity: input.openingQuantity, reason: input.reason });
  return { category, product, variant };
}

export function money(minor: string | number | bigint): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(BigInt(minor)) / 100);
}
