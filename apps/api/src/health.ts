import {
  Controller,
  Get,
  Inject,
  Injectable,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { log } from '@rjpos/logging';
import { createConnection } from 'node:net';
import type { RequestWithId } from './foundation.js';

export const POSTGRES_CHECK = Symbol('POSTGRES_CHECK');
export const REDIS_CHECK = Symbol('REDIS_CHECK');

export type DependencyCheck = () => Promise<unknown>;
export type DependencyStatus = 'up' | 'down';
export type ReadinessDependencies = {
  postgres: DependencyStatus;
  redis: DependencyStatus;
};

export class ReadinessUnavailableException extends ServiceUnavailableException {
  constructor(readonly dependencies: ReadinessDependencies) {
    super('Required dependencies are unavailable');
  }
}

export async function checkPostgres(prisma: PrismaClient): Promise<boolean> {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

export async function checkRedis(url: string): Promise<boolean> {
  const address = new URL(url);
  const port = Number(address.port || 6379);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address.hostname, port });
    const finish = (error?: Error) => {
      socket.destroy();
      error ? reject(error) : resolve(true);
    };
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error));
    socket.setTimeout(1_000, () => finish(new Error('REDIS_TIMEOUT')));
  });
}

async function withTimeout(
  check: DependencyCheck,
  timeoutMilliseconds: number,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('DEPENDENCY_CHECK_TIMEOUT')),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(POSTGRES_CHECK) private readonly postgresCheck: DependencyCheck,
    @Inject(REDIS_CHECK) private readonly redisCheck: DependencyCheck,
  ) {}

  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async readiness(): Promise<{
    status: 'ready';
    dependencies: ReadinessDependencies;
  }> {
    const [postgres, redis] = await Promise.allSettled([
      withTimeout(this.postgresCheck, 2_000),
      withTimeout(this.redisCheck, 2_000),
    ]);
    const dependencies: ReadinessDependencies = {
      postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
      redis: redis.status === 'fulfilled' ? 'up' : 'down',
    };
    if (dependencies.postgres === 'down' || dependencies.redis === 'down') {
      throw new ReadinessUnavailableException(dependencies);
    }
    return { status: 'ready', dependencies };
  }
}

@Controller('/api/v1/health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  getHealth(@Req() request: RequestWithId): { status: 'ok' } {
    const result = this.health.liveness();
    log('info', 'Health liveness check passed', {
      requestId: request.requestId,
    });
    return result;
  }

  @Get('/ready')
  async getReadiness(@Req() request: RequestWithId): Promise<{
    status: 'ready';
    dependencies: ReadinessDependencies;
  }> {
    const result = await this.health.readiness();
    log('info', 'Health readiness check passed', {
      requestId: request.requestId,
    });
    return result;
  }
}
