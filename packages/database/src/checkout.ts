import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  calculateCartTotals,
  calculateChangeDue,
  type CartDiscount,
} from '@rjpos/domain-types';
import type {
  TerminalPaymentProvider,
  TerminalPaymentResult,
} from '@rjpos/payment-contracts';
import { PosError, requirePositiveQuantity } from './pos-errors.js';
import { findGiftCardByCode, giftCardBalance, loyaltyBalance } from './phase-three.js';

export type CheckoutLine = {
  variantId: string;
  quantity: number;
  discount?: CartDiscount;
};

export type CheckoutContext = {
  organizationId: string;
  storeId: string;
  registerId: string;
  registerSessionId: string;
  employeeId: string;
  idempotencyKey: string;
  lines: CheckoutLine[];
  orderDiscount?: CartDiscount;
  ageVerified?: boolean;
  customerId?: string;
};

export type MixedTender = {
  giftCards?: Array<{ code: string; amountMinor: bigint }>;
  loyaltyPoints?: number;
  remainder: { kind: 'CASH'; tenderedMinor: bigint } | { kind: 'TERMINAL' };
};

export type CheckoutResult = {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentId: string;
  paymentStatus: string;
  subtotalMinor: string;
  discountMinor: string;
  taxMinor: string;
  totalMinor: string;
  tenderedMinor?: string;
  changeDueMinor?: string;
  attemptId?: string;
  payments?: Array<{ id: string; kind: string; status: string; amountMinor: string; capturedMinor: string }>;
};

type Tx = Prisma.TransactionClient;

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item)).digest('hex');
}

function assertCheckoutInput(input: CheckoutContext): void {
  if (!input.idempotencyKey.trim()) throw new PosError('IDEMPOTENCY_KEY_REQUIRED');
  if (input.lines.length === 0) throw new PosError('CART_EMPTY');
  const seen = new Set<string>();
  for (const line of input.lines) {
    requirePositiveQuantity(line.quantity);
    if (seen.has(line.variantId)) throw new PosError('DUPLICATE_CART_VARIANT');
    seen.add(line.variantId);
  }
}

async function acquireIdempotency(
  tx: Tx,
  input: CheckoutContext,
  scope: string,
  requestFingerprint: string,
): Promise<{ existingOrderId?: string }> {
  const id = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "IdempotencyKey" (id, "organizationId", "operationScope", key,
      "requestFingerprint", status, "expiresAt", "createdAt", "updatedAt")
    VALUES (${id}::uuid, ${input.organizationId}::uuid, ${scope},
      ${input.idempotencyKey}, ${requestFingerprint}, 'PROCESSING',
      NOW() + INTERVAL '24 hours', NOW(), NOW())
    ON CONFLICT ("organizationId", "operationScope", key) DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{
    requestFingerprint: string;
    status: string;
    resultReference: string | null;
  }>>`
    SELECT "requestFingerprint", status, "resultReference"
    FROM "IdempotencyKey"
    WHERE "organizationId" = ${input.organizationId}::uuid
      AND "operationScope" = ${scope}
      AND key = ${input.idempotencyKey}
    FOR UPDATE
  `;
  const record = rows[0];
  if (!record) throw new Error('IDEMPOTENCY_RECORD_MISSING');
  if (record.requestFingerprint !== requestFingerprint) {
    throw new PosError('IDEMPOTENCY_KEY_REUSED', 409);
  }
  if (record.status === 'SUCCEEDED' && record.resultReference) {
    return { existingOrderId: record.resultReference };
  }
  if (record.status === 'PROCESSING' && record.resultReference) {
    throw new PosError('PAYMENT_IN_PROGRESS', 409);
  }
  return {};
}

async function resultForOrder(tx: Tx, organizationId: string, orderId: string): Promise<CheckoutResult> {
  const order = await tx.order.findFirst({
    where: { organizationId, id: orderId },
    include: { payments: { orderBy: { id: 'asc' } } },
  });
  const payment = order?.payments[0];
  if (!order || !payment) throw new Error('IDEMPOTENT_ORDER_MISSING');
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentId: payment.id,
    paymentStatus: payment.status,
    subtotalMinor: order.subtotalMinor.toString(),
    discountMinor: order.discountMinor.toString(),
    taxMinor: order.taxMinor.toString(),
    totalMinor: order.totalMinor.toString(),
    ...(payment.tenderedMinor === null ? {} : { tenderedMinor: payment.tenderedMinor.toString() }),
    ...(payment.changeDueMinor === null ? {} : { changeDueMinor: payment.changeDueMinor.toString() }),
    payments: order.payments.map((item) => ({ id: item.id, kind: item.kind, status: item.status,
      amountMinor: item.amountMinor.toString(), capturedMinor: item.capturedMinor.toString() })),
  };
}

