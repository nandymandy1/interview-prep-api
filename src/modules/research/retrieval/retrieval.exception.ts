import type {
  RedirectBlockReason,
  RetrievalFailureCode,
} from '@/modules/research/retrieval/retrieval.type';

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

// Caller redirect-policy rejection. Thrown by a RetrievalRequest
// onBeforeRedirect hook and propagated untouched through RetrievalClient so
// the caller (e.g. a crawler) can map it to its own skip/failure vocabulary.
// Never converted into a RetrievalFailureCode.
export class RedirectBlockedError extends Error {
  readonly reason: RedirectBlockReason;
  readonly url: string;

  constructor(reason: RedirectBlockReason, url: string) {
    super(
      `Redirect to ${reason === 'ROBOTS_DISALLOWED' ? 'a robots-disallowed' : 'an out-of-scope'} URL was blocked.`,
    );
    this.name = new.target.name;
    this.reason = reason;
    this.url = url;

    Error.captureStackTrace?.(this, new.target);
  }
}
