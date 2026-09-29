import 'reflect-metadata';
import {
  MiddlewareConsumer,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { BigIntJsonInterceptor, ErrorEnvelopeFilter, RequestIdMiddleware } from './foundation.js';
import { TenantContextService } from './tenant-context.js';
import { HttpTerminalProvider, SimulatedTerminalProvider, UnavailableTerminalProvider } from '@rjpos/payment-contracts';
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
import { PhaseSevenController } from './phase-seven.js';
import { InvoiceController, INVOICE_OCR_PROVIDER } from './invoices.js';
import { LocalFixtureInvoiceOcrProvider, UnavailableInvoiceOcrProvider } from './invoice-ocr.js';

const environment = loadEnvironment();
const prisma = new PrismaClient({
  datasources: { db: { url: environment.DATABASE_URL } },
});
const terminalProvider = process.env.RJPOS_TERMINAL_PROVIDER === 'http'
  ? new HttpTerminalProvider({ endpoint: process.env.RJPOS_TERMINAL_ENDPOINT ?? '', token: process.env.RJPOS_TERMINAL_TOKEN ?? '' })
  : process.env.NODE_ENV === 'production'
    ? new UnavailableTerminalProvider()
    : new SimulatedTerminalProvider();
const invoiceOcrProvider = process.env.NODE_ENV !== 'production' && (process.env.RJPOS_INVOICE_OCR_PROVIDER ?? 'fixture') === 'fixture'
  ? new LocalFixtureInvoiceOcrProvider()
  : new UnavailableInvoiceOcrProvider();
const requestWindows = new Map<string, { startedAt: number; count: number }>();
function productionHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('x-frame-options', 'DENY'); response.setHeader('referrer-policy', 'no-referrer'); response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  const key = request.ip ?? 'unknown'; const now = Date.now(); const current = requestWindows.get(key);
  const window = !current || now - current.startedAt >= 60_000 ? { startedAt: now, count: 1 } : { ...current, count: current.count + 1 }; requestWindows.set(key, window);
  if (window.count > 300) { response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', requestId: request.headers['x-request-id'] } }); return; }
  next();
}

@Module({
  controllers: [HealthController, CorePosController, BackOfficeController, PhaseThreeController, PurchasingController, PhaseFiveController, ReportingController, PhaseSevenController, InvoiceController],
  providers: [
    HealthService,
    TenantContextService,
    DevelopmentAuthMiddleware,
    { provide: PRISMA, useValue: prisma },
    { provide: TERMINAL_PROVIDER, useValue: terminalProvider },
    { provide: INVOICE_OCR_PROVIDER, useValue: invoiceOcrProvider },
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
app.use(productionHeaders);
app.use(json({ limit: '10mb' }));
app.use(urlencoded({ extended: true, limit: '10mb' }));
app.enableShutdownHooks();
app.enableVersioning();
const allowedOrigins = Array.from(new Set([
  'rjpos://app',
  ...(process.env.RJPOS_ALLOWED_ORIGINS ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000,http://127.0.0.1:3000')).split(',').map((value) => value.trim()).filter(Boolean),
]));
app.enableCors({ origin: allowedOrigins, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['content-type', 'x-request-id', 'x-rjpos-role', 'x-rjpos-organization-id', 'x-rjpos-store-id', 'x-rjpos-register-id', 'x-rjpos-employee-id'], credentials: false, maxAge: 600 });
app.useGlobalFilters(new ErrorEnvelopeFilter());
app.useGlobalInterceptors(new BigIntJsonInterceptor());
await app.listen(process.env.PORT ?? 3001);