async function prepareOrder(tx: Tx, input: CheckoutContext) {
  await tx.$queryRaw`
    SELECT id FROM "RegisterSession"
    WHERE id = ${input.registerSessionId}::uuid
      AND "organizationId" = ${input.organizationId}::uuid
    FOR UPDATE
  `;
  const [session, employeeStore, store] = await Promise.all([
    tx.registerSession.findFirst({ where: {
      id: input.registerSessionId, organizationId: input.organizationId,
      storeId: input.storeId, registerId: input.registerId,
    }}),
    tx.employeeStore.findUnique({ where: { organizationId_employeeId_storeId: {
      organizationId: input.organizationId, employeeId: input.employeeId, storeId: input.storeId,
    }}, include: { employee: true } }),
    tx.store.findFirst({ where: { id: input.storeId, organizationId: input.organizationId } }),
  ]);
  if (!session || session.status !== 'OPEN') throw new PosError('REGISTER_SESSION_NOT_OPEN', 409);
  if (!employeeStore || employeeStore.employee.status !== 'ACTIVE') throw new PosError('EMPLOYEE_STORE_ACCESS_DENIED', 403);
  if (!store) throw new PosError('STORE_NOT_FOUND', 404);
  if (input.customerId) {
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, organizationId: input.organizationId } });
    if (!customer) throw new PosError('CUSTOMER_NOT_FOUND', 404);
    if (!customer.active) throw new PosError('CUSTOMER_INACTIVE', 409);
  }

  const now = new Date();
  const requestedIds = input.lines.map((line) => line.variantId);
  const variants = await tx.productVariant.findMany({
    where: { organizationId: input.organizationId, id: { in: requestedIds } },
    include: {
      product: true,
      barcodes: { take: 1 },
      prices: {
        where: { effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          AND: [{ OR: [{ storeId: input.storeId }, { storeId: null }] }] },
        orderBy: { effectiveFrom: 'desc' },
      },
    },
  });
  if (variants.length !== requestedIds.length) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const authoritative = input.lines.map((line) => {
    const variant = byId.get(line.variantId);
    if (!variant) throw new PosError('PRODUCT_VARIANT_NOT_FOUND', 404);
    if (!variant.active || !variant.product.active) throw new PosError('PRODUCT_INACTIVE', 409);
    const price = variant.prices.find((candidate) => candidate.storeId === input.storeId)
      ?? variant.prices.find((candidate) => candidate.storeId === null);
    if (!price) throw new PosError('PRICE_NOT_FOUND', 409);
    return { line, variant, price };
  });
  const requiresAgeVerification = authoritative.some(({ variant }) => variant.product.ageRestricted);
  if (requiresAgeVerification && !input.ageVerified) {
    throw new PosError('AGE_VERIFICATION_REQUIRED', 409);
  }
  const totals = calculateCartTotals({
    lines: authoritative.map(({ line, variant, price }) => ({
      variantId: variant.id,
      quantity: line.quantity,
      unitPriceMinor: price.amountMinor,
      taxable: variant.product.taxCategory !== 'EXEMPT',
      ...(line.discount ? { discount: line.discount } : {}),
    })),
    taxRateBasisPoints: store.taxRateBasisPoints,
    ...(input.orderDiscount ? { orderDiscount: input.orderDiscount } : {}),
  });
  const orderId = randomUUID();
  const order = await tx.order.create({ data: {
    id: orderId,
    organizationId: input.organizationId,
    storeId: input.storeId,
    registerId: input.registerId,
    registerSessionId: input.registerSessionId,
    orderNumber: `R-${Date.now().toString(36).toUpperCase()}-${orderId.slice(0, 6).toUpperCase()}`,
    status: 'DRAFT',
    subtotalMinor: totals.subtotalMinor,
    discountMinor: totals.discountMinor,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(requiresAgeVerification && input.ageVerified ? { ageVerifiedAt: now, ageVerifiedByEmployeeId: input.employeeId } : {}),
  }});
  await tx.orderItem.createMany({ data: totals.lines.map((line) => {
      const source = authoritative.find((candidate) => candidate.variant.id === line.variantId)!;
      return {
        organizationId: input.organizationId,
        orderId: order.id,
        variantId: line.variantId,
        productNameSnapshot: source.variant.product.name,
        variantNameSnapshot: source.variant.name,
        skuSnapshot: source.variant.sku,
        barcodeSnapshot: source.variant.barcodes[0]?.barcodeValue ?? null,
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        subtotalMinor: line.subtotalMinor,
        discountMinor: line.discountMinor,
        taxMinor: line.taxMinor,
        totalMinor: line.totalMinor,
        currency: source.price.currency,
        taxCategorySnapshot: source.variant.product.taxCategory,
      };
    }) });

  const tracked = authoritative.filter(({ variant }) => variant.product.inventoryTracked);
  let reservationId: string | undefined;
  if (tracked.length > 0) {
    const ids = tracked.map(({ variant }) => Prisma.sql`${variant.id}::uuid`);
    await tx.$queryRaw`
      SELECT id FROM "InventoryLevel"
      WHERE "organizationId" = ${input.organizationId}::uuid
        AND "storeId" = ${input.storeId}::uuid
        AND "variantId" IN (${Prisma.join(ids)})
      ORDER BY id FOR UPDATE
    `;
    const levels = await tx.inventoryLevel.findMany({ where: {
      organizationId: input.organizationId, storeId: input.storeId,
      variantId: { in: tracked.map(({ variant }) => variant.id) },
    }});
    const levelByVariant = new Map(levels.map((level) => [level.variantId, level]));
    for (const { line, variant } of tracked) {
      const level = levelByVariant.get(variant.id);
      if (!level || level.onHand - level.reserved < line.quantity) throw new PosError('INSUFFICIENT_INVENTORY', 409);
    }
    const reservation = await tx.inventoryReservation.create({ data: {
      organizationId: input.organizationId, storeId: input.storeId, orderId: order.id,
    }});
    await tx.inventoryReservationLine.createMany({ data: tracked.map(({ line, variant }) => ({
      organizationId: input.organizationId, reservationId: reservation.id, storeId: input.storeId,
      variantId: variant.id, quantity: line.quantity,
    })) });
    reservationId = reservation.id;
    for (const { line, variant } of tracked) {
      await tx.inventoryLevel.update({ where: { organizationId_storeId_variantId: {
        organizationId: input.organizationId, storeId: input.storeId, variantId: variant.id,
      }}, data: { reserved: { increment: line.quantity } } });
    }
  }
  return { order, totals, reservationId, requiresAgeVerification };
}

