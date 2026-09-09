import { describe, expect, it } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import type { CompanyCrawlResult, CrawlPage } from '@/modules/research/crawl/crawl.type';
import {
  CompanyResearchService,
  companyNameHintFromCrawl,
} from '@/modules/research/company-research.service';
import type { PublicDiscussionResearchService } from '@/modules/research/discussion/public-discussion-research.service';
import type { PublicDiscussionResearchResult } from '@/modules/research/discussion/discussion.type';

const makeLogger = (): LoggerService =>
  new LoggerService({
    baseLogger: createBaseLogger('silent'),
    requestContext: new RequestContextService(),
  });

const seedPage = (title: string | null): CrawlPage => ({
  requestedUrl: 'https://acme.example/',
  finalUrl: 'https://acme.example/',
  depth: 0,
  discoveredFrom: null,
  status: 200,
  contentType: 'text/html',
  content: {
    title,
    description: null,
    headings: [],
    text: 'Acme home',
    textChars: 9,
    truncated: false,
    contentEmpty: false,
    contentHash: 'abc',
    trust: 'external-untrusted',
  },
  relevanceScore: 0,
});

const stats = { pageRequestsAttempted: 1, pagesSucceeded: 1, pagesFailed: 0, pagesSkipped: 0 };

const goodCrawl = (title: string | null = 'Acme Corp'): CompanyCrawlResult => ({
  seedUrl: 'https://acme.example/',
  finalSeedUrl: 'https://acme.example/',
  pages: [seedPage(title)],
  failures: [],
  skipped: [],
  rankedLinks: [],
  truncated: false,
  truncationReasons: [],
  robots: [],
  stats,
});

const failedCrawl = (): CompanyCrawlResult => ({
  ...goodCrawl(),
  finalSeedUrl: null,
  pages: [],
  failures: [
    {
      url: 'https://acme.example/',
      discoveredFrom: null,
      depth: 0,
      code: 'TIMEOUT',
      message: 'The request timed out.',
    },
  ],
  stats: { pageRequestsAttempted: 1, pagesSucceeded: 0, pagesFailed: 1, pagesSkipped: 0 },
});

const discussionStats = {
  queriesAttempted: 2,
  searchResultsFound: 1,
  uniqueResults: 1,
  pagesAttempted: 1,
  pagesFetched: 1,
  pagesSkipped: 0,
  pagesFailed: 0,
};

const goodDiscussions = (): PublicDiscussionResearchResult => ({
  companySearchName: 'acme',
  queries: ['acme interview experience', 'acme interview questions'],
  sources: [
    {
      title: 'Acme interview',
      url: 'https://forum.example/t/1',
      domain: 'forum.example',
      trust: 'external-untrusted',
      search: { query: 'acme interview experience', rank: 0, snippet: 'onsite' },
      page: {
        requestedUrl: 'https://forum.example/t/1',
        finalUrl: 'https://forum.example/t/1',
        content: {
          title: 'Acme interview',
          description: null,
          headings: [],
          text: 'onsite notes',
          textChars: 12,
          truncated: false,
          contentEmpty: false,
          contentHash: 'def',
          trust: 'external-untrusted',
        },
      },
      fetchStatus: 'fetched',
    },
  ],
  failures: [],
  status: 'complete',
  stats: discussionStats,
});

const unavailableDiscussions = (): PublicDiscussionResearchResult => ({
  companySearchName: 'acme',
  queries: [],
  sources: [],
  failures: [{ source: 'search', code: 'SEARCH_PROVIDER_NOT_CONFIGURED' }],
  status: 'unavailable',
  stats: {
    queriesAttempted: 0,
    searchResultsFound: 0,
    uniqueResults: 0,
    pagesAttempted: 0,
    pagesFetched: 0,
    pagesSkipped: 0,
    pagesFailed: 0,
  },
});

const makeService = (
  crawl: CompanyCrawlResult,
  discussions: PublicDiscussionResearchResult,
  captured: Array<Record<string, unknown>> = [],
): CompanyResearchService =>
  new CompanyResearchService({
    companyCrawler: {
      crawlCompanySite: async () => crawl,
    },
    discussionResearch: {
      research: async (input: Record<string, unknown>) => {
        captured.push(input);
        return discussions;
      },
    } as unknown as Pick<PublicDiscussionResearchService, 'research'>,
    logger: makeLogger(),
  });

