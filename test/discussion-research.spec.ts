import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { LinkDiscoveryService } from '@/modules/research/crawl/link-discovery.service';
import { PageExtractionService } from '@/modules/research/extraction/page-extraction.service';
import {
  PublicDiscussionResearchService,
  buildDiscussionQueries,
  resolveCompanySearchName,
} from '@/modules/research/discussion/public-discussion-research.service';
import type { PublicDiscussionResearchInput } from '@/modules/research/discussion/discussion.type';
import {
  RetrievalClient,
  type HttpGetter,
} from '@/modules/research/retrieval/retrieval-client.service';
import { RetrievalException } from '@/modules/research/retrieval/retrieval.exception';
import { toRetrievalResult } from '@/modules/research/retrieval/retrieval.failure';
import type {
  RetrievalFailureCode,
  RetrievalRequest,
  RetrievalResult,
} from '@/modules/research/retrieval/retrieval.type';
import { UrlSafetyService } from '@/modules/research/retrieval/url-safety.service';
import { RobotsPolicyService } from '@/modules/research/robots/robots-policy.service';
import { SearchProviderException } from '@/modules/research/search/search.exception';
import type {
  PublicSearchProvider,
  PublicSearchResult,
} from '@/modules/research/search/search.type';

const makeLogger = (): LoggerService =>
  new LoggerService({
    baseLogger: createBaseLogger('silent'),
    requestContext: new RequestContextService(),
  });

type StubPage = {
  body?: string;
  contentType?: string;
  fail?: { code: RetrievalFailureCode; status?: number };
};

const stubRetrieval = (
  routes: Record<string, StubPage>,
  seen: string[],
): Pick<RetrievalClient, 'retrieve'> => ({
  retrieve: async (request: RetrievalRequest): Promise<RetrievalResult> => {
    seen.push(request.url);
    const route = routes[request.url];

    if (!route) {
      return toRetrievalResult(
        new RetrievalException('HTTP_ERROR', 'stub has no route', {
          url: request.url,
          status: 404,
        }),
      );
    }

    if (route.fail) {
      return toRetrievalResult(
        new RetrievalException(route.fail.code, 'stub failure', {
          url: request.url,
          ...(route.fail.status !== undefined ? { status: route.fail.status } : {}),
        }),
      );
    }

    const body = route.body ?? '';
    return {
      ok: true,
      resource: {
        requestedUrl: request.url,
        finalUrl: request.url,
        status: 200,
        contentType: route.contentType ?? 'text/html',
        body,
        bytes: Buffer.byteLength(body, 'utf8'),
      },
    };
  },
});

const allowAllRobots = (): Pick<RobotsPolicyService, 'loadPolicy' | 'isUrlAllowed'> => ({
  loadPolicy: async (origin: string) => ({
    origin,
    state: 'ok' as const,
    crawlDelayMs: null,
    allows: () => true,
  }),
  isUrlAllowed: () => true,
});

const scriptProvider = (
  entries: PublicSearchResult[] | ((query: string) => PublicSearchResult[] | Error),
  seenQueries: string[] = [],
): PublicSearchProvider => ({
  search: async (input: { query: string }): Promise<PublicSearchResult[]> => {
    seenQueries.push(input.query);
    const resolved = typeof entries === 'function' ? entries(input.query) : entries;

    if (resolved instanceof Error) {
      throw resolved;
    }

    return resolved;
  },
});

const result = (
  url: string,
  title = 'Result',
  snippet: string | null = null,
  rank = 0,
): PublicSearchResult => ({ title, url, snippet, rank });

const makeService = (
  provider: PublicSearchProvider | null,
  retrieval: Pick<RetrievalClient, 'retrieve'>,
  options: {
    robots?: Pick<RobotsPolicyService, 'loadPolicy' | 'isUrlAllowed'>;
    sleeps?: number[];
  } = {},
): PublicDiscussionResearchService =>
  new PublicDiscussionResearchService({
    searchProvider: provider,
    retrievalClient: retrieval,
    robotsPolicy: options.robots ?? allowAllRobots(),
    pageExtraction: new PageExtractionService(),
    linkDiscovery: new LinkDiscoveryService(),
    logger: makeLogger(),
    sleep: async (ms: number) => {
      options.sleeps?.push(ms);
    },
  });

