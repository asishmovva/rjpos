import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  adjustInventory,
  createCategory,
  createEmployee,
  setEmployeePin,
  createProduct,
  createRegister,
  createStore,
  createVariant,
  getDashboard,
  getOrderAdmin,
  getProduct,
  listAuditRecords,
  listCategories,
  listEmployees,
  listInventoryAdmin,
  listInventoryMovements,
  listOrdersAdmin,
  listPriceHistory,
  listProducts,
  listRefunds,
  listRegisters,
  listStores,
  postOpeningBalance,
  schedulePrice,
  updateCategory,
  updateEmployee,
  updateProduct,
  updateRegister,
  updateStore,
  updateVariant,
  type AdminActor,
  PosError,
} from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

const number = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new PosError('QUERY_NUMBER_INVALID');
  return parsed;
};
const boolean = (value: string | undefined): boolean | undefined => value === undefined ? undefined : value === 'true' ? true : value === 'false' ? false : (() => { throw new PosError('QUERY_BOOLEAN_INVALID'); })();
const date = (value: string | undefined): Date | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new PosError('QUERY_DATE_INVALID');
  return parsed;
};

@Controller('/api/v1/admin')
export class BackOfficeController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TenantContextService) private readonly tenants: TenantContextService,
  ) {}

  private async actor(request: TenantRequest, permission: string): Promise<AdminActor> {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has(permission)) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: { id: context.userId, organizationId: context.organizationId, status: 'ACTIVE',
      ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}) }, select: { id: true } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId, ...(context.storeId ? { storeId: context.storeId } : {}) };
  }

  @Get('dashboard')
  async dashboard(@Req() request: TenantRequest, @Query('storeId') storeId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return getDashboard(this.prisma, await this.actor(request, 'dashboard:read'), { ...(storeId ? { storeId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }

  @Get('categories')
  async categories(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listCategories(this.prisma, await this.actor(request, 'catalog:manage'), { page: number(query.page), pageSize: number(query.pageSize), search: query.search, active: boolean(query.active) });
  }

  @Post('categories')
  async addCategory(@Req() request: TenantRequest, @Body() body: { name: string }) {
    return createCategory(this.prisma, await this.actor(request, 'catalog:manage'), body);
  }

  @Patch('categories/:categoryId')
  async editCategory(@Req() request: TenantRequest, @Param('categoryId') categoryId: string, @Body() body: { name?: string; active?: boolean }) {
    return updateCategory(this.prisma, await this.actor(request, 'catalog:manage'), categoryId, body);
  }

  @Get('products')
  async products(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listProducts(this.prisma, await this.actor(request, 'catalog:manage'), { page: number(query.page), pageSize: number(query.pageSize), search: query.search,
      categoryId: query.categoryId, active: boolean(query.active), sort: query.sort === 'created' ? 'created' : 'name', direction: query.direction === 'desc' ? 'desc' : 'asc' });
  }

  @Post('products')
  async addProduct(@Req() request: TenantRequest, @Body() body: Parameters<typeof createProduct>[2]) {
    return createProduct(this.prisma, await this.actor(request, 'catalog:manage'), body);
  }

  @Get('products/:productId')
  async product(@Req() request: TenantRequest, @Param('productId') productId: string) {
    return getProduct(this.prisma, await this.actor(request, 'catalog:manage'), productId);
  }

  @Patch('products/:productId')
  async editProduct(@Req() request: TenantRequest, @Param('productId') productId: string, @Body() body: Parameters<typeof updateProduct>[3]) {
    return updateProduct(this.prisma, await this.actor(request, 'catalog:manage'), productId, body);
  }

  @Post('products/:productId/variants')
  async addVariant(@Req() request: TenantRequest, @Param('productId') productId: string, @Body() body: Parameters<typeof createVariant>[3]) {
    return createVariant(this.prisma, await this.actor(request, 'catalog:manage'), productId, body);
  }

  @Patch('variants/:variantId')
  async editVariant(@Req() request: TenantRequest, @Param('variantId') variantId: string, @Body() body: Parameters<typeof updateVariant>[3]) {
    return updateVariant(this.prisma, await this.actor(request, 'catalog:manage'), variantId, body);
  }

  @Post('prices')
  async addPrice(@Req() request: TenantRequest, @Body() body: { variantId: string; storeId?: string; amountMinor: string; currency?: string; effectiveFrom: string; effectiveTo?: string }) {
    return schedulePrice(this.prisma, await this.actor(request, 'price:manage'), { ...body, effectiveFrom: new Date(body.effectiveFrom), effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : undefined });
  }

  @Get('variants/:variantId/prices')
  async prices(@Req() request: TenantRequest, @Param('variantId') variantId: string, @Query('storeId') storeId?: string) {
    return listPriceHistory(this.prisma, await this.actor(request, 'price:manage'), variantId, storeId);
  }

  @Get('inventory')
  async inventory(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listInventoryAdmin(this.prisma, await this.actor(request, 'inventory:read'), { page: number(query.page), pageSize: number(query.pageSize), storeId: query.storeId,
      search: query.search, lowStock: boolean(query.lowStock) });
  }

  @Get('inventory/movements')
  async movements(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listInventoryMovements(this.prisma, await this.actor(request, 'inventory:read'), { page: number(query.page), pageSize: number(query.pageSize), storeId: query.storeId,
      productId: query.productId, variantId: query.variantId, type: query.type as Parameters<typeof listInventoryMovements>[2]['type'], employeeId: query.employeeId, from: date(query.from), to: date(query.to) });
  }

  @Post('inventory/opening-balance')
  async openingBalance(@Req() request: TenantRequest, @Body() body: { storeId: string; variantId: string; quantity: number; reason: string }) {
    const actor = await this.actor(request, 'inventory:adjust');
    return postOpeningBalance(this.prisma, { organizationId: actor.organizationId, employeeId: actor.userId, ...body });
  }

  @Post('inventory/adjust')
  async adjust(@Req() request: TenantRequest, @Body() body: { storeId: string; variantId: string; quantityDelta: number; reason: string }) {
    const actor = await this.actor(request, 'inventory:adjust');
    return adjustInventory(this.prisma, { organizationId: actor.organizationId, employeeId: actor.userId, storeId: body.storeId, variantId: body.variantId, quantity: body.quantityDelta, reason: body.reason });
  }

  @Get('employees')
  async employees(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listEmployees(this.prisma, await this.actor(request, 'employee:manage'), { page: number(query.page), pageSize: number(query.pageSize), search: query.search,
      status: query.status as 'ACTIVE' | 'INACTIVE' | undefined });
  }

  @Post('employees')
  async addEmployee(@Req() request: TenantRequest, @Body() body: Parameters<typeof createEmployee>[2]) {
    return createEmployee(this.prisma, await this.actor(request, 'employee:manage'), body, this.tenants.require(request.tenantContext).permissions.has('settings:write'));
  }

  // Set or reset only: the current PIN is stored hashed and can never be read back. Owner/Manager PINs are Owner-managed.
  @Post('employees/:employeeId/pin')
  async resetPin(@Req() request: TenantRequest, @Param('employeeId') employeeId: string, @Body() body: { pin: string }) {
    return setEmployeePin(this.prisma, await this.actor(request, 'employee:manage'), employeeId, body.pin, this.tenants.require(request.tenantContext).permissions.has('settings:write'));
  }

  @Patch('employees/:employeeId')
  async editEmployee(@Req() request: TenantRequest, @Param('employeeId') employeeId: string, @Body() body: Parameters<typeof updateEmployee>[3]) {
    return updateEmployee(this.prisma, await this.actor(request, 'employee:manage'), employeeId, body);
  }

  @Get('stores')
  async stores(@Req() request: TenantRequest) { return listStores(this.prisma, await this.actor(request, 'catalog:manage')); }

  @Post('stores')
  async addStore(@Req() request: TenantRequest, @Body() body: Parameters<typeof createStore>[2]) {
    return createStore(this.prisma, await this.actor(request, 'store:manage'), body);
  }

  @Patch('stores/:storeId')
  async editStore(@Req() request: TenantRequest, @Param('storeId') storeId: string, @Body() body: Parameters<typeof updateStore>[3]) {
    return updateStore(this.prisma, await this.actor(request, 'store:manage'), storeId, body);
  }

  @Get('registers')
  async registers(@Req() request: TenantRequest, @Query('storeId') storeId?: string) {
    return listRegisters(this.prisma, await this.actor(request, 'register:manage'), storeId);
  }

  @Post('registers')
  async addRegister(@Req() request: TenantRequest, @Body() body: Parameters<typeof createRegister>[2]) {
    return createRegister(this.prisma, await this.actor(request, 'register:manage'), body);
  }

  @Patch('registers/:registerId')
  async editRegister(@Req() request: TenantRequest, @Param('registerId') registerId: string, @Body() body: Parameters<typeof updateRegister>[3]) {
    return updateRegister(this.prisma, await this.actor(request, 'register:manage'), registerId, body);
  }

  @Get('orders')
  async orders(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listOrdersAdmin(this.prisma, await this.actor(request, 'order:read'), { page: number(query.page), pageSize: number(query.pageSize), search: query.search,
      storeId: query.storeId, registerId: query.registerId, employeeId: query.employeeId, status: query.status as Parameters<typeof listOrdersAdmin>[2]['status'],
      paymentStatus: query.paymentStatus as Parameters<typeof listOrdersAdmin>[2]['paymentStatus'], paymentKind: query.paymentKind as Parameters<typeof listOrdersAdmin>[2]['paymentKind'], from: date(query.from), to: date(query.to) });
  }

  @Get('orders/:orderId')
  async order(@Req() request: TenantRequest, @Param('orderId') orderId: string) {
    return getOrderAdmin(this.prisma, await this.actor(request, 'order:read'), orderId);
  }

  @Get('refunds')
  async refunds(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listRefunds(this.prisma, await this.actor(request, 'order:read'), { page: number(query.page), pageSize: number(query.pageSize), storeId: query.storeId,
      status: query.status as Parameters<typeof listRefunds>[2]['status'], search: query.search, from: date(query.from), to: date(query.to) });
  }

  @Get('audit')
  async audit(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return listAuditRecords(this.prisma, await this.actor(request, 'audit:read'), { page: number(query.page), pageSize: number(query.pageSize), action: query.action,
      employeeId: query.employeeId, entityType: query.entityType, storeId: query.storeId, from: date(query.from), to: date(query.to) });
  }

  @Get('settings')
  async settings(@Req() request: TenantRequest) { return listStores(this.prisma, await this.actor(request, 'settings:write')); }
}
