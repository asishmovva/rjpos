import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  addInvoiceLine, addInvoicePage, appendInvoiceOcrResult, applyInvoiceOcrResult, confirmInvoiceDocument, createClaimFromInvoiceLine, createInvoiceDocument, createManualInvoice, findContinuationCandidates, getInvoiceDocument, getInvoiceReview,
  getInvoiceDocumentInput, getReceiptDetail, listInvoiceDocuments, markInvoiceOcrFailed, markInvoiceOcrProcessing, mergeInvoiceDocuments, productReceiptHistory, rejectInvoiceDocument, removeInvoiceCharge, removeInvoiceLine, saveInvoiceCharge,
  searchReceiving, updateInvoiceDocument, updateInvoiceLine, vendorOverview, type AdminActor, type ChargeInput, type InvoiceHeaderInput, type InvoiceLineInput, PosError,
} from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';
import type { InvoiceOcrProvider } from './invoice-ocr.js';

export const INVOICE_OCR_PROVIDER = Symbol('INVOICE_OCR_PROVIDER');
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/json']);
const maximumBytes = 5 * 1024 * 1024;

@Controller('/api/v1/admin/invoices')
export class InvoiceController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TenantContextService) private readonly tenants: TenantContextService,
    @Inject(INVOICE_OCR_PROVIDER) private readonly ocr: InvoiceOcrProvider,
  ) {}

  private async actor(request: TenantRequest, permission: 'purchase:read' | 'purchase:manage'): Promise<AdminActor> {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has(permission)) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: { id: context.userId, organizationId: context.organizationId,
      status: 'ACTIVE', ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}) }, select: { id: true } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId, ...(context.storeId ? { storeId: context.storeId } : {}) };
  }

  @Get()
  async list(@Req() request: TenantRequest) {
    return listInvoiceDocuments(this.prisma, await this.actor(request, 'purchase:read'));
  }

  /** Case economics, discrepancies, and available vendor deals for each line, computed for the review step. */
  @Get(':invoiceId/review')
  async review(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string) {
    return getInvoiceReview(this.prisma, await this.actor(request, 'purchase:read'), invoiceId);
  }

  @Get(':invoiceId/continuations')
  async continuations(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string) {
    return findContinuationCandidates(this.prisma, await this.actor(request, 'purchase:read'), invoiceId);
  }

  @Get(':invoiceId')
  async get(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string) {
    return getInvoiceDocument(this.prisma, await this.actor(request, 'purchase:read'), invoiceId);
  }

  @Post('upload')
  async upload(@Req() request: TenantRequest, @Body() body: { originalFilename: string; mimeType: string; contentBase64: string; storeId?: string; vendorId?: string; purchaseOrderId?: string }) {
    if (!body.originalFilename?.trim() || body.originalFilename.length > 255) throw new PosError('INVOICE_FILENAME_INVALID');
    if (!allowedMimeTypes.has(body.mimeType)) throw new PosError('INVOICE_FILE_TYPE_UNSUPPORTED', 415);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.contentBase64 ?? '')) throw new PosError('INVOICE_FILE_INVALID');
    const content = Buffer.from(body.contentBase64, 'base64');
    if (!content.length || content.length > maximumBytes) throw new PosError('INVOICE_FILE_SIZE_INVALID', 413);
    const actor = await this.actor(request, 'purchase:manage');
    const document = await createInvoiceDocument(this.prisma, actor, { ...(body.storeId ? { storeId: body.storeId } : {}),
      ...(body.vendorId ? { vendorId: body.vendorId } : {}), ...(body.purchaseOrderId ? { purchaseOrderId: body.purchaseOrderId } : {}),
      originalFilename: body.originalFilename, mimeType: body.mimeType, content,
      documentHash: createHash('sha256').update(content).digest('hex') });
    return this.runOcr(actor, document.id);
  }

  /** Starts an invoice with no file or OCR. Everything OCR can fill in can be typed here. */
  @Post('manual')
  async manual(@Req() request: TenantRequest, @Body() body: InvoiceHeaderInput & { storeId?: string; vendorId?: string; purchaseOrderId?: string; label?: string }) {
    return createManualInvoice(this.prisma, await this.actor(request, 'purchase:manage'), body);
  }

  /** Another photo/page of the same invoice. It is stored, read by OCR when available, and its lines join this invoice. */
  @Post(':invoiceId/pages')
  async addPage(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Body() body: { originalFilename: string; mimeType: string; contentBase64: string }) {
    if (!body.originalFilename?.trim() || body.originalFilename.length > 255) throw new PosError('INVOICE_FILENAME_INVALID');
    if (!allowedMimeTypes.has(body.mimeType)) throw new PosError('INVOICE_FILE_TYPE_UNSUPPORTED', 415);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.contentBase64 ?? '')) throw new PosError('INVOICE_FILE_INVALID');
    const content = Buffer.from(body.contentBase64, 'base64');
    if (!content.length || content.length > maximumBytes) throw new PosError('INVOICE_FILE_SIZE_INVALID', 413);
    const actor = await this.actor(request, 'purchase:manage');
    const page = await addInvoicePage(this.prisma, actor, invoiceId, { originalFilename: body.originalFilename, mimeType: body.mimeType, content, documentHash: createHash('sha256').update(content).digest('hex') });
    try {
      const result = await this.ocr.extract({ filename: body.originalFilename, mimeType: body.mimeType, content });
      if (result.lines.length) return { page, invoice: await appendInvoiceOcrResult(this.prisma, actor, invoiceId, page.pageNumber, result) };
    } catch { /* OCR is an accelerator: the page is kept and lines can be entered by hand. */ }
    return { page, invoice: await getInvoiceDocument(this.prisma, actor, invoiceId) };
  }

  @Post(':invoiceId/merge')
  async merge(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Body() body: { sourceId: string }) {
    return mergeInvoiceDocuments(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, body.sourceId);
  }

  @Post(':invoiceId/lines')
  async addLine(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Body() body: InvoiceLineInput) {
    return addInvoiceLine(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, body);
  }

  @Post(':invoiceId/lines/:lineId/remove')
  async removeLine(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Param('lineId') lineId: string) {
    return removeInvoiceLine(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, lineId);
  }

  @Post(':invoiceId/lines/:lineId/claim')
  async claimLine(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Param('lineId') lineId: string, @Body() body: { kind: Parameters<typeof createClaimFromInvoiceLine>[3]['kind']; quantity: number; unitCostMinor: string; reason: string }) {
    return createClaimFromInvoiceLine(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, { lineId, ...body });
  }

  @Post(':invoiceId/charges')
  async addCharge(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Body() body: ChargeInput) {
    return saveInvoiceCharge(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, null, body);
  }

  @Patch(':invoiceId/charges/:chargeId')
  async editCharge(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Param('chargeId') chargeId: string, @Body() body: Partial<ChargeInput>) {
    return saveInvoiceCharge(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, chargeId, body);
  }

  @Post(':invoiceId/charges/:chargeId/remove')
  async dropCharge(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Param('chargeId') chargeId: string) {
    return removeInvoiceCharge(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, chargeId);
  }

  @Post(':invoiceId/retry-ocr')
  async retry(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string) {
    return this.runOcr(await this.actor(request, 'purchase:manage'), invoiceId);
  }

  private async runOcr(actor: AdminActor, invoiceId: string) {
    const document = await getInvoiceDocumentInput(this.prisma, actor, invoiceId);
    await markInvoiceOcrProcessing(this.prisma, actor, invoiceId);
    try {
      const result = await this.ocr.extract({ filename: document.originalFilename, mimeType: document.mimeType, content: Buffer.from(document.documentData) });
      return applyInvoiceOcrResult(this.prisma, actor, invoiceId, result);
    } catch (error) {
      return markInvoiceOcrFailed(this.prisma, actor, invoiceId, this.ocr.name, error instanceof Error ? error.message : 'OCR failed');
    }
  }

  @Patch(':invoiceId')
  async update(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Body() body: Parameters<typeof updateInvoiceDocument>[3]) {
    return updateInvoiceDocument(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, body);
  }

  @Patch(':invoiceId/lines/:lineId')
  async updateLine(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Param('lineId') lineId: string,
    @Body() body: Parameters<typeof updateInvoiceLine>[4]) {
    return updateInvoiceLine(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, lineId, body);
  }

  @Post(':invoiceId/reject')
  async reject(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string) {
    return rejectInvoiceDocument(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId);
  }

  @Post(':invoiceId/confirm')
  async confirm(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Body() body: { acknowledgeDuplicate?: boolean; acknowledgeDiscrepancies?: boolean; reconciliationNote?: string; createClaims?: boolean }) {
    return confirmInvoiceDocument(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, body.acknowledgeDuplicate === true, body.acknowledgeDiscrepancies === true,
      { ...(body.reconciliationNote ? { reconciliationNote: body.reconciliationNote } : {}), ...(body.createClaims === undefined ? {} : { createClaims: body.createClaims }) });
  }
}

