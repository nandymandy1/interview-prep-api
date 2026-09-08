import axios, { type AxiosInstance } from 'axios';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import {
  MAX_RETRIEVAL_BYTES,
  RETRIEVAL_ACCEPT_HEADER,
  RETRIEVAL_ALLOWED_CONTENT_TYPES,
  RETRIEVAL_BASE_RETRY_DELAY_MS,
  RETRIEVAL_JITTER_MS,
  RETRIEVAL_MAX_ATTEMPTS,
  RETRIEVAL_MAX_REDIRECTS,
  RETRIEVAL_MAX_RETRY_DELAY_MS,
  RETRIEVAL_MAX_RETRY_WAIT_MS,
  RETRIEVAL_REDIRECT_STATUSES,
  RETRIEVAL_RETRYABLE_STATUSES,
  RETRIEVAL_TIMEOUT_MS,
  RETRIEVAL_USER_AGENT,
} from '@/modules/research/retrieval/retrieval.constants';
import {
  RetrievalException,
  toRetrievalResult,
  type RetrievedResource,
  type RetrievalMode,
  type RetrievalRequest,
  type RetrievalResult,
} from '@/modules/research/retrieval/retrieval.type';
import type { UrlSafetyService } from '@/modules/research/retrieval/url-safety.service';

export type RetrievalHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type HttpGetter = (url: string) => Promise<RetrievalHttpResponse>;

export type Sleep = (ms: number) => Promise<void>;

export type RandomSource = () => number;

type RetrievalClientDependencies = {
  urlSafety: UrlSafetyService;
  logger: LoggerService;
  httpGet?: HttpGetter;
  sleep?: Sleep;
  random?: RandomSource;
  timeoutMs?: number;
};

const defaultSleep: Sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Pure delay helper: exponential backoff capped at RETRIEVAL_MAX_RETRY_DELAY_MS
// plus bounded jitter in [0, RETRIEVAL_JITTER_MS). retryIndex is 0-based, so
// the first retry waits ~base and the second ~2x base. randomValue ∈ [0, 1).
export const computeRetryDelayMs = (retryIndex: number, randomValue: number): number => {
  const exponential = RETRIEVAL_BASE_RETRY_DELAY_MS * 2 ** Math.max(0, retryIndex);
  const capped = Math.min(exponential, RETRIEVAL_MAX_RETRY_DELAY_MS);
  const jitter = Math.floor(Math.min(Math.max(randomValue, 0), 0.999999) * RETRIEVAL_JITTER_MS);
  return capped + jitter;
};

// Parses Retry-After (integer seconds or HTTP-date) into a bounded wait in ms.
// Returns null when the header is absent or unparseable.
export const parseRetryAfterMs = (value: string | undefined, nowMs: number): number | null => {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (/^\d{1,9}$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, RETRIEVAL_MAX_RETRY_WAIT_MS);
  }

  const timestamp = Date.parse(trimmed);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.min(Math.max(timestamp - nowMs, 0), RETRIEVAL_MAX_RETRY_WAIT_MS);
};

const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ENOTCONN',
  'EAI_AGAIN',
  'ERR_NETWORK',
]);

const isRetryableException = (error: RetrievalException): boolean => {
  if (error.code === 'TIMEOUT' || error.code === 'RATE_LIMITED' || error.code === 'NETWORK_ERROR') {
    return true;
  }

  if (error.code === 'HTTP_ERROR' && error.status !== undefined) {
    return RETRIEVAL_RETRYABLE_STATUSES.has(error.status);
  }

  return false;
};

export class RetrievalClient {
  private readonly urlSafety: UrlSafetyService;
  private readonly logger: LoggerService;
  private readonly httpGet: HttpGetter;
  private readonly sleep: Sleep;
  private readonly random: RandomSource;
  private readonly timeoutMs: number;

  constructor(dependencies: RetrievalClientDependencies) {
    this.urlSafety = dependencies.urlSafety;
    this.logger = dependencies.logger;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.random = dependencies.random ?? Math.random;
    this.timeoutMs = dependencies.timeoutMs ?? RETRIEVAL_TIMEOUT_MS;
    this.httpGet = dependencies.httpGet ?? this.createDefaultHttpGet();
  }

