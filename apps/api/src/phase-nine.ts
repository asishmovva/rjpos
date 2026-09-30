import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import {
  addAlternateBarcode, applyBulkOperation, cancelHeldTransaction, cancelVendorClaim, commitCsvImport, createSalesChannel, createVendorClaim, exportCsv, expireStaleHeldTransactions, listAuditView, listSalesChannels, listVendorClaims,
  previewBulkOperation, previewCsvImport, PosError, recordVendorCredit, revokeEmployeeSessions, rejectVendorClaim, removeAlternateBarcode, setVendorCaseUpc, submitVendorClaim, updateSalesChannel, velocitySuggestions,
  activePromoAssets, deletePromoAsset, listPromoAssets, savePromoAsset, type PromoInput,
  CSV_KINDS, type AdminActor, type CsvKind,
} from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

const date = (value?: string) => (value ? new Date(value) : undefined);
const whole = (value?: string) => (value === undefined || value === '' ? undefined : Number(value));

/** Phase 9 back-office operations: channels, bulk tools, CSV, vendor claims, purchase suggestions, barcodes, audit viewer, backup status. */
@Controller('/api/v1')
export class PhaseNineController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient, @Inject(TenantContextService) private readonly tenants: TenantContextService) {}

  private async actor(request: TenantRequest, permission: string): Promise<AdminActor> {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has(permission)) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: { id: context.userId, organizationId: context.organizationId, status: 'ACTIVE', ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}) }, select: { id: true } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId, ...(context.storeId ? { storeId: context.storeId } : {}) };
  }
  private kind(value: string): CsvKind {
    if (!(CSV_KINDS as readonly string[]).includes(value)) throw new PosError('CSV_KIND_INVALID', 404);
    return value as CsvKind;
  }

  // Sales channels -----------------------------------------------------------------------------------------------------
  /** Register-facing: active channels for the channel picker. */
  @Get('sales-channels')
  async channels(@Req() request: TenantRequest) {
    const actor = await this.actor(request, 'sale:create');
    return (await listSalesChannels(this.prisma, actor.organizationId)).filter((channel) => channel.active);
  }
  @Get('admin/sales-channels')
  async channelsAdmin(@Req() request: TenantRequest) { return listSalesChannels(this.prisma, (await this.actor(request, 'catalog:read')).organizationId); }
  @Post('admin/sales-channels')
  async addChannel(@Req() request: TenantRequest, @Body() body: Parameters<typeof createSalesChannel>[2]) { return createSalesChannel(this.prisma, await this.actor(request, 'settings:write'), body); }
  @Patch('admin/sales-channels/:id')
  async editChannel(@Req() request: TenantRequest, @Param('id') id: string, @Body() body: Parameters<typeof updateSalesChannel>[3]) { return updateSalesChannel(this.prisma, await this.actor(request, 'settings:write'), id, body); }

  // Customer display promotions ----------------------------------------------------------------------------------------
  /** Register-facing: active promotions the register forwards to the customer display. */
  @Get('customer-display/promotions')
  async displayPromotions(@Req() request: TenantRequest) { return activePromoAssets(this.prisma, (await this.actor(request, 'sale:create')).organizationId); }
  @Get('admin/promo-assets')
  async promoList(@Req() request: TenantRequest) { return listPromoAssets(this.prisma, await this.actor(request, 'settings:write')); }
  @Post('admin/promo-assets')
  async promoAdd(@Req() request: TenantRequest, @Body() body: PromoInput) { return savePromoAsset(this.prisma, await this.actor(request, 'settings:write'), null, body); }
  @Patch('admin/promo-assets/:id')
  async promoEdit(@Req() request: TenantRequest, @Param('id') id: string, @Body() body: Partial<PromoInput>) { return savePromoAsset(this.prisma, await this.actor(request, 'settings:write'), id, body); }
  @Post('admin/promo-assets/:id/delete')
  async promoDelete(@Req() request: TenantRequest, @Param('id') id: string) { return deletePromoAsset(this.prisma, await this.actor(request, 'settings:write'), id); }

  // Held sales ---------------------------------------------------------------------------------------------------------
  /** Manager cleanup of stale held sales for the store (also runs lazily whenever the list is opened). */
  @Post('admin/held-transactions/cleanup')
  async cleanupHeld(@Req() request: TenantRequest) {
    const actor = await this.actor(request, 'register:manage');
    const storeId = this.tenants.require(request.tenantContext).storeId;
    if (!storeId) throw new PosError('STORE_REQUIRED');
    return expireStaleHeldTransactions(this.prisma, { organizationId: actor.organizationId, storeId });
  }
  @Post('admin/held-transactions/:heldId/cancel')
  async managerCancelHeld(@Req() request: TenantRequest, @Param('heldId') heldId: string) {
    const actor = await this.actor(request, 'register:manage');
    const context = this.tenants.require(request.tenantContext);
    if (!context.storeId || !context.registerId) throw new PosError('STORE_REQUIRED');
    return cancelHeldTransaction(this.prisma, { organizationId: actor.organizationId, storeId: context.storeId, registerId: context.registerId, userId: actor.userId }, heldId);
  }

  // Bulk tools ---------------------------------------------------------------------------------------------------------
  @Post('admin/bulk/preview')
  async bulkPreview(@Req() request: TenantRequest, @Body() body: Parameters<typeof previewBulkOperation>[2]) { return previewBulkOperation(this.prisma, await this.actor(request, 'bulk:manage'), body); }
  @Post('admin/bulk/apply')
  async bulkApply(@Req() request: TenantRequest, @Body() body: Parameters<typeof applyBulkOperation>[2]) { return applyBulkOperation(this.prisma, await this.actor(request, 'bulk:manage'), body); }

  // CSV ----------------------------------------------------------------------------------------------------------------
  @Get('admin/csv/:kind/export')
  async csvExport(@Req() request: TenantRequest, @Param('kind') kind: string, @Query('storeId') storeId: string | undefined, @Res() response: Response) {
    const csvKind = this.kind(kind);
    const csv = await exportCsv(this.prisma, await this.actor(request, 'report:export'), csvKind, { ...(storeId ? { storeId } : {}) });
    response.setHeader('content-type', 'text/csv; charset=utf-8'); response.setHeader('content-disposition', `attachment; filename="rjpos-${csvKind}.csv"`); response.send(csv);
  }
  @Post('admin/csv/:kind/preview')
  async csvPreview(@Req() request: TenantRequest, @Param('kind') kind: string, @Body() body: { csv: string; storeId?: string; createCategories?: boolean }) {
    return previewCsvImport(this.prisma, await this.actor(request, 'import:manage'), this.kind(kind), body.csv, { ...(body.storeId ? { storeId: body.storeId } : {}), createCategories: body.createCategories === true });
  }
  @Post('admin/csv/:kind/commit')
  async csvCommit(@Req() request: TenantRequest, @Param('kind') kind: string, @Body() body: { csv: string; storeId?: string; createCategories?: boolean; skipInvalidRows?: boolean }) {
    return commitCsvImport(this.prisma, await this.actor(request, 'import:manage'), this.kind(kind), body.csv, { ...(body.storeId ? { storeId: body.storeId } : {}), createCategories: body.createCategories === true, skipInvalidRows: body.skipInvalidRows === true });
  }

  // Vendor claims and purchase suggestions -----------------------------------------------------------------------------
  @Get('admin/vendor-claims')
  async claims(@Req() request: TenantRequest, @Query() query: Record<string, string>) { return listVendorClaims(this.prisma, await this.actor(request, 'purchase:read'), { ...(query.status ? { status: query.status } : {}), ...(query.vendorId ? { vendorId: query.vendorId } : {}) }); }
  @Post('admin/vendor-claims')
  async addClaim(@Req() request: TenantRequest, @Body() body: Parameters<typeof createVendorClaim>[2]) { return createVendorClaim(this.prisma, await this.actor(request, 'purchase:manage'), body); }
  @Post('admin/vendor-claims/:id/submit')
  async submitClaim(@Req() request: TenantRequest, @Param('id') id: string) { return submitVendorClaim(this.prisma, await this.actor(request, 'purchase:manage'), id); }
  @Post('admin/vendor-claims/:id/credit')
  async creditClaim(@Req() request: TenantRequest, @Param('id') id: string, @Body() body: { creditedMinor: string; creditReference?: string }) { return recordVendorCredit(this.prisma, await this.actor(request, 'purchase:manage'), id, body); }
  @Post('admin/vendor-claims/:id/reject')
  async rejectClaim(@Req() request: TenantRequest, @Param('id') id: string, @Body() body: { reason: string }) { return rejectVendorClaim(this.prisma, await this.actor(request, 'purchase:manage'), id, body.reason); }
  @Post('admin/vendor-claims/:id/cancel')
  async cancelClaim(@Req() request: TenantRequest, @Param('id') id: string) { return cancelVendorClaim(this.prisma, await this.actor(request, 'purchase:manage'), id); }
  @Get('admin/purchasing/velocity-suggestions')
  async velocity(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    const lookbackDays = whole(query.lookbackDays); const coverDays = whole(query.coverDays); const leadTimeDays = whole(query.leadTimeDays);
    return velocitySuggestions(this.prisma, await this.actor(request, 'purchase:read'), { ...(query.storeId ? { storeId: query.storeId } : {}), ...(lookbackDays === undefined ? {} : { lookbackDays }), ...(coverDays === undefined ? {} : { coverDays }), ...(leadTimeDays === undefined ? {} : { leadTimeDays }) });
  }

  // Barcodes -----------------------------------------------------------------------------------------------------------
  @Post('admin/variants/:variantId/barcodes')
  async addBarcode(@Req() request: TenantRequest, @Param('variantId') variantId: string, @Body() body: { barcodeValue: string }) { return addAlternateBarcode(this.prisma, await this.actor(request, 'catalog:manage'), { variantId, barcodeValue: body.barcodeValue }); }
  @Post('admin/barcodes/:barcodeId/remove')
  async removeBarcode(@Req() request: TenantRequest, @Param('barcodeId') barcodeId: string) { return removeAlternateBarcode(this.prisma, await this.actor(request, 'catalog:manage'), barcodeId); }
  @Patch('admin/vendor-mappings/:mappingId/case-upc')
  async caseUpc(@Req() request: TenantRequest, @Param('mappingId') mappingId: string, @Body() body: { caseUpc: string | null }) { return setVendorCaseUpc(this.prisma, await this.actor(request, 'catalog:manage'), mappingId, body.caseUpc ?? null); }

  /** Forces an employee to sign in again on every register (lost device, suspected PIN sharing). */
  @Post('admin/employees/:employeeId/revoke-sessions')
  async revokeSessions(@Req() request: TenantRequest, @Param('employeeId') employeeId: string) { return revokeEmployeeSessions(this.prisma, await this.actor(request, 'employee:manage'), employeeId); }

  // Audit viewer and system status -------------------------------------------------------------------------------------
  @Get('admin/audit-view')
  async auditView(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    const page = whole(query.page); const pageSize = whole(query.pageSize); const from = date(query.from); const to = date(query.to);
    return listAuditView(this.prisma, await this.actor(request, 'audit:read'), { ...(page === undefined ? {} : { page }), ...(pageSize === undefined ? {} : { pageSize }), ...(query.action ? { action: query.action } : {}), ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}), ...(query.storeId ? { storeId: query.storeId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }

  /** Reads the status file written by scripts/backup-database.ps1. It contains times and file names only, never credentials. */
  @Get('admin/system/backup-status')
  async backupStatus(@Req() request: TenantRequest) {
    await this.actor(request, 'system:read');
    const configured = process.env.RJPOS_BACKUP_DIR;
    const directory = configured ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured)) : resolve(process.cwd(), '../../backups');
    const restoreInstructions = ['Stop the API and the register app.', 'Check the backup first: run scripts\\restore-database.ps1 -BackupPath backups\\<file>. It restores into a separate test database and never touches live data.', 'To replace live data, an administrator restores the backup into the live database with pg_restore --clean (steps in docs/phase-9/deployment.md), then starts the API.', 'Sign in, run a test sale, and preview a day close before opening for business.'];
    try {
      const status = JSON.parse((await readFile(resolve(directory, 'status.json'), 'utf8')).replace(/^﻿/, '')) as { lastAttemptAt?: string; lastSuccessAt?: string; result?: string; file?: string; detail?: string };
      const lastSuccessAt = status.lastSuccessAt ?? null;
      const ageHours = lastSuccessAt ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000 : null;
      const fileStat = status.file && /^rjpos-[\w.-]+\.dump$/.test(status.file) ? await stat(resolve(directory, status.file)).catch(() => null) : null;
      return { destination: 'Local folder on the server (backups)', fileExists: fileStat !== null, fileSizeBytes: fileStat?.size ?? null, configured: true, lastAttemptAt: status.lastAttemptAt ?? null, lastSuccessAt, result: status.result === 'SUCCESS' ? 'SUCCESS' : 'FAILURE', file: status.file ?? null, detail: status.detail ?? null, stale: ageHours === null || ageHours > 36, restoreInstructions };
    } catch {
      return { destination: 'Local folder on the server (backups)', fileExists: false, fileSizeBytes: null, configured: false, lastAttemptAt: null, lastSuccessAt: null, result: 'UNKNOWN', file: null, detail: 'No backup has been recorded yet. Run scripts\\backup-database.ps1 (schedule it daily).', stale: true, restoreInstructions };
    }
  }
}
