import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { CompanyCrawlerService } from '@/modules/research/crawl/company-crawler.service';
import type { CompanyCrawlResult } from '@/modules/research/crawl/crawl.type';
import type { PublicDiscussionResearchService } from '@/modules/research/discussion/public-discussion-research.service';
import type { PublicDiscussionResearchResult } from '@/modules/research/discussion/discussion.type';
import type { RetrievalMode } from '@/modules/research/retrieval/retrieval.type';

export type CompanyResearchInput = {
  companyUrl: string;
  roleHint?: string;
  mode: RetrievalMode;
};

export type ResearchFailure = {
  branch: 'company-site' | 'public-discussions';
  code: string;
  detail?: string;
};

export type CompanyResearchStatus = 'complete' | 'partial' | 'failed';

export type CompanyResearchResult = {
  companyUrl: string;
  companySite: CompanyCrawlResult;
  publicDiscussions: PublicDiscussionResearchResult;
  status: CompanyResearchStatus;
  failures: ResearchFailure[];
};

type CompanyResearchDependencies = {
  companyCrawler: Pick<CompanyCrawlerService, 'crawlCompanySite'>;
  discussionResearch: Pick<PublicDiscussionResearchService, 'research'>;
  logger: LoggerService;
};

// Discussion search prefers a real homepage title over a hostname guess, but
// never blocks on crawl metadata: a failed crawl still gets hostname fallback
// inside discussion research.
export const companyNameHintFromCrawl = (crawl: CompanyCrawlResult): string | null => {
  const seed = crawl.pages.find((page) => page.depth === 0) ?? crawl.pages[0];
  const title = seed?.content.title?.replace(/\s+/g, ' ').trim() ?? '';

  return title ? title.slice(0, 100) : null;
};

// The final deterministic research capability: bounded company-site crawl
// followed by bounded public discussion research. Child results are kept
// intact; only branch usefulness and compact failures are derived here. One
// failed branch never destroys the other; nothing is persisted and no LLM
// is involved.
export class CompanyResearchService {
  private readonly companyCrawler: Pick<CompanyCrawlerService, 'crawlCompanySite'>;
  private readonly discussionResearch: Pick<PublicDiscussionResearchService, 'research'>;
  private readonly logger: LoggerService;

  constructor(dependencies: CompanyResearchDependencies) {
    this.companyCrawler = dependencies.companyCrawler;
    this.discussionResearch = dependencies.discussionResearch;
    this.logger = dependencies.logger;
  }

  async researchCompany(input: CompanyResearchInput): Promise<CompanyResearchResult> {
    const startedAt = Date.now();

    const companySite = await this.companyCrawler.crawlCompanySite({
      companyUrl: input.companyUrl,
      mode: input.mode,
    });

    const publicDiscussions = await this.discussionResearch.research({
      companyUrl: input.companyUrl,
      companyNameHint: companyNameHintFromCrawl(companySite) ?? undefined,
      roleHint: input.roleHint,
      mode: input.mode,
    });

    const siteUseful = companySite.pages.length > 0;
    const discussionsUseful = publicDiscussions.sources.length > 0;
    const status: CompanyResearchStatus =
      siteUseful && discussionsUseful
        ? 'complete'
        : siteUseful || discussionsUseful
          ? 'partial'
          : 'failed';

    const failures: ResearchFailure[] = [
      ...companySite.failures.map((failure) => ({
        branch: 'company-site' as const,
        code: failure.code,
        detail: failure.message,
      })),
      ...publicDiscussions.failures.map((failure) => ({
        branch: 'public-discussions' as const,
        code: failure.code,
        ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
      })),
    ];

    this.logger.info('research.finished', {
      status,
      sitePages: companySite.pages.length,
      discussionSources: publicDiscussions.sources.length,
      failures: failures.length,
      durationMs: Date.now() - startedAt,
    });

    return {
      companyUrl: input.companyUrl,
      companySite,
      publicDiscussions,
      status,
      failures,
    };
  }
}
