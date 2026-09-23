import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
  NestMiddleware,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { log, sanitizeLogText } from '@rjpos/logging';
import { ReadinessUnavailableException } from './health.js';
import { PosError } from '@rjpos/database';
import { map, type Observable } from 'rxjs';

export type RequestWithId = Request & { requestId: string };

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if ('toJSON' in value && typeof value.toJSON === 'function') {
      return jsonSafe(value.toJSON());
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

@Injectable()
export class BigIntJsonInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(jsonSafe));
  }
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: RequestWithId, response: Response, next: NextFunction): void {
    request.requestId = request.header('x-request-id') ?? randomUUID();
    response.setHeader('x-request-id', request.requestId);
    next();
  }
}

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  constructor(private readonly writeLog: typeof log = log) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<RequestWithId>();
    const status =
      typeof exception === 'object' &&
      exception !== null &&
      'getStatus' in exception &&
      typeof exception.getStatus === 'function'
        ? exception.getStatus()
        : 500;
    if (exception instanceof PosError) {
      response.status(exception.httpStatus).json({
        error: {
          code: exception.code,
          message: 'The request could not be completed.',
          requestId: request.requestId,
        },
      });
      return;
    }
    if (exception instanceof ReadinessUnavailableException) {
      this.writeLog('warn', 'Health readiness check failed', {
        requestId: request.requestId,
      });
      response.status(503).json({
        error: {
          code: 'NOT_READY',
          message: 'Required dependencies are unavailable.',
          requestId: request.requestId,
          dependencies: exception.dependencies,
        },
      });
      return;
    }
    if (status >= 500) {
      const errorName =
        exception instanceof Error ? exception.name : typeof exception;
      const errorMessage =
        exception instanceof Error
          ? sanitizeLogText(exception.message)
          : 'Non-Error value thrown';
      this.writeLog('error', 'Unexpected server exception', {
        requestId: request.requestId,
        errorName,
        errorMessage,
      });
    }
    response.status(status).json({
      error: {
        code: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
        message:
          status === 500
            ? 'An unexpected error occurred.'
            : 'The request could not be completed.',
        requestId: request.requestId,
      },
    });
  }
}
