import { describe, expect, it } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { CompanyCrawlerService } from '@/modules/research/crawl/company-crawler.service';
import { LinkDiscoveryService } from '@/modules/research/crawl/link-discovery.service';
import { LinkRankingService } from '@/modules/research/crawl/link-ranking.service';
import { PageExtractionService } from '@/modules/research/extraction/page-extraction.service';
import type { RetrievalClient } from '@/modules/research/retrieval/retrieval-client.service';
import { RetrievalException } from '@/modules/research/retrieval/retrieval.exception';
import { toRetrievalResult } from '@/modules/research/retrieval/retrieval.failure';
import type {
  RetrievalFailureCode,
  RetrievalRequest,
  RetrievalResult,
} from '@/modules/research/retrieval/retrieval.type';
import {
  MAX_CRAWL_ORIGINS,
  ROBOTS_PATH,
  ROBOTS_USER_AGENT_TOKEN,
} from '@/modules/research/robots/robots.constants';
import { RobotsPolicyService } from '@/modules/research/robots/robots-policy.service';
import { UrlSafetyService } from '@/modules/research/retrieval/url-safety.service';

const makeLogger = (): LoggerService =>
  new LoggerService({
    baseLogger: createBaseLogger('silent'),
    requestContext: new RequestContextService(),
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

const makeRobotsCrawler = (
  routes: Record<string, StubRoute>,
  seen: string[],
  options: { sleeps?: number[] } = {},
): CompanyCrawlerService => {
  const retrieval = scriptRetrieval(routes, seen);

  return new CompanyCrawlerService({
    urlSafety: new UrlSafetyService(),
    retrievalClient: retrieval,
    linkDiscovery: new LinkDiscoveryService(),
    linkRanking: new LinkRankingService(),
    robotsPolicy: new RobotsPolicyService({ retrievalClient: retrieval, logger: makeLogger() }),
    pageExtraction: new PageExtractionService(),
    logger: makeLogger(),
    sleep: async (ms: number) => {
      options.sleeps?.push(ms);
    },
  });
};

const link = (href: string, text: string): string => `<a href="${href}">${text}</a>`;

const robotsSeen = (seen: string[]): string[] => seen.filter((url) => url.endsWith(ROBOTS_PATH));

describe('robots policy', () => {
  it('1. robots URL is built from the origin well-known path', () => {
    const service = new RobotsPolicyService({
      retrievalClient: scriptRetrieval({}, []),
      logger: makeLogger(),
    });

    expect(service.buildRobotsUrl('https://acme.example')).toBe('https://acme.example/robots.txt');
    expect(service.buildRobotsUrl('http://localhost:8099')).toBe(
      'http://localhost:8099/robots.txt',
    );
  });

  it('2. robots is fetched once per origin', async () => {
    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/': { body: `${link('/a', 'A')}${link('/b', 'B')}` },
        'https://acme.example/a': { body: '' },
        'https://acme.example/b': { body: '' },
      },
      seen,
    );
    await crawler.crawlCompanySite({ companyUrl: 'https://acme.example/', mode: 'production' });

    expect(robotsSeen(seen)).toEqual(['https://acme.example/robots.txt']);
  });

  it('3. missing robots 404 stays allowed', async () => {
    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/': { body: link('/about', 'About') },
        'https://acme.example/about': { body: '' },
      },
      seen,
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result.pages).toHaveLength(2);
    expect(result.robots).toEqual([
      { origin: 'https://acme.example', status: 'missing', httpStatus: 404 },
    ]);
  });

  it('4/8. Disallow /private prevents the fetch and records a skip, not a failure', async () => {
    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/robots.txt': {
          body: 'User-agent: *\nDisallow: /private\n',
        },
        'https://acme.example/': { body: link('/private', 'Private') },
        'https://acme.example/private': { body: 'secret' },
      },
      seen,
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(seen).not.toContain('https://acme.example/private');
    expect(result.pages).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([
      {
        url: 'https://acme.example/private',
        reason: 'ROBOTS_DISALLOWED',
        discoveredFrom: 'https://acme.example/',
        depth: 1,
      },
    ]);
  });

  it('5. Allow rules admit listed paths while the rest stays disallowed', async () => {
    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/robots.txt': {
          body: 'User-agent: *\nDisallow: /\nAllow: /public/\n',
        },
        'https://acme.example/public/': {
          body: `${link('/public/x', 'Public')}${link('/other', 'Other')}`,
        },
        'https://acme.example/public/x': { body: '' },
        'https://acme.example/other': { body: '' },
      },
      seen,
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/public/',
      mode: 'production',
    });

    expect(seen).toContain('https://acme.example/public/x');
    expect(seen).not.toContain('https://acme.example/other');
    expect(result.pages.map((page) => page.finalUrl)).toContain('https://acme.example/public/x');
  });

  it('6/7. bot-specific group wins and our user-agent token is used', async () => {
    expect(ROBOTS_USER_AGENT_TOKEN).toBe('InterviewPrepResearchBot');

    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/robots.txt': {
          body: 'User-agent: *\nAllow: /\n\nUser-agent: InterviewPrepResearchBot\nDisallow: /bot-zone\n',
        },
        'https://acme.example/': {
          body: `${link('/bot-zone', 'Bot zone')}${link('/open', 'Open')}`,
        },
        'https://acme.example/open': { body: '' },
        'https://acme.example/bot-zone': { body: '' },
      },
      seen,
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(seen).not.toContain('https://acme.example/bot-zone');
    expect(seen).toContain('https://acme.example/open');
    expect(result.skipped.map((skip) => skip.url)).toContain('https://acme.example/bot-zone');
  });

  it('unmatched user-agent groups stay allowed', async () => {
    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/robots.txt': {
          body: 'User-agent: OtherBot\nDisallow: /\n',
        },
        'https://acme.example/': { body: link('/about', 'About') },
        'https://acme.example/about': { body: '' },
      },
      seen,
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result.pages).toHaveLength(2);
  });

  it('9. robots 429 is handled conservatively: origin skipped, nothing fetched', async () => {
    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/robots.txt': { fail: { code: 'RATE_LIMITED', status: 429 } },
        'https://acme.example/': { body: link('/about', 'About') },
      },
      seen,
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(seen).toEqual(['https://acme.example/robots.txt']);
    expect(result.pages).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([
      {
        url: 'https://acme.example/',
        reason: 'ROBOTS_UNAVAILABLE',
        discoveredFrom: null,
        depth: 0,
      },
    ]);
    expect(result.robots).toEqual([
      {
        origin: 'https://acme.example',
        status: 'unavailable',
        httpStatus: 429,
        failureCode: 'RATE_LIMITED',
      },
    ]);
  });

  it('10. robots 5xx and network failures stay unavailable, never allow-all', async () => {
    for (const fail of [
      { code: 'HTTP_ERROR' as const, status: 500 },
      { code: 'TIMEOUT' as const },
    ]) {
      const seen: string[] = [];
      const crawler = makeRobotsCrawler(
        {
          'https://acme.example/robots.txt': { fail },
          'https://acme.example/': { body: link('/about', 'About') },
        },
        seen,
      );
      const result = await crawler.crawlCompanySite({
        companyUrl: 'https://acme.example/',
        mode: 'production',
      });

      expect(result.pages).toEqual([]);
      expect(result.skipped[0]?.reason).toBe('ROBOTS_UNAVAILABLE');
      expect(seen).toEqual(['https://acme.example/robots.txt']);
      expect(result.robots).toEqual([
        {
          origin: 'https://acme.example',
          status: 'unavailable',
          ...(fail.status !== undefined ? { httpStatus: fail.status } : {}),
          failureCode: fail.code,
        },
      ]);
    }
  });

  it('13. a second allowed origin gets its own robots policy', async () => {
    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/': { body: link('https://careers.acme.example/jobs', 'Jobs') },
        'https://careers.acme.example/robots.txt': {
          body: 'User-agent: *\nDisallow: /jobs\n',
        },
        'https://careers.acme.example/jobs': { body: '' },
      },
      seen,
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(robotsSeen(seen)).toEqual([
      'https://acme.example/robots.txt',
      'https://careers.acme.example/robots.txt',
    ]);
    expect(seen).not.toContain('https://careers.acme.example/jobs');
    expect(result.skipped.map((skip) => skip.url)).toContain('https://careers.acme.example/jobs');
  });

  it('14. robots origin count is bounded', async () => {
    expect(MAX_CRAWL_ORIGINS).toBe(3);

    const seen: string[] = [];
    const subdomains = ['a', 'b', 'c', 'd'].map((name) => `https://${name}.acme.example/`);
    const routes: Record<string, StubRoute> = {
      'https://acme.example/': {
        body: subdomains.map((url) => link(url, url)).join(''),
      },
    };

    for (const url of subdomains) {
      routes[`${url}robots.txt`] = { body: 'User-agent: *\nAllow: /\n' };
      routes[url] = { body: '' };
    }

    const crawler = makeRobotsCrawler(routes, seen);
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(robotsSeen(seen)).toHaveLength(MAX_CRAWL_ORIGINS);
    expect(result.skipped.map((skip) => skip.reason)).toContain('ORIGIN_LIMIT');
  });

  it('15. redirected out-of-scope finals are recorded as skips, never expanded', async () => {
    const seen: string[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/': { body: link('/go', 'Go') },
        'https://acme.example/go': { body: '', finalUrl: 'https://evil.com/' },
      },
      seen,
    );
    const result = await crawler.crawlCompanySite({
      companyUrl: 'https://acme.example/',
      mode: 'production',
    });

    expect(result.pages).toHaveLength(1);
    expect(result.skipped).toEqual([
      {
        url: 'https://evil.com/',
        reason: 'OUT_OF_SCOPE',
        discoveredFrom: 'https://acme.example/',
        depth: 1,
      },
    ]);
    expect(result.rankedLinks).toHaveLength(1);
  });

  it('crawl-delay raises the effective per-origin interval without capping it down', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    const crawler = makeRobotsCrawler(
      {
        'https://acme.example/robots.txt': {
          body: 'User-agent: *\nAllow: /\nCrawl-delay: 1\n',
        },
        'https://acme.example/': { body: link('/a', 'A') },
        'https://acme.example/a': { body: '' },
      },
      seen,
      { sleeps },
    );
    await crawler.crawlCompanySite({ companyUrl: 'https://acme.example/', mode: 'production' });

    expect(seen).toContain('https://acme.example/a');
    expect(sleeps).toContain(1000);
  });
});