const discuss = (
  companyUrl = 'https://acme.example/',
  overrides: Partial<PublicDiscussionResearchInput> = {},
): PublicDiscussionResearchInput => ({ companyUrl, mode: 'evaluation', ...overrides });

describe('discussion queries', () => {
  it('14. company interview experience query generated', () => {
    expect(buildDiscussionQueries('acme')).toContain('acme interview experience');
  });

  it('15. company interview questions query generated', () => {
    expect(buildDiscussionQueries('acme')).toContain('acme interview questions');
  });

  it('16. optional role query generated when roleHint exists', () => {
    expect(buildDiscussionQueries('acme', 'Backend Engineer')).toContain(
      'acme Backend Engineer interview',
    );
  });

  it('17. no role query when roleHint absent', () => {
    expect(buildDiscussionQueries('acme')).toHaveLength(2);
  });

  it('18. max query count enforced', () => {
    expect(buildDiscussionQueries('acme', 'Backend Engineer')).toHaveLength(3);
  });

  it('19. deterministic repeated input gives same queries', () => {
    expect(buildDiscussionQueries('acme', 'Backend Engineer')).toEqual(
      buildDiscussionQueries('acme', 'Backend Engineer'),
    );
  });

  it('20. hostname fallback company name works', () => {
    expect(resolveCompanySearchName('https://careers.acme.com/jobs')).toBe('acme');
    expect(resolveCompanySearchName('https://www.acme.com/')).toBe('acme');
  });

  it('21. caller companyNameHint takes precedence', () => {
    expect(resolveCompanySearchName('https://careers.acme.com/', 'Acme Corp')).toBe('Acme Corp');
  });
});

