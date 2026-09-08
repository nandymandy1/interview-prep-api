import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import {
  compareCrawlCandidates,
  CompanyCrawlerService,
} from '@/modules/research/crawl/company-crawler.service';
import type { CrawlCandidate } from '@/modules/research/crawl/crawl.type';
import { LinkDiscoveryService } from '@/modules/research/crawl/link-discovery.service';
import { LinkRankingService } from '@/modules/research/crawl/link-ranking.service';
import { PageExtractionService } from '@/modules/research/extraction/page-extraction.service';
import { RobotsPolicyService } from '@/modules/research/robots/robots-policy.service';
import {
  RetrievalClient,
  type HttpGetter,
  type RetrievalHttpResponse,
} from '@/modules/research/retrieval/retrieval-client.service';
import { RetrievalException } from '@/modules/research/retrieval/retrieval.exception';
import { toRetrievalResult } from '@/modules/research/retrieval/retrieval.failure';
import type {
  RetrievalFailureCode,
  RetrievalRequest,
  RetrievalResult,
} from '@/modules/research/retrieval/retrieval.type';
import {
  UrlSafetyService,
  type DnsResolver,
} from '@/modules/research/retrieval/url-safety.service';

const PUBLIC_IPV4 = '93.184.216.34';

const makeLogger = (): LoggerService =>
  new LoggerService({
    baseLogger: createBaseLogger('silent'),
    requestContext: new RequestContextService(),
  });

const mockDns = (records: Record<string, string[]>): DnsResolver => {
  const resolver: DnsResolver = async (hostname: string) => [...(records[hostname] ?? [])];
  return resolver;
};

const okResponse = (overrides: Partial<RetrievalHttpResponse> = {}): RetrievalHttpResponse => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: '',
  ...overrides,
});

type StubRoute = {
  body?: string;
  finalUrl?: string;
  contentType?: string;
  fail?: { code: RetrievalFailureCode; status?: number };
};

