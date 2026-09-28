import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { cancelHeldTransaction, holdTransaction, listHeldTransactions, listQuickKeys, listQuickKeysAdmin, recordAudit, resumeHeldTransaction, saveQuickKey, type RegisterActor } from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

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
  @Get('held-transactions') held(@Req() request: TenantRequest) { return listHeldTransactions(this.prisma, this.actor(request, 'sale:create')); }
  @Post('held-transactions') hold(@Req() request: TenantRequest, @Body() body: Parameters<typeof holdTransaction>[2]) { return holdTransaction(this.prisma, this.actor(request, 'sale:create'), body); }
  @Post('held-transactions/:heldId/resume') resume(@Req() request: TenantRequest, @Param('heldId') heldId: string) { return resumeHeldTransaction(this.prisma, this.actor(request, 'sale:create'), heldId); }
  @Post('held-transactions/:heldId/cancel') cancel(@Req() request: TenantRequest, @Param('heldId') heldId: string) { return cancelHeldTransaction(this.prisma, this.actor(request, 'sale:create'), heldId); }
  @Post('register/manual-drawer-open')
  async manualDrawer(@Req() request: TenantRequest, @Body() body: { reason: string }) {
    const actor = this.actor(request, 'drawer:open'); const reason = body.reason?.trim();
    if (!reason) throw new ForbiddenException();
    await recordAudit(this.prisma, { organizationId: actor.organizationId, action: 'CASH_DRAWER_OPENED_MANUALLY', entityType: 'Register', entityId: actor.registerId, afterJson: { employeeId: actor.userId, storeId: actor.storeId, reason } });
    return { authorized: true, auditRecorded: true };
  }
}
