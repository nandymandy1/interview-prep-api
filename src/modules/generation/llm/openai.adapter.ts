import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';
import { retryWithBackoff } from '@/common/retry/retry-with-backoff';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { LlmGenerationAdapter, LlmJsonRequest } from '@/modules/generation/llm/llm-adapter';

export const OPENAI_API_BASE = 'https://api.openai.com';
export const OPENAI_TIMEOUT_MS = 60_000;
export const OPENAI_MAX_RESPONSE_BYTES = 1024 * 1024;
// Bounded retries: attempt 1 immediate, ~750ms + jitter, ~1500ms + jitter.
export const MAX_OPENAI_ATTEMPTS = 3;
export const OPENAI_BASE_RETRY_DELAY_MS = 750;
export const OPENAI_MAX_RETRY_DELAY_MS = 10_000;
export const OPENAI_RETRY_JITTER_MS = 250;

const OPENAI_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

// Transient axios/network codes only. Auth/client errors (400/401/403) and
// domain validation failures are never retried.
const OPENAI_TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ENOTCONN',
  'EAI_AGAIN',
  'ERR_NETWORK',
]);

export type OpenAiExceptionCode =
  | 'OPENAI_NOT_CONFIGURED'
  | 'OPENAI_HTTP_ERROR'
  | 'OPENAI_RATE_LIMITED'
  | 'OPENAI_TIMEOUT'
  | 'OPENAI_NETWORK_ERROR'
  | 'OPENAI_INVALID_RESPONSE'
  | 'LLM_AUTH_INVALID';

export class OpenAiException extends Error {
  readonly code: OpenAiExceptionCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: OpenAiExceptionCode,
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

const openAiResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullish() }),
    }),
  ),
});

export type OpenAiHttpPost = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
) => Promise<{ status: number; headers: Record<string, string>; data: unknown }>;