const scriptRetrieval = (
  routes: Record<string, StubRoute>,
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
    const finalUrl = route.finalUrl ?? request.url;

    return {
      ok: true,
      resource: {
        requestedUrl: request.url,
        finalUrl,
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

const makeCrawler = (
  retrieval: Pick<RetrievalClient, 'retrieve'>,
  options: {
    sleeps?: number[];
    now?: () => number;
    robotsPolicy?: Pick<RobotsPolicyService, 'loadPolicy' | 'isUrlAllowed'>;
  } = {},
): CompanyCrawlerService =>
  new CompanyCrawlerService({
    urlSafety: new UrlSafetyService(),
    retrievalClient: retrieval,
    linkDiscovery: new LinkDiscoveryService(),
    linkRanking: new LinkRankingService(),
    robotsPolicy: options.robotsPolicy ?? allowAllRobots(),
    pageExtraction: new PageExtractionService(),
    logger: makeLogger(),
    sleep: async (ms: number) => {
      options.sleeps?.push(ms);
    },
    ...(options.now ? { now: options.now } : {}),
  });

const link = (href: string, text: string): string => `<a href="${href}">${text}</a>`;

describe('link discovery', () => {
  const discovery = new LinkDiscoveryService();
  const base = 'https://acme.example/';

  it('1. relative /careers resolves correctly', () => {
    expect(discovery.normalizeCrawlUrl('/careers', base)).toBe('https://acme.example/careers');
  });

  it('2. relative careers resolves correctly', () => {
    expect(discovery.normalizeCrawlUrl('careers', base)).toBe('https://acme.example/careers');
  });

  it('3. ../jobs resolves correctly', () => {
    expect(discovery.normalizeCrawlUrl('../jobs', 'https://acme.example/a/b')).toBe(
      'https://acme.example/jobs',
    );
  });

  it('4. protocol-relative company URL resolves correctly', () => {
    expect(discovery.normalizeCrawlUrl('//acme.example/team', base)).toBe(
      'https://acme.example/team',
    );
  });

  it('5. fragments are removed', () => {
    expect(discovery.normalizeCrawlUrl('/careers#jobs', base)).toBe('https://acme.example/careers');
  });

  it.each([
    ['6. mailto ignored', 'mailto:jobs@acme.example'],
    ['7. tel ignored', 'tel:+123456789'],
    ['8. javascript ignored', 'javascript:void(0)'],
    ['9. data ignored', 'data:text/html,<h1>x</h1>'],
    ['ftp ignored', 'ftp://acme.example/file'],
    ['fragment-only ignored', '#section'],
    ['empty ignored', ''],
    ['whitespace ignored', '   '],
  ])('%s', (_label, href) => {
    expect(discovery.normalizeCrawlUrl(href, base)).toBeNull();
  });

  it('10. binary and static assets are not enqueued', () => {
    for (const href of [
      '/logo.png',
      '/photo.jpg',
      '/doc.pdf',
      '/app.js',
      '/style.css',
      '/font.woff2',
      '/clip.mp4',
    ]) {
      expect(discovery.normalizeCrawlUrl(href, base)).toBeNull();
    }

    expect(discovery.normalizeCrawlUrl('/careers', base)).not.toBeNull();
  });

  it('non-content actions are not enqueued', () => {
    expect(discovery.normalizeCrawlUrl('/logout', base)).toBeNull();
    expect(discovery.normalizeCrawlUrl('/account/signout', base)).toBeNull();
    expect(discovery.normalizeCrawlUrl('/about', base)).not.toBeNull();
  });

  it('11. whitespace anchor text is normalized', () => {
    const links = discovery.discoverLinks(`<a href="/careers">  Join\n\t Us  </a>`, base);
    expect(links).toEqual([{ url: 'https://acme.example/careers', anchorText: 'Join Us' }]);
  });

  it('12. invalid hrefs are skipped safely', () => {
    const links = discovery.discoverLinks(
      `${link('http://', 'Bad')}${link('/about', 'About')}`,
      base,
    );
    expect(links).toEqual([{ url: 'https://acme.example/about', anchorText: 'About' }]);
  });

  it('13. tracking params are stripped', () => {
    expect(
      discovery.normalizeCrawlUrl('/careers?utm_source=linkedin&utm_medium=social', base),
    ).toBe('https://acme.example/careers');
    expect(discovery.normalizeCrawlUrl('/x?gclid=abc&fbclid=def', base)).toBe(
      'https://acme.example/x',
    );
  });

  it('14. meaningful query params are preserved', () => {
    expect(discovery.normalizeCrawlUrl('/search?role=eng', base)).toBe(
      'https://acme.example/search?role=eng',
    );
    expect(discovery.normalizeCrawlUrl('/search?role=eng&utm_source=x', base)).toBe(
      'https://acme.example/search?role=eng',
    );
  });

  it('duplicate hrefs are returned raw for best-signal grouping downstream', () => {
    const links = discovery.discoverLinks(
      `${link('/about', 'About')}${link('/about#team', 'Team')}`,
      base,
    );
    expect(links).toEqual([
      { url: 'https://acme.example/about', anchorText: 'About' },
      { url: 'https://acme.example/about', anchorText: 'Team' },
    ]);
  });
});

describe('link ranking', () => {
  const ranking = new LinkRankingService();

  it('25. anchor "Careers" outranks a generic page', () => {
    expect(ranking.scoreLink('https://a/foo', 'Careers').score).toBeGreaterThan(
      ranking.scoreLink('https://a/news', 'Latest updates').score,
    );
  });

  it('26. anchor "Jobs" ranks highly', () => {
    expect(ranking.scoreLink('https://a/x', 'Jobs').score).toBeGreaterThanOrEqual(100);
  });

  it('27. anchor "Hiring Process" ranks highly with an explainable signal', () => {
    const { score, signals } = ranking.scoreLink('https://a/x', 'Hiring Process');
    expect(score).toBeGreaterThanOrEqual(100);
    expect(signals).toContain('anchor-phrase:hiring process');
  });

  it('28. /careers path ranks highly', () => {
    expect(ranking.scoreLink('https://a/careers', 'Stuff').score).toBeGreaterThanOrEqual(50);
  });

  it('29. /about ranks above privacy', () => {
    expect(ranking.scoreLink('https://a/about', '').score).toBeGreaterThan(
      ranking.scoreLink('https://a/privacy', '').score,
    );
  });

  it('30. engineering page receives a useful positive score', () => {
    expect(ranking.scoreLink('https://a/engineering', '').score).toBeGreaterThan(0);
  });

  it('31. privacy and legal are deprioritized', () => {
    expect(ranking.scoreLink('https://a/privacy', 'Privacy').score).toBeLessThan(0);
    expect(ranking.scoreLink('https://a/legal/terms', 'Terms').score).toBeLessThan(0);
  });

  it('32. anchor signal works even when the pathname is opaque', () => {
    const { score, signals } = ranking.scoreLink('https://a/foo', 'Careers');
    expect(score).toBeGreaterThanOrEqual(100);
    expect(signals).toContain('anchor:careers');
  });

  it('33. tie-breaking is deterministic: score desc, depth asc, url asc', () => {
    const candidate = (url: string, score: number, depth: number): CrawlCandidate => ({
      url,
      discoveredFrom: 'https://a/',
      depth,
      anchorText: '',
      score,
      signals: [],
    });

    expect(
      [candidate('https://a/b', 10, 1), candidate('https://a/a', 10, 1)].sort(
        compareCrawlCandidates,
      )[0]?.url,
    ).toBe('https://a/a');
    expect(
      [candidate('https://a/a', 10, 2), candidate('https://a/a', 10, 1)].sort(
        compareCrawlCandidates,
      )[0]?.depth,
    ).toBe(1);
    expect(
      [candidate('https://a/a', 0, 1), candidate('https://a/a', 50, 1)].sort(
        compareCrawlCandidates,
      )[0]?.score,
    ).toBe(50);
  });

  it('34. repeated input produces identical order', () => {
    const first = ranking.scoreLink('https://a/careers', 'Careers');
    const second = ranking.scoreLink('https://a/careers', 'Careers');
    expect(second).toEqual(first);
  });
});

describe('site scope', () => {
  it('15. same origin is accepted', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: link('/about', 'About') },
          'https://acme.example/about': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(seen).toContain('https://acme.example/about');
    expect(result.pages.map((page) => page.finalUrl)).toContain('https://acme.example/about');
  });

  it('16. apex and www are accepted under one registrable domain', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://www.acme.example/': { body: link('https://acme.example/about', 'About') },
          'https://acme.example/about': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://www.acme.example/',
      mode: 'production',
    });

    expect(seen).toContain('https://acme.example/about');
    expect(result.pages).toHaveLength(2);
  });

  it('17. careers subdomain is accepted', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: link('https://careers.acme.example/jobs', 'Jobs') },
          'https://careers.acme.example/jobs': { body: '' },
        },
        seen,
      ),
    );
    await crawler.crawlCompanySite({ companyUrl: 'https://acme.example/', mode: 'production' });

    expect(seen).toContain('https://careers.acme.example/jobs');
  });

  it.each([
    ['18. unrelated domain rejected', 'https://evil.example/'],
    ['19. lookalike domain rejected', 'https://acme.example.attacker.com/'],
    ['20. sibling registrable domain rejected', 'https://acme.io/'],
    ['weird port rejected', 'https://acme.example:8443/admin'],
  ])('%s', async (_label, href) => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval({ 'https://acme.example/': { body: link(href, 'X') } }, seen),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(seen).not.toContain(href);
    expect(result.pages).toHaveLength(1);
    expect(result.rankedLinks).toHaveLength(0);
  });

  it('21/22/23. local evaluator seeds stay exact-origin scoped', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'http://127.0.0.1:8099/': {
            body: [
              link('/about', 'About'),
              link('http://127.0.0.1:9000/other', 'Other port'),
              link('http://192.168.1.6/', 'Other host'),
            ].join(''),
          },
          'http://127.0.0.1:8099/about': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'http://127.0.0.1:8099/',
      mode: 'evaluation',
    });

    expect(seen).toContain('http://127.0.0.1:8099/about');
    expect(seen).not.toContain('http://127.0.0.1:9000/other');
    expect(seen).not.toContain('http://192.168.1.6/');
    expect(result.pages).toHaveLength(2);
  });

  it('24. every fetched discovered URL still goes through the retrieval client', async () => {
    const httpSeen: string[] = [];
    const http: HttpGetter = async (url: string) => {
      httpSeen.push(url);
      return okResponse({
        body: url === 'http://acme.example/' ? link('http://private.acme.example/', 'VPN') : '',
      });
    };
    const retrieval = new RetrievalClient({
      urlSafety: new UrlSafetyService({
        dnsResolver: mockDns({
          'acme.example': [PUBLIC_IPV4],
          'private.acme.example': ['10.0.0.9'],
        }),
      }),
      logger: makeLogger(),
      httpGet: http,
      sleep: async () => {},
      random: () => 0,
    });
    const crawler = makeCrawler(retrieval);
    const result = await crawler.crawlCompanySite({
      companyUrl: 'http://acme.example/',
      mode: 'production',
    });

    // The in-scope private-subdomain link reaches the retrieval client, which
    // blocks it; the transport layer never sees it.
    expect(httpSeen).toEqual(['http://acme.example/']);
    expect(result.pages).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe('BLOCKED_ADDRESS');
    expect(result.failures[0]?.url).toBe('http://private.acme.example/');
  });
});