describe('result normalization', () => {
  it('22/23/24. duplicates, fragments, and tracking variants collapse', async () => {
    const seen: string[] = [];
    const service = makeService(
      scriptProvider([
        result('https://forum.example/t/1', 'Acme interview experience', 'great onsite', 2),
        result('https://forum.example/t/1#faq', 'Acme interview experience', 'great onsite', 1),
        result('https://forum.example/t/1?utm_source=newsletter', 'Acme interview', null, 0),
      ]),
      stubRetrieval({ 'https://forum.example/t/1': { body: '<p>onsite notes</p>' } }, seen),
    );

    const outcome = await service.research(discuss());

    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources[0]?.url).toBe('https://forum.example/t/1');
    expect(outcome.stats.uniqueResults).toBe(1);
    expect(seen.filter((url) => url === 'https://forum.example/t/1')).toHaveLength(1);
  });

  it('25. semantic query params preserved', async () => {
    const service = makeService(
      scriptProvider([
        result('https://forum.example/search?page=2', 'P2', null, 0),
        result('https://forum.example/search?page=3', 'P3', null, 1),
      ]),
      stubRetrieval(
        {
          'https://forum.example/search?page=2': { body: '<p>two</p>' },
          'https://forum.example/search?page=3': { body: '<p>three</p>' },
        },
        [],
      ),
    );

    const outcome = await service.research(discuss());

    expect(outcome.sources.map((source) => source.url).sort()).toEqual([
      'https://forum.example/search?page=2',
      'https://forum.example/search?page=3',
    ]);
  });

  it('26/27. same-company results excluded, third-party retained', async () => {
    const service = makeService(
      scriptProvider([
        result('https://acme.example/blog', 'Acme blog', null, 0),
        result('https://careers.acme.example/jobs', 'Acme jobs', null, 1),
        result('https://forum.example/t/9', 'Acme interview experience', 'onsite', 2),
      ]),
      stubRetrieval({ 'https://forum.example/t/9': { body: '<p>notes</p>' } }, []),
    );

    const outcome = await service.research(discuss('https://acme.example/'));

    expect(outcome.sources.map((source) => source.url)).toEqual(['https://forum.example/t/9']);
  });

  it('28/29. stronger duplicate provider rank retained with query provenance', async () => {
    const seenQueries: string[] = [];
    const service = makeService(
      scriptProvider(
        (query: string) =>
          query.includes('experience')
            ? [result('https://forum.example/t/1', 'Acme interview', 'weak', 3)]
            : [result('https://forum.example/t/1', 'Acme interview', 'strong', 0)],
        seenQueries,
      ),
      stubRetrieval({ 'https://forum.example/t/1': { body: '<p>notes</p>' } }, []),
    );

    const outcome = await service.research(discuss());

    expect(seenQueries).toHaveLength(2);
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources[0]?.search.rank).toBe(0);
    expect(outcome.sources[0]?.search.snippet).toBe('strong');
    expect(outcome.sources[0]?.search.query).toBe('acme interview questions');
  });

  it('30. deterministic ranking across runs', async () => {
    const entries = [
      result('https://b.example/x', 'Acme news today', null, 0),
      result('https://a.example/y', 'Acme interview experience', 'onsite rounds', 1),
    ];
    const first = await makeService(
      scriptProvider(entries),
      stubRetrieval(
        {
          'https://b.example/x': { body: '<p>n</p>' },
          'https://a.example/y': { body: '<p>i</p>' },
        },
        [],
      ),
    ).research(discuss());
    const second = await makeService(
      scriptProvider([...entries].reverse()),
      stubRetrieval(
        {
          'https://b.example/x': { body: '<p>n</p>' },
          'https://a.example/y': { body: '<p>i</p>' },
        },
        [],
      ),
    ).research(discuss());

    expect(first.sources.map((source) => source.url)).toEqual(
      second.sources.map((source) => source.url),
    );
    expect(first.sources[0]?.url).toBe('https://a.example/y');
  });

  it('31/32. interview relevance outranks generic pages, salary-only deprioritized', async () => {
    const service = makeService(
      scriptProvider([
        result('https://news.example/acme', 'Acme raises funding', 'startup news', 0),
        result('https://salary.example/acme', 'Acme salary report', 'pay bands', 1),
        result('https://forum.example/t/5', 'Acme interview experience', 'my onsite', 2),
      ]),
      stubRetrieval(
        {
          'https://news.example/acme': { body: '<p>news</p>' },
          'https://salary.example/acme': { body: '<p>pay</p>' },
          'https://forum.example/t/5': { body: '<p>onsite</p>' },
        },
        [],
      ),
    );

    const outcome = await service.research(discuss());

    expect(outcome.sources[0]?.url).toBe('https://forum.example/t/5');
  });
});

