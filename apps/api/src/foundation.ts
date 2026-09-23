import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

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
    response
      .status(status)
      .json({
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
