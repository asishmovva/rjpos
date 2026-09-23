import { describe, expect, it } from 'vitest';
import { ErrorEnvelopeFilter, RequestIdMiddleware } from '../src/foundation.js';
import { checkPostgres, checkRedis } from '../src/health.js';
import { PrismaClient } from '@prisma/client';

describe('API foundation', () => {
  it('adds and propagates request IDs', () => {
    let nextCalled = false;
    const headers = new Map<string, string>();
    const request = { header: () => undefined } as never;
    const response = { setHeader: (key: string, value: string) => headers.set(key, value) } as never;
    new RequestIdMiddleware().use(request, response, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the standardized error envelope', () => {
    const body: { error?: { code: string; message: string; requestId: string } } = {};
    const response = { status: () => ({ json: (value: typeof body) => Object.assign(body, value) }) } as never;
    const request = { requestId: 'request-1' } as never;
    new ErrorEnvelopeFilter().catch(new Error('boom'), { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as never);
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId: 'request-1' });
  });

  it('verifies a live Redis endpoint when configured', async () => {
    const url = process.env.TEST_REDIS_URL;
    if (!url) throw new Error('TEST_REDIS_URL is required for Phase 0 verification');
    await expect(checkRedis(url)).resolves.toBe(true);
  });

  it('verifies a live PostgreSQL endpoint when configured', async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for Phase 0 verification');
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try { await expect(checkPostgres(prisma)).resolves.toBe(true); } finally { await prisma.$disconnect(); }
  });
});
