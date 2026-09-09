export type RetrySleep = (ms: number) => Promise<void>;

export type RetryRandom = () => number;

export type RetryWithBackoffOptions<T> = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs?: number;
  sleep?: RetrySleep;
  random?: RetryRandom;
  shouldRetry: (error: unknown, attempt: number) => boolean;
  getRetryAfterMs?: (error: unknown) => number | undefined;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  operation: (attempt: number) => Promise<T>;
};

const defaultSleep: RetrySleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// One shared bounded-retry helper: exponential backoff
// delay = min(maxDelayMs, baseDelayMs * 2^(attempt-1)) + jitter, with
// Retry-After honored as a floor ("wait at least Retry-After"). Callers own
// classification via shouldRetry; sleep/random inject for deterministic tests.
export const retryWithBackoff = async <T>(options: RetryWithBackoffOptions<T>): Promise<T> => {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const jitterMs = options.jitterMs ?? 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await options.operation(attempt);
    } catch (error) {
      if (attempt >= options.maxAttempts || !options.shouldRetry(error, attempt)) {
        throw error;
      }

      const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const jitter =
        jitterMs > 0 ? Math.floor(Math.min(Math.max(random(), 0), 0.999999) * jitterMs) : 0;
      const retryAfterMs = options.getRetryAfterMs?.(error);
      const delayMs =
        retryAfterMs === undefined ? backoff + jitter : Math.max(backoff + jitter, retryAfterMs);

      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
};
