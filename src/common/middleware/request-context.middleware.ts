import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { RequestContextService } from '../context/request-context.service';
import type { LoggerService } from '../../infrastructure/logger/logger.service';

type RequestContextMiddlewareDependencies = {
  requestContext: RequestContextService;
  logger: LoggerService;
};

export const createRequestContextMiddleware = ({
  requestContext,
  logger,
}: RequestContextMiddlewareDependencies): RequestHandler =>
  (req, res, next): void => {
    const requestId = req.header('x-request-id')?.trim() || randomUUID();
    const startedAt = performance.now();

    res.setHeader('x-request-id', requestId);

    requestContext.run(
      {
        requestId,
        method: req.method,
        path: req.originalUrl,
        startedAt,
      },
      () => {
        logger.info('http.request.started');

        res.once('finish', () => {
          logger.info('http.request.completed', {
            statusCode: res.statusCode,
            durationMs: roundDuration(performance.now() - startedAt),
          });
        });

        res.once('close', () => {
          if (!res.writableEnded) {
            logger.warn('http.request.aborted', {
              statusCode: res.statusCode,
              durationMs: roundDuration(performance.now() - startedAt),
            });
          }
        });

        next();
      },
    );
  };

const roundDuration = (durationMs: number): number =>
  Math.round(durationMs * 100) / 100;
