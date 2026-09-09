import { describe, expect, it, vi } from 'vitest';
import { retryWithBackoff } from '@/common/retry/retry-with-backoff';

describe('retryWithBackoff', () => {
  it('returns the first success without sleeping', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const operation = vi.fn(async () => 'ok');

    const result = await retryWithBackoff({
      maxAttempts: 3,
      baseDelayMs: 750,
      maxDelayMs: 10_000,
      sleep,
      random: () => 0,
      shouldRetry: () => true,
      operation,
    });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('backs off exponentially (750, 1500) with jitter and stops at maxAttempts', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const onRetry: { attempt: number; delayMs: number }[] = [];
    const operation = vi.fn(async () => {
      throw new Error('transient');
    });

    await expect(
      retryWithBackoff({
        maxAttempts: 3,
        baseDelayMs: 750,
        maxDelayMs: 10_000,
        jitterMs: 250,
        sleep,
        random: () => 0.5,
        shouldRetry: () => true,
        onRetry: (info) => {
          onRetry.push({ attempt: info.attempt, delayMs: info.delayMs });
        },
        operation,
      }),
    ).rejects.toThrow('transient');

    expect(operation).toHaveBeenCalledTimes(3);
    // attempt 1 → 750 + 125 jitter; attempt 2 → 1500 + 125 jitter.
    expect(delays).toEqual([875, 1625]);
    expect(onRetry.map((entry) => entry.attempt)).toEqual([1, 2]);
  });

  it('caps the delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const operation = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      retryWithBackoff({
        maxAttempts: 4,
        baseDelayMs: 5_000,
        maxDelayMs: 8_000,
        sleep,
        random: () => 0,
        shouldRetry: () => true,
        operation,
      }),
    ).rejects.toThrow('boom');

    expect(delays).toEqual([5_000, 8_000, 8_000]);
  });

  it('honors Retry-After as a floor above the computed backoff', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let attempts = 0;
    const operation = vi.fn(async () => {
      attempts += 1;

      if (attempts === 1) {
        const error = new Error('limited') as Error & { retryAfterMs: number };
        error.retryAfterMs = 5_000;
        throw error;
      }

      return 'recovered';
    });

    const result = await retryWithBackoff({
      maxAttempts: 3,
      baseDelayMs: 750,
      maxDelayMs: 10_000,
      jitterMs: 250,
      sleep,
      random: () => 0,
      shouldRetry: () => true,
      getRetryAfterMs: (error: unknown) => (error as { retryAfterMs?: number }).retryAfterMs,
      operation,
    });

    expect(result).toBe('recovered');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(delays[0]).toBe(5_000);
  });

  it('never retries when shouldRetry refuses (auth/client failure)', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const operation = vi.fn(async () => {
      throw new Error('unauthorized');
    });

    await expect(
      retryWithBackoff({
        maxAttempts: 3,
        baseDelayMs: 750,
        maxDelayMs: 10_000,
        sleep,
        random: () => 0,
        shouldRetry: () => false,
        operation,
      }),
    ).rejects.toThrow('unauthorized');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
