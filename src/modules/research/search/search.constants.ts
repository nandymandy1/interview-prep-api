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

// Brave plan limit is 2 requests/second. The safety interval keeps request
// *starts* (not completions) at least 600ms apart; queries run sequentially.
export const BRAVE_MIN_REQUEST_INTERVAL_MS = 600;

// Redis key for the tiny distributed request-start gate shared by every
// Brave HTTP attempt in web/worker contexts. TTL auto-releases a dead holder.
export const BRAVE_REQUEST_GATE_KEY = 'brave:request-gate';
