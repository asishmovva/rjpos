import { Body, Controller, ForbiddenException, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { finalizeDayClose, listDayCloses, previewDayClose, PosError, type AdminActor } from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

/** Store/day closeout (Z report). Owner and Manager only; a store's business date can be finalized exactly once. */
@Controller('/api/v1/admin/day-close')
export class DayCloseController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient, @Inject(TenantContextService) private readonly tenants: TenantContextService) {}

  private async actor(request: TenantRequest): Promise<AdminActor> {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has('dayclose:manage')) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: { id: context.userId, organizationId: context.organizationId, status: 'ACTIVE',
      ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}) }, select: { id: true } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId, ...(context.storeId ? { storeId: context.storeId } : {}) };
  }
  private storeOf(request: TenantRequest, storeId?: string): string {
    const resolved = storeId ?? this.tenants.require(request.tenantContext).storeId;
    if (!resolved) throw new PosError('STORE_REQUIRED');
    return resolved;
  }

  @Get('preview')
  async preview(@Req() request: TenantRequest, @Query('storeId') storeId?: string, @Query('date') date?: string) {
    if (!date) throw new PosError('BUSINESS_DATE_INVALID');
    return previewDayClose(this.prisma, await this.actor(request), { storeId: this.storeOf(request, storeId), businessDate: date });
  }
  @Get()
  async history(@Req() request: TenantRequest, @Query('storeId') storeId?: string) {
    return listDayCloses(this.prisma, await this.actor(request), this.storeOf(request, storeId));
  }
  @Post()
  async finalize(@Req() request: TenantRequest, @Body() body: { storeId?: string; businessDate: string; acknowledgeOpenRegisters?: boolean }) {
    return finalizeDayClose(this.prisma, await this.actor(request), { storeId: this.storeOf(request, body.storeId), businessDate: body.businessDate, acknowledgeOpenRegisters: body.acknowledgeOpenRegisters === true });
  }
}
