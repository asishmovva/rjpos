import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TerminalPaymentProvider } from '@rjpos/payment-contracts';
import { PosError, requirePositiveQuantity } from './pos-errors.js';

type Tx = Prisma.TransactionClient;

function serializeMoney<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)) as T;
}

export async function getReceipt(prisma: PrismaClient, organizationId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId },
    include: {
      store: { select: { name: true, addressJson: true } },
      register: { select: { name: true, code: true } },
      session: { include: { employee: { select: { id: true, firstName: true, lastName: true } } } },
      items: { orderBy: { id: 'asc' } },
      payments: { include: { attempts: { orderBy: { createdAt: 'asc' } } } },
      refunds: { include: { items: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!order) throw new PosError('ORDER_NOT_FOUND', 404);
  return serializeMoney(order);
}

export async function searchOrders(prisma: PrismaClient, input: {
  organizationId: string;
  storeId?: string;
  query?: string;
  from?: Date;
  to?: Date;
  take?: number;
}) {
  const query = input.query?.trim();
  const orders = await prisma.order.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.storeId ? { storeId: input.storeId } : {}),
      ...(input.from || input.to ? { createdAt: {
        ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}),
      }} : {}),
      ...(query ? { OR: [
        { orderNumber: { contains: query, mode: 'insensitive' } },
        { items: { some: { OR: [
          { productNameSnapshot: { contains: query, mode: 'insensitive' } },
          { skuSnapshot: { contains: query, mode: 'insensitive' } },
          { barcodeSnapshot: { contains: query, mode: 'insensitive' } },
        ] } } },
      ] } : {}),
    },
    include: {
      items: true,
      payments: true,
      refunds: true,
      store: { select: { id: true, name: true } },
      register: { select: { id: true, name: true, code: true } },
      session: { include: { employee: { select: { id: true, firstName: true, lastName: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(input.take ?? 25, 1), 100),
  });
  return serializeMoney(orders);
}

function actionFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function acquireActionKey(tx: Tx, input: {
  organizationId: string;
  scope: string;
  key: string;
  fingerprint: string;
}): Promise<string | undefined> {
  await tx.$executeRaw`
    INSERT INTO "IdempotencyKey" (id, "organizationId", "operationScope", key,
      "requestFingerprint", status, "expiresAt", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${input.organizationId}::uuid, ${input.scope}, ${input.key},
      ${input.fingerprint}, 'PROCESSING', NOW() + INTERVAL '24 hours', NOW(), NOW())
    ON CONFLICT ("organizationId", "operationScope", key) DO NOTHING
  `;
  const [record] = await tx.$queryRaw<Array<{ requestFingerprint: string; status: string; resultReference: string | null }>>`
    SELECT "requestFingerprint", status, "resultReference" FROM "IdempotencyKey"
    WHERE "organizationId" = ${input.organizationId}::uuid AND "operationScope" = ${input.scope} AND key = ${input.key}
    FOR UPDATE
  `;
  if (!record) throw new Error('IDEMPOTENCY_RECORD_MISSING');
  if (record.requestFingerprint !== input.fingerprint) throw new PosError('IDEMPOTENCY_KEY_REUSED', 409);
  if (record.resultReference) return record.resultReference;
  return undefined;
}

async function restoreInventory(tx: Tx, input: {
  organizationId: string;
  storeId: string;
  employeeId: string;
  referenceId: string;
  movementType: 'VOID_REVERSAL' | 'SALE_RETURN';
  lines: Array<{ variantId: string; quantity: number }>;
}): Promise<void> {
  for (const line of input.lines) {
    const variant = await tx.productVariant.findFirst({ where: { id: line.variantId, organizationId: input.organizationId }, include: { product: true } });
    if (!variant?.product.inventoryTracked) continue;
    // Pack variants return stock to their base variant: quantity × unitsPerPack base units.
    const stockVariantId = variant.baseVariantId ?? variant.id;
    const stockQuantity = line.quantity * (variant.baseVariantId ? variant.unitsPerPack : 1);
    await tx.$queryRaw`SELECT id FROM "InventoryLevel" WHERE "organizationId" = ${input.organizationId}::uuid AND "storeId" = ${input.storeId}::uuid AND "variantId" = ${stockVariantId}::uuid FOR UPDATE`;
    await tx.inventoryLevel.update({ where: { organizationId_storeId_variantId: {
      organizationId: input.organizationId, storeId: input.storeId, variantId: stockVariantId,
    }}, data: { onHand: { increment: stockQuantity } } });
    await tx.inventoryMovement.create({ data: { organizationId: input.organizationId, storeId: input.storeId,
      variantId: stockVariantId, quantityDelta: stockQuantity, type: input.movementType,
      referenceType: input.movementType === 'VOID_REVERSAL' ? 'ORDER' : 'REFUND',
      referenceId: input.referenceId, employeeId: input.employeeId } });
  }
}

async function compensateCustomerValue(tx: Tx, input: {
  organizationId: string;
  orderId: string;
  employeeId: string;
  referencePrefix: string;
  refundId?: string;
  numerator?: bigint;
  denominator?: bigint;
  settleFully?: boolean;
}) {
  const ratio = (absolute: bigint): bigint => {
    if (input.numerator === undefined || input.denominator === undefined) return absolute;
    return input.denominator === 0n ? 0n : (absolute * input.numerator) / input.denominator;
  };
  const loyaltyEntries = await tx.loyaltyTransaction.findMany({ where: { organizationId: input.organizationId,
    orderId: input.orderId, status: 'POSTED', type: { in: ['EARN', 'REDEEM'] } } });
  for (const entry of loyaltyEntries) {
    let signedPoints = entry.points > 0
      ? -Number(ratio(BigInt(entry.points)))
      : Number(ratio(BigInt(-entry.points)));
    if (input.settleFully) {
      const prior = await tx.loyaltyTransaction.aggregate({ where: {
        organizationId: input.organizationId, orderId: input.orderId, type: 'REVERSAL', status: 'POSTED',
        referenceKey: { endsWith: `:loyalty:${entry.id}` },
      }, _sum: { points: true } });
      signedPoints = -entry.points - (prior._sum.points ?? 0);
    }
    if (signedPoints === 0) continue;
    await tx.loyaltyTransaction.create({ data: { organizationId: input.organizationId, customerId: entry.customerId,
      orderId: input.orderId, ...(input.refundId ? { refundId: input.refundId } : {}), employeeId: input.employeeId,
      type: 'REVERSAL', points: signedPoints,
      reason: input.refundId ? 'Refund compensation' : 'Void compensation', referenceKey: `${input.referencePrefix}:loyalty:${entry.id}` } });
  }
  const giftEntries = await tx.giftCardTransaction.findMany({ where: { organizationId: input.organizationId,
    orderId: input.orderId, status: 'POSTED', type: 'REDEEM' } });
  for (const entry of giftEntries) {
    let amountMinor = ratio(entry.amountMinor < 0n ? -entry.amountMinor : entry.amountMinor);
    if (input.settleFully) {
      const prior = await tx.giftCardTransaction.aggregate({ where: {
        organizationId: input.organizationId, orderId: input.orderId, status: 'POSTED',
        type: { in: ['REFUND', 'REVERSAL'] }, referenceKey: { endsWith: `:gift:${entry.id}` },
      }, _sum: { amountMinor: true } });
      amountMinor = -entry.amountMinor - (prior._sum.amountMinor ?? 0n);
    }
    if (amountMinor === 0n) continue;
    await tx.giftCardTransaction.create({ data: { organizationId: input.organizationId, giftCardId: entry.giftCardId,
      orderId: input.orderId, ...(input.refundId ? { refundId: input.refundId } : {}), employeeId: input.employeeId,
      type: input.refundId ? 'REFUND' : 'REVERSAL', amountMinor,
      reason: input.refundId ? 'Refund compensation' : 'Void compensation', referenceKey: `${input.referencePrefix}:gift:${entry.id}` } });
  }
}

export async function voidOrder(prisma: PrismaClient, input: {
  organizationId: string;
  orderId: string;
  employeeId: string;
  reason: string;
  idempotencyKey: string;
}, provider?: TerminalPaymentProvider): Promise<{ orderId: string; status: 'VOIDED' }> {
  if (!input.reason.trim()) throw new PosError('VOID_REASON_REQUIRED');
  if (!input.idempotencyKey.trim()) throw new PosError('IDEMPOTENCY_KEY_REQUIRED');
  const scope = 'VOID_ORDER';
  const fingerprint = actionFingerprint(input);
  const terminalPayment = await prisma.payment.findFirst({ where: { organizationId: input.organizationId,
    orderId: input.orderId, kind: 'TERMINAL', status: 'CAPTURED' }, include: { attempts: true } });
  if (terminalPayment) {
    if (!provider) throw new PosError('TERMINAL_PROVIDER_REQUIRED', 409);
    const attempt = terminalPayment.attempts.find((candidate) => candidate.status === 'SUCCEEDED');
    if (!attempt) throw new PosError('PAYMENT_ATTEMPT_NOT_FOUND', 409);
    const result = await provider.cancel(attempt.id, input.idempotencyKey);
    if (result.status !== 'CANCELLED' && result.status !== 'SUCCEEDED') throw new PosError('PAYMENT_VOID_FAILED', 409);
  }
  return prisma.$transaction(async (tx) => {
    const existing = await acquireActionKey(tx, { organizationId: input.organizationId, scope, key: input.idempotencyKey, fingerprint });
    if (existing) return { orderId: existing, status: 'VOIDED' };
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId}::uuid AND "organizationId" = ${input.organizationId}::uuid FOR UPDATE`;
    const order = await tx.order.findFirst({ where: { id: input.orderId, organizationId: input.organizationId }, include: { items: true, payments: true, refunds: true } });
    if (!order) throw new PosError('ORDER_NOT_FOUND', 404);
    if (order.status === 'VOIDED') throw new PosError('ORDER_ALREADY_VOIDED', 409);
    if (order.status !== 'COMPLETED') throw new PosError('ORDER_NOT_VOIDABLE', 409);
    if (order.refunds.some((refund) => refund.status === 'SUCCEEDED')) throw new PosError('REFUNDED_ORDER_NOT_VOIDABLE', 409);
    await restoreInventory(tx, { organizationId: input.organizationId, storeId: order.storeId,
      employeeId: input.employeeId, referenceId: order.id, movementType: 'VOID_REVERSAL',
      lines: order.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })) });
    await tx.payment.updateMany({ where: { organizationId: input.organizationId, orderId: order.id,
      status: { in: ['CAPTURED', 'AUTHORIZED'] } }, data: { status: 'CANCELLED', capturedMinor: 0n } });
    await compensateCustomerValue(tx, { organizationId: input.organizationId, orderId: order.id,
      employeeId: input.employeeId, referencePrefix: `void:${order.id}` });
    await tx.order.update({ where: { id: order.id }, data: { status: 'VOIDED', voidedAt: new Date() } });
    await Promise.all([
      tx.auditRecord.create({ data: { organizationId: input.organizationId, storeId: order.storeId,
        registerId: order.registerId, userId: input.employeeId, action: 'ORDER_VOIDED', entityType: 'Order', entityId: order.id,
        metadataJson: { reason: input.reason } } }),
      tx.outboxEvent.create({ data: { organizationId: input.organizationId, aggregateType: 'Order', aggregateId: order.id,
        eventType: 'ORDER_VOIDED', payload: { orderId: order.id, reason: input.reason } } }),
      tx.idempotencyKey.update({ where: { organizationId_operationScope_key: { organizationId: input.organizationId,
        operationScope: scope, key: input.idempotencyKey } }, data: { status: 'SUCCEEDED', responseStatus: 200,
        responseBody: { orderId: order.id, status: 'VOIDED' }, resultReference: order.id } }),
    ]);
    return { orderId: order.id, status: 'VOIDED' };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function refundOrder(
  prisma: PrismaClient,
  provider: TerminalPaymentProvider,
  input: {
    organizationId: string;
    orderId: string;
    employeeId: string;
    reason: string;
    idempotencyKey: string;
    items: Array<{ orderItemId: string; quantity: number; returnToStock?: boolean }>;
  },
): Promise<{ refundId: string; orderId: string; status: string; amountMinor: string }> {
  if (!input.reason.trim()) throw new PosError('REFUND_REASON_REQUIRED');
  if (!input.idempotencyKey.trim()) throw new PosError('IDEMPOTENCY_KEY_REQUIRED');
  if (input.items.length === 0) throw new PosError('REFUND_ITEMS_REQUIRED');
  for (const item of input.items) requirePositiveQuantity(item.quantity);
  const scope = 'REFUND_ORDER';
  const fingerprint = actionFingerprint(input);

  const prepared = await prisma.$transaction(async (tx) => {
    const existingId = await acquireActionKey(tx, { organizationId: input.organizationId, scope, key: input.idempotencyKey, fingerprint });
    if (existingId) {
      const existing = await tx.refund.findFirst({ where: { id: existingId, organizationId: input.organizationId } });
      if (!existing) throw new Error('IDEMPOTENT_REFUND_MISSING');
      return { existing: { refundId: existing.id, orderId: existing.orderId, status: existing.status, amountMinor: existing.amountMinor.toString() } };
    }
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId}::uuid AND "organizationId" = ${input.organizationId}::uuid FOR UPDATE`;
    const order = await tx.order.findFirst({ where: { id: input.orderId, organizationId: input.organizationId },
      include: { items: { include: { refundItems: { where: { refund: { status: 'SUCCEEDED' } } } } }, payments: { include: { attempts: true } } } });
    if (!order) throw new PosError('ORDER_NOT_FOUND', 404);
    if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.status)) throw new PosError('ORDER_NOT_REFUNDABLE', 409);
    const refundablePayments = order.payments.filter((candidate) => ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(candidate.status));
    const payment = refundablePayments.find((candidate) => candidate.kind === 'TERMINAL')
      ?? refundablePayments.find((candidate) => candidate.kind === 'CASH')
      ?? refundablePayments[0];
    if (!payment) throw new PosError('PAYMENT_NOT_REFUNDABLE', 409);
    const requested = input.items.map((request) => {
      const item = order.items.find((candidate) => candidate.id === request.orderItemId);
      if (!item) throw new PosError('ORDER_ITEM_NOT_FOUND', 404);
      const refundedQty = item.refundItems.reduce((sum, refundItem) => sum + refundItem.quantity, 0);
      const remainingQty = item.quantity - refundedQty;
      if (request.quantity > remainingQty) throw new PosError('REFUND_QUANTITY_EXCEEDS_REMAINING', 409);
      const previouslyRefundedMinor = item.refundItems.reduce((sum, refundItem) => sum + refundItem.amountMinor, 0n);
      const remainingMinor = item.totalMinor - previouslyRefundedMinor;
      const amountMinor = request.quantity === remainingQty
        ? remainingMinor
        : (item.totalMinor * BigInt(request.quantity)) / BigInt(item.quantity);
      return { item, quantity: request.quantity, amountMinor, returnToStock: request.returnToStock !== false };
    });
    const amountMinor = requested.reduce((sum, item) => sum + item.amountMinor, 0n);
    const refund = await tx.refund.create({ data: { organizationId: input.organizationId, orderId: order.id,
      paymentId: payment.id, status: payment.kind === 'CASH' ? 'PROCESSING' : 'PROCESSING', amountMinor,
      reason: input.reason, employeeId: input.employeeId } });
    await tx.refundItem.createMany({ data: requested.map((item) => ({ organizationId: input.organizationId,
      refundId: refund.id, orderItemId: item.item.id, variantId: item.item.variantId,
      quantity: item.quantity, amountMinor: item.amountMinor, returnToStock: item.returnToStock })) });
    let attemptId: string | undefined;
    const terminalAttempt = payment.attempts.find((attempt) => attempt.status === 'SUCCEEDED');
    const terminalCaptured = order.payments.filter((candidate) => candidate.kind === 'TERMINAL')
      .reduce((sum, candidate) => sum + candidate.capturedMinor, 0n);
    const previouslyRefundedMinor = order.items.reduce((sum, item) => sum
      + item.refundItems.reduce((itemSum, refundItem) => itemSum + refundItem.amountMinor, 0n), 0n);
    const finalRefund = previouslyRefundedMinor + amountMinor >= order.totalMinor;
    const priorProviderRefunds = await tx.refundAttempt.aggregate({ where: {
      organizationId: input.organizationId, status: 'SUCCEEDED', refund: { orderId: order.id },
    }, _sum: { requestedMinor: true } });
    const providerAmountMinor = order.totalMinor === 0n ? 0n : finalRefund
      ? terminalCaptured - (priorProviderRefunds._sum.requestedMinor ?? 0n)
      : (amountMinor * terminalCaptured) / order.totalMinor;
    if (payment.kind === 'TERMINAL' && providerAmountMinor > 0n) {
      if (!terminalAttempt?.providerTransactionId) throw new PosError('PROVIDER_TRANSACTION_MISSING', 409);
      const attempt = await tx.refundAttempt.create({ data: { organizationId: input.organizationId, refundId: refund.id,
        status: 'PROCESSING', idempotencyKey: input.idempotencyKey, requestedMinor: providerAmountMinor } });
      attemptId = attempt.id;
    }
    await tx.idempotencyKey.update({ where: { organizationId_operationScope_key: { organizationId: input.organizationId,
      operationScope: scope, key: input.idempotencyKey } }, data: { resultReference: refund.id } });
    return { order, payment, refund, requested, amountMinor, providerAmountMinor, attemptId,
      providerTransactionId: terminalAttempt?.providerTransactionId };
  });
  if ('existing' in prepared) return prepared.existing;

  let success = prepared.attemptId === undefined;
  let providerStatus = 'SUCCEEDED';
  if (prepared.attemptId) {
    try {
      const result = await provider.refund(prepared.providerTransactionId!, prepared.providerAmountMinor.toString(), input.idempotencyKey);
      providerStatus = result.status;
      success = result.status === 'SUCCEEDED';
    } catch {
      providerStatus = 'UNKNOWN';
    }
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${prepared.refund.id}::uuid FOR UPDATE`;
    const current = await tx.refund.findUnique({ where: { id: prepared.refund.id } });
    if (!current) throw new Error('REFUND_MISSING');
    if (current.status === 'SUCCEEDED') return { refundId: current.id, orderId: current.orderId, status: current.status, amountMinor: current.amountMinor.toString() };
    if (!success) {
      const status = providerStatus === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
      await tx.refund.update({ where: { id: current.id }, data: { status } });
      if (prepared.attemptId) await tx.refundAttempt.update({ where: { id: prepared.attemptId }, data: {
        status: providerStatus === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
        ...(providerStatus === 'UNKNOWN' ? { nextReconciliationAt: new Date(Date.now() + 60_000) } : {}),
      } });
      await tx.idempotencyKey.update({ where: { organizationId_operationScope_key: { organizationId: input.organizationId,
        operationScope: scope, key: input.idempotencyKey } }, data: { status: 'FAILED', responseStatus: 409,
        responseBody: { refundId: current.id, orderId: current.orderId, status, amountMinor: current.amountMinor.toString() },
        resultReference: current.id } });
      return { refundId: current.id, orderId: current.orderId, status, amountMinor: current.amountMinor.toString() };
    }
    if (prepared.attemptId) await tx.refundAttempt.update({ where: { id: prepared.attemptId }, data: { status: 'SUCCEEDED' } });
    await restoreInventory(tx, { organizationId: input.organizationId, storeId: prepared.order.storeId,
      employeeId: input.employeeId, referenceId: current.id, movementType: 'SALE_RETURN',
      lines: prepared.requested.filter((item) => item.returnToStock).map((item) => ({ variantId: item.item.variantId, quantity: item.quantity })) });
    const successfulTotal = await tx.refund.aggregate({ where: { organizationId: input.organizationId,
      orderId: input.orderId, status: 'SUCCEEDED' }, _sum: { amountMinor: true } });
    const totalRefunded = (successfulTotal._sum.amountMinor ?? 0n) + current.amountMinor;
    const fullyRefunded = totalRefunded >= prepared.order.totalMinor;
    await tx.refund.update({ where: { id: current.id }, data: { status: 'SUCCEEDED', completedAt: new Date() } });
    await tx.payment.updateMany({ where: { organizationId: input.organizationId, orderId: input.orderId,
      status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } }, data: { status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
    await tx.order.update({ where: { id: input.orderId }, data: { status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
    await compensateCustomerValue(tx, { organizationId: input.organizationId, orderId: input.orderId,
      employeeId: input.employeeId, refundId: current.id, referencePrefix: `refund:${current.id}`,
      numerator: current.amountMinor, denominator: prepared.order.totalMinor, settleFully: fullyRefunded });
    await Promise.all([
      tx.auditRecord.create({ data: { organizationId: input.organizationId, storeId: prepared.order.storeId,
        registerId: prepared.order.registerId, userId: input.employeeId, action: 'ORDER_REFUNDED', entityType: 'Refund', entityId: current.id,
        metadataJson: { reason: input.reason, amountMinor: current.amountMinor.toString() } } }),
      tx.outboxEvent.create({ data: { organizationId: input.organizationId, aggregateType: 'Refund', aggregateId: current.id,
        eventType: 'ORDER_REFUNDED', payload: { orderId: input.orderId, refundId: current.id } } }),
      tx.idempotencyKey.update({ where: { organizationId_operationScope_key: { organizationId: input.organizationId,
        operationScope: scope, key: input.idempotencyKey } }, data: { status: 'SUCCEEDED', responseStatus: 200,
        responseBody: { refundId: current.id, orderId: input.orderId, status: 'SUCCEEDED', amountMinor: current.amountMinor.toString() }, resultReference: current.id } }),
    ]);
    return { refundId: current.id, orderId: input.orderId, status: 'SUCCEEDED', amountMinor: current.amountMinor.toString() };
  });
}