type OpenAiGenerationAdapterDependencies = {
  apiKey?: string;
  model?: string;
  logger: LoggerService;
  httpPost?: OpenAiHttpPost;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// OpenAI chat-completions adapter: structured JSON via response_format, never
// logs the key or Authorization header. No InterviewKit knowledge here.
export class OpenAiGenerationAdapter implements LlmGenerationAdapter {
  readonly provider = 'openai' as const;
  private readonly httpPost: OpenAiHttpPost;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: LoggerService;

  constructor(private readonly dependencies: OpenAiGenerationAdapterDependencies) {
    this.logger = dependencies.logger;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.random = dependencies.random ?? Math.random;
    this.httpPost = dependencies.httpPost ?? this.createDefaultHttpPost();
  }

  async generateJson<T>(request: LlmJsonRequest, schema: z.ZodType<T>): Promise<T> {
    const { apiKey, model } = this.dependencies;

    if (!apiKey || !model) {
      throw new OpenAiException(
        'OPENAI_NOT_CONFIGURED',
        'OpenAI generation is not configured (OPENAI_API_KEY/OPENAI_MODEL).',
      );
    }

    const url = `${OPENAI_API_BASE}/v1/chat/completions`;

    // HTTP transient failures retry here (max 3). Successful HTTP with
    // invalid JSON/schema gets at most one corrective call from the pipeline
    // layer — never nested inside these attempts.
    return retryWithBackoff({
      maxAttempts: MAX_OPENAI_ATTEMPTS,
      baseDelayMs: OPENAI_BASE_RETRY_DELAY_MS,
      maxDelayMs: OPENAI_MAX_RETRY_DELAY_MS,
      jitterMs: OPENAI_RETRY_JITTER_MS,
      sleep: this.sleep,
      random: this.random,
      shouldRetry: (error) => this.isRetryable(this.normalizeError(error)),
      getRetryAfterMs: (error) => this.normalizeError(error).retryAfterMs,
      onRetry: ({ attempt, delayMs, error }) => {
        const failure = this.normalizeError(error);
        this.logger.warn('openai.attempt_failed', {
          attempt,
          code: failure.code,
          retryDelayMs: delayMs,
        });
      },
      operation: async () => {
        const response = await this.httpPost(
          url,
          {
            model,
            messages: [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          },
          { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        );

        if (response.status !== 200) {
          throw this.statusToException(response.status, response.headers);
        }

        return this.parsePayload(response.data, schema);
      },
    });
  }

  private parsePayload<T>(data: unknown, schema: z.ZodType<T>): T {
    const envelope = openAiResponseSchema.safeParse(data);

    if (!envelope.success) {
      throw new OpenAiException('OPENAI_INVALID_RESPONSE', 'OpenAI returned a malformed envelope.');
    }

    const text = envelope.data.choices[0]?.message.content;

    if (!text?.trim()) {
      throw new OpenAiException('OPENAI_INVALID_RESPONSE', 'OpenAI returned no text content.');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new OpenAiException('OPENAI_INVALID_RESPONSE', 'OpenAI did not return valid JSON.', {
        cause: error,
      });
    }

    const validated = schema.safeParse(parsed);

    if (!validated.success) {
      throw new OpenAiException(
        'OPENAI_INVALID_RESPONSE',
        'OpenAI JSON failed schema validation.',
        { cause: validated.error },
      );
    }

    return validated.data;
  }

  private statusToException(status: number, headers: Record<string, string>): OpenAiException {
    const retryAfterMs = parseRetryAfterMs(headers['retry-after']);

    // Authentication is validated on first real provider call, never at boot
    // (no paid call per startup). 401/403 normalize to LLM_AUTH_INVALID and
    // are never retried.
    if (status === 401 || status === 403) {
      return new OpenAiException('LLM_AUTH_INVALID', 'OpenAI rejected the API key.', { status });
    }

    if (status === 429) {
      return new OpenAiException('OPENAI_RATE_LIMITED', 'OpenAI rate-limited the request.', {
        status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    return new OpenAiException('OPENAI_HTTP_ERROR', `OpenAI responded ${status}.`, {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private isRetryable(error: OpenAiException): boolean {
    if (error.code === 'LLM_AUTH_INVALID' || error.code === 'OPENAI_INVALID_RESPONSE') {
      return false;
    }

    if (error.code === 'OPENAI_RATE_LIMITED' || error.code === 'OPENAI_TIMEOUT') {
      return true;
    }

    if (error.code === 'OPENAI_NETWORK_ERROR') {
      return isTransientNetworkCause(error.cause);
    }

    return (
      error.code === 'OPENAI_HTTP_ERROR' &&
      error.status !== undefined &&
      OPENAI_RETRYABLE_STATUSES.has(error.status)
    );
  }

  private normalizeError(error: unknown): OpenAiException {
    if (error instanceof OpenAiException) {
      return error;
    }

    return new OpenAiException('OPENAI_NETWORK_ERROR', 'An OpenAI network failure occurred.', {
      cause: error,
    });
  }

  private createDefaultHttpPost(): OpenAiHttpPost {
    const instance: AxiosInstance = axios.create({
      timeout: OPENAI_TIMEOUT_MS,
      maxContentLength: OPENAI_MAX_RESPONSE_BYTES,
      maxBodyLength: OPENAI_MAX_RESPONSE_BYTES,
      responseType: 'json',
      validateStatus: () => true,
    });

    return async (url: string, body: unknown, headers: Record<string, string>) => {
      try {
        const response = await instance.post(url, body, { headers });
        const normalized: Record<string, string> = {};

        for (const [key, value] of Object.entries(response.headers ?? {})) {
          if (value !== undefined && value !== null) {
            normalized[key.toLowerCase()] = Array.isArray(value)
              ? value.map((entry) => String(entry)).join(', ')
              : String(value);
          }
        }

        return { status: response.status, headers: normalized, data: response.data as unknown };
      } catch (error) {
        if (
          axios.isAxiosError(error) &&
          (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')
        ) {
          throw new OpenAiException('OPENAI_TIMEOUT', 'The OpenAI request timed out.', {
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

// Only transient network failures retry. A missing code is treated as a
// temporary network failure (DNS/TLS/unknown transport error); anything else
// (config, client misuse) fails fast.
const isTransientNetworkCause = (cause: unknown): boolean => {
  if (cause === undefined || cause === null) {
    return true;
  }

  if (typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code !== 'string' || OPENAI_TRANSIENT_NETWORK_CODES.has(code);
  }

  return true;
};
