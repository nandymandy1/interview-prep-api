import { describe, expect, it, vi } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import {
  GENERATION_VERSION,
  generationFingerprint,
} from '@/modules/generation/generation-fingerprint';
import { CompanyResearchService } from '@/modules/research/company-research.service';
import { researchCacheKey } from '@/modules/research/research-cache';
import type { CompanyResearchResult } from '@/modules/research/company-research.service';

const silentLogger = (): LoggerService => {
  const requestContext = new RequestContextService();
  return new LoggerService({ baseLogger: createBaseLogger('silent'), requestContext });
};

describe('generation fingerprint', () => {
  const jd = 'Senior Engineer\nBuild Node.js APIs.';
  const company = 'https://acme.test/jobs/';

  it('is deterministic for identical input', () => {
    expect(generationFingerprint(jd, company)).toBe(generationFingerprint(jd, company));
  });

  it('normalizes insignificant whitespace identically', () => {
    expect(generationFingerprint('Senior  Engineer\r\nBuild   Node.js APIs.  ', company)).toBe(
      generationFingerprint(jd, company),
    );
  });

  it('canonicalizes the company URL (case, trailing slash, fragment)', () => {
    expect(generationFingerprint(jd, 'HTTPS://ACME.TEST/jobs#team')).toBe(
      generationFingerprint(jd, company),
    );
  });

  it('differs across JD, company, and generation version', () => {
    const base = generationFingerprint(jd, company);

    expect(generationFingerprint(`${jd} Extra duty.`, company)).not.toBe(base);
    expect(generationFingerprint(jd, 'https://other.test')).not.toBe(base);
    expect(GENERATION_VERSION).toBe('v1');
  });
});

describe('company research cache', () => {
  const buildResearch = (store: Map<string, CompanyResearchResult> | null) => {
    const crawlCompanySite = vi.fn(async () => ({ pages: [], failures: [] }));
    const research = vi.fn(async () => ({
      companySearchName: null,
      sources: [],
      failures: [],
    }));
    const cache =
      store === null
        ? undefined
        : {
            findFresh: vi.fn(async (key: string) => store.get(key) ?? null),
            store: vi.fn(async (key: string, result: CompanyResearchResult) => {
              store.set(key, result);
            }),
          };
    const service = new CompanyResearchService({
      companyCrawler: { crawlCompanySite } as never,
      discussionResearch: { research } as never,
      ...(cache ? { cache } : {}),
      logger: silentLogger(),
    });

    return { service, crawlCompanySite, research, cache };
  };

  it('reuses research for the same company without crawling again', async () => {
    const store = new Map<string, CompanyResearchResult>();
    const { service, crawlCompanySite } = buildResearch(store);

    await service.researchCompany({
      companyUrl: 'https://acme.test/jobs/',
      mode: 'production',
    });
    expect(crawlCompanySite).toHaveBeenCalledTimes(1);

    const reused = await service.researchCompany({
      companyUrl: 'https://ACME.test/jobs',
      mode: 'production',
    });
    expect(crawlCompanySite).toHaveBeenCalledTimes(1);
    expect(reused.companyUrl).toBe('https://ACME.test/jobs');
  });

  it('separates evaluation and production cache entries by mode', () => {
    expect(researchCacheKey('https://acme.test', 'production')).not.toBe(
      researchCacheKey('https://acme.test', 'evaluation'),
    );
  });

  it('a different mode still crawls (no cross-mode reuse)', async () => {
    const store = new Map<string, CompanyResearchResult>();
    const { service, crawlCompanySite } = buildResearch(store);

    await service.researchCompany({ companyUrl: 'https://acme.test', mode: 'production' });
    await service.researchCompany({ companyUrl: 'https://acme.test', mode: 'evaluation' });

    expect(crawlCompanySite).toHaveBeenCalledTimes(2);
  });

  it('works without a cache store (direct evaluator path)', async () => {
    const { service, crawlCompanySite } = buildResearch(null);

    const result = await service.researchCompany({
      companyUrl: 'https://acme.test',
      mode: 'evaluation',
    });

    expect(crawlCompanySite).toHaveBeenCalledTimes(1);
    expect(result.companyUrl).toBe('https://acme.test');
  });
});