describe('crawl traversal', () => {
  it('36. seed page is fetched first', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: link('/about', 'About') },
          'https://acme.example/about': { body: '' },
        },
        seen,
      ),
    );
    await crawler.crawlCompanySite({ companyUrl: 'https://acme.example/', mode: 'production' });

    expect(seen[0]).toBe('https://acme.example/');
  });

  it('37/46. max pages are enforced and truncation is flagged', async () => {
    const seen: string[] = [];
    const routes: Record<string, StubRoute> = {
      'https://acme.example/': {
        body: Array.from({ length: 10 }, (_, index) => link(`/p${index}`, `P${index}`)).join(''),
      },
    };

    for (let index = 0; index < 10; index += 1) {
      routes[`https://acme.example/p${index}`] = { body: '' };
    }

    const crawler = makeCrawler(scriptRetrieval(routes, seen));
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result.pages).toHaveLength(8);
    expect(result.truncated).toBe(true);
    expect(seen).toHaveLength(8);
  });

  it('38. max depth is enforced along a chain', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: link('/a', 'A') },
          'https://acme.example/a': { body: link('/b', 'B') },
          'https://acme.example/b': { body: link('/c', 'C') },
          'https://acme.example/c': { body: link('/d', 'D') },
          'https://acme.example/d': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(seen).toEqual([
      'https://acme.example/',
      'https://acme.example/a',
      'https://acme.example/b',
    ]);
    expect(result.pages.map((page) => page.depth)).toEqual([0, 1, 2]);
  });

  it('39/40. duplicates and tracking variants are fetched once; real queries stay distinct', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': {
            body: [
              link('/x', 'X'),
              link('/x', 'X again'),
              link('/x#frag', 'X frag'),
              link('/x?utm_source=a', 'X tracked'),
              link('/search?role=eng', 'Eng'),
              link('/search?role=design', 'Design'),
            ].join(''),
          },
          'https://acme.example/x': { body: '' },
          'https://acme.example/search?role=eng': { body: '' },
          'https://acme.example/search?role=design': { body: '' },
        },
        seen,
      ),
    );
    await crawler.crawlCompanySite({ companyUrl: 'https://acme.example/', mode: 'production' });

    expect(seen.filter((url) => url === 'https://acme.example/x')).toHaveLength(1);
    expect(seen).toContain('https://acme.example/search?role=eng');
    expect(seen).toContain('https://acme.example/search?role=design');
  });

  it('41. ranked high-value links consume budget before DOM-early low-value links', async () => {
    const seen: string[] = [];
    const routes: Record<string, StubRoute> = {
      'https://acme.example/': {
        body: [
          link('/privacy', 'Privacy'),
          link('/login', 'Login'),
          link('/terms', 'Terms'),
          ...Array.from({ length: 5 }, (_, index) => link(`/p${index}`, `P${index}`)),
          link('/careers', 'Careers'),
        ].join(''),
      },
    };

    for (const path of [
      '/privacy',
      '/login',
      '/terms',
      '/careers',
      '/p0',
      '/p1',
      '/p2',
      '/p3',
      '/p4',
    ]) {
      routes[`https://acme.example${path}`] = { body: '' };
    }

    const crawler = makeCrawler(scriptRetrieval(routes, seen));
    await crawler.crawlCompanySite({ companyUrl: 'https://acme.example/', mode: 'production' });

    expect(seen).toContain('https://acme.example/careers');
    expect(seen).not.toContain('https://acme.example/privacy');
  });

  it('42. one page failure does not abort the others', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: `${link('/good', 'Good')}${link('/bad', 'Bad')}` },
          'https://acme.example/good': { body: '' },
          'https://acme.example/bad': { fail: { code: 'HTTP_ERROR', status: 404 } },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result.pages.map((page) => page.finalUrl)).toContain('https://acme.example/good');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      url: 'https://acme.example/bad',
      code: 'HTTP_ERROR',
      status: 404,
      depth: 1,
      discoveredFrom: 'https://acme.example/',
    });
    expect(seen).toContain('https://acme.example/good');
  });

  it('43. seed failure returns an honest result', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        { 'https://acme.example/': { fail: { code: 'HTTP_ERROR', status: 500 } } },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result).toEqual({
      seedUrl: 'https://acme.example/',
      finalSeedUrl: null,
      pages: [],
      failures: [
        {
          url: 'https://acme.example/',
          discoveredFrom: null,
          depth: 0,
          code: 'HTTP_ERROR',
          status: 500,
          message: 'The remote server returned an error.',
        },
      ],
      skipped: [],
      rankedLinks: [],
      truncated: false,
      truncationReasons: [],
      robots: [],
      stats: {
        pageRequestsAttempted: 1,
        pagesSucceeded: 0,
        pagesFailed: 1,
        pagesSkipped: 0,
      },
    });
    expect(seen).toEqual(['https://acme.example/']);
  });

  it('44. redirect-equivalent pages are deduplicated by final URL', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: `${link('/old', 'Old')}${link('/new', 'New')}` },
          'https://acme.example/old': { body: '', finalUrl: 'https://acme.example/new' },
          'https://acme.example/new': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(
      result.pages.filter((page) => page.finalUrl === 'https://acme.example/new'),
    ).toHaveLength(1);
    expect(result.pages).toHaveLength(2);
  });

  it('45. crawl deadline stops further scheduling with truncation flagged', async () => {
    const seen: string[] = [];
    let now = 0;
    const routes: Record<string, StubRoute> = {
      'https://acme.example/': { body: link('/about', 'About') },
      'https://acme.example/about': { body: '' },
    };
    const base = scriptRetrieval(routes, seen);
    const retrieval: Pick<RetrievalClient, 'retrieve'> = {
      retrieve: async (request: RetrievalRequest): Promise<RetrievalResult> => {
        now += 40_000;
        return base.retrieve(request);
      },
    };
    const crawler = makeCrawler(retrieval, { now: () => now });
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result.pages).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(seen).toEqual(['https://acme.example/']);
  });

  it('46. exhausted sites are not flagged truncated', async () => {
    const crawler = makeCrawler(scriptRetrieval({ 'https://acme.example/': { body: '' } }, []));
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result.pages).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it('47. concurrency never exceeds the configured limit', async () => {
    const seen: string[] = [];
    const seedUrl = 'https://acme.example/';
    let active = 0;
    let maxActive = 0;
    let releaseBatch!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const pageFor = (url: string): RetrievalResult => {
      const bodies: Record<string, string> = {
        [seedUrl]: [link('/a', 'A'), link('/b', 'B'), link('/c', 'C')].join(''),
      };
      const body = bodies[url] ?? '';
      return {
        ok: true,
        resource: {
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          contentType: 'text/html',
          body,
          bytes: Buffer.byteLength(body, 'utf8'),
        },
      };
    };
    const retrieval: Pick<RetrievalClient, 'retrieve'> = {
      retrieve: async (request: RetrievalRequest): Promise<RetrievalResult> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seen.push(request.url);

        if (request.url !== seedUrl) {
          await barrier;
        }

        active -= 1;
        return pageFor(request.url);
      },
    };
    const crawlPromise = makeCrawler(retrieval).crawlCompanySite({
      companyUrl: seedUrl,
      mode: 'production',
    });

    for (let spin = 0; spin < 1000 && seen.length < 3; spin += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    expect(seen).toHaveLength(3);
    releaseBatch();
    await crawlPromise;

    expect(maxActive).toBe(2);
    expect(seen).toHaveLength(4);
  });

  it('48. per-host request-start rate discipline is applied', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: `${link('/a', 'A')}${link('/b', 'B')}` },
          'https://acme.example/a': { body: '' },
          'https://acme.example/b': { body: '' },
        },
        seen,
      ),
      { sleeps },
    );
    await crawler.crawlCompanySite({ companyUrl: 'https://acme.example/', mode: 'production' });

    expect(seen).toHaveLength(3);
    expect(sleeps).toContain(200);
  });

  it('seed redirect establishes the crawl context', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': {
            body: link('/careers', 'Careers'),
            finalUrl: 'https://www.acme.example/',
          },
          'https://www.acme.example/careers': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result.finalSeedUrl).toBe('https://www.acme.example/');
    expect(seen).toContain('https://www.acme.example/careers');
  });
});

