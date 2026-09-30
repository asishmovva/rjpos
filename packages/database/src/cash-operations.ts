import { Prisma, type CashMovementKind, type PrismaClient } from '@prisma/client';
import { PosError } from './pos-errors.js';

type Tx = Prisma.TransactionClient;
type SessionRow = { id: string; organizationId: string; openingCashMinor: bigint };

export type CashActor = { organizationId: string; storeId: string; registerId: string; userId: string; approvedByEmployeeId?: string | null };

const CAPTURED = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export type CashTotals = {
  openingCashMinor: bigint; cashSalesMinor: bigint; cashRefundsMinor: bigint; paidInMinor: bigint; paidOutMinor: bigint; safeDropsMinor: bigint;
  adjustmentsInMinor: bigint; adjustmentsOutMinor: bigint; noSaleCount: number; expectedCashMinor: bigint;
};

/** Expected drawer cash: opening + cash sales − cash refunds + paid in + adjustments in − paid out − safe drops − adjustments out. */
export async function calculateCashTotals(tx: Tx, session: SessionRow): Promise<CashTotals> {
  const [sales, refunds, movements] = await Promise.all([
    tx.payment.aggregate({ where: { organizationId: session.organizationId, kind: 'CASH', status: { in: [...CAPTURED] }, order: { registerSessionId: session.id } }, _sum: { capturedMinor: true } }),
    tx.refund.aggregate({ where: { organizationId: session.organizationId, status: 'SUCCEEDED', payment: { kind: 'CASH' }, order: { registerSessionId: session.id } }, _sum: { amountMinor: true } }),
    tx.cashMovement.groupBy({ by: ['kind'], where: { organizationId: session.organizationId, registerSessionId: session.id }, _sum: { amountMinor: true }, _count: true }),
  ]);
  const sum = (kind: CashMovementKind) => movements.find((row) => row.kind === kind)?._sum.amountMinor ?? 0n;
  const totals = { openingCashMinor: session.openingCashMinor, cashSalesMinor: sales._sum.capturedMinor ?? 0n, cashRefundsMinor: refunds._sum.amountMinor ?? 0n,
    paidInMinor: sum('PAID_IN'), paidOutMinor: sum('PAID_OUT'), safeDropsMinor: sum('SAFE_DROP'), adjustmentsInMinor: sum('ADJUSTMENT_IN'), adjustmentsOutMinor: sum('ADJUSTMENT_OUT'),
    noSaleCount: movements.find((row) => row.kind === 'NO_SALE')?._count ?? 0 };
  return { ...totals, expectedCashMinor: totals.openingCashMinor + totals.cashSalesMinor - totals.cashRefundsMinor + totals.paidInMinor + totals.adjustmentsInMinor - totals.paidOutMinor - totals.safeDropsMinor - totals.adjustmentsOutMinor };
}

const OUTFLOWS = new Set<CashMovementKind>(['PAID_OUT', 'SAFE_DROP', 'ADJUSTMENT_OUT']);
const REASON_OPTIONAL = new Set<CashMovementKind>(['PAID_IN', 'SAFE_DROP']);

/**
 * Paid in/out, safe drops, no-sale drawer opens, and authorized adjustments. The caller has already checked the
 * permission for `kind`; this records who did it, when, how much, and why, and never lets an outflow exceed the drawer's cash.
 */
export async function recordCashMovement(prisma: PrismaClient, actor: CashActor, input: { kind: CashMovementKind; amountMinor?: string; reason?: string }) {
  const kind = input.kind;
  if (!['PAID_IN', 'PAID_OUT', 'SAFE_DROP', 'NO_SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT'].includes(kind)) throw new PosError('CASH_KIND_INVALID');
  const rawAmount = kind === 'NO_SALE' ? '0' : input.amountMinor ?? '';
  if (!/^(0|[1-9]\d{0,11})$/.test(rawAmount)) throw new PosError('CASH_AMOUNT_INVALID');
  const amountMinor = BigInt(rawAmount);
  if (kind !== 'NO_SALE' && amountMinor <= 0n) throw new PosError('CASH_AMOUNT_INVALID');
  const reason = input.reason?.trim().slice(0, 200) || null;
  if (!REASON_OPTIONAL.has(kind) && !reason) throw new PosError('CASH_REASON_REQUIRED');
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "RegisterSession" WHERE "organizationId" = ${actor.organizationId}::uuid AND "registerId" = ${actor.registerId}::uuid AND "status" = 'OPEN' ORDER BY "openedAt" DESC LIMIT 1 FOR UPDATE`;
    const session = rows[0] ? await tx.registerSession.findUniqueOrThrow({ where: { id: rows[0].id } }) : null;
    if (!session) throw new PosError('REGISTER_SESSION_NOT_OPEN', 409);
    const employee = await tx.employeeStore.findUnique({ where: { organizationId_employeeId_storeId: { organizationId: actor.organizationId, employeeId: actor.userId, storeId: actor.storeId } }, include: { employee: true } });
    if (!employee || employee.employee.status !== 'ACTIVE') throw new PosError('EMPLOYEE_STORE_ACCESS_DENIED', 403);
    if (OUTFLOWS.has(kind)) {
      const totals = await calculateCashTotals(tx, session);
      if (amountMinor > totals.expectedCashMinor) throw new PosError('INSUFFICIENT_DRAWER_CASH', 409);
    }
    const movement = await tx.cashMovement.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId, registerSessionId: session.id,
      employeeId: actor.userId, approvedByEmployeeId: actor.approvedByEmployeeId ?? null, kind, amountMinor, reason } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId, registerId: actor.registerId, userId: actor.userId, action: `CASH_${kind}`, entityType: 'CashMovement', entityId: movement.id,
      afterJson: { registerSessionId: session.id, amountMinor: amountMinor.toString(), reason, approvedByEmployeeId: actor.approvedByEmployeeId ?? null } } });
    return movement;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export const listCashMovements = (prisma: PrismaClient, scope: { organizationId: string; registerId: string; storeId: string }, registerSessionId: string) =>
  prisma.cashMovement.findMany({ where: { organizationId: scope.organizationId, storeId: scope.storeId, registerId: scope.registerId, registerSessionId }, orderBy: { createdAt: 'asc' }, take: 200 });