  // Boundary helper: expected source failures become data for the later
  // crawler/orchestrator instead of killing the pipeline.
  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    try {
      const resource = await this.fetchResource(request);
      return { ok: true, resource };
    } catch (error) {
      if (error instanceof RetrievalException) {
        return toRetrievalResult(error);
      }

      this.logger.error(error, 'retrieval.unexpected_failure', {
        url: this.sanitize(request.url),
      });

      return toRetrievalResult(
        new RetrievalException('NETWORK_ERROR', 'Unexpected retrieval failure.', {
          url: this.sanitize(request.url),
          cause: error,
        }),
      );
    }
  }

  private async fetchResource(request: RetrievalRequest): Promise<RetrievedResource> {
    const start = await this.urlSafety.validateUrl(request.url, request.mode);
    let lastFailure: RetrievalException | null = null;

    for (let attempt = 1; attempt <= RETRIEVAL_MAX_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();

      try {
        const resource = await this.fetchOnce(start, request.mode, attempt);
        return resource;
      } catch (error) {
        const failure = this.normalizeTransportError(error, start.toString());

        this.logger.warn('retrieval.attempt_failed', {
          url: this.sanitize(start.toString()),
          mode: request.mode,
          attempt,
          code: failure.code,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          durationMs: Date.now() - startedAt,
        });

        if (!isRetryableException(failure) || attempt >= RETRIEVAL_MAX_ATTEMPTS) {
          throw failure;
        }

        lastFailure = failure;
        await this.sleep(this.retryDelayMs(attempt - 1, failure));
      }
    }

    throw (
      lastFailure ??
      new RetrievalException('NETWORK_ERROR', 'Retrieval failed without an attempt.', {
        url: start.toString(),
      })
    );
  }

  // One attempt: manual redirect chain so every destination is revalidated.
  private async fetchOnce(
    start: URL,
    mode: RetrievalMode,
    attempt: number,
  ): Promise<RetrievedResource> {
    let current = new URL(start.toString());

    for (let redirect = 0; ; redirect += 1) {
      await this.urlSafety.assertHostAllowed(current.hostname, mode);

      const startedAt = Date.now();
      const response = await this.httpGet(current.toString());

      this.logger.debug('retrieval.response', {
        url: this.sanitize(current.toString()),
        attempt,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });

      if (RETRIEVAL_REDIRECT_STATUSES.has(response.status)) {
        if (redirect >= RETRIEVAL_MAX_REDIRECTS) {
          throw new RetrievalException(
            'TOO_MANY_REDIRECTS',
            `Exceeded ${RETRIEVAL_MAX_REDIRECTS} redirects.`,
            { url: current.toString() },
          );
        }

        const location = response.headers['location'];

        if (!location) {
          throw new RetrievalException('HTTP_ERROR', `Redirect without a location header.`, {
            url: current.toString(),
            status: response.status,
          });
        }

        let next: URL;

        try {
          next = new URL(location, current.toString());
        } catch (error) {
          throw new RetrievalException('INVALID_URL', 'Redirect location is malformed.', {
            url: current.toString(),
            cause: error,
          });
        }

        // Reuse shape policy (protocol allow-list, credential rejection) then
        // re-run DNS/address policy at the top of the next loop iteration.
        this.urlSafety.normalizeUrl(next.toString());
        next.hash = '';

        this.logger.info('retrieval.redirect', {
          url: this.sanitize(current.toString()),
          destination: this.sanitize(next.toString()),
          status: response.status,
        });

        current = next;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw this.httpStatusToException(response, current.toString());
      }

      return this.toResource(response, start.toString(), current.toString());
    }
  }

  private toResource(
    response: RetrievalHttpResponse,
    requestedUrl: string,
    finalUrl: string,
  ): RetrievedResource {
    const contentType = this.parseContentType(response.headers['content-type'], finalUrl);
    const bytes = Buffer.byteLength(response.body, 'utf8');

    if (bytes > MAX_RETRIEVAL_BYTES) {
      throw new RetrievalException(
        'RESPONSE_TOO_LARGE',
        `Response body of ${bytes} bytes exceeds the ${MAX_RETRIEVAL_BYTES} byte limit.`,
        { url: finalUrl },
      );
    }

    return {
      requestedUrl,
      finalUrl,
      status: response.status,
      contentType,
      body: response.body,
      bytes,
    };
  }

  private parseContentType(header: string | undefined, url: string): string {
    const mime = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

    if (!mime || !RETRIEVAL_ALLOWED_CONTENT_TYPES.has(mime)) {
      throw new RetrievalException(
        'UNSUPPORTED_CONTENT_TYPE',
        `Content type "${header ?? 'missing'}" is not supported.`,
        { url },
      );
    }

    return mime;
  }

  private httpStatusToException(response: RetrievalHttpResponse, url: string): RetrievalException {
    const retryAfterMs =
      response.status === 429 || response.status === 503
        ? (parseRetryAfterMs(response.headers['retry-after'], Date.now()) ?? undefined)
        : undefined;

    if (response.status === 429) {
      return new RetrievalException('RATE_LIMITED', 'Remote server rate-limited the request.', {
        url,
        status: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    return new RetrievalException('HTTP_ERROR', `Remote server responded ${response.status}.`, {
      url,
      status: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private retryDelayMs(retryIndex: number, failure: RetrievalException): number {
    const backoff = computeRetryDelayMs(retryIndex, this.random());

    if (failure.retryAfterMs === undefined) {
      return backoff;
    }

    return Math.min(RETRIEVAL_MAX_RETRY_WAIT_MS, Math.max(backoff, failure.retryAfterMs));
  }

  // Maps Axios transport errors to structured codes. HTTP statuses are handled
  // by the caller; this covers timeouts, size aborts, and connection failures.
  private normalizeTransportError(error: unknown, url: string): RetrievalException {
    if (error instanceof RetrievalException) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      const code = error.code ?? '';

      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return new RetrievalException('TIMEOUT', 'The request timed out.', { url, cause: error });
      }

      if (/maxContentLength|maxBodyLength/i.test(error.message)) {
        return new RetrievalException(
          'RESPONSE_TOO_LARGE',
          'The response exceeded the maximum allowed size.',
          { url, cause: error },
        );
      }

      if (error.response) {
        return this.httpStatusToException(
          {
            status: error.response.status,
            headers: this.normalizeHeaders(error.response.headers),
            body: '',
          },
          url,
        );
      }

      return new RetrievalException('NETWORK_ERROR', `Network failure (${code || 'unknown'}).`, {
        url,
        cause: error,
      });
    }

    if (
      error instanceof Error &&
      TRANSIENT_NETWORK_CODES.has((error as { code?: string }).code ?? '')
    ) {
      return new RetrievalException('NETWORK_ERROR', 'A transient network failure occurred.', {
        url,
        cause: error,
      });
    }

    if (error instanceof Error) {
      return new RetrievalException('NETWORK_ERROR', 'A network error occurred.', {
        url,
        cause: error,
      });
    }

    return new RetrievalException('NETWORK_ERROR', 'A network error occurred.', {
      url,
      cause: error,
    });
  }

  private normalizeHeaders(headers: unknown): Record<string, string> {
    if (typeof headers !== 'object' || headers === null) {
      return {};
    }

    const normalized: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        normalized[key.toLowerCase()] = value.map((entry) => String(entry)).join(', ');
      } else if (value !== undefined && value !== null) {
        normalized[key.toLowerCase()] = String(value);
      }
    }

    return normalized;
  }

  private createDefaultHttpGet(): HttpGetter {
    const instance: AxiosInstance = axios.create({
      timeout: this.timeoutMs,
      maxRedirects: 0,
      maxContentLength: MAX_RETRIEVAL_BYTES,
      maxBodyLength: MAX_RETRIEVAL_BYTES,
      responseType: 'text',
      validateStatus: () => true,
      headers: {
        'User-Agent': RETRIEVAL_USER_AGENT,
        Accept: RETRIEVAL_ACCEPT_HEADER,
      },
    });

    return async (url: string): Promise<RetrievalHttpResponse> => {
      const response = await instance.get(url);
      const data = response.data;

      return {
        status: response.status,
        headers: this.normalizeHeaders(response.headers),
        body: typeof data === 'string' ? data : String(data ?? ''),
      };
    };
  }

  private sanitize(url: string): string {
    try {
      const parsed = new URL(url);

      if (parsed.username || parsed.password) {
        parsed.username = '[REDACTED]';
        parsed.password = '';
        return parsed.toString();
      }

      return parsed.toString();
    } catch {
      return '[unparseable-url]';
    }
  }
}