describe('source fetch', () => {
  const sevenResults = [
    result('https://a.example/1', 'Acme interview experience one', 'one', 0),
    result('https://a.example/2', 'Acme interview experience two', 'two', 1),
    result('https://a.example/3', 'Acme interview experience three', 'three', 2),
    result('https://a.example/4', 'Acme interview experience four', 'four', 3),
    result('https://b.example/5', 'Acme interview experience five', 'five', 4),
    result('https://b.example/6', 'Acme interview experience six', 'six', 5),
    result('https://b.example/7', 'Acme interview experience seven', 'seven', 6),
  ];

  it('33/34/35. top-ranked bounded pages fetched, overflow not fetched', async () => {
    const seen: string[] = [];
    const service = makeService(
      scriptProvider(sevenResults),
      stubRetrieval(
        Object.fromEntries(
          sevenResults.map((entry) => [entry.url, { body: `<p>${entry.url}</p>` }]),
        ),
        seen,
      ),
    );

    const outcome = await service.research(discuss());

    expect(outcome.stats.pagesAttempted).toBe(5);
    expect(outcome.stats.pagesFetched).toBe(5);
    expect(outcome.sources.filter((source) => source.fetchStatus === 'fetched')).toHaveLength(5);
    expect(outcome.sources.filter((source) => source.fetchStatus === 'not-attempted')).toHaveLength(
      2,
    );
    expect(outcome.status).toBe('complete');
  });

  it('36. MAX_DISCUSSION_ORIGINS enforced', async () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      result(`https://o${index}.example/p`, `Acme interview ${index}`, 'x', index),
    );
    const service = makeService(
      scriptProvider(entries),
      stubRetrieval(
        Object.fromEntries(entries.map((entry) => [entry.url, { body: '<p>x</p>' }])),
        [],
      ),
    );

    const outcome = await service.research(discuss());

    expect(outcome.stats.pagesAttempted).toBe(4);
  });

  it('37. robots disallowed page never fetched', async () => {
    const seen: string[] = [];
    const retrieval = stubRetrieval(
      {
        'https://forum.example/robots.txt': { body: 'User-agent: *\nDisallow: /private\n' },
        'https://forum.example/open': { body: '<p>open notes</p>' },
        'https://forum.example/private': { body: '<p>secret</p>' },
      },
      seen,
    );
    const service = makeService(
      scriptProvider([
        result('https://forum.example/private', 'Acme interview', 'secret snippet', 0),
        result('https://forum.example/open', 'Acme interview', 'open snippet', 1),
      ]),
      retrieval,
      {
        robots: new RobotsPolicyService({ retrievalClient: retrieval, logger: makeLogger() }),
      },
    );

    const outcome = await service.research(discuss());

    expect(seen).not.toContain('https://forum.example/private');
    const skipped = outcome.sources.find(
      (source) => source.url === 'https://forum.example/private',
    );
    expect(skipped?.fetchStatus).toBe('robots-skipped');
    expect(skipped?.search.snippet).toBe('secret snippet');
    expect(skipped?.page).toBeUndefined();
    expect(outcome.failures.some((failure) => failure.code === 'ROBOTS_DISALLOWED')).toBe(true);
    expect(outcome.status).toBe('partial');
  });

  it('38. robots unavailable follows conservative policy', async () => {
    const retrieval = stubRetrieval(
      {
        'https://forum.example/robots.txt': { fail: { code: 'TIMEOUT' } },
        'https://forum.example/t/1': { body: '<p>notes</p>' },
      },
      [],
    );
    const service = makeService(
      scriptProvider([result('https://forum.example/t/1', 'Acme interview', 'kept snippet', 0)]),
      retrieval,
      {
        robots: new RobotsPolicyService({ retrievalClient: retrieval, logger: makeLogger() }),
      },
    );

    const outcome = await service.research(discuss());

    expect(outcome.sources[0]?.fetchStatus).toBe('robots-skipped');
    expect(outcome.sources[0]?.search.snippet).toBe('kept snippet');
    expect(outcome.failures.some((failure) => failure.code === 'ROBOTS_UNAVAILABLE')).toBe(true);
  });

  it('39/40. successful page extracted, raw HTML absent', async () => {
    const service = makeService(
      scriptProvider([result('https://forum.example/t/1', 'Acme interview', 'snippet', 0)]),
      stubRetrieval(
        {
          'https://forum.example/t/1': {
            body: '<html><head><title>Forum</title></head><body><a href="/linked">x</a><p>onsite recap</p></body></html>',
          },
        },
        [],
      ),
    );

    const outcome = await service.research(discuss());

    expect(outcome.sources[0]?.fetchStatus).toBe('fetched');
    expect(outcome.sources[0]?.page?.content.text).toContain('onsite recap');
    expect(JSON.stringify(outcome)).not.toContain('<html');
    expect(JSON.stringify(outcome)).not.toContain('<a href');
  });

  it('41. page extraction failure non-fatal', async () => {
    const service = makeService(
      scriptProvider([
        result('https://a.example/empty', 'Acme interview empty', 's1', 0),
        result('https://b.example/full', 'Acme interview full', 's2', 1),
      ]),
      stubRetrieval(
        {
          'https://a.example/empty': { body: '' },
          'https://b.example/full': { body: '<p>full notes</p>' },
        },
        [],
      ),
    );

    const outcome = await service.research(discuss());

    expect(outcome.failures.some((failure) => failure.code === 'EXTRACTION_EMPTY')).toBe(true);
    expect(
      outcome.sources.find((source) => source.url === 'https://b.example/full')?.fetchStatus,
    ).toBe('fetched');
    expect(outcome.status).toBe('partial');
  });

  it('42/43. timeout and 404 non-fatal', async () => {
    const service = makeService(
      scriptProvider([
        result('https://a.example/slow', 'Acme interview slow', 's1', 0),
        result('https://b.example/gone', 'Acme interview gone', 's2', 1),
        result('https://c.example/good', 'Acme interview good', 's3', 2),
      ]),
      stubRetrieval(
        {
          'https://a.example/slow': { fail: { code: 'TIMEOUT' } },
          'https://b.example/gone': { fail: { code: 'HTTP_ERROR', status: 404 } },
          'https://c.example/good': { body: '<p>good notes</p>' },
        },
        [],
      ),
    );

    const outcome = await service.research(discuss());

    expect(outcome.failures.filter((failure) => failure.code === 'RETRIEVAL_FAILED')).toHaveLength(
      2,
    );
    expect(
      outcome.sources.find((source) => source.url === 'https://c.example/good')?.fetchStatus,
    ).toBe('fetched');
    expect(outcome.status).toBe('partial');
  });

  it('44. production localhost result blocked', async () => {
    const httpCalls: string[] = [];
    const http: HttpGetter = async (url: string) => {
      httpCalls.push(url);
      return { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>x</p>' };
    };
    const client = new RetrievalClient({
      urlSafety: new UrlSafetyService({ dnsResolver: async () => [] }),
      logger: makeLogger(),
      httpGet: http,
      sleep: async () => {},
      random: () => 0,
    });
    const service = makeService(
      scriptProvider([result('http://127.0.0.1:18099/secret', 'Acme interview', 's', 0)]),
      client,
    );

    const outcome = await service.research(
      discuss('https://acme.example/', { mode: 'production' }),
    );

    expect(httpCalls).toEqual([]);
    expect(outcome.sources[0]?.fetchStatus).toBe('failed');
    expect(outcome.failures[0]?.code).toBe('RETRIEVAL_FAILED');
    expect(outcome.failures[0]?.retrievalCode).toBe('BLOCKED_ADDRESS');
  });

  it('46. no recursive link crawling occurs', async () => {
    const seen: string[] = [];
    const service = makeService(
      scriptProvider([result('https://forum.example/t/1', 'Acme interview', 's', 0)]),
      stubRetrieval(
        { 'https://forum.example/t/1': { body: '<a href="/linked">more</a><p>notes</p>' } },
        seen,
      ),
    );

    await service.research(discuss());

    expect(seen).toEqual(['https://forum.example/t/1']);
  });

  it('47. fetch status truthful across mixed outcomes', async () => {
    const retrieval = stubRetrieval(
      {
        'https://forum.example/robots.txt': { body: 'User-agent: *\nDisallow: /shut\n' },
        'https://forum.example/shut': { body: '<p>shut</p>' },
        'https://forum.example/ok': { body: '<p>ok notes</p>' },
        'https://forum.example/bad': { fail: { code: 'TIMEOUT' } },
      },
      [],
    );
    const service = makeService(
      scriptProvider([
        result('https://forum.example/ok', 'Acme interview ok', 's', 0),
        result('https://forum.example/shut', 'Acme interview shut', 's', 1),
        result('https://forum.example/bad', 'Acme interview bad', 's', 2),
      ]),
      retrieval,
      {
        robots: new RobotsPolicyService({ retrievalClient: retrieval, logger: makeLogger() }),
      },
    );

    const outcome = await service.research(discuss());

    expect(
      outcome.sources.find((source) => source.url === 'https://forum.example/ok')?.fetchStatus,
    ).toBe('fetched');
    expect(
      outcome.sources.find((source) => source.url === 'https://forum.example/shut')?.fetchStatus,
    ).toBe('robots-skipped');
    expect(
      outcome.sources.find((source) => source.url === 'https://forum.example/bad')?.fetchStatus,
    ).toBe('failed');
    expect(outcome.stats.pagesFetched).toBe(1);
    expect(outcome.stats.pagesSkipped).toBe(1);
    expect(outcome.stats.pagesFailed).toBe(1);
  });
});

