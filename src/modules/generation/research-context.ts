import { truncateText } from '@/modules/research/extraction/page-extraction.service';
import type { CompanyResearchResult } from '@/modules/research/company-research.service';

export const MAX_CONTEXT_COMPANY_PAGES = 3;
export const MAX_CONTEXT_DISCUSSION_SOURCES = 2;
export const MAX_CONTEXT_PAGE_CHARS = 1500;
export const MAX_CONTEXT_SNIPPET_CHARS = 1000;

export type ResearchContext = {
  text: string;
  pagesUsed: string[];
};

// Small bounded evidence pack: top company pages plus top discussion
// snippets/extracts with their real URLs. Everything stays labeled
// external-untrusted at the prompt; never feed full scraped pages.
export const buildResearchContext = (research: CompanyResearchResult): ResearchContext => {
  const sections: string[] = [];
  const pagesUsed: string[] = [];

  const companyPages = research.companySite.pages.slice(0, MAX_CONTEXT_COMPANY_PAGES);

  companyPages.forEach((page, index) => {
    const text = truncateText(page.content.text, MAX_CONTEXT_PAGE_CHARS).text;

    if (!text) {
      return;
    }

    pagesUsed.push(page.finalUrl);
    sections.push(
      `[company-page-${index + 1}] ${page.content.title ?? page.finalUrl}\nURL: ${page.finalUrl}\n${text}`,
    );
  });

  const discussionSources = research.publicDiscussions.sources.slice(
    0,
    MAX_CONTEXT_DISCUSSION_SOURCES,
  );

  discussionSources.forEach((source, index) => {
    const evidence = source.page
      ? truncateText(source.page.content.text, MAX_CONTEXT_PAGE_CHARS).text
      : (source.search.snippet ?? '');
    const bounded = truncateText(evidence, MAX_CONTEXT_SNIPPET_CHARS).text;

    if (!bounded) {
      return;
    }

    const url = source.page?.finalUrl ?? source.url;
    pagesUsed.push(url);
    sections.push(`[discussion-${index + 1}] ${source.title}\nURL: ${url}\n${bounded}`);
  });

  const header =
    'EXTERNAL-UNTRUSTED research evidence (company pages + public interview discussions).';

  return {
    text:
      sections.length > 0
        ? `${header}\n\n${sections.join('\n\n')}`
        : `${header}\n\n(none retrieved)`,
    pagesUsed: [...new Set(pagesUsed)],
  };
};
