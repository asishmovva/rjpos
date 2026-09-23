import 'reflect-metadata';
import {
  MiddlewareConsumer,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { ErrorEnvelopeFilter, RequestIdMiddleware } from './foundation.js';
import { TenantContextService } from './tenant-context.js';
import { loadEnvironment } from '@rjpos/config';
import {
  checkPostgres,
  checkRedis,
  HealthController,
  HealthService,
  POSTGRES_CHECK,
  REDIS_CHECK,
} from './health.js';

const environment = loadEnvironment();
const prisma = new PrismaClient({
  datasources: { db: { url: environment.DATABASE_URL } },
});

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    TenantContextService,
    { provide: POSTGRES_CHECK, useValue: () => checkPostgres(prisma) },
    { provide: REDIS_CHECK, useValue: () => checkRedis(environment.REDIS_URL) },
  ],
})
class AppModule implements OnApplicationShutdown {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }

  async onApplicationShutdown(): Promise<void> {
    await prisma.$disconnect();
  }
}

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
app.enableVersioning();
app.enableCors();
app.useGlobalFilters(new ErrorEnvelopeFilter());
await app.listen(process.env.PORT ?? 3001);
