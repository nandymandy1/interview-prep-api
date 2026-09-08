import type {
  RetrievalFailureCode,
  RetrievalMode,
} from '@/modules/research/retrieval/retrieval.type';

export type CrawlInput = {
  companyUrl: string;
  mode: RetrievalMode;
};

export type CrawlPage = {
  requestedUrl: string;
  finalUrl: string;
  depth: number;
  discoveredFrom: string | null;
  status: number;
  contentType: string;
  body: string;
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
  rankedLinks: DiscoveredLink[];
  truncated: boolean;
};

export type CrawlCandidate = {
  url: string;
  discoveredFrom: string;
  depth: number;
  anchorText: string;
  score: number;
  signals: string[];
};