async function convertReservationInTransaction(tx: Tx, organizationId: string, reservationId: string | undefined, employeeId: string): Promise<void> {
  if (!reservationId) return;
  const reservation = await tx.inventoryReservation.findUnique({
    where: { organizationId_id: { organizationId, id: reservationId } }, include: { lines: true },
  });
  if (!reservation || reservation.status !== 'ACTIVE') throw new Error('RESERVATION_NOT_ACTIVE');
  for (const line of reservation.lines) {
    await tx.inventoryLevel.update({ where: { organizationId_storeId_variantId: {
      organizationId, storeId: line.storeId, variantId: line.variantId,
    }}, data: { onHand: { decrement: line.quantity }, reserved: { decrement: line.quantity } } });
    await tx.inventoryMovement.create({ data: {
      organizationId, storeId: line.storeId, variantId: line.variantId,
      quantityDelta: -line.quantity, type: 'SALE', referenceType: 'ORDER',
      referenceId: reservation.orderId, employeeId,
    }});
  }
  await tx.inventoryReservation.update({ where: { id: reservationId }, data: { status: 'CONVERTED', convertedAt: new Date() } });
}

async function releaseReservationInTransaction(tx: Tx, organizationId: string, reservationId: string | undefined): Promise<void> {
  if (!reservationId) return;
  const reservation = await tx.inventoryReservation.findUnique({ where: { organizationId_id: { organizationId, id: reservationId } }, include: { lines: true } });
  if (!reservation || reservation.status !== 'ACTIVE') return;
  for (const line of reservation.lines) {
    await tx.inventoryLevel.update({ where: { organizationId_storeId_variantId: {
      organizationId, storeId: line.storeId, variantId: line.variantId,
    }}, data: { reserved: { decrement: line.quantity } } });
  }
  await tx.inventoryReservation.update({ where: { id: reservationId }, data: { status: 'RELEASED', releasedAt: new Date() } });
}

