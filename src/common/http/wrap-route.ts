import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Provider } from '@/common/providers/provider';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import { normalizeHttpException, sendErrorResponse } from '@/common/errors/error-response';

export type ControllerRouteMethod = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

type RouteMethodKey<T> = {
  [K in keyof T]-?: T[K] extends ControllerRouteMethod ? K : never;
}[keyof T];

export type WrapRoute = <T, K extends RouteMethodKey<T>>(
  provider: Provider<T>,
  methodName: K,
  operation?: string,
) => RequestHandler;

type WrapRouteDependencies = {
  logger: LoggerService;
};

export const createWrapRoute =
  ({ logger }: WrapRouteDependencies): WrapRoute =>
  <T, K extends RouteMethodKey<T>>(
    provider: Provider<T>,
    methodName: K,
    operation?: string,
  ): RequestHandler =>
  async (req, res, next): Promise<void> => {
    const startedAt = performance.now();
    const handlerName = operation ?? String(methodName);

    try {
      // Lazy provider resolution happens here, at request execution time.
      const instance = provider();
      const method = instance[methodName] as ControllerRouteMethod;

      logger.debug('http.route.started', {
        operation: handlerName,
      });

      await method.call(instance, req, res, next);

      logger.debug('http.route.completed', {
        operation: handlerName,
        statusCode: res.statusCode,
        durationMs: roundDuration(performance.now() - startedAt),
      });
    } catch (error) {
      const exception = normalizeHttpException(error);

      logger.error(error, 'http.route.failed', {
        operation: handlerName,
        statusCode: exception.statusCode,
        errorCode: exception.code,
        durationMs: roundDuration(performance.now() - startedAt),
      });

      if (res.headersSent) {
        next(error);
        return;
      }

      sendErrorResponse(res, exception);
    }
  };

const roundDuration = (durationMs: number): number => Math.round(durationMs * 100) / 100;
