import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import {
  computeRetryDelayMs,
  parseRetryAfterMs,
  type Clock,
  type RandomSource,
  type Sleep,
} from '@/modules/research/retrieval/retrieval-client.service';
import { truncateText } from '@/modules/research/extraction/page-extraction.service';
import {
  BRAVE_SEARCH_ENDPOINT,
  BRAVE_SEARCH_MAX_RESPONSE_BYTES,
  BRAVE_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_ATTEMPTS,
  MAX_SEARCH_SNIPPET_CHARS,
  SEARCH_RETRYABLE_STATUSES,
} from '@/modules/research/search/search.constants';
import { SearchProviderException } from '@/modules/research/search/search.exception';
import type {
  PublicSearchProvider,
  PublicSearchQuery,
  PublicSearchResult,
} from '@/modules/research/search/search.type';

export type BraveHttpResponse = {
  status: number;
  headers: Record<string, string>;
  data: unknown;
};

export type BraveHttpGetter = (
  url: string,
  headers: Record<string, string>,
) => Promise<BraveHttpResponse>;

type BraveSearchProviderDependencies = {
  apiKey: string;
  logger: LoggerService;
  httpGet?: BraveHttpGetter;
  sleep?: Sleep;
  random?: RandomSource;
  now?: Clock;
};

const defaultSleep: Sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Brave web/search contract: GET with q + count, X-Subscription-Token auth,
// `{ web: { results: [{ title, url, description }] } }`. Only these three
// fields cross the provider boundary; everything vendor-specific stays here.
const braveResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().nullish(),
});

const braveResponseSchema = z.object({
  web: z
    .object({
      results: z.array(braveResultSchema),
    })
    .nullish(),
});

// The single real public search provider. The endpoint is fixed application
// configuration (never request input) and traffic stays on a dedicated Axios
// instance: provider JSON is trusted/fixed infrastructure, while page
// retrieval keeps the SSRF-oriented RetrievalClient.
export class BraveSearchProvider implements PublicSearchProvider {
  private readonly apiKey: string;
  private readonly logger: LoggerService;
  private readonly httpGet: BraveHttpGetter;
  private readonly sleep: Sleep;
  private readonly random: RandomSource;
  private readonly now: Clock;

  constructor(dependencies: BraveSearchProviderDependencies) {
    this.apiKey = dependencies.apiKey;
    this.logger = dependencies.logger;
    this.httpGet = dependencies.httpGet ?? this.createDefaultHttpGet();
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.random = dependencies.random ?? Math.random;
    this.now = dependencies.now ?? Date.now;
  }

  async search(input: PublicSearchQuery): Promise<PublicSearchResult[]> {
    const count = Math.max(1, Math.min(input.limit, 20));
    const url = `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(input.query)}&count=${count}`;
    const startedAt = this.now();
    let lastFailure: SearchProviderException | null = null;

    for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.httpGet(url, this.headers());

        if (response.status === 200) {
          const results = this.parseResults(response.data);

          this.logger.info('search.succeeded', {
            resultCount: results.length,
            attempt,
            durationMs: this.now() - startedAt,
          });

          return results;
        }

        throw this.statusToException(response.status, response.headers);
      } catch (error) {
        const failure = this.normalizeError(error);

        if (!this.isRetryable(failure) || attempt >= MAX_SEARCH_ATTEMPTS) {
          throw failure;
        }

        lastFailure = failure;

        this.logger.warn('search.attempt_failed', {
          attempt,
          code: failure.code,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
        });

        await this.sleep(this.retryDelayMs(attempt - 1, failure));
      }
    }

    throw (
      lastFailure ??
      new SearchProviderException('NETWORK_ERROR', 'Search failed without an attempt.')
    );
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': this.apiKey,
    };
  }

  private parseResults(data: unknown): PublicSearchResult[] {
    const parsed = braveResponseSchema.safeParse(data);

    if (!parsed.success) {
      throw new SearchProviderException(
        'INVALID_RESPONSE',
        'The search provider returned a malformed response.',
      );
    }

    return (parsed.data.web?.results ?? []).map((entry, index) => ({
      title: entry.title,
      url: entry.url,
      snippet: this.boundSnippet(entry.description ?? null),
      rank: index,
    }));
  }

  private boundSnippet(value: string | null): string | null {
    if (!value) {
      return null;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();

    if (!normalized) {
      return null;
    }

    return truncateText(normalized, MAX_SEARCH_SNIPPET_CHARS).text;
  }

  private statusToException(
    status: number,
    headers: Record<string, string>,
  ): SearchProviderException {
    const retryAfterMs =
      status === 429
        ? (parseRetryAfterMs(headers['retry-after'], this.now()) ?? undefined)
        : undefined;

    if (status === 429) {
      return new SearchProviderException('RATE_LIMITED', 'The search provider rate-limited.', {
        status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    return new SearchProviderException('HTTP_ERROR', `The search provider responded ${status}.`, {
      status,
    });
  }

  private isRetryable(error: SearchProviderException): boolean {
    if (
      error.code === 'RATE_LIMITED' ||
      error.code === 'TIMEOUT' ||
      error.code === 'NETWORK_ERROR'
    ) {
      return true;
    }

    return error.code === 'HTTP_ERROR' && error.status !== undefined
      ? SEARCH_RETRYABLE_STATUSES.has(error.status)
      : false;
  }

  private retryDelayMs(retryIndex: number, failure: SearchProviderException): number {
    const backoff = computeRetryDelayMs(retryIndex, this.random());

    if (failure.retryAfterMs === undefined) {
      return backoff;
    }

    return Math.max(backoff, failure.retryAfterMs);
  }

  private normalizeError(error: unknown): SearchProviderException {
    if (error instanceof SearchProviderException) {
      return error;
    }

    return new SearchProviderException('NETWORK_ERROR', 'A search network failure occurred.', {
      cause: error,
    });
  }

  private createDefaultHttpGet(): BraveHttpGetter {
    const instance: AxiosInstance = axios.create({
      timeout: BRAVE_SEARCH_TIMEOUT_MS,
      maxContentLength: BRAVE_SEARCH_MAX_RESPONSE_BYTES,
      maxBodyLength: BRAVE_SEARCH_MAX_RESPONSE_BYTES,
      responseType: 'json',
      validateStatus: () => true,
    });

    return async (url: string, headers: Record<string, string>): Promise<BraveHttpResponse> => {
      try {
        const response = await instance.get(url, { headers });
        return {
          status: response.status,
          headers: this.lowerHeaders(response.headers),
          data: response.data,
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          if (error.response) {
            return {
              status: error.response.status,
              headers: this.lowerHeaders(error.response.headers),
              data: error.response.data,
            };
          }

          const code = error.code ?? '';

          if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
            throw new SearchProviderException('TIMEOUT', 'The search request timed out.', {
              cause: error,
            });
          }
        }

        throw new SearchProviderException('NETWORK_ERROR', 'A search network failure occurred.', {
          cause: error,
        });
      }
    };
  }

  private lowerHeaders(headers: unknown): Record<string, string> {
    if (typeof headers !== 'object' || headers === null) {
      return {};
    }

    const normalized: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value !== undefined && value !== null) {
        normalized[key.toLowerCase()] = Array.isArray(value)
          ? value.map((entry) => String(entry)).join(', ')
          : String(value);
      }
    }

    return normalized;
  }
}
