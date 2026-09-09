import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';
import { retryWithBackoff } from '@/common/retry/retry-with-backoff';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import { GeminiException } from '@/modules/generation/gemini.exception';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
export const GEMINI_TIMEOUT_MS = 60_000;
export const GEMINI_MAX_RESPONSE_BYTES = 1024 * 1024;

// Bounded retries equivalent to OpenAI: attempt 1 immediate, ~750ms +
// jitter, ~1500ms + jitter. Never retry 400/401/403.
export const MAX_GEMINI_ATTEMPTS = 3;
export const GEMINI_BASE_RETRY_DELAY_MS = 750;
export const GEMINI_MAX_RETRY_DELAY_MS = 10_000;
export const GEMINI_RETRY_JITTER_MS = 250;
const GEMINI_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

const GEMINI_TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ENOTCONN',
  'EAI_AGAIN',
  'ERR_NETWORK',
]);

const geminiPartSchema = z.object({ text: z.string().nullish() });
const geminiResponseSchema = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(geminiPartSchema) }) })),
});

export type GeminiHttpPost = (
  url: string,
  body: unknown,
  // Response headers cross the seam so Retry-After can be respected; the
  // request itself needs no headers (the key travels as a query param).
) => Promise<{ status: number; headers: Record<string, string>; data: unknown }>;

type GeminiServiceDependencies = {
  apiKey?: string;
  model?: string;
  logger: LoggerService;
  httpPost?: GeminiHttpPost;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

// The single LLM provider. Backend only; the key travels as a query param on
// a dedicated Axios instance and is never logged. Structured JSON output is
// requested from the model and every payload is Zod-validated by the caller.
export class GeminiService {
  private readonly httpPost: GeminiHttpPost;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: LoggerService;

  constructor(private readonly dependencies: GeminiServiceDependencies) {
    this.logger = dependencies.logger;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = dependencies.random ?? Math.random;
    this.httpPost = dependencies.httpPost ?? this.createDefaultHttpPost();
  }

  async generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
    const { apiKey, model } = this.dependencies;

    if (!apiKey || !model) {
      throw new GeminiException(
        'GEMINI_NOT_CONFIGURED',
        'Gemini generation is not configured (GEMINI_API_KEY/GEMINI_MODEL).',
      );
    }

    const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    return retryWithBackoff({
      maxAttempts: MAX_GEMINI_ATTEMPTS,
      baseDelayMs: GEMINI_BASE_RETRY_DELAY_MS,
      maxDelayMs: GEMINI_MAX_RETRY_DELAY_MS,
      jitterMs: GEMINI_RETRY_JITTER_MS,
      sleep: this.sleep,
      random: this.random,
      shouldRetry: (error) => this.isRetryable(this.normalizeError(error)),
      getRetryAfterMs: (error) => this.normalizeError(error).retryAfterMs,
      onRetry: ({ attempt, delayMs, error }) => {
        const failure = this.normalizeError(error);
        this.logger.warn('gemini.attempt_failed', {
          attempt,
          code: failure.code,
          retryDelayMs: delayMs,
        });
      },
      operation: async () => {
        const response = await this.httpPost(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        });

        if (response.status !== 200) {
          throw this.statusToException(response.status, response.headers);
        }

        return this.parsePayload(response.data, schema);
      },
    });
  }

  private parsePayload<T>(data: unknown, schema: z.ZodType<T>): T {
    const envelope = geminiResponseSchema.safeParse(data);

    if (!envelope.success) {
      throw new GeminiException('GEMINI_INVALID_RESPONSE', 'Gemini returned a malformed envelope.');
    }

    const text = envelope.data.candidates[0]?.content.parts.map((part) => part.text ?? '').join('');

    if (!text?.trim()) {
      throw new GeminiException('GEMINI_INVALID_RESPONSE', 'Gemini returned no text content.');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new GeminiException('GEMINI_INVALID_RESPONSE', 'Gemini did not return valid JSON.', {
        cause: error,
      });
    }

    const validated = schema.safeParse(parsed);

    if (!validated.success) {
      throw new GeminiException(
        'GEMINI_INVALID_RESPONSE',
        'Gemini JSON failed schema validation.',
        {
          cause: validated.error,
        },
      );
    }

    return validated.data;
  }

  private statusToException(status: number, headers: Record<string, string>): GeminiException {
    const retryAfterMs = parseRetryAfterMs(headers['retry-after']);

    if (status === 401 || status === 403) {
      return new GeminiException('LLM_AUTH_INVALID', 'Gemini rejected the API key.', { status });
    }

    if (status === 429) {
      return new GeminiException('GEMINI_RATE_LIMITED', 'Gemini rate-limited the request.', {
        status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    return new GeminiException('GEMINI_HTTP_ERROR', `Gemini responded ${status}.`, {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private isRetryable(error: GeminiException): boolean {
    if (error.code === 'LLM_AUTH_INVALID' || error.code === 'GEMINI_INVALID_RESPONSE') {
      return false;
    }

    if (error.code === 'GEMINI_RATE_LIMITED' || error.code === 'GEMINI_TIMEOUT') {
      return true;
    }

    if (error.code === 'GEMINI_NETWORK_ERROR') {
      return isTransientNetworkCause(error.cause);
    }

    return (
      error.code === 'GEMINI_HTTP_ERROR' &&
      error.status !== undefined &&
      GEMINI_RETRYABLE_STATUSES.has(error.status)
    );
  }

  private normalizeError(error: unknown): GeminiException {
    if (error instanceof GeminiException) {
      return error;
    }

    return new GeminiException('GEMINI_NETWORK_ERROR', 'A Gemini network failure occurred.', {
      cause: error,
    });
  }

  private createDefaultHttpPost(): GeminiHttpPost {
    const { apiKey } = this.dependencies;
    const instance: AxiosInstance = axios.create({
      timeout: GEMINI_TIMEOUT_MS,
      maxContentLength: GEMINI_MAX_RESPONSE_BYTES,
      maxBodyLength: GEMINI_MAX_RESPONSE_BYTES,
      responseType: 'json',
      validateStatus: () => true,
    });

    return async (url: string, body: unknown) => {
      try {
        const response = await instance.post(url, body, { params: { key: apiKey } });
        const headers: Record<string, string> = {};

        for (const [key, value] of Object.entries(response.headers ?? {})) {
          if (value !== undefined && value !== null) {
            headers[key.toLowerCase()] = Array.isArray(value)
              ? value.map((entry) => String(entry)).join(', ')
              : String(value);
          }
        }

        return { status: response.status, headers, data: response.data as unknown };
      } catch (error) {
        if (
          axios.isAxiosError(error) &&
          (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')
        ) {
          throw new GeminiException('GEMINI_TIMEOUT', 'The Gemini request timed out.', {
            cause: error,
          });
        }

        throw error;
      }
    };
  }
}

const parseRetryAfterMs = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  return undefined;
};

const isTransientNetworkCause = (cause: unknown): boolean => {
  if (cause === undefined || cause === null) {
    return true;
  }

  if (typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code !== 'string' || GEMINI_TRANSIENT_NETWORK_CODES.has(code);
  }

  return true;
};
