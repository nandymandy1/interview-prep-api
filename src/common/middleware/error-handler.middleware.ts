import type { ErrorRequestHandler } from 'express';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import { normalizeHttpException, sendErrorResponse } from '@/common/errors/error-response';

export const createErrorHandlerMiddleware = (
  logger: LoggerService,
): ErrorRequestHandler =>
  (error, _req, res, next): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const exception = normalizeHttpException(error);

    logger.error(error, 'http.middleware.failed', {
      statusCode: exception.statusCode,
      errorCode: exception.code,
    });

    sendErrorResponse(res, exception);
  };
