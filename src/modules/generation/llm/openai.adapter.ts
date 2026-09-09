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
  | 'OPENAI_PROJECT_LIMIT_EXCEEDED'
  | 'OPENAI_ORG_LIMIT_EXCEEDED'
  | 'OPENAI_CREDITS_EXHAUSTED'
  | 'OPENAI_PROVIDER_ERROR'
  | 'OPENAI_TIMEOUT'
  | 'OPENAI_NETWORK_ERROR'
  | 'OPENAI_INVALID_RESPONSE'
  | 'LLM_AUTH_INVALID';

export type OpenAiRateLimit = {
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequests?: number;
  resetTokens?: number;
};

export class OpenAiException extends Error {
  readonly code: OpenAiExceptionCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly providerErrorCode?: string;
  readonly providerErrorType?: string;
  readonly providerErrorParam?: string;
  readonly providerErrorMessage?: string;
  readonly requestId?: string;
  readonly rateLimit?: OpenAiRateLimit;

  constructor(
    code: OpenAiExceptionCode,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      providerErrorCode?: string;
      providerErrorType?: string;
      providerErrorParam?: string;
      providerErrorMessage?: string;
      requestId?: string;
      rateLimit?: OpenAiRateLimit;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.providerErrorCode = options.providerErrorCode;
    this.providerErrorType = options.providerErrorType;
    this.providerErrorParam = options.providerErrorParam;
    this.providerErrorMessage = options.providerErrorMessage;
    this.requestId = options.requestId;
    this.rateLimit = options.rateLimit;

    Error.captureStackTrace?.(this, new.target);
  }
}

const openAiProviderErrorSchema = z.object({
  error: z
    .object({
      code: z.string().nullish(),
      type: z.string().nullish(),
      param: z.string().nullish(),
      message: z.string().nullish(),
    })
    .nullish(),
});

type OpenAiProviderError = {
  code?: string;
  type?: string;
  param?: string;
  message?: string;
};

// Only safe scalar fields of the provider error envelope: code/type plus the
// offending param and a truncated provider message. The browser still gets
// only the normalized safe message; these fields exist for server logs.
const extractProviderError = (data: unknown): OpenAiProviderError => {
  const parsed = openAiProviderErrorSchema.safeParse(data);

  if (!parsed.success) {
    return {};
  }

  const error = parsed.data.error;

  return {
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.type ? { type: error.type } : {}),
    ...(error?.param ? { param: error.param } : {}),
    ...(error?.message ? { message: error.message.slice(0, 300) } : {}),
  };
};

// Quota/billing/spend signals fail fast and are never retried. Pure RPM/TPM
// signals (rate_limit_exceeded, requests/tokens per minute) stay transient:
// they carry no quota/billing/credit/spend/payment wording.
const classifyQuotaError = (provider: OpenAiProviderError): OpenAiExceptionCode | undefined => {
  const combined = `${provider.code ?? ''} ${provider.type ?? ''}`.toLowerCase();

  if (!/quota|billing|credit|spend|payment|balance/.test(combined)) {
    return undefined;
  }

  if (/project/.test(combined)) {
    return 'OPENAI_PROJECT_LIMIT_EXCEEDED';
  }

  if (/org/.test(combined)) {
    return 'OPENAI_ORG_LIMIT_EXCEEDED';
  }

  return 'OPENAI_CREDITS_EXHAUSTED';
};

