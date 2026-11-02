import { ADMIN_API, adminRequest } from '../admin-client';
import { adminHeaders, handleAdminAuthError } from '../admin-auth';

const post = (value?: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value ?? {}) });
const patch = (value: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(value) });
const qs = (values: Record<string, string | number | boolean | undefined>) => { const search = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') search.set(key, String(value)); const text = search.toString(); return text ? `?${text}` : ''; };

// ---- money helpers (dollars in the UI, integer minor units everywhere else) ----
/** "12.5" → "1250"; "" → undefined; anything not a plain amount → null. No floating point. */
export function dollarsToMinor(text: string): string | undefined | null {
  const value = text.trim().replace(/^\$/, '');
  if (value === '') return undefined;
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
  return match ? String(BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')) : null;
}
export const minorToDollars = (minor: string | null | undefined): string => { if (minor === null || minor === undefined || minor === '') return ''; const value = BigInt(minor); return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`; };
export const show = (minor: string | null | undefined): string => (minor === null || minor === undefined ? '—' : `$${minorToDollars(minor)}`);
export const pct = (basisPoints: number | null | undefined): string => (basisPoints === null || basisPoints === undefined ? '—' : `${(basisPoints / 100).toFixed(1)}%`);

// ---- types ----
export type Evidence = Record<string, { label?: string; original?: string; normalized?: string; confidence?: number; page?: number; corrected?: string }>;
export type ReceivingLine = {
  id: string; lineNumber: number; lineKind: string; description: string; upc: string | null; caseUpc: string | null; alternateUpc: string | null; vendorSku: string | null; vendorItemNumber: string | null; brand: string | null; size: string | null; packLabel: string | null; vintage: string | null;
  quantity: number; caseQuantity: number; casesOrdered: number | null; casesReceived: number | null; casesBackordered: number; casesRejected: number; looseUnitsReceived: number; bonusUnits: number; unitsDamaged: number; unitsBroken: number; unitsMissing: number;
  fulfillment: string; damageDisposition: string | null; listCaseMinor: string | null; unitListMinor: string | null; caseCostMinor: string | null; postOffPerCaseMinor: string | null; qtyDiscountPerCaseMinor: string | null; caseDiscountPerCaseMinor: string | null;
  promoDiscountPerCaseMinor: string | null; otherDiscountPerCaseMinor: string | null; allowancePerCaseMinor: string | null; rebatePerCaseMinor: string | null; discountPerCaseMinor: string | null; netCaseCostMinor: string | null; netUnitCostMinor: string | null;
  lineTotalMinor: string; ripCode: string | null; ripValueMinor: string | null; temporaryDeal: boolean; dealEndsAt: string | null; standardCaseCostMinor: string | null; notes: string | null; confidence: string | number | null;
  matchStatus: string; ignored: boolean; updateVendorCost: boolean; variantId: string | null; sourcePage: number | null; evidence: Evidence | null; correctedFields: Record<string, { from: unknown; to: unknown }> | null;
  variant?: { id: string; name: string; sku: string; product: { name: string } } | null; masterProduct?: { name: string } | null;
};
export type CostChange = { previousCaseMinor: string | null; invoiceCaseMinor: string; deltaMinor: string | null; deltaBasisPoints: number | null; direction: 'UP' | 'DOWN' | 'SAME' | 'NEW'; significant: boolean; retailMinor: string | null; previousUnitMinor: string | null; newUnitMinor: string; previousMarginBasisPoints: number | null; newMarginBasisPoints: number | null; marginDropBasisPoints: number | null };
export type ReviewedLine = {
  lineId: string; lineNumber: number; ignored: boolean; matched: boolean; lowConfidence: boolean; issues: string[];
  economics: { baseCaseMinor: string; discountPerCaseMinor: string; netCaseMinor: string; rebatePerCaseMinor: string; effectiveCaseMinor: string; netUnitMinor: string; effectiveUnitMinor: string; extendedMinor: string; warnings: string[] };
  quantities: { invoicedUnits: number; receivedUnits: number; rejectedUnits: number; damagedUnits: number; sellableUnits: number; backorderedUnits: number; shortUnits: number; overUnits: number; orderedUnits: number | null; variance: 'SHORT' | 'OVER' | 'EXACT'; fulfillment: string };
  comparison: { flags: string[]; invoicedVsOrdered: number | null; receivedVsInvoiced: number };
  costChange: CostChange; effectiveCostChange: CostChange | null;
};
export type ReceivingReview = {
  docType: string; postsInventory: boolean; stages: string[]; lines: ReviewedLine[]; nonInventoryLines: Array<{ lineId: string; kind: string; description: string; amountMinor: string }>;
  charges: Array<{ id: string; kind: string; label: string; originalLabel: string | null; amountMinor: string }>;
  reconciliation: { merchandiseMinor: string; calculatedTotalMinor: string; invoiceTotalMinor: string | null; differenceMinor: string | null; status: 'MATCH' | 'MINOR_DIFFERENCE' | 'MATERIAL_DIFFERENCE' | 'NO_TOTAL'; thresholdMinor: string };
  missingFromInvoice: Array<{ variantId: string; productName: string; variantName: string; outstandingUnits: number }>;
  exactDuplicate: { invoiceId: string } | null; continuation: Array<{ id: string; originalFilename: string; invoiceNumber: string | null; pageCount: number; _count: { lines: number } }>;
  blockers: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }>; requiresNote: boolean;
};
export type FullReview = { invoiceId: string; hasDiscrepancies: boolean; receiving: ReceivingReview };
export type ReceiptRow = { id: string; receivedAt: string; invoiceNumber: string | null; purchaseOrder: { id: string; poNumber: string; status: string; vendor: { id: string; name: string } }; receivedBy: { firstName: string; lastName: string }; lineCount: number; deliveredUnits: number; damagedUnits: number; rejectedUnits: number };
export type ReceiptDetail = { id: string; receivedAt: string; invoiceNumber: string | null; notes: string | null; receivedBy: { firstName: string; lastName: string }; purchaseOrder: { id: string; poNumber: string; status: string; vendor: { id: string; name: string } };
  invoice: { id: string; invoiceNumber: string | null; invoiceDate: string | null; totalMinor: string | null; docType: string; paymentTerms: string | null; dueDate: string | null } | null;
  claims: Array<{ id: string; kind: string; status: string; expectedCreditMinor: string; creditedMinor: string | null; creditReference: string | null; resolvedAt: string | null }>;
  lines: Array<{ id: string; productName: string; variantName: string; sku: string; vendorSku: string | null; deliveredUnits: number; damagedUnits: number; rejectedUnits: number; sellableUnits: number; unitCostMinor: string;
    cost: { unitsPerCase: number; listCaseCostMinor: string | null; baseCaseCostMinor: string; discountPerCaseMinor: string; rebatePerCaseMinor: string; netCaseCostMinor: string | null; effectiveCaseCostMinor: string; effectiveUnitCostMinor: string; unitsShort: number; temporaryDeal: boolean; componentsJson: Record<string, string> | null } | null }> };
export type VendorOverview = { vendor: { id: string; name: string; contactName: string | null; email: string | null; phone: string | null }; openCreditExpectedMinor: string;
  invoices: Array<{ id: string; invoiceNumber: string | null; invoiceDate: string | null; totalMinor: string | null; reviewStatus: string; docType: string; uploadedAt: string }>;
  purchaseOrders: Array<{ id: string; poNumber: string; status: string; createdAt: string; _count: { lines: number } }>; receipts: Array<{ id: string; receivedAt: string; vendorReferenceNumber: string | null; purchaseOrder: { poNumber: string } }>;
  mappings: Array<{ id: string; vendorSku: string | null; caseCostMinor: string | null; vendorCostMinor: string; casePackQuantity: number; preferred: boolean; variant: { id: string; name: string; sku: string; product: { id: string; name: string } } }>;
  costHistory: Array<{ id: string; occurredAt: string; netCaseCostMinor: string | null; effectiveCaseCostMinor: string; baseCaseCostMinor: string; temporaryDeal: boolean; variant: { name: string; product: { name: string } } }>;
  deals: Array<{ id: string; name: string; kind: string; amountMinor: string | null }>;
  claims: Array<{ id: string; kind: string; status: string; reason: string; expectedCreditMinor: string; creditedMinor: string | null; creditReference: string | null; invoiceDocumentId: string | null; createdAt: string; resolvedAt: string | null }> };
export type ProductReceipts = { last: ReceiptHistoryRow | null; history: ReceiptHistoryRow[] };
export type ReceiptHistoryRow = { id: string; occurredAt: string; vendor: { id: string; name: string } | null; invoice: { id: string; invoiceNumber: string | null } | null; unitsReceived: number | null; unitsPerCase: number; baseCaseCostMinor: string; listCaseCostMinor: string | null; discountPerCaseMinor: string; netCaseCostMinor: string | null; effectiveCaseCostMinor: string; effectiveUnitCostMinor: string; temporaryDeal: boolean };

export const receivingApi = {
  review: (id: string) => adminRequest<FullReview>(`/invoices/${id}/review`),
  createManual: (body: Record<string, unknown>) => adminRequest<{ id: string }>('/invoices/manual', post(body)),
  updateHeader: (id: string, body: Record<string, unknown>) => adminRequest<Record<string, unknown>>(`/invoices/${id}`, patch(body)),
  addLine: (id: string, body: Record<string, unknown>) => adminRequest<ReceivingLine>(`/invoices/${id}/lines`, post(body)),
  updateLine: (id: string, lineId: string, body: Record<string, unknown>) => adminRequest<Record<string, unknown>>(`/invoices/${id}/lines/${lineId}`, patch(body)),
  removeLine: (id: string, lineId: string) => adminRequest<{ removed: true }>(`/invoices/${id}/lines/${lineId}/remove`, post()),
  addCharge: (id: string, body: { kind: string; label?: string; amountMinor: string }) => adminRequest<{ id: string }>(`/invoices/${id}/charges`, post(body)),
  removeCharge: (id: string, chargeId: string) => adminRequest<{ removed: true }>(`/invoices/${id}/charges/${chargeId}/remove`, post()),
  addPage: (id: string, body: { originalFilename: string; mimeType: string; contentBase64: string }) => adminRequest<{ page: { pageNumber: number } }>(`/invoices/${id}/pages`, post(body)),
  merge: (id: string, sourceId: string) => adminRequest<{ pageCount: number; linesMoved: number }>(`/invoices/${id}/merge`, post({ sourceId })),
  claimLine: (id: string, lineId: string, body: { kind: string; quantity: number; unitCostMinor: string; reason: string }) => adminRequest<{ id: string }>(`/invoices/${id}/lines/${lineId}/claim`, post(body)),
  confirm: (id: string, body: { acknowledgeDuplicate?: boolean; acknowledgeDiscrepancies?: boolean; reconciliationNote?: string; createClaims?: boolean }) => adminRequest<{ receiptId?: string; claimsCreated?: Array<{ id: string; kind: string }> }>(`/invoices/${id}/confirm`, post(body)),
  search: (filter: Record<string, string | number | boolean | undefined>) => adminRequest<{ total: number; page: number; pageSize: number; items: ReceiptRow[] }>(`/receiving${qs(filter)}`),
  receipt: (id: string) => adminRequest<ReceiptDetail>(`/receiving/${id}`),
  vendor: (id: string) => adminRequest<VendorOverview>(`/vendors/${id}/overview`),
  productReceipts: (productId: string) => adminRequest<ProductReceipts>(`/products/${productId}/receipts`),
  async pageFile(file: File): Promise<{ originalFilename: string; mimeType: string; contentBase64: string }> {
    const contentBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read the file.')); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file); });
    return { originalFilename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64 };
  },
};
void ADMIN_API; void adminHeaders; void handleAdminAuthError;

export const receivingErrors: Record<string, string> = {
  INVOICE_ALREADY_RECEIVED: 'This vendor invoice number was already received. It cannot be received twice.', INVOICE_DISCREPANCIES_REQUIRE_ACKNOWLEDGEMENT: 'There are discrepancies. Review them and tick the confirmation.',
  INVOICE_RECONCILIATION_NOTE_REQUIRED: 'The totals differ materially. Add a note explaining why before confirming.', INVOICE_LINES_REQUIRE_REVIEW: 'Match, create, or ignore every product line first.',
  INVOICE_OVER_SHIPMENT_EXCEEDS_PO: 'A line is received above the open purchase order quantity. Change the quantity or detach the purchase order.', INVOICE_DAMAGE_DISPOSITION_REQUIRED: 'Choose what happens to damaged or broken units.',
  INVOICE_VENDOR_REQUIRED: 'Choose the vendor first.', INVOICE_DUPLICATE_REQUIRES_ACKNOWLEDGEMENT: 'This looks like a duplicate. Confirm you intend to receive it.', INVOICE_NOTHING_RECEIVED: 'Nothing was received. Enter received quantities.',
  INVOICE_NOT_DRAFT: 'This invoice is already confirmed or rejected.', INVOICE_DUPLICATE_DOCUMENT: 'That exact file was already uploaded.', INVOICE_MERGE_VENDOR_MISMATCH: 'These invoices belong to different vendors.',
  DAMAGE_EXCEEDS_RECEIVED: 'More units are damaged than were received.', REJECTED_EXCEEDS_RECEIVED: 'More units are rejected than were received.', INVOICE_LINE_COST_INVALID: 'Enter a cost for this line.', HTTP_403: 'You do not have permission for that.',
};
export const receivingError = (cause: unknown): string => { const code = cause instanceof Error ? cause.message : ''; return receivingErrors[code] ?? (/^[A-Z0-9_]+$/.test(code) ? code.replace(/_/g, ' ').toLowerCase() : 'That did not work. Try again.'); };