async function completeIdempotency(tx: Tx, input: CheckoutContext, scope: string, orderId: string, body: CheckoutResult): Promise<void> {
  await tx.idempotencyKey.update({ where: { organizationId_operationScope_key: {
    organizationId: input.organizationId, operationScope: scope, key: input.idempotencyKey,
  }}, data: { status: 'SUCCEEDED', responseStatus: 200, responseBody: body, resultReference: orderId } });
}

async function recordSaleEvents(tx: Tx, input: CheckoutContext, orderId: string, evidence: { discountApplied: boolean; ageVerified: boolean }): Promise<void> {
  const writes: Array<Prisma.PrismaPromise<unknown>> = [
    tx.auditRecord.create({ data: { organizationId: input.organizationId, storeId: input.storeId,
      registerId: input.registerId, userId: input.employeeId, action: 'SALE_COMPLETED', entityType: 'Order', entityId: orderId } }),
    tx.outboxEvent.create({ data: { organizationId: input.organizationId, aggregateType: 'Order', aggregateId: orderId,
      eventType: 'SALE_COMPLETED', payload: { orderId, storeId: input.storeId } } }),
  ];
  if (evidence.discountApplied) writes.push(tx.auditRecord.create({ data: {
    organizationId: input.organizationId, storeId: input.storeId, registerId: input.registerId,
    userId: input.employeeId, action: 'DISCOUNT_APPLIED', entityType: 'Order', entityId: orderId,
  }}));
  if (evidence.ageVerified) writes.push(tx.auditRecord.create({ data: {
    organizationId: input.organizationId, storeId: input.storeId, registerId: input.registerId,
    userId: input.employeeId, action: 'AGE_VERIFIED', entityType: 'Order', entityId: orderId,
  }}));
  await Promise.all(writes);
}

async function awardLoyalty(tx: Tx, input: CheckoutContext, orderId: string, eligibleMinor: bigint): Promise<void> {
  if (!input.customerId) return;
  const [customer, program] = await Promise.all([
    tx.customer.findFirst({ where: { id: input.customerId, organizationId: input.organizationId } }),
    tx.loyaltyProgram.findUnique({ where: { organizationId: input.organizationId } }),
  ]);
  if (!customer?.active || !program?.enabled) return;
  const points = Number(eligibleMinor / program.spendMinor) * program.pointsEarned;
  if (points <= 0) return;
  await tx.loyaltyTransaction.create({ data: { organizationId: input.organizationId, customerId: customer.id,
    orderId, type: 'EARN', points, referenceKey: `order:${orderId}:earn` } });
}