describe('Phase A carry-forward regressions', () => {
  it('A1. failed pages consume the request budget: 50 broken links stay within 8 attempts', async () => {
    const seen: string[] = [];
    const routes: Record<string, StubRoute> = {
      'https://acme.example/': {
        body: Array.from({ length: 50 }, (_, index) => link(`/b${index}`, `B${index}`)).join(''),
      },
    };

    for (let index = 0; index < 50; index += 1) {
      routes[`https://acme.example/b${index}`] = { fail: { code: 'HTTP_ERROR', status: 404 } };
    }

    const crawler = makeCrawler(scriptRetrieval(routes, seen));
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(seen).toHaveLength(8);
    expect(result.stats).toEqual({
      pageRequestsAttempted: 8,
      pagesSucceeded: 1,
      pagesFailed: 7,
      pagesSkipped: 0,
    });
    expect(result.truncationReasons).toContain('page-request-limit');
  });

  it('A2. private-suffix hosts scope per tenant, not per suffix', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://company.github.io/': {
            body: [
              link('/about', 'About'),
              link('https://attacker.github.io/', 'Attacker'),
              link('https://otherco.github.io/', 'Other'),
            ].join(''),
          },
          'https://company.github.io/about': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://company.github.io/',
      mode: 'production',
    });

    expect(seen).toContain('https://company.github.io/about');
    expect(seen).not.toContain('https://attacker.github.io/');
    expect(seen).not.toContain('https://otherco.github.io/');
    expect(result.pages).toHaveLength(2);
  });

  it('A4. a URL discovered by two pages before fetching is fetched once', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: `${link('/a', 'A')}${link('/b', 'B')}` },
          'https://acme.example/a': { body: link('/foo', 'Foo A') },
          'https://acme.example/b': { body: link('/foo', 'Foo B') },
          'https://acme.example/foo': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(seen.filter((url) => url === 'https://acme.example/foo')).toHaveLength(1);
    expect(
      result.rankedLinks.filter((entry) => entry.url === 'https://acme.example/foo'),
    ).toHaveLength(1);
  });

  it('A5. per-page discoveries are rank-capped with candidate-limit truncation', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': {
            body: [
              link('/careers', 'Careers'),
              ...Array.from({ length: 250 }, (_, index) => link(`/g${index}`, `G${index}`)),
            ].join(''),
          },
          'https://acme.example/careers': { body: '' },
        },
        seen,
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    // 251 discoveries collapse to the top 200 by rank; Careers survives the cap.
    expect(result.rankedLinks).toHaveLength(200);
    expect(result.rankedLinks[0]?.url).toBe('https://acme.example/careers');
    expect(result.truncationReasons).toContain('candidate-limit');
    expect(result.truncated).toBe(true);
  });

  it('A6. fetched pages preserve the candidate relevance that selected them', async () => {
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: link('/foo', 'Careers') },
          'https://acme.example/foo': { body: 'hiring page' },
        },
        [],
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    const page = result.pages.find((entry) => entry.finalUrl === 'https://acme.example/foo');
    const ranked = result.rankedLinks.find((entry) => entry.url === 'https://acme.example/foo');
    expect(page?.relevanceScore).toBeGreaterThanOrEqual(100);
    expect(page?.relevanceScore).toBe(ranked?.score);
  });

  it('A7. duplicate URLs keep the best deterministic anchor signal', async () => {
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': {
            body: `${link('/foo', 'Learn More')}${link('/foo', 'Careers')}`,
          },
          'https://acme.example/foo': { body: '' },
        },
        [],
      ),
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    const ranked = result.rankedLinks.filter((entry) => entry.url === 'https://acme.example/foo');
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.anchorText).toBe('Careers');
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(100);
  });

  it('A8. truncation reasons stay truthful across bounds', async () => {
    const maxCrawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': {
            body: Array.from({ length: 10 }, (_, index) => link(`/p${index}`, `P${index}`)).join(
              '',
            ),
          },
          ...Object.fromEntries(
            Array.from({ length: 10 }, (_, index) => [
              `https://acme.example/p${index}`,
              { body: '' },
            ]),
          ),
        },
        [],
      ),
    );
    const maxed = await maxCrawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });
    expect(maxed.truncationReasons).toContain('page-request-limit');

    const chainCrawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: link('/a', 'A') },
          'https://acme.example/a': { body: link('/b', 'B') },
          'https://acme.example/b': { body: link('/c', 'C') },
          'https://acme.example/c': { body: link('/d', 'D') },
        },
        [],
      ),
    );
    const chained = await chainCrawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });
    expect(chained.truncationReasons).toContain('depth-limit');

    const completeCrawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: link('/about', 'About') },
          'https://acme.example/about': { body: '' },
        },
        [],
      ),
    );
    const complete = await completeCrawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });
    expect(complete.truncated).toBe(false);
    expect(complete.truncationReasons).toEqual([]);
  });

  it('A9. seed shares pacing: the first same-origin candidate waits the interval', async () => {
    const sleeps: number[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://acme.example/': { body: link('/a', 'A') },
          'https://acme.example/a': { body: '' },
        },
        [],
      ),
      { sleeps },
    );
    await crawler.crawlCompanySite({ companyUrl: 'https://acme.example/', mode: 'production' });

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0] ?? 0).toBeGreaterThan(150);
  });
});

