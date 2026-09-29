import { Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { PrismaClient, VendorDealKind } from '@prisma/client';
import {
  assignTaxProfile, createPriceBook, createPurchasedProduct, createTaxProfile, createVendorDeal, deleteTaxProfile, getProductDetail, listPriceBooks, listSpecialPrices, listTaxProfiles,
  listVendorDeals, lookupUpcForCreation, saveSpecialPrice, updatePriceBook, updateTaxProfile, updateVendorDeal, PosError, type AdminActor, type PurchasedProductInput,
} from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

const date = (value: unknown): Date | null | undefined => (value === undefined ? undefined : value === null || value === '' ? null : new Date(String(value)));

/**
 * Costing, pricing, and tax administration. Purchase cost (vendor mapping + cost history), standard price (Price), and
 * special/channel prices (SpecialPrice) are separate resources by design. Creating a brand-new purchased product requires
 * both catalog and vendor management (Owner/Admin); Managers can maintain pricing and read everything.
 */
@Controller('/api/v1/admin')
export class CostingController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient, @Inject(TenantContextService) private readonly tenants: TenantContextService) {}

  private async actor(request: TenantRequest, ...permissions: string[]): Promise<AdminActor> {
    const context = this.tenants.require(request.tenantContext);
    if (permissions.some((permission) => !context.permissions.has(permission))) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: { id: context.userId, organizationId: context.organizationId, status: 'ACTIVE',
      ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}) }, select: { id: true } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId, ...(context.storeId ? { storeId: context.storeId } : {}) };
  }

  // ---- Tax profiles -------------------------------------------------------------------------------------------------
  @Get('tax-profiles') async taxProfiles(@Req() request: TenantRequest) { return listTaxProfiles(this.prisma, await this.actor(request, 'catalog:read')); }
  @Post('tax-profiles') async addTaxProfile(@Req() request: TenantRequest, @Body() body: { name: string; rateBasisPoints: number; description?: string }) { return createTaxProfile(this.prisma, await this.actor(request, 'settings:write'), body); }
  @Patch('tax-profiles/:id') async editTaxProfile(@Req() request: TenantRequest, @Param('id') id: string, @Body() body: Parameters<typeof updateTaxProfile>[3]) { return updateTaxProfile(this.prisma, await this.actor(request, 'settings:write'), id, body); }
  @Delete('tax-profiles/:id') async removeTaxProfile(@Req() request: TenantRequest, @Param('id') id: string) { return deleteTaxProfile(this.prisma, await this.actor(request, 'settings:write'), id); }
  @Post('tax-assignments') async assignTax(@Req() request: TenantRequest, @Body() body: Parameters<typeof assignTaxProfile>[2]) { return assignTaxProfile(this.prisma, await this.actor(request, 'catalog:manage'), body); }

  // ---- Price books and special prices --------------------------------------------------------------------------------
  @Get('price-books') async priceBooks(@Req() request: TenantRequest) { return listPriceBooks(this.prisma, await this.actor(request, 'catalog:read')); }
  @Post('price-books') async addPriceBook(@Req() request: TenantRequest, @Body() body: Parameters<typeof createPriceBook>[2]) { return createPriceBook(this.prisma, await this.actor(request, 'price:manage'), body); }
  @Patch('price-books/:id') async editPriceBook(@Req() request: TenantRequest, @Param('id') id: string, @Body() body: Parameters<typeof updatePriceBook>[3]) { return updatePriceBook(this.prisma, await this.actor(request, 'price:manage'), id, body); }
  @Get('special-prices') async specialPrices(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listSpecialPrices(this.prisma, await this.actor(request, 'catalog:read'), { ...(query.variantId ? { variantId: query.variantId } : {}), ...(query.productId ? { productId: query.productId } : {}), ...(query.storeId ? { storeId: query.storeId } : {}) });
  }
  @Post('special-prices') async saveSpecial(@Req() request: TenantRequest, @Body() body: { id?: string; priceBookId: string; storeId: string; variantId: string; amountMinor: string; active?: boolean; effectiveFrom?: string | null; effectiveTo?: string | null }) {
    return saveSpecialPrice(this.prisma, await this.actor(request, 'price:manage'), { ...body, effectiveFrom: date(body.effectiveFrom) ?? null, effectiveTo: date(body.effectiveTo) ?? null });
  }

  // ---- Vendor deals -------------------------------------------------------------------------------------------------
  @Get('vendor-deals') async deals(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listVendorDeals(this.prisma, await this.actor(request, 'vendor:read'), { ...(query.vendorId ? { vendorId: query.vendorId } : {}), ...(query.variantId ? { variantId: query.variantId } : {}), activeOnly: query.activeOnly === 'true' });
  }
  @Post('vendor-deals') async addDeal(@Req() request: TenantRequest, @Body() body: { vendorId: string; variantId?: string | null; name: string; kind: VendorDealKind; amountMinor?: string; dealCaseCostMinor?: string; minimumCases?: number | null; startsAt?: string | null; endsAt?: string | null; notes?: string }) {
    return createVendorDeal(this.prisma, await this.actor(request, 'vendor:manage'), { ...body, startsAt: date(body.startsAt) ?? null, endsAt: date(body.endsAt) ?? null });
  }
  @Patch('vendor-deals/:id') async editDeal(@Req() request: TenantRequest, @Param('id') id: string, @Body() body: { name?: string; active?: boolean; startsAt?: string | null; endsAt?: string | null; notes?: string | null }) {
    return updateVendorDeal(this.prisma, await this.actor(request, 'vendor:manage'), id, {
      ...(body.name === undefined ? {} : { name: body.name }), ...(body.active === undefined ? {} : { active: body.active }), ...(body.notes === undefined ? {} : { notes: body.notes }),
      ...(body.startsAt === undefined ? {} : { startsAt: date(body.startsAt) ?? null }), ...(body.endsAt === undefined ? {} : { endsAt: date(body.endsAt) ?? null }) });
  }

  // ---- Product creation and detail ------------------------------------------------------------------------------------
  @Get('product-costing/upc-lookup') async upcLookup(@Req() request: TenantRequest, @Query('upc') upc?: string) {
    if (!upc) throw new PosError('UPC_REQUIRED');
    return lookupUpcForCreation(this.prisma, await this.actor(request, 'catalog:read'), upc);
  }
  @Post('product-costing/purchased') async createPurchased(@Req() request: TenantRequest, @Body() body: PurchasedProductInput) {
    const actor = await this.actor(request, 'catalog:manage', 'vendor:manage');
    return createPurchasedProduct(this.prisma, actor, { ...body, ...(body.specialPrices ? { specialPrices: body.specialPrices.map((special) => ({ ...special, effectiveFrom: date(special.effectiveFrom) ?? null, effectiveTo: date(special.effectiveTo) ?? null })) } : {}) });
  }
  @Get('product-costing/:productId/detail') async productDetail(@Req() request: TenantRequest, @Param('productId') productId: string) {
    return getProductDetail(this.prisma, await this.actor(request, 'catalog:read'), productId);
  }
}
