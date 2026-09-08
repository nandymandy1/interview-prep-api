import { describe, expect, it } from 'vitest';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import {
  BraveSearchProvider,
  type BraveHttpGetter,
  type BraveHttpResponse,
} from '@/modules/research/search/brave-search.provider';
import { MAX_SEARCH_SNIPPET_CHARS } from '@/modules/research/search/search.constants';
import { SearchProviderException } from '@/modules/research/search/search.exception';

const API_KEY = 'test-brave-key';

type CapturedLog = { method: string; message: string; data: unknown };

const makeLogger = (captured: CapturedLog[] = []): LoggerService => {
  const record =
    (method: string) =>
    (message: string, data?: unknown): void => {
      captured.push({ method, message, data });
    };

  return {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as LoggerService;
};

const bravePayload = (entries: Array<{ title: string; url: string; description?: string }>) => ({
  type: 'search',
  query: { original: 'acme' },
  web: { results: entries },
  discussions: { should_not: 'leak' },
  extra_vendor_section: [{ internal_score: 0.99 }],
});

const okGetter = (
  entries: Array<{ title: string; url: string; description?: string }>,
  seen: { urls: string[]; headers: Array<Record<string, string>> } = {
    urls: [],
    headers: [],
  },
): BraveHttpGetter => {
  const getter: BraveHttpGetter = async (url: string, headers: Record<string, string>) => {
    seen.urls.push(url);
    seen.headers.push(headers);
    return { status: 200, headers: {}, data: bravePayload(entries) };
  };
  return getter;
};

const makeProvider = (
  httpGet: BraveHttpGetter,
  options: { sleeps?: number[]; captured?: CapturedLog[]; apiKey?: string } = {},
): BraveSearchProvider =>
  new BraveSearchProvider({
    apiKey: options.apiKey ?? API_KEY,
    logger: makeLogger(options.captured),
    httpGet,
    sleep: async (ms: number) => {
      options.sleeps?.push(ms);
    },
    random: () => 0,
  });

describe('search provider', () => {
  it('1. valid provider response maps to application types', async () => {
    const provider = makeProvider(
      okGetter([
        { title: 'Acme interviews', url: 'https://forum.example/t/1', description: 'My onsite' },
        { title: 'No snippet', url: 'https://blog.example/post' },
      ]),
    );

    const results = await provider.search({ query: 'Acme interview experience', limit: 5 });

    expect(results).toEqual([
      { title: 'Acme interviews', url: 'https://forum.example/t/1', snippet: 'My onsite', rank: 0 },
      { title: 'No snippet', url: 'https://blog.example/post', snippet: null, rank: 1 },
    ]);
  });

  it('2. vendor-specific fields do not leak', async () => {
    const provider = makeProvider(okGetter([{ title: 'T', url: 'https://x.example/' }]));
    const results = await provider.search({ query: 'q', limit: 5 });

    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(['rank', 'snippet', 'title', 'url']);
    }
  });

  it('3. API key never logged', async () => {
    const captured: CapturedLog[] = [];
    const seen: { urls: string[]; headers: Array<Record<string, string>> } = {
      urls: [],
      headers: [],
    };
    const provider = makeProvider(okGetter([{ title: 'T', url: 'https://x.example/' }], seen), {
      captured,
    });

    await provider.search({ query: 'Acme interview experience', limit: 5 });

    expect(seen.headers[0]?.['X-Subscription-Token']).toBe(API_KEY);
    expect(JSON.stringify(captured)).not.toContain(API_KEY);
  });

  it('4. request targets the fixed endpoint with bounded count', async () => {
    const seen: { urls: string[]; headers: Array<Record<string, string>> } = {
      urls: [],
      headers: [],
    };
    const provider = makeProvider(okGetter([], seen));

    await provider.search({ query: 'Acme interview experience', limit: 5 });

    expect(seen.urls).toHaveLength(1);
    expect(seen.urls[0]?.startsWith('https://api.search.brave.com/res/v1/web/search?q=')).toBe(
      true,
    );
    expect(seen.urls[0]).toContain('count=5');
  });

  it('5. 429 retried according to policy', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const getter: BraveHttpGetter = async (): Promise<BraveHttpResponse> => {
      calls += 1;
      return calls === 1
        ? { status: 429, headers: { 'retry-after': '1' }, data: {} }
        : {
            status: 200,
            headers: {},
            data: bravePayload([{ title: 'T', url: 'https://x.example/' }]),
          };
    };
    const provider = makeProvider(getter, { sleeps });

    const results = await provider.search({ query: 'q', limit: 5 });

    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(results).toHaveLength(1);
  });

  it('6. transient 5xx retried', async () => {
    let calls = 0;
    const getter: BraveHttpGetter = async () => {
      calls += 1;
      return calls === 1
        ? { status: 503, headers: {}, data: {} }
        : {
            status: 200,
            headers: {},
            data: bravePayload([{ title: 'T', url: 'https://x.example/' }]),
          };
    };
    const provider = makeProvider(getter);

    await provider.search({ query: 'q', limit: 5 });

    expect(calls).toBe(2);
  });

  it('7. 400 not retried', async () => {
    let calls = 0;
    const getter: BraveHttpGetter = async () => {
      calls += 1;
      return { status: 400, headers: {}, data: {} };
    };
    const provider = makeProvider(getter);

    const error = await provider.search({ query: 'q', limit: 5 }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(SearchProviderException);
    expect((error as SearchProviderException).code).toBe('HTTP_ERROR');
  });

  it('8. 401/403 not endlessly retried', async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      const getter: BraveHttpGetter = async () => {
        calls += 1;
        return { status, headers: {}, data: {} };
      };
      const provider = makeProvider(getter);

      await expect(provider.search({ query: 'q', limit: 5 })).rejects.toBeInstanceOf(
        SearchProviderException,
      );
      expect(calls).toBe(1);
    }
  });

  it('9. max attempts enforced', async () => {
    let calls = 0;
    const getter: BraveHttpGetter = async () => {
      calls += 1;
      return { status: 500, headers: {}, data: {} };
    };
    const provider = makeProvider(getter);

    const error = await provider.search({ query: 'q', limit: 5 }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(calls).toBe(2);
    expect((error as SearchProviderException).code).toBe('HTTP_ERROR');
  });

  it('10. timeout handled', async () => {
    let calls = 0;
    const getter: BraveHttpGetter = async () => {
      calls += 1;
      throw new SearchProviderException('TIMEOUT', 'The search request timed out.');
    };
    const provider = makeProvider(getter);

    const error = await provider.search({ query: 'q', limit: 5 }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(calls).toBe(2);
    expect((error as SearchProviderException).code).toBe('TIMEOUT');
  });

  it('11. malformed provider response handled safely', async () => {
    const getter: BraveHttpGetter = async () => ({
      status: 200,
      headers: {},
      data: { web: { results: [{ nope: true }] } },
    });
    const provider = makeProvider(getter);

    const error = await provider.search({ query: 'q', limit: 5 }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(SearchProviderException);
    expect((error as SearchProviderException).code).toBe('INVALID_RESPONSE');
  });

  it('12. snippet bounded', async () => {
    const provider = makeProvider(
      okGetter([
        { title: 'T', url: 'https://x.example/', description: `a\n\n  b${'x'.repeat(5000)}` },
      ]),
    );

    const results = await provider.search({ query: 'q', limit: 5 });

    expect(results[0]?.snippet).not.toContain('\n');
    expect((results[0]?.snippet ?? '').length).toBeLessThanOrEqual(MAX_SEARCH_SNIPPET_CHARS);
  });

  it('13. transient transport errors retried, then surfaced typed', async () => {
    let calls = 0;
    const getter: BraveHttpGetter = async () => {
      calls += 1;

      if (calls === 1) {
        throw new Error('socket hang up');
      }

      return {
        status: 200,
        headers: {},
        data: bravePayload([{ title: 'T', url: 'https://x.example/' }]),
      };
    };
    const provider = makeProvider(getter);

    const results = await provider.search({ query: 'q', limit: 5 });

    expect(calls).toBe(2);
    expect(results).toHaveLength(1);
  });
});