export async function checkoutCash(prisma: PrismaClient, input: CheckoutContext & { tenderedMinor: bigint }): Promise<CheckoutResult> {
  assertCheckoutInput(input);
  const scope = 'CHECKOUT_CASH';
  const requestFingerprint = fingerprint(input);
  return prisma.$transaction(async (tx) => {
    const acquired = await acquireIdempotency(tx, input, scope, requestFingerprint);
    if (acquired.existingOrderId) return resultForOrder(tx, input.organizationId, acquired.existingOrderId);
    const prepared = await prepareOrder(tx, input);
    const change = calculateChangeDue(prepared.totals.totalMinor, input.tenderedMinor);
    const payment = await tx.payment.create({ data: {
      organizationId: input.organizationId, orderId: prepared.order.id, kind: 'CASH', status: 'CAPTURED',
      amountMinor: prepared.totals.totalMinor, capturedMinor: prepared.totals.totalMinor,
      tenderedMinor: input.tenderedMinor, changeDueMinor: change,
    }});
    await convertReservationInTransaction(tx, input.organizationId, prepared.reservationId, input.employeeId);
    await tx.order.update({ where: { id: prepared.order.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    await awardLoyalty(tx, input, prepared.order.id, prepared.totals.totalMinor);
    await recordSaleEvents(tx, input, prepared.order.id, {
      discountApplied: prepared.totals.discountMinor > 0n,
      ageVerified: prepared.requiresAgeVerification,
    });
    const result: CheckoutResult = {
      orderId: prepared.order.id, orderNumber: prepared.order.orderNumber, status: 'COMPLETED',
      paymentId: payment.id, paymentStatus: 'CAPTURED', subtotalMinor: prepared.totals.subtotalMinor.toString(),
      discountMinor: prepared.totals.discountMinor.toString(), taxMinor: prepared.totals.taxMinor.toString(),
      totalMinor: prepared.totals.totalMinor.toString(), tenderedMinor: input.tenderedMinor.toString(), changeDueMinor: change.toString(),
    };
    await completeIdempotency(tx, input, scope, prepared.order.id, result);
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function checkoutTerminal(
  prisma: PrismaClient,
  provider: TerminalPaymentProvider,
  input: CheckoutContext,
): Promise<CheckoutResult> {
  assertCheckoutInput(input);
  const scope = 'CHECKOUT_TERMINAL';
  const requestFingerprint = fingerprint(input);
  const prepared = await prisma.$transaction(async (tx) => {
    const acquired = await acquireIdempotency(tx, input, scope, requestFingerprint);
    if (acquired.existingOrderId) return { existing: await resultForOrder(tx, input.organizationId, acquired.existingOrderId) };
    const orderData = await prepareOrder(tx, input);
    const payment = await tx.payment.create({ data: { organizationId: input.organizationId, orderId: orderData.order.id,
      kind: 'TERMINAL', status: 'PROCESSING', amountMinor: orderData.totals.totalMinor } });
    const attempt = await tx.paymentAttempt.create({ data: { organizationId: input.organizationId, paymentId: payment.id,
      status: 'PROCESSING', idempotencyKey: input.idempotencyKey, requestedMinor: orderData.totals.totalMinor } });
    await tx.order.update({ where: { id: orderData.order.id }, data: { status: 'PENDING_PAYMENT' } });
    await tx.idempotencyKey.update({ where: { organizationId_operationScope_key: {
      organizationId: input.organizationId, operationScope: scope, key: input.idempotencyKey,
    }}, data: { resultReference: orderData.order.id } });
    return { orderData, payment, attempt };
  });
  if ('existing' in prepared) return prepared.existing;

  let providerResult: TerminalPaymentResult;
  try {
    providerResult = await provider.authorize({ attemptId: prepared.attempt.id,
      amountMinor: prepared.orderData.totals.totalMinor.toString(), currency: 'USD', idempotencyKey: input.idempotencyKey });
  } catch {
    providerResult = { status: 'UNKNOWN', failureCode: 'PROVIDER_EXCEPTION' };
  }
  return finalizeTerminalAttempt(prisma, input, prepared.attempt.id, providerResult);
}

export async function finalizeTerminalAttempt(
  prisma: PrismaClient,
  input: CheckoutContext,
  attemptId: string,
  providerResult: TerminalPaymentResult,
): Promise<CheckoutResult> {
  const scope = 'CHECKOUT_TERMINAL';
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PaymentAttempt" WHERE id = ${attemptId}::uuid AND "organizationId" = ${input.organizationId}::uuid FOR UPDATE`;
    const attempt = await tx.paymentAttempt.findFirst({ where: { id: attemptId, organizationId: input.organizationId },
      include: { payment: { include: { order: { include: { reservations: true } } } } } });
    if (!attempt) throw new PosError('PAYMENT_ATTEMPT_NOT_FOUND', 404);
    if (['SUCCEEDED', 'DECLINED', 'CANCELLED'].includes(attempt.status)) {
      return resultForOrder(tx, input.organizationId, attempt.payment.orderId);
    }
    const order = attempt.payment.order;
    const reservationId = order.reservations[0]?.id;
    if (providerResult.status === 'SUCCEEDED') {
      await convertReservationInTransaction(tx, input.organizationId, reservationId, input.employeeId);
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED',
        ...(providerResult.providerTransactionId ? { providerTransactionId: providerResult.providerTransactionId } : {}),
        providerResultJson: providerResult as Prisma.InputJsonValue,
        failureCode: null, nextReconciliationAt: null } });
      await tx.payment.update({ where: { id: attempt.paymentId }, data: { status: 'CAPTURED', capturedMinor: attempt.requestedMinor } });
      await tx.order.update({ where: { id: order.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await awardLoyalty(tx, input, order.id, order.totalMinor);
      await recordSaleEvents(tx, input, order.id, {
        discountApplied: order.discountMinor > 0n,
        ageVerified: order.ageVerifiedAt !== null,
      });
    } else if (providerResult.status === 'DECLINED' || providerResult.status === 'CANCELLED' || providerResult.status === 'FAILED') {
      await releaseReservationInTransaction(tx, input.organizationId, reservationId);
      const terminalStatus = providerResult.status === 'DECLINED' ? 'DECLINED' : 'CANCELLED';
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: terminalStatus,
        providerResultJson: providerResult as Prisma.InputJsonValue,
        ...(providerResult.failureCode ? { failureCode: providerResult.failureCode } : {}) } });
      await tx.payment.update({ where: { id: attempt.paymentId }, data: { status: terminalStatus } });
      await tx.order.update({ where: { id: order.id }, data: { status: 'VOIDED', voidedAt: new Date() } });
    } else {
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN',
        ...(providerResult.providerTransactionId ? { providerTransactionId: providerResult.providerTransactionId } : {}),
        providerResultJson: providerResult as Prisma.InputJsonValue,
        ...(providerResult.failureCode ? { failureCode: providerResult.failureCode } : {}),
        nextReconciliationAt: new Date(Date.now() + 60_000) } });
      await tx.payment.update({ where: { id: attempt.paymentId }, data: { status: 'UNKNOWN' } });
    }
    const result = await resultForOrder(tx, input.organizationId, order.id);
    const enriched = { ...result, attemptId: attempt.id };
    if (providerResult.status !== 'UNKNOWN') await completeIdempotency(tx, input, scope, order.id, enriched);
    return enriched;
  });
}

