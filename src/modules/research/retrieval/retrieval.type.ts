export type RetrievalMode = 'production' | 'evaluation';

export type RetrievalRequest = {
  url: string;
  mode: RetrievalMode;
};

export type RetrievedResource = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
};

export type RetrievalFailureCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROTOCOL'
  | 'BLOCKED_ADDRESS'
  | 'DNS_RESOLUTION_FAILED'
  | 'TIMEOUT'
  | 'TOO_MANY_REDIRECTS'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'RESPONSE_TOO_LARGE'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED';

export type RetrievalFailure = {
  code: RetrievalFailureCode;
  url: string;
  status?: number;
  message: string;
};

export type RetrievalResult =
  | {
      ok: true;
      resource: RetrievedResource;
    }
  | {
      ok: false;
      failure: RetrievalFailure;
    };

export type RetrievalExceptionOptions = {
  url: string;
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
};

// Transport-independent retrieval failure. The same core serves web request
// orchestration, a future evaluator CLI, and future background generation, so
// HTTP transport semantics stay outside this error. Upstream bodies and raw
// provider messages are never exposed; clients see only fixed safe text.
export class RetrievalException extends Error {
  readonly code: RetrievalFailureCode;
  readonly url: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: RetrievalFailureCode, message: string, options: RetrievalExceptionOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.url = options.url;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;

    Error.captureStackTrace?.(this, new.target);
  }
}

const SAFE_MESSAGES: Record<RetrievalFailureCode, string> = {
  INVALID_URL: 'The provided URL is invalid.',
  UNSUPPORTED_PROTOCOL: 'Only http(s) URLs can be retrieved.',
  BLOCKED_ADDRESS: 'The URL resolves to a blocked address.',
  DNS_RESOLUTION_FAILED: 'The URL hostname could not be resolved.',
  TIMEOUT: 'The request timed out.',
  TOO_MANY_REDIRECTS: 'The URL redirected too many times.',
  UNSUPPORTED_CONTENT_TYPE: 'The response content type is not supported.',
  RESPONSE_TOO_LARGE: 'The response exceeded the maximum allowed size.',
  HTTP_ERROR: 'The remote server returned an error.',
  NETWORK_ERROR: 'A network error occurred while retrieving the URL.',
  RATE_LIMITED: 'The remote server rate-limited the request.',
};

export const toRetrievalFailure = (error: RetrievalException): RetrievalFailure => ({
  code: error.code,
  url: error.url,
  ...(error.status !== undefined ? { status: error.status } : {}),
  message: SAFE_MESSAGES[error.code],
});

export const toRetrievalResult = (error: RetrievalException): RetrievalResult => ({
  ok: false,
  failure: toRetrievalFailure(error),
});