/** Receiving history, vendor overview and product receipt history, read from what was actually posted. */
@Controller('/api/v1/admin')
export class ReceivingHistoryController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient, @Inject(TenantContextService) private readonly tenants: TenantContextService) {}

  private async actor(request: TenantRequest): Promise<AdminActor> {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has('purchase:read')) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: { id: context.userId, organizationId: context.organizationId, status: 'ACTIVE', ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}) }, select: { id: true } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId, ...(context.storeId ? { storeId: context.storeId } : {}) };
  }

  @Get('receiving')
  async search(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    const date = (value?: string) => (value ? new Date(value) : undefined);
    const from = date(query.from); const to = date(query.to);
    return searchReceiving(this.prisma, await this.actor(request), { ...(query.vendorId ? { vendorId: query.vendorId } : {}), ...(query.invoiceNumber ? { invoiceNumber: query.invoiceNumber } : {}), ...(query.poNumber ? { poNumber: query.poNumber } : {}),
      ...(query.product ? { product: query.product } : {}), ...(query.employeeId ? { employeeId: query.employeeId } : {}), ...(query.status ? { status: query.status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}),
      ...(query.discrepancy === 'true' ? { discrepancy: true } : {}), ...(query.page ? { page: Number(query.page) } : {}), ...(query.pageSize ? { pageSize: Number(query.pageSize) } : {}) });
  }

  @Get('receiving/:receiptId')
  async receipt(@Req() request: TenantRequest, @Param('receiptId') receiptId: string) { return getReceiptDetail(this.prisma, await this.actor(request), receiptId); }

  @Get('vendors/:vendorId/overview')
  async vendor(@Req() request: TenantRequest, @Param('vendorId') vendorId: string) { return vendorOverview(this.prisma, await this.actor(request), vendorId); }

  @Get('products/:productId/receipts')
  async product(@Req() request: TenantRequest, @Param('productId') productId: string) {
    const actor = await this.actor(request);
    const variants = await this.prisma.productVariant.findMany({ where: { organizationId: actor.organizationId, productId }, select: { id: true, baseVariantId: true } });
    return productReceiptHistory(this.prisma, actor, [...new Set(variants.map((variant) => variant.baseVariantId ?? variant.id))]);
  }
}
