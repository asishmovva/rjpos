import { Prisma, type PrismaClient } from '@prisma/client';

async function requireRegisterEmployee(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    storeId: string;
    registerId: string;
    employeeId: string;
  },
): Promise<void> {
  const [register, employeeStore] = await Promise.all([
    tx.register.findFirst({
      where: {
        id: input.registerId,
        organizationId: input.organizationId,
        storeId: input.storeId,
        status: 'ACTIVE',
        store: { status: 'ACTIVE' },
      },
    }),
    tx.employeeStore.findUnique({
      where: {
        organizationId_employeeId_storeId: {
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          storeId: input.storeId,
        },
      },
      include: { employee: true },
    }),
  ]);
  if (!register) throw new Error('REGISTER_NOT_FOUND');
  if (!employeeStore || employeeStore.employee.status !== 'ACTIVE')
    throw new Error('EMPLOYEE_STORE_ACCESS_DENIED');
}

export async function openRegisterSession(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    storeId: string;
    registerId: string;
    employeeId: string;
    openingCashMinor: bigint;
  },
) {
  if (input.openingCashMinor < 0n) throw new Error('OPENING_CASH_INVALID');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM "Store"
      WHERE id = ${input.storeId}::uuid
        AND "organizationId" = ${input.organizationId}::uuid
      FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT id FROM "Register"
      WHERE id = ${input.registerId}::uuid
        AND "organizationId" = ${input.organizationId}::uuid
      FOR UPDATE
    `;
    await requireRegisterEmployee(tx, input);
    const session = await tx.registerSession.create({ data: input });
    await Promise.all([
      tx.auditRecord.create({
        data: {
          organizationId: input.organizationId,
          storeId: input.storeId,
          registerId: input.registerId,
          userId: input.employeeId,
          action: 'REGISTER_OPENED',
          entityType: 'RegisterSession',
          entityId: session.id,
          afterJson: { openingCashMinor: input.openingCashMinor.toString() },
        },
      }),
      tx.outboxEvent.create({
        data: {
          organizationId: input.organizationId,
          aggregateType: 'RegisterSession',
          aggregateId: session.id,
          eventType: 'REGISTER_OPENED',
          payload: { registerId: input.registerId, storeId: input.storeId },
        },
      }),
    ]);
    return session;
  });
}

export async function closeRegisterSession(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    storeId: string;
    registerId: string;
    sessionId: string;
    employeeId: string;
    countedCashMinor: bigint;
  },
) {
  if (input.countedCashMinor < 0n) throw new Error('COUNTED_CASH_INVALID');
  return prisma.$transaction(async (tx) => {
    await requireRegisterEmployee(tx, input);
    await tx.$queryRaw`
      SELECT id FROM "RegisterSession"
      WHERE id = ${input.sessionId}::uuid
        AND "organizationId" = ${input.organizationId}::uuid
      FOR UPDATE
    `;
    const session = await tx.registerSession.findFirst({
      where: {
        id: input.sessionId,
        organizationId: input.organizationId,
        storeId: input.storeId,
        registerId: input.registerId,
      },
    });
    if (!session) throw new Error('REGISTER_SESSION_NOT_FOUND');
    if (session.status !== 'OPEN') throw new Error('REGISTER_SESSION_NOT_OPEN');
    const cashPayments = await tx.payment.aggregate({
      where: {
        organizationId: input.organizationId,
        kind: 'CASH',
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        order: { registerSessionId: input.sessionId },
      },
      _sum: { capturedMinor: true },
    });
    const cashRefunds = await tx.refund.aggregate({
      where: {
        organizationId: input.organizationId,
        status: 'SUCCEEDED',
        payment: { kind: 'CASH' },
        order: { registerSessionId: input.sessionId },
      },
      _sum: { amountMinor: true },
    });
    const expectedCashMinor =
      session.openingCashMinor +
      (cashPayments._sum.capturedMinor ?? 0n) -
      (cashRefunds._sum.amountMinor ?? 0n);
    const closed = await tx.registerSession.update({
      where: { id: session.id },
      data: {
        status: 'CLOSED',
        expectedCashMinor,
        actualCashMinor: input.countedCashMinor,
        differenceMinor: input.countedCashMinor - expectedCashMinor,
        closedByEmployeeId: input.employeeId,
        closedAt: new Date(),
      },
    });
    await Promise.all([
      tx.auditRecord.create({
        data: {
          organizationId: input.organizationId,
          storeId: input.storeId,
          registerId: input.registerId,
          userId: input.employeeId,
          action: 'REGISTER_CLOSED',
          entityType: 'RegisterSession',
          entityId: session.id,
          afterJson: {
            expectedCashMinor: expectedCashMinor.toString(),
            countedCashMinor: input.countedCashMinor.toString(),
            differenceMinor: (
              input.countedCashMinor - expectedCashMinor
            ).toString(),
          },
        },
      }),
      tx.outboxEvent.create({
        data: {
          organizationId: input.organizationId,
          aggregateType: 'RegisterSession',
          aggregateId: session.id,
          eventType: 'REGISTER_CLOSED',
          payload: { registerId: input.registerId, storeId: input.storeId },
        },
      }),
    ]);
    return closed;
  });
}