async function prepareMixedBenefits(
  tx: Tx,
  input: CheckoutContext,
  orderId: string,
  totalMinor: bigint,
  tender: MixedTender,
  pending: boolean,
): Promise<{ allocatedMinor: bigint; loyaltyMinor: bigint }> {
  const giftCards = tender.giftCards ?? [];
  if (new Set(giftCards.map((item) => item.code.trim().toUpperCase())).size !== giftCards.length) {
    throw new PosError('GIFT_CARD_DUPLICATE');
  }
  let allocatedMinor = 0n;
  let loyaltyMinor = 0n;
  const status = pending ? 'PENDING' : 'POSTED';

  if (tender.loyaltyPoints !== undefined && tender.loyaltyPoints > 0) {
    if (!input.customerId) throw new PosError('LOYALTY_CUSTOMER_REQUIRED');
    if (!Number.isInteger(tender.loyaltyPoints)) throw new PosError('LOYALTY_POINTS_INVALID');
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${input.customerId}::uuid AND "organizationId" = ${input.organizationId}::uuid FOR UPDATE`;
    const [customer, program] = await Promise.all([
      tx.customer.findFirst({ where: { id: input.customerId, organizationId: input.organizationId } }),
      tx.loyaltyProgram.findUnique({ where: { organizationId: input.organizationId } }),
    ]);
    if (!customer?.active) throw new PosError('CUSTOMER_INACTIVE', 409);
    if (!program?.enabled) throw new PosError('LOYALTY_DISABLED', 409);
    if (await loyaltyBalance(tx, input.organizationId, customer.id, true) < tender.loyaltyPoints) throw new PosError('LOYALTY_POINTS_INSUFFICIENT', 409);
    loyaltyMinor = BigInt(tender.loyaltyPoints) * program.redeemMinorPerPoint;
    if (loyaltyMinor > totalMinor) throw new PosError('LOYALTY_REDEMPTION_EXCEEDS_TOTAL', 409);
    await tx.loyaltyTransaction.create({ data: { organizationId: input.organizationId, customerId: customer.id,
      orderId, type: 'REDEEM', status, points: -tender.loyaltyPoints, referenceKey: `order:${orderId}:redeem` } });
    await tx.payment.create({ data: { organizationId: input.organizationId, orderId, kind: 'LOYALTY', status: pending ? 'PROCESSING' : 'CAPTURED',
      amountMinor: loyaltyMinor, capturedMinor: pending ? 0n : loyaltyMinor } });
    allocatedMinor += loyaltyMinor;
  } else if (tender.loyaltyPoints !== undefined && tender.loyaltyPoints !== 0) {
    throw new PosError('LOYALTY_POINTS_INVALID');
  }

  const orderedCards = [...giftCards].sort((left, right) => left.code.localeCompare(right.code));
  for (let index = 0; index < orderedCards.length; index += 1) {
    const requested = orderedCards[index]!;
    if (requested.amountMinor <= 0n) throw new PosError('GIFT_CARD_AMOUNT_INVALID');
    const located = await findGiftCardByCode(tx, input.organizationId, requested.code);
    await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${located.id}::uuid AND "organizationId" = ${input.organizationId}::uuid FOR UPDATE`;
    const card = await tx.giftCard.findFirst({ where: { id: located.id, organizationId: input.organizationId } });
    if (!card) throw new PosError('GIFT_CARD_NOT_FOUND', 404);
    if (card.status !== 'ACTIVE') throw new PosError('GIFT_CARD_DISABLED', 409);
    if (await giftCardBalance(tx, input.organizationId, card.id, true) < requested.amountMinor) throw new PosError('GIFT_CARD_FUNDS_INSUFFICIENT', 409);
    if (allocatedMinor + requested.amountMinor > totalMinor) throw new PosError('TENDER_EXCEEDS_TOTAL', 409);
    await tx.giftCardTransaction.create({ data: { organizationId: input.organizationId, giftCardId: card.id,
      orderId, employeeId: input.employeeId, type: 'REDEEM', status, amountMinor: -requested.amountMinor,
      referenceKey: `order:${orderId}:gift:${index}` } });
    await tx.payment.create({ data: { organizationId: input.organizationId, orderId, kind: 'GIFT_CARD', status: pending ? 'PROCESSING' : 'CAPTURED',
      amountMinor: requested.amountMinor, capturedMinor: pending ? 0n : requested.amountMinor } });
    allocatedMinor += requested.amountMinor;
  }
  return { allocatedMinor, loyaltyMinor };
}

