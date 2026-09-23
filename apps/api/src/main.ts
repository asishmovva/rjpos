import 'reflect-metadata';
import {
  Controller,
  Get,
  Injectable,
  MiddlewareConsumer,
  Module,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { ErrorEnvelopeFilter, RequestIdMiddleware } from './foundation.js';
import { TenantContextService } from './tenant-context.js';
import { loadEnvironment } from '@rjpos/config';

@Injectable()
class HealthService {
  readiness(): { status: 'ok'; requestId: string } {
    return { status: 'ok', requestId: randomUUID() };
  }
}

@Controller('/api/v1/health')
class HealthController {
  constructor(private readonly health: HealthService) {}
  @Get()
  getHealth(): { status: 'ok'; requestId: string } {
    return this.health.readiness();
  }
  @Get('/ready')
  getReadiness(): { status: 'ok'; requestId: string } {
    return this.health.readiness();
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService, TenantContextService],
})
class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

loadEnvironment(process.env);
const app = await NestFactory.create(AppModule);
app.enableVersioning();
app.enableCors();
app.useGlobalFilters(new ErrorEnvelopeFilter());
await app.listen(process.env.PORT ?? 3001);