const OPENAI_SAFE_MESSAGES: Record<OpenAiExceptionCode, string> = {
  OPENAI_NOT_CONFIGURED: 'OpenAI generation is not configured (OPENAI_API_KEY/OPENAI_MODEL).',
  OPENAI_HTTP_ERROR: 'OpenAI returned an error while generating the kit.',
  OPENAI_RATE_LIMITED: 'OpenAI is temporarily rate-limiting requests. Please retry in a moment.',
  OPENAI_PROJECT_LIMIT_EXCEEDED:
    'OpenAI usage limit or billing quota was reached for the configured project.',
  OPENAI_ORG_LIMIT_EXCEEDED:
    'OpenAI usage limit or billing quota was reached for the configured organization.',
  OPENAI_CREDITS_EXHAUSTED: 'OpenAI billing quota was exhausted.',
  OPENAI_PROVIDER_ERROR: 'OpenAI returned an error while generating the kit.',
  OPENAI_TIMEOUT: 'The OpenAI request timed out.',
  OPENAI_NETWORK_ERROR: 'An OpenAI network failure occurred.',
  OPENAI_INVALID_RESPONSE: 'OpenAI returned an unexpected response.',
  LLM_AUTH_INVALID: 'OpenAI credentials are invalid or unavailable.',
};

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
    try {
      return await retryWithBackoff({
        maxAttempts: MAX_OPENAI_ATTEMPTS,
        baseDelayMs: OPENAI_BASE_RETRY_DELAY_MS,
        maxDelayMs: OPENAI_MAX_RETRY_DELAY_MS,
        jitterMs: OPENAI_RETRY_JITTER_MS,
        sleep: this.sleep,
        random: this.random,
        shouldRetry: (error) => this.isRetryable(this.normalizeError(error)),
        getRetryAfterMs: (error) => this.normalizeError(error).retryAfterMs,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn('openai.attempt_failed', {
            ...this.safeLogFields(this.normalizeError(error)),
            attempt,
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
            },
            { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          );

          if (response.status !== 200) {
            throw this.statusToException(response.status, response.headers, response.data);
          }

          return this.parsePayload(response.data, schema);
        },
      });
    } catch (error) {
      // Final failure: one structured warning with safe provider fields only.
      // Never the key, Authorization header, request body, or JD.
      this.logger.warn('openai.request_failed', this.safeLogFields(this.normalizeError(error)));
      throw error;
    }
  }

  // Safe log shape: provider status/code/type/param, truncated provider
  // message, request id, Retry-After, and rate-limit counters. Nothing
  // secret (no key, Authorization, prompts, or JD), no raw payloads.
  private safeLogFields(failure: OpenAiException): Record<string, unknown> {
    return {
      provider: 'openai',
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      code: failure.code,
      ...(failure.providerErrorCode !== undefined
        ? { providerErrorCode: failure.providerErrorCode }
        : {}),
      ...(failure.providerErrorType !== undefined
        ? { providerErrorType: failure.providerErrorType }
        : {}),
      ...(failure.providerErrorParam !== undefined
        ? { providerErrorParam: failure.providerErrorParam }
        : {}),
      ...(failure.providerErrorMessage !== undefined
        ? { providerErrorMessage: failure.providerErrorMessage }
        : {}),
      ...(failure.requestId !== undefined ? { requestId: failure.requestId } : {}),
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      ...(failure.rateLimit !== undefined
        ? {
            rateLimit: {
              ...(failure.rateLimit.remainingRequests !== undefined
                ? { remainingRequests: failure.rateLimit.remainingRequests }
                : {}),
              ...(failure.rateLimit.remainingTokens !== undefined
                ? { remainingTokens: failure.rateLimit.remainingTokens }
                : {}),
              ...(failure.rateLimit.resetRequests !== undefined
                ? { resetRequests: failure.rateLimit.resetRequests }
                : {}),
              ...(failure.rateLimit.resetTokens !== undefined
                ? { resetTokens: failure.rateLimit.resetTokens }
                : {}),
            },
          }
        : {}),
    };
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

  private statusToException(
    status: number,
    headers: Record<string, string>,
    data: unknown,
  ): OpenAiException {
    const retryAfterMs = parseRetryAfterMs(headers['retry-after']);
    const provider = extractProviderError(data);
    const quotaCode = classifyQuotaError(provider);
    const shared = {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(provider.code !== undefined ? { providerErrorCode: provider.code } : {}),
      ...(provider.type !== undefined ? { providerErrorType: provider.type } : {}),
      ...(provider.param !== undefined ? { providerErrorParam: provider.param } : {}),
      ...(provider.message !== undefined ? { providerErrorMessage: provider.message } : {}),
      ...(headers['x-request-id'] !== undefined ? { requestId: headers['x-request-id'] } : {}),
      ...rateLimitOf(headers),
    };

    // Quota/billing/spend errors fail fast on any status — never retried.
    if (quotaCode) {
      return new OpenAiException(quotaCode, OPENAI_SAFE_MESSAGES[quotaCode], shared);
    }

    // Authentication is validated on first real provider call, never at boot
    // (no paid call per startup). 401/403 normalize to LLM_AUTH_INVALID and
    // are never retried.
    if (status === 401 || status === 403) {
      return new OpenAiException('LLM_AUTH_INVALID', OPENAI_SAFE_MESSAGES.LLM_AUTH_INVALID, shared);
    }

    if (status === 429) {
      return new OpenAiException(
        'OPENAI_RATE_LIMITED',
        OPENAI_SAFE_MESSAGES.OPENAI_RATE_LIMITED,
        shared,
      );
    }

    if (status >= 500) {
      return new OpenAiException(
        'OPENAI_HTTP_ERROR',
        OPENAI_SAFE_MESSAGES.OPENAI_HTTP_ERROR,
        shared,
      );
    }

    // Any other provider error status carries the provider payload marker so
    // the failure stays distinguishable from transport-level HTTP errors.
    if (provider.code ?? provider.type) {
      return new OpenAiException(
        'OPENAI_PROVIDER_ERROR',
        OPENAI_SAFE_MESSAGES.OPENAI_PROVIDER_ERROR,
        shared,
      );
    }

    return new OpenAiException('OPENAI_HTTP_ERROR', OPENAI_SAFE_MESSAGES.OPENAI_HTTP_ERROR, shared);
  }

  private isRetryable(error: OpenAiException): boolean {
    if (
      error.code === 'LLM_AUTH_INVALID' ||
      error.code === 'OPENAI_INVALID_RESPONSE' ||
      error.code === 'OPENAI_NOT_CONFIGURED' ||
      error.code === 'OPENAI_PROJECT_LIMIT_EXCEEDED' ||
      error.code === 'OPENAI_ORG_LIMIT_EXCEEDED' ||
      error.code === 'OPENAI_CREDITS_EXHAUSTED' ||
      error.code === 'OPENAI_PROVIDER_ERROR'
    ) {
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

// Safe numeric rate-limit counters only. Counts parse as plain numbers;
// reset values accept OpenAI's duration suffixes (ms/s/m) normalized to ms.
// Unparseable values are dropped, never logged raw.
const rateLimitOf = (headers: Record<string, string>): { rateLimit?: OpenAiRateLimit } => {
  const remainingRequests = parseHeaderCount(headers['x-ratelimit-remaining-requests']);
  const remainingTokens = parseHeaderCount(headers['x-ratelimit-remaining-tokens']);
  const resetRequests = parseHeaderReset(headers['x-ratelimit-reset-requests']);
  const resetTokens = parseHeaderReset(headers['x-ratelimit-reset-tokens']);

  const rateLimit: OpenAiRateLimit = {
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(resetRequests !== undefined ? { resetRequests } : {}),
    ...(resetTokens !== undefined ? { resetTokens } : {}),
  };

  return Object.keys(rateLimit).length > 0 ? { rateLimit } : {};
};

const parseHeaderCount = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  return undefined;
};

const parseHeaderReset = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const plain = Number(value);

  if (Number.isFinite(plain) && plain >= 0) {
    return plain;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/.exec(value.trim().toLowerCase());

  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2] === 'ms' ? 1 : match[2] === 's' ? 1000 : 60_000;

  return amount * unit;
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
