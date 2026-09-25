import { describe, expect, it, vi } from 'vitest';
import { ErrorEnvelopeFilter, RequestIdMiddleware } from '../src/foundation.js';
import {
  checkPostgres,
  checkRedis,
  HealthService,
  ReadinessUnavailableException,
} from '../src/health.js';
import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment } from '@rjpos/config';
import { createRequire } from 'node:module';

const testEnvironment = loadTestEnvironment();
const require = createRequire(import.meta.url);

describe('API foundation', () => {
  it('can resolve every directly imported runtime dependency', () => {
    expect(() => require.resolve('express')).not.toThrow();
  });

  it('adds and propagates request IDs', () => {
    let nextCalled = false;
    const headers = new Map<string, string>();
    const request = { header: () => undefined } as never;
    const response = {
      setHeader: (key: string, value: string) => headers.set(key, value),
    } as never;
    new RequestIdMiddleware().use(request, response, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the standardized error envelope for an unexpected exception', () => {
    const body: {
      error?: { code: string; message: string; requestId: string };
    } = {};
    const response = {
      status: () => ({
        json: (value: typeof body) => Object.assign(body, value),
      }),
    } as never;
    const request = { requestId: 'request-1' } as never;
    const writeLog = vi.fn();
    new ErrorEnvelopeFilter(writeLog).catch(new Error('boom'), {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as never);
    expect(body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      requestId: 'request-1',
    });
  });

  it('correlates sanitized unexpected-error logs with the response request ID', () => {
    const body: {
      error?: { code: string; message: string; requestId: string };
    } = {};
    const response = {
      status: () => ({
        json: (value: typeof body) => Object.assign(body, value),
      }),
    } as never;
    const request = { requestId: 'correlated-request' } as never;
    const writeLog = vi.fn();
    new ErrorEnvelopeFilter(writeLog).catch(
      new Error(
        'database postgresql://app:do-not-log@localhost/db token=do-not-log',
      ),
      {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => request,
        }),
      } as never,
    );
    expect(writeLog).toHaveBeenCalledWith(
      'error',
      'Unexpected server exception',
      expect.objectContaining({
        requestId: body.error?.requestId,
        errorMessage:
          'database postgresql://[REDACTED]@localhost/db token=[REDACTED]',
      }),
    );
    expect(JSON.stringify(writeLog.mock.calls)).not.toContain('do-not-log');
  });

  it('returns a controlled non-ready envelope', () => {
    const body: Record<string, unknown> = {};
    const response = {
      status: (status: number) => {
        expect(status).toBe(503);
        return { json: (value: typeof body) => Object.assign(body, value) };
      },
    } as never;
    const request = { requestId: 'request-503' } as never;
    new ErrorEnvelopeFilter(vi.fn()).catch(
      new ReadinessUnavailableException({ postgres: 'down', redis: 'up' }),
      {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => request,
        }),
      } as never,
    );
    expect(body).toEqual({
      error: {
        code: 'NOT_READY',
        message: 'Required dependencies are unavailable.',
        requestId: 'request-503',
        dependencies: { postgres: 'down', redis: 'up' },
      },
    });
  });

  it('reports liveness without checking dependencies', () => {
    const postgres = vi.fn(async () => true);
    const redis = vi.fn(async () => true);
    expect(new HealthService(postgres, redis).liveness()).toEqual({
      status: 'ok',
    });
    expect(postgres).not.toHaveBeenCalled();
    expect(redis).not.toHaveBeenCalled();
  });

  it('reports readiness when PostgreSQL and Redis are available', async () => {
    const health = new HealthService(
      async () => true,
      async () => true,
    );
    await expect(health.readiness()).resolves.toEqual({
      status: 'ready',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });

  it('reports PostgreSQL as unavailable', async () => {
    const health = new HealthService(
      async () => Promise.reject(new Error('postgres unavailable')),
      async () => true,
    );
    await expect(health.readiness()).rejects.toMatchObject({
      dependencies: { postgres: 'down', redis: 'up' },
    });
  });

  it('reports Redis as unavailable', async () => {
    const health = new HealthService(
      async () => true,
      async () => Promise.reject(new Error('redis unavailable')),
    );
    await expect(health.readiness()).rejects.toMatchObject({
      dependencies: { postgres: 'up', redis: 'down' },
    });
  });

  it('verifies a live Redis endpoint when configured', async () => {
    await expect(checkRedis(testEnvironment.TEST_REDIS_URL)).resolves.toBe(
      true,
    );
  });

  it('verifies a live PostgreSQL endpoint when configured', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: testEnvironment.TEST_DATABASE_URL } },
    });
    try {
      await expect(checkPostgres(prisma)).resolves.toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });
});
