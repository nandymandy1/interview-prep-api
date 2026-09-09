export type GeminiExceptionCode =
  | 'GEMINI_NOT_CONFIGURED'
  | 'GEMINI_HTTP_ERROR'
  | 'GEMINI_RATE_LIMITED'
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_NETWORK_ERROR'
  | 'GEMINI_INVALID_RESPONSE'
  | 'LLM_AUTH_INVALID';

// Typed Gemini failure. Carries only status codes and fixed detail; API keys
// and raw upstream bodies are never attached or logged.
export class GeminiException extends Error {
  readonly code: GeminiExceptionCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: GeminiExceptionCode,
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
