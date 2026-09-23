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
