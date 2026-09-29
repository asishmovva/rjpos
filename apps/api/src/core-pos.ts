import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NestMiddleware,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import {
  adjustInventory,
  checkoutCash,
  checkoutMixed,
  checkoutTerminal,
  closeRegisterSession,
  getInventorySnapshot,
  getActiveRegisterSession,
  getReceipt,
  lookupCatalog,
  openRegisterSession,
  parseMoneyApi,
  postOpeningBalance,
  quoteCheckout,
  recordAudit,
  refundOrder,
  searchInventory,
  searchOrders,
  voidOrder,
  type CheckoutContext,
} from '@rjpos/database';
import type { CartDiscount } from '@rjpos/domain-types';
import { SimulatedTerminalProvider, type TerminalPaymentProvider } from '@rjpos/payment-contracts';
import { applyElevation, contextFromSession } from './elevation-token.js';
import {
  contextFromDevelopmentHeaders,
  TenantContextService,
  type AuthenticatedTenantContext,
  type TenantRequest,
} from './tenant-context.js';

export const PRISMA = Symbol('PRISMA');
export const TERMINAL_PROVIDER = Symbol('TERMINAL_PROVIDER');

@Injectable()
export class DevelopmentAuthMiddleware implements NestMiddleware {
  use(request: TenantRequest, _response: Response, next: NextFunction): void {
    // A PIN-login session identifies the real employee; without one, the development header provider is used.
    const session = request.header('x-rjpos-session');
    const context = session ? contextFromSession(session) : contextFromDevelopmentHeaders(request);
    const elevation = request.header('x-rjpos-elevation');
    request.tenantContext = elevation ? applyElevation(context, elevation) : context;
    next();
  }
}

type DiscountBody = { kind: 'FIXED'; amountMinor: string } | { kind: 'PERCENTAGE'; basisPoints: number };
type CheckoutBody = {
  registerSessionId: string;
  idempotencyKey: string;
  lines: Array<{ variantId: string; quantity: number; discount?: DiscountBody }>;
  orderDiscount?: DiscountBody;
  ageVerified?: boolean;
  tenderedMinor?: string;
  customerId?: string;
  overrideReason?: string;
};

function discountFromBody(discount: DiscountBody | undefined): CartDiscount | undefined {
  if (!discount) return undefined;
  return discount.kind === 'FIXED'
    ? { kind: 'FIXED', amountMinor: parseMoneyApi(discount.amountMinor) }
    : { kind: 'PERCENTAGE', basisPoints: discount.basisPoints };
}

