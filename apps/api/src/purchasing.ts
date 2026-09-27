import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  addMasterProductToStore,
  createPurchaseOrder,
  createVendor,
  getPurchaseOrder,
  importMasterCatalogCsv,
  listPurchaseOrders,
  listReceivingHistory,
  listVendorMappings,
  listVendors,
  lookupMasterProduct,
  receivePurchaseOrder,
  saveVendorMapping,
  searchMasterProducts,
  transitionPurchaseOrder,
  updateDraftPurchaseOrder,
  updateVendor,
  type AdminActor,
  PosError,
} from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

const integer = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new PosError('QUERY_INTEGER_INVALID');
  return parsed;
};
const pagination = (query: Record<string, string>) => {
  const page = integer(query.page);
  const pageSize = integer(query.pageSize);
  return { ...(page === undefined ? {} : { page }), ...(pageSize === undefined ? {} : { pageSize }) };
};

@Controller('/api/v1')
export class PurchasingController {
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

  @Get('catalog/upc/:upc')
  async lookupUpc(@Req() request: TenantRequest, @Param('upc') upc: string) {
    return lookupMasterProduct(this.prisma, await this.actor(request, 'catalog:read'), upc);
  }

  @Get('admin/master-catalog')
  async masterCatalog(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    await this.actor(request, 'catalog:read');
    return searchMasterProducts(this.prisma, query.search ?? '', pagination(query));
  }

  @Post('admin/master-catalog/import')
  async importCatalog(@Req() request: TenantRequest, @Body() body: { csv: string }) {
    return importMasterCatalogCsv(this.prisma, await this.actor(request, 'mastercatalog:manage'), body.csv);
  }

  @Post('admin/master-catalog/:upc/add-to-store')
  async addMasterToStore(@Req() request: TenantRequest, @Param('upc') upc: string, @Body() body: {
    categoryId: string; sku: string; variantName?: string; storeId?: string; priceMinor?: string; costMinor?: string;
    inventoryTracked?: boolean; lowStockThreshold?: number;
  }) {
    return addMasterProductToStore(this.prisma, await this.actor(request, 'catalog:manage'), upc, body);
  }

  @Get('admin/vendors')
  async vendors(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    const permission = query.manage === 'true' ? 'vendor:manage' : 'vendor:read';
    return listVendors(this.prisma, await this.actor(request, permission), {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.active === undefined ? {} : { active: query.active === 'true' }),
      ...pagination(query),
    });
  }

  @Post('admin/vendors')
  async addVendor(@Req() request: TenantRequest, @Body() body: Parameters<typeof createVendor>[2]) {
    return createVendor(this.prisma, await this.actor(request, 'vendor:manage'), body);
  }

  @Patch('admin/vendors/:vendorId')
  async editVendor(@Req() request: TenantRequest, @Param('vendorId') vendorId: string, @Body() body: Parameters<typeof updateVendor>[3]) {
    return updateVendor(this.prisma, await this.actor(request, 'vendor:manage'), vendorId, body);
  }

  @Get('admin/vendor-mappings')
  async mappings(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listVendorMappings(this.prisma, await this.actor(request, 'vendor:read'), {
      ...(query.vendorId === undefined ? {} : { vendorId: query.vendorId }),
      ...(query.search === undefined ? {} : { search: query.search }),
      ...pagination(query),
    });
  }

  @Post('admin/vendor-mappings')
  async saveMapping(@Req() request: TenantRequest, @Body() body: Parameters<typeof saveVendorMapping>[2]) {
    return saveVendorMapping(this.prisma, await this.actor(request, 'vendor:manage'), body);
  }

  @Get('admin/purchase-orders')
  async purchaseOrders(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listPurchaseOrders(this.prisma, await this.actor(request, 'purchase:read'), {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
      ...pagination(query),
    });
  }

  @Post('admin/purchase-orders')
  async createPurchaseOrder(@Req() request: TenantRequest, @Body() body: Parameters<typeof createPurchaseOrder>[2]) {
    return createPurchaseOrder(this.prisma, await this.actor(request, 'purchase:manage'), body);
  }

  @Get('admin/purchase-orders/:purchaseOrderId')
  async purchaseOrder(@Req() request: TenantRequest, @Param('purchaseOrderId') purchaseOrderId: string) {
    return getPurchaseOrder(this.prisma, await this.actor(request, 'purchase:read'), purchaseOrderId);
  }

  @Patch('admin/purchase-orders/:purchaseOrderId')
  async updatePurchaseOrder(@Req() request: TenantRequest, @Param('purchaseOrderId') purchaseOrderId: string,
    @Body() body: Parameters<typeof updateDraftPurchaseOrder>[3]) {
    return updateDraftPurchaseOrder(this.prisma, await this.actor(request, 'purchase:manage'), purchaseOrderId, body);
  }

  @Post('admin/purchase-orders/:purchaseOrderId/submit')
  async submitPurchaseOrder(@Req() request: TenantRequest, @Param('purchaseOrderId') purchaseOrderId: string) {
    return transitionPurchaseOrder(this.prisma, await this.actor(request, 'purchase:manage'), purchaseOrderId, 'SUBMIT');
  }

  @Post('admin/purchase-orders/:purchaseOrderId/cancel')
  async cancelPurchaseOrder(@Req() request: TenantRequest, @Param('purchaseOrderId') purchaseOrderId: string) {
    return transitionPurchaseOrder(this.prisma, await this.actor(request, 'purchase:manage'), purchaseOrderId, 'CANCEL');
  }

  @Post('admin/purchase-orders/:purchaseOrderId/receipts')
  async receive(@Req() request: TenantRequest, @Param('purchaseOrderId') purchaseOrderId: string,
    @Body() body: Parameters<typeof receivePurchaseOrder>[3]) {
    return receivePurchaseOrder(this.prisma, await this.actor(request, 'purchase:manage'), purchaseOrderId, body);
  }

  @Get('admin/receiving-history')
  async receivingHistory(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listReceivingHistory(this.prisma, await this.actor(request, 'purchase:read'), {
      ...(query.purchaseOrderId === undefined ? {} : { purchaseOrderId: query.purchaseOrderId }),
      ...pagination(query),
    });
  }
}
