import { canonicalCompanyUrl } from '@/modules/research/retrieval/canonical-url';
import { RESEARCH_VERSION } from '@/modules/research/research-cache.model';
import type { CompanyResearchResult } from '@/modules/research/company-research.service';
import type { RetrievalMode } from '@/modules/research/retrieval/retrieval.type';

// Cache key binds the canonical company URL, the research version, AND the
// retrieval mode: an evaluation-mode result fetched through the
// private/loopback allowance must never be reused by production, and the
// reverse would only waste a crawl.
export const researchCacheKey = (companyUrl: string, mode: RetrievalMode): string => {
  let canonical: string;

  try {
    canonical = canonicalCompanyUrl(companyUrl);
  } catch {
    canonical = companyUrl.trim();
  }

  return `research:${RESEARCH_VERSION}:${mode}:${canonical}`;
};

// Optional seam: the application path passes a Mongo-backed store, the
// evaluator passes none and always researches directly.
export type ResearchCacheStore = {
  findFresh(key: string): Promise<CompanyResearchResult | null>;
  store(key: string, result: CompanyResearchResult): Promise<void>;
};
