import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  adjustLoyalty,
  clockIn,
  clockOut,
  configureLoyalty,
  correctShift,
  createCustomer,
  disableGiftCard,
  getCurrentShift,
  getCustomerDetail,
  getLoyaltyProgram,
  issueGiftCard,
  listCustomers,
  listShifts,
  lookupGiftCard,
  parseMoneyApi,
  reloadGiftCard,
  updateCustomer,
  type WorkforceActor,
} from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

const integer = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new BadRequestException('QUERY_INTEGER_INVALID');
  return parsed;
};

const date = (value: string | undefined): Date | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException('QUERY_DATE_INVALID');
  return parsed;
};

const requiredDate = (value: string | undefined): Date => {
  const parsed = date(value);
  if (!parsed) throw new BadRequestException('QUERY_DATE_INVALID');
  return parsed;
};

@Controller('/api/v1')
export class PhaseThreeController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TenantContextService) private readonly tenants: TenantContextService,
  ) {}

  private async actor(request: TenantRequest, permission: string): Promise<WorkforceActor> {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has(permission)) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: { id: context.userId, organizationId: context.organizationId,
      status: 'ACTIVE', ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}) } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId,
      ...(context.storeId ? { storeId: context.storeId } : {}), ...(context.registerId ? { registerId: context.registerId } : {}) };
  }

  @Get('workforce/current')
  async currentShift(@Req() request: TenantRequest) {
    const actor = await this.actor(request, 'workforce:clock');
    return getCurrentShift(this.prisma, actor);
  }

  @Post('workforce/clock-in')
  async startShift(@Req() request: TenantRequest) {
    return clockIn(this.prisma, await this.actor(request, 'workforce:clock'), {});
  }

  @Post('workforce/clock-out')
  async endShift(@Req() request: TenantRequest) {
    return clockOut(this.prisma, await this.actor(request, 'workforce:clock'), {});
  }

  @Get('admin/shifts')
  async shifts(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    const page = integer(query.page); const pageSize = integer(query.pageSize); const from = date(query.from); const to = date(query.to);
    return listShifts(this.prisma, await this.actor(request, 'workforce:manage'), {
      ...(page === undefined ? {} : { page }), ...(pageSize === undefined ? {} : { pageSize }),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}), ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.active === undefined ? {} : { active: query.active === 'true' }), ...(from ? { from } : {}), ...(to ? { to } : {}),
    });
  }

  @Patch('admin/shifts/:shiftId')
  async fixShift(@Req() request: TenantRequest, @Param('shiftId') shiftId: string,
    @Body() body: { clockedInAt: string; clockedOutAt: string; reason: string }) {
    return correctShift(this.prisma, await this.actor(request, 'workforce:manage'), shiftId,
      { clockedInAt: requiredDate(body.clockedInAt), clockedOutAt: requiredDate(body.clockedOutAt), reason: body.reason });
  }

  @Get('customers')
  async customers(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    const page = integer(query.page); const pageSize = integer(query.pageSize);
    return listCustomers(this.prisma, await this.actor(request, 'customer:read'), {
      ...(page === undefined ? {} : { page }), ...(pageSize === undefined ? {} : { pageSize }),
      ...(query.search ? { search: query.search } : {}), ...(query.active === undefined ? {} : { active: query.active === 'true' }),
    });
  }

  @Post('customers')
  async addCustomer(@Req() request: TenantRequest, @Body() body: Parameters<typeof createCustomer>[2]) {
    return createCustomer(this.prisma, await this.actor(request, 'customer:manage'), body);
  }

  @Get('customers/:customerId')
  async customer(@Req() request: TenantRequest, @Param('customerId') customerId: string) {
    return getCustomerDetail(this.prisma, await this.actor(request, 'customer:read'), customerId);
  }

  @Patch('customers/:customerId')
  async editCustomer(@Req() request: TenantRequest, @Param('customerId') customerId: string,
    @Body() body: Parameters<typeof updateCustomer>[3]) {
    return updateCustomer(this.prisma, await this.actor(request, 'customer:manage'), customerId, body);
  }

  @Get('loyalty/program')
  async loyaltyProgram(@Req() request: TenantRequest) {
    const actor = await this.actor(request, 'customer:read');
    return getLoyaltyProgram(this.prisma, actor.organizationId);
  }

  @Patch('admin/loyalty/program')
  async setLoyaltyProgram(@Req() request: TenantRequest,
    @Body() body: { enabled: boolean; pointsEarned: number; spendMinor: string; redeemMinorPerPoint: string }) {
    return configureLoyalty(this.prisma, await this.actor(request, 'loyalty:manage'), {
      enabled: body.enabled, pointsEarned: body.pointsEarned, spendMinor: parseMoneyApi(body.spendMinor), redeemMinorPerPoint: parseMoneyApi(body.redeemMinorPerPoint),
    });
  }

  @Post('admin/customers/:customerId/loyalty-adjustments')
  async loyaltyAdjustment(@Req() request: TenantRequest, @Param('customerId') customerId: string,
    @Body() body: { points: number; reason: string }) {
    return adjustLoyalty(this.prisma, await this.actor(request, 'loyalty:manage'), customerId, body);
  }

  @Get('gift-cards/lookup')
  async giftCard(@Req() request: TenantRequest, @Query('code') code: string) {
    const actor = await this.actor(request, 'giftcard:redeem');
    return lookupGiftCard(this.prisma, actor.organizationId, code);
  }

  @Post('admin/gift-cards')
  async addGiftCard(@Req() request: TenantRequest, @Body() body: { amountMinor: string; reason?: string }) {
    return issueGiftCard(this.prisma, await this.actor(request, 'giftcard:manage'), {
      amountMinor: parseMoneyApi(body.amountMinor), ...(body.reason ? { reason: body.reason } : {}),
    });
  }

  @Post('admin/gift-cards/reload')
  async reload(@Req() request: TenantRequest, @Body() body: { code: string; amountMinor: string; reason: string }) {
    return reloadGiftCard(this.prisma, await this.actor(request, 'giftcard:manage'), body.code,
      { amountMinor: parseMoneyApi(body.amountMinor), reason: body.reason });
  }

  @Post('admin/gift-cards/:cardId/disable')
  async disable(@Req() request: TenantRequest, @Param('cardId') cardId: string, @Body() body: { reason: string }) {
    return disableGiftCard(this.prisma, await this.actor(request, 'giftcard:manage'), cardId, body.reason);
  }
}
