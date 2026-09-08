import type { ExtractedPageContent } from '@/modules/research/extraction/extraction.type';
import type {
  RetrievalFailureCode,
  RetrievalMode,
} from '@/modules/research/retrieval/retrieval.type';
import type { RobotsOriginStatus } from '@/modules/research/robots/robots.type';

export type CrawlInput = {
  companyUrl: string;
  mode: RetrievalMode;
};

export type CrawlTruncationReason =
  'page-request-limit' | 'depth-limit' | 'deadline' | 'candidate-limit';

export type CrawlSkipReason =
  'ROBOTS_DISALLOWED' | 'ROBOTS_UNAVAILABLE' | 'ORIGIN_LIMIT' | 'OUT_OF_SCOPE';

export type CrawlSkip = {
  url: string;
  reason: CrawlSkipReason;
  discoveredFrom: string | null;
  depth: number;
};

export type CrawlStats = {
  pageRequestsAttempted: number;
  pagesSucceeded: number;
  pagesFailed: number;
  pagesSkipped: number;
};
export type CrawlPage = {
  requestedUrl: string;
  finalUrl: string;
  depth: number;
  discoveredFrom: string | null;
  status: number;
  contentType: string;
  content: ExtractedPageContent;
  relevanceScore: number;
};

export type DiscoveredLink = {
  url: string;
  discoveredFrom: string;
  depth: number;
  anchorText: string;
  score: number;
  signals: string[];
};

export type CrawlFailure = {
  url: string;
  discoveredFrom: string | null;
  depth: number;
  code: RetrievalFailureCode;
  status?: number;
  message: string;
};

export type CompanyCrawlResult = {
  seedUrl: string;
  finalSeedUrl: string | null;
  pages: CrawlPage[];
  failures: CrawlFailure[];
  skipped: CrawlSkip[];
  rankedLinks: DiscoveredLink[];
  truncated: boolean;
  truncationReasons: CrawlTruncationReason[];
  robots: RobotsOriginStatus[];
  stats: CrawlStats;
};

export type CrawlCandidate = {
  url: string;
  discoveredFrom: string;
  depth: number;
  anchorText: string;
  score: number;
  signals: string[];
};