describe('partial failure', () => {
  it('48. one failed query does not erase successful query', async () => {
    const service = makeService(
      scriptProvider((query: string) => {
        if (query.includes('questions')) {
          throw new SearchProviderException('RATE_LIMITED', 'limited', { status: 429 });
        }

        return [result('https://forum.example/t/1', 'Acme interview', 's', 0)];
      }),
      stubRetrieval({ 'https://forum.example/t/1': { body: '<p>notes</p>' } }, []),
    );

    const outcome = await service.research(discuss());

    expect(outcome.sources).toHaveLength(1);
    expect(
      outcome.failures.some((failure) => failure.code === 'SEARCH_PROVIDER_RATE_LIMITED'),
    ).toBe(true);
    expect(outcome.status).toBe('partial');
  });

  it('50. provider unavailable gives unavailable status', async () => {
    const missing = makeService(null, stubRetrieval({}, []));

    const missingOutcome = await missing.research(discuss());

    expect(missingOutcome.status).toBe('unavailable');
    expect(
      missingOutcome.failures.some((failure) => failure.code === 'SEARCH_PROVIDER_NOT_CONFIGURED'),
    ).toBe(true);
    expect(missingOutcome.sources).toEqual([]);

    const failing = makeService(
      scriptProvider(() => {
        throw new SearchProviderException('HTTP_ERROR', 'down', { status: 500 });
      }),
      stubRetrieval({}, []),
    );

    const failingOutcome = await failing.research(discuss());

    expect(failingOutcome.status).toBe('unavailable');
    expect(failingOutcome.sources).toEqual([]);
  });

  it('52. all successful gives complete status', async () => {
    const service = makeService(
      scriptProvider([result('https://forum.example/t/1', 'Acme interview', 's', 0)]),
      stubRetrieval({ 'https://forum.example/t/1': { body: '<p>notes</p>' } }, []),
    );

    const outcome = await service.research(discuss());

    expect(outcome.status).toBe('complete');
    expect(outcome.failures).toEqual([]);
  });

  it('53. zero results give truthful empty result', async () => {
    const seenQueries: string[] = [];
    const service = makeService(scriptProvider([], seenQueries), stubRetrieval({}, []));

    const outcome = await service.research(discuss());

    expect(seenQueries).toHaveLength(2);
    expect(outcome.sources).toEqual([]);
    expect(outcome.status).toBe('complete');
    expect(outcome.stats).toMatchObject({
      queriesAttempted: 2,
      searchResultsFound: 0,
      uniqueResults: 0,
      pagesAttempted: 0,
    });
  });

  it('54. no fabricated questions or discussion content', async () => {
    const provided = [result('https://forum.example/t/1', 'Provided title', 'Provided snippet', 0)];
    const service = makeService(
      scriptProvider(provided),
      stubRetrieval({ 'https://forum.example/t/1': { body: '<p>Provided body</p>' } }, []),
    );

    const outcome = await service.research(discuss());

    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources[0]?.title).toBe('Provided title');
    expect(outcome.sources[0]?.search.snippet).toBe('Provided snippet');
    expect(outcome.sources[0]?.page?.content.text).toContain('Provided body');
    expect(outcome.sources[0]?.trust).toBe('external-untrusted');
  });
});