export async function checkoutMixed(
  prisma: PrismaClient,
  provider: TerminalPaymentProvider,
  input: CheckoutContext,
  tender: MixedTender,
): Promise<CheckoutResult> {
  assertCheckoutInput(input);
  const terminal = tender.remainder.kind === 'TERMINAL';
  const scope = terminal ? 'CHECKOUT_MIXED_TERMINAL' : 'CHECKOUT_MIXED_CASH';
  const requestFingerprint = fingerprint({ input, tender });
  const prepared = await prisma.$transaction(async (tx) => {
    const acquired = await acquireIdempotency(tx, input, scope, requestFingerprint);
    if (acquired.existingOrderId) return { existing: await resultForOrder(tx, input.organizationId, acquired.existingOrderId) };
    const orderData = await prepareOrder(tx, input);
    const benefits = await prepareMixedBenefits(tx, input, orderData.order.id, orderData.totals.totalMinor, tender, terminal);
    const remainingMinor = orderData.totals.totalMinor - benefits.allocatedMinor;
    if (remainingMinor < 0n) throw new PosError('TENDER_EXCEEDS_TOTAL', 409);

    if (tender.remainder.kind === 'CASH') {
      const tenderedMinor = tender.remainder.tenderedMinor;
      const change = calculateChangeDue(remainingMinor, tenderedMinor);
      const payment = await tx.payment.create({ data: { organizationId: input.organizationId, orderId: orderData.order.id,
        kind: 'CASH', status: 'CAPTURED', amountMinor: remainingMinor, capturedMinor: remainingMinor, tenderedMinor, changeDueMinor: change } });
      await convertReservationInTransaction(tx, input.organizationId, orderData.reservationId, input.employeeId);
      await tx.order.update({ where: { id: orderData.order.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await awardLoyalty(tx, input, orderData.order.id, orderData.totals.totalMinor - benefits.loyaltyMinor);
      await recordSaleEvents(tx, input, orderData.order.id, { discountApplied: orderData.totals.discountMinor > 0n, ageVerified: orderData.requiresAgeVerification });
      const result = await resultForOrder(tx, input.organizationId, orderData.order.id);
      const enriched = { ...result, paymentId: payment.id, paymentStatus: payment.status, tenderedMinor: tenderedMinor.toString(), changeDueMinor: change.toString() };
      await completeIdempotency(tx, input, scope, orderData.order.id, enriched);
      return { existing: enriched };
    }

    if (remainingMinor <= 0n) throw new PosError('TERMINAL_AMOUNT_REQUIRED');
    const payment = await tx.payment.create({ data: { organizationId: input.organizationId, orderId: orderData.order.id,
      kind: 'TERMINAL', status: 'PROCESSING', amountMinor: remainingMinor } });
    const attempt = await tx.paymentAttempt.create({ data: { organizationId: input.organizationId, paymentId: payment.id,
      status: 'PROCESSING', idempotencyKey: input.idempotencyKey, requestedMinor: remainingMinor } });
    await tx.order.update({ where: { id: orderData.order.id }, data: { status: 'PENDING_PAYMENT' } });
    await tx.idempotencyKey.update({ where: { organizationId_operationScope_key: { organizationId: input.organizationId,
      operationScope: scope, key: input.idempotencyKey } }, data: { resultReference: orderData.order.id } });
    return { orderData, benefits, payment, attempt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if ('existing' in prepared) return prepared.existing;

  let providerResult: TerminalPaymentResult;
  try {
    providerResult = await provider.authorize({ attemptId: prepared.attempt.id, amountMinor: prepared.attempt.requestedMinor.toString(),
      currency: 'USD', idempotencyKey: input.idempotencyKey });
  } catch {
    providerResult = { status: 'UNKNOWN', failureCode: 'PROVIDER_EXCEPTION' };
  }
  return finalizeMixedTerminal(prisma, input, prepared.attempt.id, providerResult, prepared.benefits.loyaltyMinor);
}

async function finalizeMixedTerminal(
  prisma: PrismaClient,
  input: CheckoutContext,
  attemptId: string,
  providerResult: TerminalPaymentResult,
  loyaltyMinor: bigint,
): Promise<CheckoutResult> {
  const scope = 'CHECKOUT_MIXED_TERMINAL';
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PaymentAttempt" WHERE id = ${attemptId}::uuid AND "organizationId" = ${input.organizationId}::uuid FOR UPDATE`;
    const attempt = await tx.paymentAttempt.findFirst({ where: { id: attemptId, organizationId: input.organizationId },
      include: { payment: { include: { order: { include: { reservations: true } } } } } });
    if (!attempt) throw new PosError('PAYMENT_ATTEMPT_NOT_FOUND', 404);
    if (['SUCCEEDED', 'DECLINED', 'CANCELLED'].includes(attempt.status)) return resultForOrder(tx, input.organizationId, attempt.payment.orderId);
    const order = attempt.payment.order;
    const reservationId = order.reservations[0]?.id;
    if (providerResult.status === 'SUCCEEDED') {
      await convertReservationInTransaction(tx, input.organizationId, reservationId, input.employeeId);
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED',
        ...(providerResult.providerTransactionId ? { providerTransactionId: providerResult.providerTransactionId } : {}), providerResultJson: providerResult as Prisma.InputJsonValue } });
      await tx.payment.updateMany({ where: { organizationId: input.organizationId, orderId: order.id, status: 'PROCESSING' }, data: { status: 'CAPTURED' } });
      await tx.payment.update({ where: { id: attempt.paymentId }, data: { capturedMinor: attempt.requestedMinor } });
      const benefitPayments = await tx.payment.findMany({ where: { organizationId: input.organizationId, orderId: order.id, kind: { in: ['GIFT_CARD', 'LOYALTY'] } } });
      for (const payment of benefitPayments) await tx.payment.update({ where: { id: payment.id }, data: { capturedMinor: payment.amountMinor } });
      await tx.giftCardTransaction.updateMany({ where: { organizationId: input.organizationId, orderId: order.id, status: 'PENDING' }, data: { status: 'POSTED' } });
      await tx.loyaltyTransaction.updateMany({ where: { organizationId: input.organizationId, orderId: order.id, status: 'PENDING' }, data: { status: 'POSTED' } });
      await tx.order.update({ where: { id: order.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await awardLoyalty(tx, input, order.id, order.totalMinor - loyaltyMinor);
      await recordSaleEvents(tx, input, order.id, { discountApplied: order.discountMinor > 0n, ageVerified: order.ageVerifiedAt !== null });
    } else if (providerResult.status === 'DECLINED' || providerResult.status === 'CANCELLED' || providerResult.status === 'FAILED') {
      await releaseReservationInTransaction(tx, input.organizationId, reservationId);
      const paymentStatus = providerResult.status === 'DECLINED' ? 'DECLINED' : 'CANCELLED';
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: paymentStatus,
        providerResultJson: providerResult as Prisma.InputJsonValue, ...(providerResult.failureCode ? { failureCode: providerResult.failureCode } : {}) } });
      await tx.payment.updateMany({ where: { organizationId: input.organizationId, orderId: order.id, status: 'PROCESSING' }, data: { status: paymentStatus } });
      await tx.giftCardTransaction.updateMany({ where: { organizationId: input.organizationId, orderId: order.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      await tx.loyaltyTransaction.updateMany({ where: { organizationId: input.organizationId, orderId: order.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      await tx.order.update({ where: { id: order.id }, data: { status: 'VOIDED', voidedAt: new Date() } });
    } else {
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN', providerResultJson: providerResult as Prisma.InputJsonValue,
        ...(providerResult.failureCode ? { failureCode: providerResult.failureCode } : {}), nextReconciliationAt: new Date(Date.now() + 60_000) } });
      await tx.payment.update({ where: { id: attempt.paymentId }, data: { status: 'UNKNOWN' } });
    }
    const result = { ...(await resultForOrder(tx, input.organizationId, order.id)), attemptId: attempt.id };
    if (providerResult.status !== 'UNKNOWN') await completeIdempotency(tx, input, scope, order.id, result);
    return result;
  });
}
