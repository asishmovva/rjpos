import 'reflect-metadata';
import {
  MiddlewareConsumer,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { PrismaClient } from '@prisma/client';
import { BigIntJsonInterceptor, ErrorEnvelopeFilter, RequestIdMiddleware } from './foundation.js';
import { TenantContextService } from './tenant-context.js';
import { SimulatedTerminalProvider } from '@rjpos/payment-contracts';
import {
  CorePosController,
  DevelopmentAuthMiddleware,
  PRISMA,
  TERMINAL_PROVIDER,
} from './core-pos.js';
import { loadEnvironment } from '@rjpos/config';
import {
  checkPostgres,
  checkRedis,
  HealthController,
  HealthService,
  POSTGRES_CHECK,
  REDIS_CHECK,
} from './health.js';
import { BackOfficeController } from './back-office.js';
import { PhaseThreeController } from './phase-three.js';
import { PurchasingController } from './purchasing.js';
import { PhaseFiveController } from './phase-five.js';
import { ReportingController } from './reporting.js';

const environment = loadEnvironment();
const prisma = new PrismaClient({
  datasources: { db: { url: environment.DATABASE_URL } },
});

@Module({
  controllers: [HealthController, CorePosController, BackOfficeController, PhaseThreeController, PurchasingController, PhaseFiveController, ReportingController],
  providers: [
    HealthService,
    TenantContextService,
    DevelopmentAuthMiddleware,
    { provide: PRISMA, useValue: prisma },
    { provide: TERMINAL_PROVIDER, useValue: new SimulatedTerminalProvider() },
    { provide: POSTGRES_CHECK, useValue: () => checkPostgres(prisma) },
    { provide: REDIS_CHECK, useValue: () => checkRedis(environment.REDIS_URL) },
  ],
})
class AppModule implements OnApplicationShutdown {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, DevelopmentAuthMiddleware).forRoutes('*');
  }

  async onApplicationShutdown(): Promise<void> {
    await prisma.$disconnect();
  }
}

const app = await NestFactory.create(AppModule, { bodyParser: false });
app.use(json({ limit: '10mb' }));
app.use(urlencoded({ extended: true, limit: '10mb' }));
app.enableShutdownHooks();
app.enableVersioning();
app.enableCors();
app.useGlobalFilters(new ErrorEnvelopeFilter());
app.useGlobalInterceptors(new BigIntJsonInterceptor());
await app.listen(process.env.PORT ?? 3001);
