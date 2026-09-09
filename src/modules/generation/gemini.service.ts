import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import { GeminiException } from '@/modules/generation/gemini.exception';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
export const GEMINI_TIMEOUT_MS = 60_000;
export const GEMINI_MAX_RESPONSE_BYTES = 1024 * 1024;

// Two attempts: provider/retrieval layers already bound their own retries,
// and replaying a full generation call wastes quota. Never retry 400/401/403.
export const MAX_GEMINI_ATTEMPTS = 2;
const GEMINI_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

const geminiPartSchema = z.object({ text: z.string().nullish() });
const geminiResponseSchema = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(geminiPartSchema) }) })),
});

export type GeminiHttpPost = (
  url: string,
  body: unknown,
) => Promise<{ status: number; data: unknown }>;

type GeminiServiceDependencies = {
  apiKey?: string;
  model?: string;
  logger: LoggerService;
  httpPost?: GeminiHttpPost;
  sleep?: (ms: number) => Promise<void>;
};

// The single LLM provider. Backend only; the key travels as a query param on
// a dedicated Axios instance and is never logged. Structured JSON output is
// requested from the model and every payload is Zod-validated by the caller.
export class GeminiService {
  private readonly httpPost: GeminiHttpPost;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: LoggerService;

  constructor(private readonly dependencies: GeminiServiceDependencies) {
    this.logger = dependencies.logger;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    let lastFailure: GeminiException | null = null;

    for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.httpPost(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        });

        if (response.status !== 200) {
          throw this.statusToException(response.status);
        }

        return this.parsePayload(response.data, schema);
      } catch (error) {
        const failure = this.normalizeError(error);

        if (!this.isRetryable(failure) || attempt >= MAX_GEMINI_ATTEMPTS) {
          throw failure;
        }

        lastFailure = failure;
        this.logger.warn('gemini.attempt_failed', { attempt, code: failure.code });
        await this.sleep(1000 * attempt);
      }
    }

    throw lastFailure ?? new GeminiException('GEMINI_NETWORK_ERROR', 'Gemini call failed.');
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

  private statusToException(status: number): GeminiException {
    if (status === 429) {
      return new GeminiException('GEMINI_RATE_LIMITED', 'Gemini rate-limited the request.', {
        status,
      });
    }

    return new GeminiException('GEMINI_HTTP_ERROR', `Gemini responded ${status}.`, { status });
  }

  private isRetryable(error: GeminiException): boolean {
    return (
      error.code === 'GEMINI_RATE_LIMITED' ||
      error.code === 'GEMINI_TIMEOUT' ||
      error.code === 'GEMINI_NETWORK_ERROR' ||
      (error.code === 'GEMINI_HTTP_ERROR' &&
        error.status !== undefined &&
        GEMINI_RETRYABLE_STATUSES.has(error.status))
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
        return { status: response.status, data: response.data as unknown };
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
