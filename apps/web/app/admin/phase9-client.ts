import { ADMIN_API, adminRequest } from './admin-client';
import { adminHeaders, handleAdminAuthError } from './admin-auth';

const post = (value?: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value ?? {}) });
const patch = (value: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(value) });
const qs = (values: Record<string, string | number | undefined>) => { const search = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') search.set(key, String(value)); const text = search.toString(); return text ? `?${text}` : ''; };

export type CsvKind = 'products' | 'pricing' | 'vendors' | 'inventory' | 'customers';
export type ImportRow = { line: number; action: 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR'; key: string; message?: string };
export type ImportPreview = { kind: CsvKind; total: number; create: number; update: number; skip: number; errors: number; rows: ImportRow[]; truncated: boolean };
export type SalesChannel = { id: string; name: string; code: string; priceBookId: string | null; isDefault: boolean; active: boolean; sortOrder: number; priceBook?: { id: string; name: string } | null };
export type BulkOperation =
  | { type: 'PRICE'; storeId: string; mode: 'PERCENT' | 'AMOUNT' | 'SET'; value: string }
  | { type: 'TAX_PROFILE'; taxProfileId: string | null }
  | { type: 'CATEGORY'; categoryId: string }
  | { type: 'VENDOR'; vendorId: string; preferred?: boolean }
  | { type: 'ACTIVE'; active: boolean }
  | { type: 'THRESHOLDS'; storeId: string; lowStockThreshold?: number; reorderTarget?: number };
export type BulkChange = { id: string; label: string; before: string; after: string; skip?: string };
export type BulkPlan = { type: BulkOperation['type']; changes: BulkChange[]; applicable: number; skipped: number };
export type VelocitySuggestion = { variantId: string; productName: string; variantName: string; sku: string; available: number; onOrder: number; soldUnits: number; dailyVelocity: number; daysOfSupply: number | null;
  suggestedUnits: number; suggestedCases: number; casePackQuantity: number; vendorName: string | null; estimatedCostMinor: string | null };
export type VendorClaim = { id: string; kind: 'RETURN' | 'SHORTAGE' | 'DAMAGE' | 'PRICE_DIFFERENCE'; status: 'DRAFT' | 'SUBMITTED' | 'CREDITED' | 'REJECTED' | 'CANCELLED'; reason: string; expectedCreditMinor: string; creditedMinor: string | null;
  creditReference: string | null; createdAt: string; vendor: { id: string; name: string }; lines: Array<{ id: string; quantity: number; unitCostMinor: string; variant: { id: string; name: string; sku: string; product: { name: string } } }> };
export type AuditView = { items: Array<{ id: string; at: string; action: string; actionLabel: string; entityType: string; entityId: string; user: { id: string; name: string } | null; store: { id: string; name: string | null } | null; register: { id: string; name: string | null } | null;
  changes: Array<{ field: string; before: string | null; after: string | null }> }>; page: number; pageSize: number; total: number };
export type PromoAsset = { id: string; title: string; subtitle: string | null; imageData: string | null; active: boolean; sortOrder: number; startsAt: string | null; endsAt: string | null };
export type BackupStatus = { destination: string; fileExists: boolean; fileSizeBytes: number | null; configured: boolean; lastAttemptAt: string | null; lastSuccessAt: string | null; result: 'SUCCESS' | 'FAILURE' | 'UNKNOWN'; file: string | null; detail: string | null; stale: boolean; restoreInstructions: string[] };

export const phaseNineApi = {
  channels: () => adminRequest<SalesChannel[]>('/sales-channels'),
  createChannel: (value: { name: string; priceBookId?: string | null }) => adminRequest<SalesChannel>('/sales-channels', post(value)),
  updateChannel: (id: string, value: Record<string, unknown>) => adminRequest<SalesChannel>(`/sales-channels/${id}`, patch(value)),
  bulkPreview: (productIds: string[], operation: BulkOperation) => adminRequest<BulkPlan>('/bulk/preview', post({ productIds, operation })),
  bulkApply: (productIds: string[], operation: BulkOperation) => adminRequest<BulkPlan & { operationId: string }>('/bulk/apply', post({ productIds, operation })),
  previewCsv: (kind: CsvKind, csv: string, options: { storeId?: string; createCategories?: boolean } = {}) => adminRequest<ImportPreview>(`/csv/${kind}/preview`, post({ csv, ...options })),
  commitCsv: (kind: CsvKind, csv: string, options: { storeId?: string; createCategories?: boolean; skipInvalidRows?: boolean } = {}) => adminRequest<ImportPreview & { importId: string }>(`/csv/${kind}/commit`, post({ csv, ...options })),
  async exportCsv(kind: CsvKind, storeId?: string): Promise<string> {
    const response = await fetch(`${ADMIN_API}/admin/csv/${kind}/export${qs({ storeId })}`, { headers: adminHeaders() });
    if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { code?: string } } | null; handleAdminAuthError(body?.error?.code ?? ''); throw new Error(body?.error?.code ?? `HTTP_${response.status}`); }
    return response.text();
  },
  claims: (status?: string) => adminRequest<VendorClaim[]>(`/vendor-claims${qs({ status })}`),
  createClaim: (value: { vendorId: string; kind: VendorClaim['kind']; reason: string; lines: Array<{ variantId: string; quantity: number; unitCostMinor?: string }> }) => adminRequest<VendorClaim>('/vendor-claims', post(value)),
  submitClaim: (id: string) => adminRequest<VendorClaim>(`/vendor-claims/${id}/submit`, post()),
  creditClaim: (id: string, creditedMinor: string, creditReference?: string) => adminRequest<VendorClaim>(`/vendor-claims/${id}/credit`, post({ creditedMinor, creditReference })),
  rejectClaim: (id: string, reason: string) => adminRequest<VendorClaim>(`/vendor-claims/${id}/reject`, post({ reason })),
  cancelClaim: (id: string) => adminRequest<VendorClaim>(`/vendor-claims/${id}/cancel`, post()),
  velocity: (query: { storeId?: string; lookbackDays?: number; coverDays?: number; leadTimeDays?: number }) => adminRequest<VelocitySuggestion[]>(`/purchasing/velocity-suggestions${qs(query)}`),
  addBarcode: (variantId: string, barcodeValue: string) => adminRequest<{ id: string; barcodeValue: string }>(`/variants/${variantId}/barcodes`, post({ barcodeValue })),
  removeBarcode: (barcodeId: string) => adminRequest<{ removed: true }>(`/barcodes/${barcodeId}/remove`, post()),
  audit: (query: { page?: number; action?: string; employeeId?: string; storeId?: string; entityType?: string; from?: string; to?: string }) => adminRequest<AuditView>(`/audit-view${qs(query)}`),
  promos: () => adminRequest<PromoAsset[]>('/promo-assets'),
  savePromo: (id: string | null, value: Partial<Omit<PromoAsset, 'id'>>) => id ? adminRequest<PromoAsset>(`/promo-assets/${id}`, patch(value)) : adminRequest<PromoAsset>('/promo-assets', post(value)),
  deletePromo: (id: string) => adminRequest<{ deleted: true }>(`/promo-assets/${id}/delete`, post()),
  backupStatus: () => adminRequest<BackupStatus>('/system/backup-status'),
  revokeSessions: (employeeId: string) => adminRequest<{ revoked: true }>(`/employees/${employeeId}/revoke-sessions`, post()),
};

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
export const phaseNineErrors: Record<string, string> = {
  CSV_IMPORT_HAS_ERRORS: 'Some rows have errors. Fix them, or choose to skip invalid rows.', CSV_EMPTY: 'The file is empty.', CSV_HEADERS_REQUIRED: 'The file is missing required columns.', CSV_TOO_MANY_ROWS: 'Files are limited to 5,000 rows.',
  CSV_DUPLICATE_HEADERS: 'Two columns have the same name.', BULK_SELECTION_REQUIRED: 'Select at least one product.', BULK_SELECTION_TOO_LARGE: 'Select up to 500 products at a time.', UPC_ALREADY_EXISTS: 'That code is already used by another item.',
  PRIMARY_BARCODE_PROTECTED: 'The main UPC cannot be removed.', INSUFFICIENT_INVENTORY: 'Not enough stock on hand for that return.', VENDOR_CLAIM_NOT_DRAFT: 'That claim has already been submitted.', SALES_CHANNEL_EXISTS: 'A channel with that name already exists.',
  PROMO_IMAGE_INVALID: 'Use a PNG, JPEG, or WebP image under 600 KB.', PROMO_TITLE_INVALID: 'Enter a title (80 characters max).', PROMO_DATE_INVALID: 'The end must be after the start.', PROMO_LIMIT_REACHED: 'You have reached the promotion limit. Delete one first.',
  HTTP_403: 'You do not have permission for that.', SESSION_REVOKED: 'You were signed out. Sign in again.',
};
export const errorText = (cause: unknown): string => { const code = cause instanceof Error ? cause.message : ''; return phaseNineErrors[code] ?? (code && /^[A-Z0-9_]+$/.test(code) ? code.replace(/_/g, ' ').toLowerCase() : 'That did not work. Try again.'); };
