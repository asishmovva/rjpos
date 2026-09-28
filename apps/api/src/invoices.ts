import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  applyInvoiceOcrResult, confirmInvoiceDocument, createInvoiceDocument, getInvoiceDocument,
  getInvoiceDocumentInput, listInvoiceDocuments, markInvoiceOcrFailed, markInvoiceOcrProcessing,
  rejectInvoiceDocument, updateInvoiceDocument, updateInvoiceLine, type AdminActor, PosError,
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
  async confirm(@Req() request: TenantRequest, @Param('invoiceId') invoiceId: string, @Body() body: { acknowledgeDuplicate?: boolean }) {
    return confirmInvoiceDocument(this.prisma, await this.actor(request, 'purchase:manage'), invoiceId, body.acknowledgeDuplicate === true);
  }
}
