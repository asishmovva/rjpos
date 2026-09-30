import type { PrismaClient } from '@prisma/client';
import { calculateCashTotals } from './cash-operations.js';
import { PosError } from './pos-errors.js';

type Scope = { organizationId: string; storeId: string; registerId: string };
const SOLD_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
const CAPTURED_STATUSES = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export type ShiftReport = {
  sessionId: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  durationMinutes: number;
  openingCashMinor: string;
  expectedCashMinor: string | null;
  countedCashMinor: string | null;
  differenceMinor: string | null;
  detail?: {
    transactionCount: number;
    sales: { cashMinor: string; cardMinor: string; giftCardMinor: string; loyaltyMinor: string };
    refunds: { count: number; totalMinor: string };
    voids: { count: number; totalMinor: string };
    discountsMinor: string;
    /** Drawer cash reconciliation: how expected cash was built. */
    cash: { openingMinor: string; cashSalesMinor: string; cashRefundsMinor: string; paidInMinor: string; paidOutMinor: string; safeDropsMinor: string; adjustmentsNetMinor: string; drawerOpens: number; expectedMinor: string };
    // Extensible per-channel buckets. Orders carry no channel today, so every sale is IN_STORE; external
    // channels (web, delivery marketplaces) get their own bucket once the order source is recorded.
    channels: Array<{ channel: string; orderCount: number; totalMinor: string }>;
  };
};

/** Cashiers get the reconciliation summary; pass `detailed` only for callers holding report:read. */
export async function getShiftReport(prisma: PrismaClient, scope: Scope, sessionId: string, detailed: boolean): Promise<ShiftReport> {
  const session = await prisma.registerSession.findFirst({ where: { id: sessionId, organizationId: scope.organizationId, storeId: scope.storeId, registerId: scope.registerId } });
  if (!session) throw new PosError('REGISTER_SESSION_NOT_FOUND', 404);
  const end = session.closedAt ?? new Date();
  const report: ShiftReport = {
    sessionId: session.id, status: session.status, openedAt: session.openedAt, closedAt: session.closedAt,
    durationMinutes: Math.max(0, Math.round((end.getTime() - session.openedAt.getTime()) / 60_000)),
    openingCashMinor: session.openingCashMinor.toString(), expectedCashMinor: session.expectedCashMinor?.toString() ?? null,
    countedCashMinor: session.actualCashMinor?.toString() ?? null, differenceMinor: session.differenceMinor?.toString() ?? null,
  };
  if (!detailed) return report;
  const orderScope = { organizationId: scope.organizationId, registerSessionId: sessionId };
  const [payments, refunds, voids, sold, cash] = await Promise.all([
    // (cash totals computed below)
    prisma.payment.groupBy({ by: ['kind'], where: { organizationId: scope.organizationId, status: { in: [...CAPTURED_STATUSES] }, order: orderScope }, _sum: { capturedMinor: true } }),
    prisma.refund.aggregate({ where: { organizationId: scope.organizationId, status: 'SUCCEEDED', order: orderScope }, _sum: { amountMinor: true }, _count: true }),
    prisma.order.aggregate({ where: { ...orderScope, status: 'VOIDED' }, _sum: { totalMinor: true }, _count: true }),
    prisma.order.aggregate({ where: { ...orderScope, status: { in: [...SOLD_STATUSES] } }, _sum: { discountMinor: true, totalMinor: true }, _count: true }),
    calculateCashTotals(prisma as never, session),
  ]);
  const byKind = (kind: string) => (payments.find((row) => row.kind === kind)?._sum.capturedMinor ?? 0n).toString();
  report.detail = {
    transactionCount: sold._count,
    sales: { cashMinor: byKind('CASH'), cardMinor: byKind('TERMINAL'), giftCardMinor: byKind('GIFT_CARD'), loyaltyMinor: byKind('LOYALTY') },
    refunds: { count: refunds._count, totalMinor: (refunds._sum.amountMinor ?? 0n).toString() },
    voids: { count: voids._count, totalMinor: (voids._sum.totalMinor ?? 0n).toString() },
    discountsMinor: (sold._sum.discountMinor ?? 0n).toString(),
    cash: { openingMinor: cash.openingCashMinor.toString(), cashSalesMinor: cash.cashSalesMinor.toString(), cashRefundsMinor: cash.cashRefundsMinor.toString(), paidInMinor: cash.paidInMinor.toString(), paidOutMinor: cash.paidOutMinor.toString(),
      safeDropsMinor: cash.safeDropsMinor.toString(), adjustmentsNetMinor: (cash.adjustmentsInMinor - cash.adjustmentsOutMinor).toString(), drawerOpens: cash.noSaleCount, expectedMinor: cash.expectedCashMinor.toString() },
    channels: [{ channel: 'IN_STORE', orderCount: sold._count, totalMinor: (sold._sum.totalMinor ?? 0n).toString() }],
  };
  return report;
}
