import type { PrismaClient } from '@prisma/client';

export type ClaimedOutboxEvent = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
};

export async function claimOutboxBatch(
  prisma: PrismaClient,
  workerId: string,
  limit = 50,
): Promise<ClaimedOutboxEvent[]> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        eventType: string;
        aggregateType: string;
        aggregateId: string;
        payload: unknown;
      }>
    >`
      SELECT "id", "eventType", "aggregateType", "aggregateId", "payload"
      FROM "OutboxEvent"
      WHERE "status" = 'PENDING' AND "availableAt" <= NOW()
      ORDER BY "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `;
    if (rows.length === 0) return [];
    await tx.outboxEvent.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, status: 'PENDING' },
      data: {
        status: 'PROCESSING',
        claimedBy: workerId,
        claimedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    return rows;
  });
}

export async function recoverStaleOutboxClaims(
  prisma: PrismaClient,
  staleBefore: Date,
): Promise<number> {
  const result = await prisma.outboxEvent.updateMany({
    where: { status: 'PROCESSING', claimedAt: { lt: staleBefore } },
    data: {
      status: 'PENDING',
      claimedAt: null,
      claimedBy: null,
      availableAt: new Date(),
    },
  });
  return result.count;
}

export async function markOutboxProcessed(prisma: PrismaClient, eventId: string): Promise<void> {
  await prisma.outboxEvent.updateMany({ where: { id: eventId, status: 'PROCESSING' }, data: { status: 'PROCESSED', processedAt: new Date(), claimedAt: null, claimedBy: null } });
}

export async function markOutboxFailed(prisma: PrismaClient, eventId: string, error: string, maxAttempts = 5): Promise<void> {
  const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
  await prisma.outboxEvent.update({ where: { id: eventId }, data: { status: event.attempts >= maxAttempts ? 'FAILED' : 'PENDING', lastError: error, claimedAt: null, claimedBy: null, availableAt: new Date(Date.now() + 1000) } });
}
