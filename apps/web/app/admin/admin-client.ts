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
