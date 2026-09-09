import type { ExtractedPageContent } from '@/modules/research/extraction/extraction.type';
import type { RetrievalFailureCode } from '@/modules/research/retrieval/retrieval.type';

export type PublicDiscussionResearchInput = {
  companyUrl: string;
  companyNameHint?: string;
  roleHint?: string;
  mode: 'production' | 'evaluation';
};

export type DiscussionFetchStatus = 'not-attempted' | 'fetched' | 'robots-skipped' | 'failed';

export type DiscussionSource = {
  title: string;
  url: string;
  domain: string;
  trust: 'external-untrusted';
  search: {
    query: string;
    rank: number;
    snippet: string | null;
  };
  page?: {
    requestedUrl: string;
    finalUrl: string;
    content: ExtractedPageContent;
  };
  fetchStatus: DiscussionFetchStatus;
};

export type DiscussionFailureCode =
  | 'SEARCH_PROVIDER_NOT_CONFIGURED'
  | 'SEARCH_PROVIDER_RATE_LIMITED'
  | 'SEARCH_PROVIDER_ERROR'
  | 'INVALID_SEARCH_RESULT_URL'
  | 'ROBOTS_DISALLOWED'
  | 'ROBOTS_UNAVAILABLE'
  | 'RETRIEVAL_FAILED'
  | 'EXTRACTION_EMPTY';

export type DiscussionFailure = {
  source: 'search' | 'page';
  query?: string;
  url?: string;
  code: DiscussionFailureCode;
  detail?: string;
  retrievalCode?: RetrievalFailureCode;
  status?: number;
};

export type PublicDiscussionResearchStatus = 'complete' | 'partial' | 'unavailable';

export type PublicDiscussionResearchResult = {
  companySearchName: string;
  queries: string[];
  sources: DiscussionSource[];
  failures: DiscussionFailure[];
  status: PublicDiscussionResearchStatus;
  stats: {
    queriesAttempted: number;
    searchResultsFound: number;
    uniqueResults: number;
    pagesAttempted: number;
    pagesFetched: number;
    pagesSkipped: number;
    pagesFailed: number;
  };
};
