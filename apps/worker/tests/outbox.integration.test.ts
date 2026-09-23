import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { claimOutboxBatch, markOutboxFailed, markOutboxProcessed, recoverStaleOutboxClaims } from '../src/outbox-processor.js';

const url = process.env.TEST_DATABASE_URL;
const suite = describe;

suite('outbox processing', () => {
  it('claims, retries, recovers stale work, and processes idempotently', async () => {
    if (!url) throw new Error('TEST_DATABASE_URL is required for Phase 0 verification');
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    const organizationId = '00000000-0000-0000-0000-000000000001';
    try {
      await prisma.outboxEvent.deleteMany({ where: { organizationId, aggregateId: 'outbox-test' } });
      const event = await prisma.outboxEvent.create({ data: { organizationId, aggregateType: 'Test', aggregateId: 'outbox-test', eventType: 'PRODUCT_CREATED', payload: { test: true } } });
      expect(await claimOutboxBatch(prisma, 'worker-a')).toHaveLength(1);
      await markOutboxFailed(prisma, event.id, 'temporary failure');
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PENDING');
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date() } });
      await claimOutboxBatch(prisma, 'worker-b');
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { claimedAt: new Date(Date.now() - 120_000) } });
      expect(await recoverStaleOutboxClaims(prisma, new Date(Date.now() - 60_000))).toBe(1);
      await claimOutboxBatch(prisma, 'worker-c');
      await markOutboxProcessed(prisma, event.id);
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PROCESSED');
    } finally { await prisma.$disconnect(); }
  });
});