describe('local discussion integration', () => {
  let server: Server;
  let baseUrl = '';
  let requestedPaths: string[] = [];
  let bodies: Record<string, { status: number; body: string }> = {};

  const startServer = async (): Promise<void> => {
    requestedPaths = [];
    server = createServer((request, response) => {
      requestedPaths.push(request.url ?? '/');
      const route = bodies[request.url ?? '/'];

      if (!route) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('missing');
        return;
      }

      response.writeHead(route.status, { 'content-type': 'text/html' }).end(route.body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  };

  const stopServer = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  it('local provider plus local pages: dedupe, robots, 404, untrusted text, no recursion', async () => {
    await startServer();

    try {
      bodies = {
        '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private\n' },
        '/good': {
          status: 200,
          body: '<html><body><a href="/linked">read more</a><p>Acme onsite recap notes</p></body></html>',
        },
        '/private': { status: 200, body: '<p>secret notes</p>' },
        '/dup': { status: 200, body: '<p>duplicate notes</p>' },
        '/evil': { status: 200, body: '<p>evil page body</p>' },
      };

      const evilSnippet = '<script>steal()</script> totally real interview';
      const provider = scriptProvider([
        result(`${baseUrl}/good`, 'Acme interview experience', 'onsite recap', 0),
        result(`${baseUrl}/private`, 'Acme interview', 'secret snippet', 1),
        result(`${baseUrl}/missing`, 'Acme interview', 'gone snippet', 2),
        result(`${baseUrl}/dup?utm_source=newsletter`, 'Acme interview dup', 'dup snippet', 3),
        result(`${baseUrl}/dup`, 'Acme interview dup', 'dup snippet', 4),
        result(`${baseUrl}/evil`, 'Acme interview', evilSnippet, 5),
      ]);

      const client = new RetrievalClient({
        urlSafety: new UrlSafetyService(),
        logger: makeLogger(),
        sleep: async () => {},
        random: () => 0,
      });
      const service = new PublicDiscussionResearchService({
        searchProvider: provider,
        retrievalClient: client,
        robotsPolicy: new RobotsPolicyService({ retrievalClient: client, logger: makeLogger() }),
        pageExtraction: new PageExtractionService(),
        linkDiscovery: new LinkDiscoveryService(),
        logger: makeLogger(),
        sleep: async () => {},
      });

      const outcome = await service.research(discuss('https://acme.example/'));

      expect(outcome.status).toBe('partial');
      expect(outcome.queries).toHaveLength(2);
      // The disallowed page and the duplicate variant are never fetched;
      // /linked would prove recursive crawling.
      expect(requestedPaths).not.toContain('/private');
      expect(requestedPaths).not.toContain('/linked');
      expect(requestedPaths.filter((path) => path === '/dup')).toHaveLength(1);

      const good = outcome.sources.find((source) => source.url === `${baseUrl}/good`);
      expect(good?.fetchStatus).toBe('fetched');
      expect(good?.page?.content.text).toContain('Acme onsite recap notes');

      const blocked = outcome.sources.find((source) => source.url === `${baseUrl}/private`);
      expect(blocked?.fetchStatus).toBe('robots-skipped');
      expect(blocked?.search.snippet).toBe('secret snippet');

      expect(
        outcome.failures.some(
          (failure) => failure.code === 'RETRIEVAL_FAILED' && failure.url === `${baseUrl}/missing`,
        ),
      ).toBe(true);

      const evil = outcome.sources.find((source) => source.url === `${baseUrl}/evil`);
      expect(evil?.search.snippet).toBe(evilSnippet);
      expect(evil?.trust).toBe('external-untrusted');

      expect(JSON.stringify(outcome)).not.toContain('<html');
      expect(outcome.stats.pagesFetched).toBeGreaterThanOrEqual(2);
    } finally {
      await stopServer();
    }
  });

  it('production mode blocks the local source', async () => {
    await startServer();

    try {
      bodies = {
        '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow:\n' },
        '/good': { status: 200, body: '<p>notes</p>' },
      };
      const provider = scriptProvider([result(`${baseUrl}/good`, 'Acme interview', 's', 0)]);
      const client = new RetrievalClient({
        urlSafety: new UrlSafetyService(),
        logger: makeLogger(),
        sleep: async () => {},
        random: () => 0,
      });
      const service = new PublicDiscussionResearchService({
        searchProvider: provider,
        retrievalClient: client,
        robotsPolicy: new RobotsPolicyService({ retrievalClient: client, logger: makeLogger() }),
        pageExtraction: new PageExtractionService(),
        linkDiscovery: new LinkDiscoveryService(),
        logger: makeLogger(),
        sleep: async () => {},
      });

      const outcome = await service.research(
        discuss('https://acme.example/', { mode: 'production' }),
      );

      expect(requestedPaths).toEqual([]);
      expect(outcome.sources[0]?.fetchStatus).toBe('robots-skipped');
      expect(outcome.failures.some((failure) => failure.code === 'ROBOTS_UNAVAILABLE')).toBe(true);
    } finally {
      await stopServer();
    }
  });
});
