import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { CashMovementKind, PrismaClient } from '@prisma/client';
import { cancelHeldTransaction, holdTransaction, listHeldTransactions, listQuickKeys, getShiftReport, listCashMovements, recordCashMovement, listQuickKeysAdmin, recordAudit, reorderQuickKeys, resumeHeldTransaction, saveQuickKey, PosError, type RegisterActor } from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

const CASH_PERMISSIONS: Partial<Record<CashMovementKind, string>> = { PAID_IN: 'cash:paid-in', SAFE_DROP: 'cash:safe-drop', PAID_OUT: 'cash:paid-out', ADJUSTMENT_IN: 'cash:adjust', ADJUSTMENT_OUT: 'cash:adjust', NO_SALE: 'drawer:open' };

@Controller('/api/v1')
export class PhaseSevenController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient, @Inject(TenantContextService) private readonly tenants: TenantContextService) {}
  private actor(request: TenantRequest, permission: string): RegisterActor {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has(permission) || !context.storeId || !context.registerId) throw new ForbiddenException();
    return { organizationId: context.organizationId, storeId: context.storeId, registerId: context.registerId, userId: context.userId };
  }
  @Get('quick-keys') quickKeys(@Req() request: TenantRequest) { return listQuickKeys(this.prisma, this.actor(request, 'sale:create')); }
  @Get('admin/quick-keys') quickKeysAdmin(@Req() request: TenantRequest) { return listQuickKeysAdmin(this.prisma, this.actor(request, 'quickkey:manage')); }
  @Post('admin/quick-keys') addQuickKey(@Req() request: TenantRequest, @Body() body: Parameters<typeof saveQuickKey>[2]) { return saveQuickKey(this.prisma, this.actor(request, 'quickkey:manage'), body); }
  @Patch('admin/quick-keys/:quickKeyId') editQuickKey(@Req() request: TenantRequest, @Param('quickKeyId') quickKeyId: string, @Body() body: Omit<Parameters<typeof saveQuickKey>[2], 'id'>) { return saveQuickKey(this.prisma, this.actor(request, 'quickkey:manage'), { ...body, id: quickKeyId }); }
  @Post('admin/quick-keys/reorder') reorderKeys(@Req() request: TenantRequest, @Body() body: { ids: string[] }) { return reorderQuickKeys(this.prisma, this.actor(request, 'quickkey:manage'), body.ids); }
  @Get('register-sessions/:sessionId/report')
  shiftReport(@Req() request: TenantRequest, @Param('sessionId') sessionId: string) {
    const actor = this.actor(request, 'register:close');
    // Cashiers get the reconciliation summary only; the detailed breakdown requires report:read (Manager/Owner).
    return getShiftReport(this.prisma, actor, sessionId, this.tenants.require(request.tenantContext).permissions.has('report:read'));
  }
  @Get('held-transactions') held(@Req() request: TenantRequest) { return listHeldTransactions(this.prisma, this.actor(request, 'sale:create')); }
  @Post('held-transactions') hold(@Req() request: TenantRequest, @Body() body: Parameters<typeof holdTransaction>[2]) { return holdTransaction(this.prisma, this.actor(request, 'sale:create'), body); }
  @Post('held-transactions/:heldId/resume') resume(@Req() request: TenantRequest, @Param('heldId') heldId: string) { return resumeHeldTransaction(this.prisma, this.actor(request, 'sale:create'), heldId); }
  @Post('held-transactions/:heldId/cancel') cancel(@Req() request: TenantRequest, @Param('heldId') heldId: string) { return cancelHeldTransaction(this.prisma, this.actor(request, 'sale:create'), heldId); }
  /** Paid in/out, safe drop, no-sale, adjustment: each kind has its own permission, so a cashier can be limited to safe drops and paid in. */
  @Post('register/cash-movements')
  async cashMovement(@Req() request: TenantRequest, @Body() body: { kind: CashMovementKind; amountMinor?: string; reason?: string }) {
    const permission = CASH_PERMISSIONS[body.kind];
    if (!permission) throw new PosError('CASH_KIND_INVALID');
    const actor = this.actor(request, permission); const context = this.tenants.require(request.tenantContext);
    return recordCashMovement(this.prisma, { ...actor, approvedByEmployeeId: context.approvedByEmployeeId ?? null }, { kind: body.kind, ...(body.amountMinor === undefined ? {} : { amountMinor: body.amountMinor }), ...(body.reason === undefined ? {} : { reason: body.reason }) });
  }
  @Get('register-sessions/:sessionId/cash-movements')
  cashMovements(@Req() request: TenantRequest, @Param('sessionId') sessionId: string) { return listCashMovements(this.prisma, this.actor(request, 'register:close'), sessionId); }
  @Post('register/manual-drawer-open')
  async manualDrawer(@Req() request: TenantRequest, @Body() body: { reason: string }) {
    const actor = this.actor(request, 'drawer:open'); const reason = body.reason?.trim();
    if (!reason) throw new ForbiddenException();
    const context = this.tenants.require(request.tenantContext);
    // Recorded as a no-sale movement on the open session so drawer opens appear on the shift and Z reports.
    await recordCashMovement(this.prisma, { ...actor, approvedByEmployeeId: context.approvedByEmployeeId ?? null }, { kind: 'NO_SALE', reason }).catch((error: unknown) => { if (!(error instanceof PosError && error.code === 'REGISTER_SESSION_NOT_OPEN')) throw error; });
    await recordAudit(this.prisma, { organizationId: actor.organizationId, action: 'CASH_DRAWER_OPENED_MANUALLY', entityType: 'Register', entityId: actor.registerId, afterJson: { employeeId: actor.userId, storeId: actor.storeId, reason } });
    return { authorized: true, auditRecorded: true };
  }
}
