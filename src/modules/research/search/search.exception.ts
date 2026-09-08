import type { SearchProviderFailureCode } from '@/modules/research/search/search.type';

// Typed search-provider failure. Carries only status codes and fixed detail;
// raw upstream bodies and API keys are never attached.
export class SearchProviderException extends Error {
  readonly code: SearchProviderFailureCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: SearchProviderFailureCode,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;

    Error.captureStackTrace?.(this, new.target);
  }
}
