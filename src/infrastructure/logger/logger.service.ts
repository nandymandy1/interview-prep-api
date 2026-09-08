import pino, { type Logger } from 'pino';
import type { RequestContextService } from '@/common/context/request-context.service';

export type LogMeta = Record<string, unknown>;

type LoggerServiceDependencies = {
  baseLogger: Logger;
  requestContext: RequestContextService;
};

export const createBaseLogger = (level: string): Logger =>
  pino({
    level,
    redact: {
      paths: [
        'password',
        '*.password',
        'passwordHash',
        '*.passwordHash',
        'authorization',
        '*.authorization',
        'cookie',
        '*.cookie',
        'sessionId',
        '*.sessionId',
        'apiKey',
        '*.apiKey',
      ],
      censor: '[REDACTED]',
    },
  });

export class LoggerService {
  constructor(private readonly dependencies: LoggerServiceDependencies) {}

  debug(message: string, meta: LogMeta = {}): void {
    this.dependencies.baseLogger.debug(this.withContext(meta), message);
  }

  info(message: string, meta: LogMeta = {}): void {
    this.dependencies.baseLogger.info(this.withContext(meta), message);
  }

  warn(message: string, meta: LogMeta = {}): void {
    this.dependencies.baseLogger.warn(this.withContext(meta), message);
  }

  error(error: unknown, message: string, meta: LogMeta = {}): void {
    this.dependencies.baseLogger.error(this.withContext({ ...meta, err: error }), message);
  }

  private withContext(meta: LogMeta): LogMeta {
    const context = this.dependencies.requestContext.get();

    if (!context) {
      return meta;
    }

    return {
      requestId: context.requestId,
      userId: context.userId,
      method: context.method,
      path: context.path,
      ...meta,
    };
  }
}