describe('local evaluator integration', () => {
  let server: Server | null = null;
  let baseUrl = '';
  const requestedPaths: string[] = [];

  const routes: Record<string, { status: number; headers: Record<string, string>; body: string }> =
    {
      '/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: [
          link('/about', 'About'),
          link('/foo', 'Careers'),
          link('/privacy', 'Privacy'),
          link('/old-redirect', 'Old'),
        ].join(''),
      },
      '/foo': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: [link('engineering', 'Engineering'), link('/jobs/openings', 'Openings')].join(''),
      },
      '/jobs/openings': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: link('../about', 'About'),
      },
      '/about': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: link('/ghost', 'Missing'),
      },
      '/old-redirect': { status: 302, headers: { location: '/about' }, body: '' },
      '/privacy': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '',
      },
      '/engineering': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '',
      },
    };

  const startServer = async (): Promise<void> => {
    requestedPaths.length = 0;
    server = createServer((request, response) => {
      requestedPaths.push(request.url ?? '/');
      const route = routes[request.url ?? '/'];

      if (!route) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('missing');
        return;
      }

      response.writeHead(route.status, route.headers);
      response.end(route.body);
    });

    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server?.address();

    if (typeof address !== 'object' || address === null) {
      throw new Error('crawl integration server did not bind');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  };

  const stopServer = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }

      server.close(() => resolve());
    });
    server = null;
  };

  const integrationCrawler = (): CompanyCrawlerService => {
    const retrievalClient = new RetrievalClient({
      urlSafety: new UrlSafetyService({ dnsResolver: mockDns({}) }),
      logger: makeLogger(),
      sleep: async () => {},
      random: () => 0,
    });

    return new CompanyCrawlerService({
      urlSafety: new UrlSafetyService(),
      retrievalClient,
      linkDiscovery: new LinkDiscoveryService(),
      linkRanking: new LinkRankingService(),
      robotsPolicy: new RobotsPolicyService({ retrievalClient, logger: makeLogger() }),
      pageExtraction: new PageExtractionService(),
      logger: makeLogger(),
      sleep: async () => {},
    });
  };

  it('crawls a local evaluator site: relative links, opaque careers ranking, 404 isolation', async () => {
    await startServer();

    try {
      const result = await integrationCrawler().crawlCompanySite({
        companyUrl: `${baseUrl}/`,
        mode: 'evaluation',
      });

      const finals = result.pages.map((page) => page.finalUrl);
      expect(finals).toContain(`${baseUrl}/`);
      expect(finals).toContain(`${baseUrl}/foo`);
      expect(finals).toContain(`${baseUrl}/about`);
      expect(finals).toContain(`${baseUrl}/jobs/openings`);
      expect(finals).toContain(`${baseUrl}/engineering`);

      // The opaque /foo "Careers" link ranks first among discoveries.
      expect(result.rankedLinks[0]?.url).toBe(`${baseUrl}/foo`);

      // Useful pages are fetched before the low-value privacy page.
      const privacyIndex = requestedPaths.indexOf('/privacy');
      expect(privacyIndex).toBeGreaterThanOrEqual(0);
      expect(privacyIndex).toBe(requestedPaths.length - 1);

      // The redirect collapses onto the single /about page.
      expect(finals.filter((url) => url === `${baseUrl}/about`)).toHaveLength(1);

      // The 404 source is recorded, not fatal.
      expect(result.failures.map((failure) => failure.url)).toContain(`${baseUrl}/ghost`);
      expect(result.failures[0]).toMatchObject({ code: 'HTTP_ERROR', status: 404 });

      // Only seed + discovered URLs + the one well-known robots path were
      // ever requested.
      const known = new Set([
        '/',
        '/robots.txt',
        '/about',
        '/foo',
        '/privacy',
        '/old-redirect',
        '/engineering',
        '/jobs/openings',
        '/ghost',
      ]);

      for (const path of requestedPaths) {
        expect(known.has(path)).toBe(true);
      }

      expect(requestedPaths).toContain('/robots.txt');
    } finally {
      await stopServer();
    }
  }, 20000);

  it('production mode rejects the same localhost target', async () => {
    await startServer();

    try {
      const result = await integrationCrawler().crawlCompanySite({
        companyUrl: `${baseUrl}/`,
        mode: 'production',
      });

      // Retrieval safety blocks even the robots fetch, so the seed is never
      // retrieved: nothing is fetched and the skip records the cause.
      expect(result.pages).toEqual([]);
      expect(result.finalSeedUrl).toBeNull();
      expect(result.failures).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toMatchObject({ reason: 'ROBOTS_UNAVAILABLE', depth: 0 });
      expect(requestedPaths).toEqual([]);
    } finally {
      await stopServer();
    }
  });
});

