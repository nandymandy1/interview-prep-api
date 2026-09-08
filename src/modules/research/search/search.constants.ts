export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_SEARCH_TIMEOUT_MS = 8_000;
export const BRAVE_SEARCH_MAX_RESPONSE_BYTES = 1024 * 1024;

// Small bounded retries for transient provider failures only. Deterministic
// client/config failures (400/401/403) are never retried.
export const MAX_SEARCH_ATTEMPTS = 2;

// Provider snippets are untrusted external content: bounded, whitespace
// normalized, and never stored as verified page text.
export const MAX_SEARCH_SNIPPET_CHARS = 1_000;

export const SEARCH_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
