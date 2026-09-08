export const RETRIEVAL_TIMEOUT_MS = 8_000;
export const RETRIEVAL_MAX_ATTEMPTS = 3;
export const RETRIEVAL_BASE_RETRY_DELAY_MS = 250;
export const RETRIEVAL_MAX_RETRY_DELAY_MS = 2_000;
export const RETRIEVAL_MAX_RETRY_WAIT_MS = 5_000;
export const RETRIEVAL_MAX_REDIRECTS = 5;
export const RETRIEVAL_JITTER_MS = 100;
export const MAX_RETRIEVAL_BYTES = 2 * 1024 * 1024;
export const RETRIEVAL_USER_AGENT = 'InterviewPrepResearchBot/1.0';
export const RETRIEVAL_ACCEPT_HEADER = 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1';

export const RETRIEVAL_ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'text/plain',
  'application/xhtml+xml',
]);

export const RETRIEVAL_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

export const RETRIEVAL_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