@Controller('/api/v1')
export class CorePosController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TERMINAL_PROVIDER) private readonly terminal: TerminalPaymentProvider,
    @Inject(TenantContextService) private readonly tenants: TenantContextService,
  ) {}

  private context(request: TenantRequest, permission: string): AuthenticatedTenantContext & { storeId: string; registerId: string } {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has(permission)) throw new ForbiddenException();
    if (!context.storeId || !context.registerId) throw new ForbiddenException();
    return context as AuthenticatedTenantContext & { storeId: string; registerId: string };
  }

  @Get('catalog/lookup')
  lookup(@Req() request: TenantRequest, @Query('barcode') barcode?: string, @Query('sku') sku?: string, @Query('search') search?: string) {
    const context = this.context(request, 'catalog:read');
    return lookupCatalog(this.prisma, { organizationId: context.organizationId, storeId: context.storeId,
      ...(barcode ? { barcode } : {}), ...(sku ? { sku } : {}), ...(search ? { search } : {}) });
  }

  @Get('store/current')
  async currentStore(@Req() request: TenantRequest) {
    const context = this.context(request, 'catalog:read');
    const store = await this.prisma.store.findFirst({ where: { id: context.storeId, organizationId: context.organizationId },
      select: { id: true, name: true, addressJson: true, taxRateBasisPoints: true } });
    if (!store) throw new ForbiddenException();
    return store;
  }

  @Get('inventory')
  inventory(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    const context = this.context(request, 'inventory:read');
    // Without paging parameters the legacy full snapshot is returned; the register always pages.
    if (query.page === undefined && query.pageSize === undefined) return getInventorySnapshot(this.prisma, context.organizationId, context.storeId);
    const status = query.status === 'in_stock' || query.status === 'low' || query.status === 'zero' ? query.status : undefined;
    return searchInventory(this.prisma, { organizationId: context.organizationId, storeId: context.storeId, ...(query.search ? { search: query.search } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}), ...(query.size ? { size: query.size } : {}), ...(status ? { status } : {}),
      ...(query.page ? { page: Number(query.page) } : {}), ...(query.pageSize ? { pageSize: Number(query.pageSize) } : {}) });
  }

  @Post('inventory/opening-balance')
  openingBalance(@Req() request: TenantRequest, @Body() body: { variantId: string; quantity: number; reason: string }) {
    const context = this.context(request, 'inventory:adjust');
    return postOpeningBalance(this.prisma, { organizationId: context.organizationId, storeId: context.storeId,
      employeeId: context.userId, variantId: body.variantId, quantity: body.quantity, reason: body.reason });
  }

  @Post('inventory/adjust')
  adjust(@Req() request: TenantRequest, @Body() body: { variantId: string; quantityDelta: number; reason: string }) {
    const context = this.context(request, 'inventory:adjust');
    return adjustInventory(this.prisma, { organizationId: context.organizationId, storeId: context.storeId,
      employeeId: context.userId, variantId: body.variantId, quantity: body.quantityDelta, reason: body.reason });
  }

  @Post('register-sessions/open')
  open(@Req() request: TenantRequest, @Body() body: { openingCashMinor: string; note?: string }) {
    const context = this.context(request, 'register:open');
    return openRegisterSession(this.prisma, { organizationId: context.organizationId, storeId: context.storeId,
      registerId: context.registerId, employeeId: context.userId, openingCashMinor: parseMoneyApi(body.openingCashMinor),
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note } : {}) });
  }

  @Get('register-sessions/current')
  currentRegisterSession(@Req() request: TenantRequest) {
    const context = this.context(request, 'register:open');
    return getActiveRegisterSession(this.prisma, {
      organizationId: context.organizationId,
      storeId: context.storeId,
      registerId: context.registerId,
    });
  }

  @Post('register-sessions/:sessionId/close')
  close(@Req() request: TenantRequest, @Param('sessionId') sessionId: string, @Body() body: { countedCashMinor: string }) {
    const context = this.context(request, 'register:close');
    return closeRegisterSession(this.prisma, { organizationId: context.organizationId, storeId: context.storeId,
      registerId: context.registerId, sessionId, employeeId: context.userId, countedCashMinor: parseMoneyApi(body.countedCashMinor) });
  }

  private checkoutInput(context: AuthenticatedTenantContext & { storeId: string; registerId: string }, body: CheckoutBody): CheckoutContext {
    return { organizationId: context.organizationId, storeId: context.storeId, registerId: context.registerId,
      registerSessionId: body.registerSessionId, employeeId: context.userId, idempotencyKey: body.idempotencyKey,
      lines: body.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity,
        ...(line.discount ? { discount: discountFromBody(line.discount)! } : {}) })),
      ...(body.orderDiscount ? { orderDiscount: discountFromBody(body.orderDiscount)! } : {}),
      ...(body.ageVerified === undefined ? {} : { ageVerified: body.ageVerified }),
      ...(body.customerId ? { customerId: body.customerId } : {}) };
  }

  private requireDiscountAuthorization(context: AuthenticatedTenantContext, body: CheckoutBody): void {
    if (!body.lines.some((line) => line.discount) && !body.orderDiscount) return;
    // Discounts and custom prices need discount:apply (Manager/Owner, or a cashier with a PIN elevation). A reason is optional.
    if (!context.permissions.has('discount:apply') && !context.permissions.has('price:override')) throw new ForbiddenException();
  }

  private async auditOverride(context: AuthenticatedTenantContext & { storeId: string; registerId: string }, body: CheckoutBody, result: { orderId: string }): Promise<void> {
    if (!body.lines.some((line) => line.discount) && !body.orderDiscount) return;
    await recordAudit(this.prisma, { organizationId: context.organizationId, action: 'PRICE_OVERRIDE_APPLIED', entityType: 'Order', entityId: result.orderId, afterJson: { employeeId: context.userId, approvedByEmployeeId: context.approvedByEmployeeId ?? null, storeId: context.storeId, registerId: context.registerId, reason: body.overrideReason?.trim() || null, lineDiscounts: body.lines.filter((line) => line.discount).map((line) => ({ variantId: line.variantId, discount: line.discount })), orderDiscount: body.orderDiscount ?? null } });
  }

  @Post('checkout/quote')
  quote(@Req() request: TenantRequest, @Body() body: { lines: Array<{ variantId: string; quantity: number; discount?: DiscountBody }>; orderDiscount?: DiscountBody }) {
    const context = this.context(request, 'sale:create');
    // Read-only preview: it applies no sale, so manual discounts are calculated here without authorization; checkout enforces it.
    return quoteCheckout(this.prisma, { organizationId: context.organizationId, storeId: context.storeId,
      lines: body.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, ...(line.discount ? { discount: discountFromBody(line.discount)! } : {}) })),
      ...(body.orderDiscount ? { orderDiscount: discountFromBody(body.orderDiscount)! } : {}) });
  }

  @Post('checkout/cash')
  async cash(@Req() request: TenantRequest, @Body() body: CheckoutBody) {
    const context = this.context(request, 'sale:create');
    this.requireDiscountAuthorization(context, body);
    if (body.tenderedMinor === undefined) throw new Error('TENDERED_MINOR_REQUIRED');
    const result = await checkoutCash(this.prisma, { ...this.checkoutInput(context, body), tenderedMinor: parseMoneyApi(body.tenderedMinor) });
    await this.auditOverride(context, body, result);
    return result;
  }

  @Post('checkout/terminal')
  async terminalCheckout(@Req() request: TenantRequest, @Body() body: CheckoutBody & { simulatedOutcome?: string }) {
    const context = this.context(request, 'sale:create');
    this.requireDiscountAuthorization(context, body);
    if (body.simulatedOutcome && this.terminal instanceof SimulatedTerminalProvider) this.terminal.setOutcome(body.simulatedOutcome as Parameters<SimulatedTerminalProvider['setOutcome']>[0]);
    const result = await checkoutTerminal(this.prisma, this.terminal, this.checkoutInput(context, body));
    await this.auditOverride(context, body, result);
    return result;
  }

  @Post('checkout/mixed')
  async mixedCheckout(@Req() request: TenantRequest, @Body() body: CheckoutBody & {
    giftCards?: Array<{ code: string; amountMinor: string }>;
    loyaltyPoints?: number;
    remainder: { kind: 'CASH'; tenderedMinor: string } | { kind: 'TERMINAL'; simulatedOutcome?: string };
  }) {
    const context = this.context(request, 'sale:create');
    this.requireDiscountAuthorization(context, body);
    if ((body.giftCards?.length ?? 0) > 0 && !context.permissions.has('giftcard:redeem')) throw new ForbiddenException();
    if (body.remainder.kind === 'TERMINAL' && body.remainder.simulatedOutcome) {
      if (this.terminal instanceof SimulatedTerminalProvider) this.terminal.setOutcome(body.remainder.simulatedOutcome as Parameters<SimulatedTerminalProvider['setOutcome']>[0]);
    }
    const result = await checkoutMixed(this.prisma, this.terminal, this.checkoutInput(context, body), {
      ...(body.giftCards ? { giftCards: body.giftCards.map((item) => ({ code: item.code, amountMinor: parseMoneyApi(item.amountMinor) })) } : {}),
      ...(body.loyaltyPoints === undefined ? {} : { loyaltyPoints: body.loyaltyPoints }),
      remainder: body.remainder.kind === 'CASH'
        ? { kind: 'CASH', tenderedMinor: parseMoneyApi(body.remainder.tenderedMinor) }
        : { kind: 'TERMINAL' },
    });
    await this.auditOverride(context, body, result);
    return result;
  }

  @Get('orders')
  orders(@Req() request: TenantRequest, @Query('query') query?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const context = this.context(request, 'order:read');
    return searchOrders(this.prisma, { organizationId: context.organizationId, storeId: context.storeId,
      ...(query ? { query } : {}), ...(from ? { from: new Date(from) } : {}), ...(to ? { to: new Date(to) } : {}) });
  }

  @Get('orders/:orderId/receipt')
  receipt(@Req() request: TenantRequest, @Param('orderId') orderId: string) {
    const context = this.context(request, 'order:read');
    return getReceipt(this.prisma, context.organizationId, orderId);
  }

  @Post('orders/:orderId/void')
  void(@Req() request: TenantRequest, @Param('orderId') orderId: string, @Body() body: { reason: string; idempotencyKey: string }) {
    const context = this.context(request, 'order:void');
    return voidOrder(this.prisma, { organizationId: context.organizationId, orderId, employeeId: context.userId,
      reason: body.reason, idempotencyKey: body.idempotencyKey }, this.terminal);
  }

  @Post('orders/:orderId/refund')
  refund(@Req() request: TenantRequest, @Param('orderId') orderId: string,
    @Body() body: { reason: string; idempotencyKey: string; items: Array<{ orderItemId: string; quantity: number; returnToStock?: boolean }> }) {
    const context = this.context(request, 'order:refund');
    return refundOrder(this.prisma, this.terminal, { organizationId: context.organizationId, orderId,
      employeeId: context.userId, reason: body.reason, idempotencyKey: body.idempotencyKey, items: body.items });
  }
}
