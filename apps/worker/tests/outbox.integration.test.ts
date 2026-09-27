import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import {
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxProcessed,
  recoverStaleOutboxClaims,
} from '../src/outbox-processor.js';

const { TEST_DATABASE_URL: url } = loadTestEnvironment();
const suite = describe;

suite('outbox processing', () => {
  it('claims, retries, recovers stale work, and processes idempotently', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    const organizationId = '00000000-0000-0000-0000-000000000001';
    try {
      // This suite owns the outbox in the dedicated test database. Clearing it
      // prevents events emitted by earlier integration suites from changing
      // the batch-level claim assertions below.
      await prisma.outboxEvent.deleteMany();
      const event = await prisma.outboxEvent.create({
        data: {
          organizationId,
          aggregateType: 'Test',
          aggregateId: 'outbox-test',
          eventType: 'PRODUCT_CREATED',
          payload: { test: true },
        },
      });
      expect(await claimOutboxBatch(prisma, 'worker-a')).toEqual([
        expect.objectContaining({ id: event.id }),
      ]);
      expect(await claimOutboxBatch(prisma, 'worker-b')).toHaveLength(0);
      await markOutboxFailed(prisma, event.id, 'temporary failure');
      expect(
        await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: event.id },
        }),
      ).toMatchObject({ status: 'PENDING', attempts: 1 });
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { availableAt: new Date() },
      });
      expect(await claimOutboxBatch(prisma, 'worker-b')).toEqual([
        expect.objectContaining({ id: event.id }),
      ]);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { claimedAt: new Date(Date.now() - 120_000) },
      });
      expect(
        await recoverStaleOutboxClaims(prisma, new Date(Date.now() - 60_000)),
      ).toBe(1);
      expect(await claimOutboxBatch(prisma, 'worker-c')).toEqual([
        expect.objectContaining({ id: event.id }),
      ]);
      await markOutboxProcessed(prisma, event.id);
      expect(
        await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: event.id },
        }),
      ).toMatchObject({
        status: 'PROCESSED',
        attempts: 3,
        claimedAt: null,
        claimedBy: null,
      });
      expect(await claimOutboxBatch(prisma, 'worker-d')).toHaveLength(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
