import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { log, sanitizeLogText } from '@rjpos/logging';
import { ReadinessUnavailableException } from './health.js';

export type RequestWithId = Request & { requestId: string };

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