describe('phase A carry-forward fixes', () => {
  const scriptHttp = (steps: Array<RetrievalHttpResponse | Error>, seen: string[]): HttpGetter => {
    const remaining = [...steps];
    return async (url: string) => {
      seen.push(url);
      const step = remaining.shift();

      if (!step) {
        throw new Error('http script exhausted');
      }

      if (step instanceof Error) {
        throw step;
      }

      return step;
    };
  };

  const redirectTo = (location: string): RetrievalHttpResponse => ({
    status: 302,
    headers: { location },
    body: '',
  });

  const htmlOk = (body: string): RetrievalHttpResponse => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
  });

  // Real client + real robots policy over a scripted transport so redirect
  // guards run exactly as in production. 127.0.0.1 literals keep evaluation
  // mode free of DNS while staying origin-scoped.
  const guardCrawler = (
    steps: Array<RetrievalHttpResponse | Error>,
    seen: string[],
    sleeps: number[] = [],
  ): CompanyCrawlerService => {
    const http = scriptHttp(steps, seen);
    const client = new RetrievalClient({
      urlSafety: new UrlSafetyService(),
      logger: makeLogger(),
      httpGet: http,
      sleep: async () => {},
      random: () => 0,
    });

    return new CompanyCrawlerService({
      urlSafety: new UrlSafetyService(),
      retrievalClient: client,
      linkDiscovery: new LinkDiscoveryService(),
      linkRanking: new LinkRankingService(),
      robotsPolicy: new RobotsPolicyService({ retrievalClient: client, logger: makeLogger() }),
      pageExtraction: new PageExtractionService(),
      logger: makeLogger(),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
  };

  it('A1. seed redirect to a robots-disallowed target is never fetched', async () => {
    const seen: string[] = [];
    const crawler = guardCrawler(
      [htmlOk('User-agent: *\nDisallow: /private\n'), redirectTo('/private')],
      seen,
    );

    const result = await crawler.crawlCompanySite({
      companyUrl: 'http://127.0.0.1:18080/go',
      mode: 'evaluation',
    });

    expect(seen).toEqual(['http://127.0.0.1:18080/robots.txt', 'http://127.0.0.1:18080/go']);
    expect(result.pages).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([
      {
        url: 'http://127.0.0.1:18080/private',
        reason: 'ROBOTS_DISALLOWED',
        discoveredFrom: null,
        depth: 0,
      },
    ]);
  });

  it('A1. candidate redirect outside company scope is never fetched', async () => {
    const seen: string[] = [];
    const crawler = guardCrawler(
      [
        htmlOk('User-agent: *\nDisallow:\n'),
        htmlOk(link('/go', 'Go')),
        redirectTo('http://127.0.0.2:19090/away'),
      ],
      seen,
    );

    const result = await crawler.crawlCompanySite({
      companyUrl: 'http://127.0.0.1:18081/',
      mode: 'evaluation',
    });

    expect(seen).not.toContain('http://127.0.0.2:19090/away');
    expect(seen).not.toContain('http://127.0.0.2:19090/robots.txt');
    expect(result.skipped).toContainEqual({
      url: 'http://127.0.0.2:19090/away',
      reason: 'OUT_OF_SCOPE_REDIRECT',
      discoveredFrom: 'http://127.0.0.1:18081/',
      depth: 1,
    });
    expect(result.pages.map((page) => page.finalUrl)).toContain('http://127.0.0.1:18081/');
  });

  it('A3. robots fetch participates in per-origin pacing before the seed', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    const now = 5_000_000;
    const retrieval = scriptRetrieval(
      {
        'https://paced.example/robots.txt': { body: 'User-agent: *\nDisallow:\n' },
        'https://paced.example/': { body: '' },
      },
      seen,
    );
    const crawler = new CompanyCrawlerService({
      urlSafety: new UrlSafetyService(),
      retrievalClient: retrieval,
      linkDiscovery: new LinkDiscoveryService(),
      linkRanking: new LinkRankingService(),
      robotsPolicy: new RobotsPolicyService({ retrievalClient: retrieval, logger: makeLogger() }),
      pageExtraction: new PageExtractionService(),
      logger: makeLogger(),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: () => now,
    });

    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://paced.example/',
      mode: 'production',
    });

    expect(seen).toEqual(['https://paced.example/robots.txt', 'https://paced.example/']);
    expect(result.pages).toHaveLength(1);
    // The robots request starts the origin clock, so the seed cannot follow
    // immediately: exactly one base-interval wait separates them.
    expect(sleeps).toEqual([200]);
  });

  it('A4. text/plain bodies extract content without feeding link discovery', async () => {
    const seen: string[] = [];
    const crawler = makeCrawler(
      scriptRetrieval(
        {
          'https://plain.example/': {
            body: '<a href="/careers">Careers</a>\nplain research notes',
            contentType: 'text/plain',
          },
        },
        seen,
      ),
    );

    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://plain.example/',
      mode: 'production',
    });

    expect(seen).toEqual(['https://plain.example/']);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.content.text).toContain('plain research notes');
    expect(result.rankedLinks).toEqual([]);
  });

  it('A5. a trimmed candidate rediscovered with a stronger signal is fetched once', async () => {
    const seen: string[] = [];
    const seedLinks = Array.from({ length: 200 }, (_, index) =>
      link(`/f${String(index + 1).padStart(3, '0')}`, 'page'),
    ).join('');
    const fillerLinks = (tag: string, anchor: string): string =>
      `${link('/foo', anchor)}${Array.from({ length: 200 }, (_, index) =>
        link(`/u${tag}${String(index).padStart(3, '0')}`, 'page'),
      ).join('')}`;

    const generativeRetrieval = (
      routes: Record<string, StubRoute>,
      seenUrls: string[],
    ): Pick<RetrievalClient, 'retrieve'> => ({
      retrieve: async (request: RetrievalRequest): Promise<RetrievalResult> => {
        seenUrls.push(request.url);
        const route = routes[request.url];

        if (!route) {
          return toRetrievalResult(
            new RetrievalException('HTTP_ERROR', 'stub has no route', {
              url: request.url,
              status: 404,
            }),
          );
        }

        const body = route.body ?? '';
        const finalUrl = route.finalUrl ?? request.url;

        return {
          ok: true,
          resource: {
            requestedUrl: request.url,
            finalUrl,
            status: 200,
            contentType: 'text/html',
            body,
            bytes: Buffer.byteLength(body, 'utf8'),
          },
        };
      },
    });

    const crawler = makeCrawler(
      generativeRetrieval(
        {
          'https://trim.example/': { body: seedLinks },
          'https://trim.example/f001': { body: fillerLinks('a', 'details') },
          'https://trim.example/f002': { body: fillerLinks('b', 'details') },
          'https://trim.example/f003': { body: fillerLinks('c', 'Careers') },
          'https://trim.example/f004': { body: fillerLinks('d', 'Careers') },
          'https://trim.example/foo': { body: 'foo careers page' },
        },
        seen,
      ),
    );

    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://trim.example/',
      mode: 'production',
    });

    const fooFetches = seen.filter((url) => url === 'https://trim.example/foo');
    expect(fooFetches).toHaveLength(1);
    const fooPage = result.pages.find((page) => page.finalUrl === 'https://trim.example/foo');
    expect(fooPage?.relevanceScore).toBe(100);
    expect(
      result.rankedLinks.find((entry) => entry.url === 'https://trim.example/foo')?.signals,
    ).toContain('anchor:careers');
    expect(result.truncationReasons).toContain('candidate-limit');
  });

  it('A6. malformed and unsupported seeds return structured failures without throwing', async () => {
    for (const companyUrl of ['javascript:alert(1)', 'ftp://acme.example/', 'not a url', '']) {
      const seen: string[] = [];
      const crawler = makeCrawler(scriptRetrieval({}, seen));

      const result = await crawler.crawlCompanySite({ companyUrl, mode: 'production' });

      expect(result.pages).toEqual([]);
      expect(result.finalSeedUrl).toBeNull();
      expect(result.failures).toHaveLength(1);
      // Only the seed retrieval itself is attempted: robots preflight never
      // throws on the malformed seed and fetches nothing.
      expect(seen).toEqual([companyUrl]);
    }
  });

  it('A7. deadline lost during pacing does not inflate attempted requests', async () => {
    const seen: string[] = [];
    let now = 9_000_000;
    let sleeps = 0;
    const crawler = new CompanyCrawlerService({
      urlSafety: new UrlSafetyService(),
      retrievalClient: scriptRetrieval(
        {
          'https://paced.example/': { body: `${link('/a', 'A')}${link('/b', 'B')}` },
          'https://paced.example/a': { body: '' },
          'https://paced.example/b': { body: '' },
        },
        seen,
      ),
      linkDiscovery: new LinkDiscoveryService(),
      linkRanking: new LinkRankingService(),
      robotsPolicy: allowAllRobots(),
      pageExtraction: new PageExtractionService(),
      logger: makeLogger(),
      sleep: async () => {
        sleeps += 1;
        // The seed pace makes no sleep call (first request for the origin);
        // the first candidate pace exhausts the deadline.
        if (sleeps >= 1) {
          now += 60_000;
        }
      },
      now: () => now,
    });

    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://paced.example/',
      mode: 'production',
    });

    expect(result.pages).toHaveLength(1);
    expect(seen).toEqual(['https://paced.example/']);
    expect(result.stats.pageRequestsAttempted).toBe(1);
    expect(result.truncationReasons).toContain('deadline');
  });
});
