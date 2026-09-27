import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  cancelTransfer, createPromotion, createStockCount, createTransfer, finalizeStockCount,
  listPromotions, listStockCounts, listTransfers, receiveTransfer, replenishmentSuggestions,
  reviewStockCount, shipTransfer, submitTransfer, updateInventoryPolicy, updatePromotion,
  type AdminActor, type PromotionInput, PosError,
} from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

const integer = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new PosError('QUERY_INTEGER_INVALID');
  return parsed;
};
const page = (query: Record<string, string>) => {
  const pageNumber = integer(query.page);
  const pageSize = integer(query.pageSize);
  return { ...(pageNumber === undefined ? {} : { page: pageNumber }), ...(pageSize === undefined ? {} : { pageSize }) };
};
type PromotionBody = Omit<PromotionInput, 'startsAt' | 'endsAt'> & { startsAt: string; endsAt: string };
const promotionInput = (body: PromotionBody): PromotionInput => {
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  if (Number.isNaN(startsAt.valueOf()) || Number.isNaN(endsAt.valueOf())) throw new PosError('PROMOTION_DATE_INVALID');
  return { ...body, startsAt, endsAt };
};

@Controller('/api/v1/admin')
export class PhaseFiveController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TenantContextService) private readonly tenants: TenantContextService,
  ) {}

  private async actor(request: TenantRequest, permission: string): Promise<AdminActor> {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has(permission)) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: {
      id: context.userId, organizationId: context.organizationId, status: 'ACTIVE',
      ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}),
    }, select: { id: true } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId, ...(context.storeId ? { storeId: context.storeId } : {}) };
  }

  @Patch('inventory/policy')
  async inventoryPolicy(@Req() request: TenantRequest, @Body() body: Parameters<typeof updateInventoryPolicy>[2]) {
    return updateInventoryPolicy(this.prisma, await this.actor(request, 'inventory:adjust'), body);
  }

  @Get('transfers')
  async transfers(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listTransfers(this.prisma, await this.actor(request, 'inventory:transfer'), {
      ...page(query), ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.status ? { status: query.status as NonNullable<Parameters<typeof listTransfers>[2]['status']> } : {}),
    });
  }

  @Post('transfers')
  async addTransfer(@Req() request: TenantRequest, @Body() body: Parameters<typeof createTransfer>[2]) {
    return createTransfer(this.prisma, await this.actor(request, 'inventory:transfer'), body);
  }

  @Post('transfers/:transferId/submit')
  async submit(@Req() request: TenantRequest, @Param('transferId') transferId: string) {
    return submitTransfer(this.prisma, await this.actor(request, 'inventory:transfer'), transferId);
  }

  @Post('transfers/:transferId/ship')
  async ship(@Req() request: TenantRequest, @Param('transferId') transferId: string, @Body() body: Parameters<typeof shipTransfer>[3]) {
    return shipTransfer(this.prisma, await this.actor(request, 'inventory:transfer'), transferId, body);
  }

  @Post('transfers/:transferId/receipts')
  async receive(@Req() request: TenantRequest, @Param('transferId') transferId: string, @Body() body: Parameters<typeof receiveTransfer>[3]) {
    return receiveTransfer(this.prisma, await this.actor(request, 'inventory:transfer'), transferId, body);
  }

  @Post('transfers/:transferId/cancel')
  async cancel(@Req() request: TenantRequest, @Param('transferId') transferId: string) {
    return cancelTransfer(this.prisma, await this.actor(request, 'inventory:transfer'), transferId);
  }

  @Get('stock-counts')
  async stockCounts(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listStockCounts(this.prisma, await this.actor(request, 'inventory:count'), {
      ...page(query), ...(query.storeId ? { storeId: query.storeId } : {}),
    });
  }

  @Post('stock-counts')
  async addStockCount(@Req() request: TenantRequest, @Body() body: Parameters<typeof createStockCount>[2]) {
    return createStockCount(this.prisma, await this.actor(request, 'inventory:count'), body);
  }

  @Post('stock-counts/:countId/review')
  async review(@Req() request: TenantRequest, @Param('countId') countId: string, @Body() body: Parameters<typeof reviewStockCount>[3]) {
    return reviewStockCount(this.prisma, await this.actor(request, 'inventory:count'), countId, body);
  }

  @Post('stock-counts/:countId/finalize')
  async finalize(@Req() request: TenantRequest, @Param('countId') countId: string) {
    return finalizeStockCount(this.prisma, await this.actor(request, 'inventory:count'), countId);
  }

  @Get('replenishment')
  async replenishment(@Req() request: TenantRequest, @Query('storeId') storeId?: string) {
    return replenishmentSuggestions(this.prisma, await this.actor(request, 'replenishment:read'), storeId);
  }

  @Get('promotions')
  async promotions(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listPromotions(this.prisma, await this.actor(request, 'promotion:manage'), {
      ...page(query), ...(query.active === undefined ? {} : { active: query.active === 'true' }),
    });
  }

  @Post('promotions')
  async addPromotion(@Req() request: TenantRequest, @Body() body: PromotionBody) {
    return createPromotion(this.prisma, await this.actor(request, 'promotion:manage'), promotionInput(body));
  }

  @Patch('promotions/:promotionId')
  async editPromotion(@Req() request: TenantRequest, @Param('promotionId') promotionId: string, @Body() body: PromotionBody) {
    return updatePromotion(this.prisma, await this.actor(request, 'promotion:manage'), promotionId, promotionInput(body));
  }
}