describe('company research orchestration', () => {
  it('1. both branches succeed gives complete', async () => {
    const crawl = goodCrawl();
    const discussions = goodDiscussions();
    const result = await makeService(crawl, discussions).researchCompany({
      companyUrl: 'https://acme.example/',
      mode: 'evaluation',
    });

    expect(result.status).toBe('complete');
    expect(result.companyUrl).toBe('https://acme.example/');
    expect(result.companySite).toBe(crawl);
    expect(result.publicDiscussions).toBe(discussions);
    expect(result.failures).toEqual([]);
  });

  it('2. crawl succeeds plus discussions unavailable gives partial', async () => {
    const result = await makeService(goodCrawl(), unavailableDiscussions()).researchCompany({
      companyUrl: 'https://acme.example/',
      mode: 'evaluation',
    });

    expect(result.status).toBe('partial');
    expect(result.companySite.pages).toHaveLength(1);
    expect(result.publicDiscussions.sources).toEqual([]);
    expect(result.failures).toEqual([
      { branch: 'public-discussions', code: 'SEARCH_PROVIDER_NOT_CONFIGURED' },
    ]);
  });

  it('3. crawl fails plus discussions succeed gives partial', async () => {
    const result = await makeService(failedCrawl(), goodDiscussions()).researchCompany({
      companyUrl: 'https://acme.example/',
      mode: 'evaluation',
    });

    expect(result.status).toBe('partial');
    expect(result.companySite.pages).toEqual([]);
    expect(result.publicDiscussions.sources).toHaveLength(1);
    expect(result.failures).toEqual([
      { branch: 'company-site', code: 'TIMEOUT', detail: 'The request timed out.' },
    ]);
  });

  it('4. both fail gives failed', async () => {
    const result = await makeService(failedCrawl(), unavailableDiscussions()).researchCompany({
      companyUrl: 'https://acme.example/',
      mode: 'evaluation',
    });

    expect(result.status).toBe('failed');
    expect(result.failures).toHaveLength(2);
  });

  it('5. child failures preserved with branches', async () => {
    const discussions = goodDiscussions();
    discussions.failures.push({
      source: 'page',
      query: 'acme interview experience',
      url: 'https://slow.example/',
      code: 'RETRIEVAL_FAILED',
      retrievalCode: 'TIMEOUT',
    });
    discussions.status = 'partial';
    const result = await makeService(failedCrawl(), discussions).researchCompany({
      companyUrl: 'https://acme.example/',
      mode: 'evaluation',
    });

    expect(result.status).toBe('partial');
    expect(result.failures).toContainEqual({
      branch: 'company-site',
      code: 'TIMEOUT',
      detail: 'The request timed out.',
    });
    expect(result.failures).toContainEqual({
      branch: 'public-discussions',
      code: 'RETRIEVAL_FAILED',
    });
  });

  it('6. crawl metadata provides the discussion company-name hint', async () => {
    const captured: Array<Record<string, unknown>> = [];
    await makeService(goodCrawl('Acme Corp'), goodDiscussions(), captured).researchCompany({
      companyUrl: 'https://careers.acme.example/jobs',
      mode: 'evaluation',
    });

    expect(captured[0]?.['companyNameHint']).toBe('Acme Corp');
    expect(companyNameHintFromCrawl(goodCrawl('Acme Corp'))).toBe('Acme Corp');
  });

  it('7. hostname fallback still works when crawl has no title', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const discussions = goodDiscussions();
    await makeService(goodCrawl(null), discussions, captured).researchCompany({
      companyUrl: 'https://careers.acme.example/jobs',
      mode: 'evaluation',
    });

    expect(captured[0]?.['companyNameHint']).toBeUndefined();
    expect(companyNameHintFromCrawl(goodCrawl(null))).toBeNull();
    expect(companyNameHintFromCrawl(failedCrawl())).toBeNull();
  });

  it('8. no fabricated research', async () => {
    const crawl = goodCrawl();
    const discussions = goodDiscussions();
    const result = await makeService(crawl, discussions).researchCompany({
      companyUrl: 'https://acme.example/',
      roleHint: 'Backend Engineer',
      mode: 'evaluation',
    });

    expect(result.companySite).toBe(crawl);
    expect(result.publicDiscussions).toBe(discussions);
    expect(
      result.publicDiscussions.sources.every(
        (source) =>
          source.url === 'https://forum.example/t/1' &&
          source.search.query === 'acme interview experience',
      ),
    ).toBe(true);
  });
});
