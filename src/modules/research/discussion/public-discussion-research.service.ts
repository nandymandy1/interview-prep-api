import { getDomain } from 'tldts';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { LinkDiscoveryService } from '@/modules/research/crawl/link-discovery.service';
import { CRAWL_MIN_REQUEST_INTERVAL_MS } from '@/modules/research/crawl/crawl.constants';
import type { PageExtractionService } from '@/modules/research/extraction/page-extraction.service';
import { RedirectBlockedError } from '@/modules/research/retrieval/retrieval.exception';
import type {
  RetrievalClient,
  Sleep,
  Clock,
} from '@/modules/research/retrieval/retrieval-client.service';
import type { RedirectGuard, RetrievalResult } from '@/modules/research/retrieval/retrieval.type';
import type { RobotsPolicyService } from '@/modules/research/robots/robots-policy.service';
import type { RobotsPolicy, RobotsPolicyCache } from '@/modules/research/robots/robots.type';
import type {
  PublicSearchProvider,
  PublicSearchResult,
} from '@/modules/research/search/search.type';
import { SearchProviderException } from '@/modules/research/search/search.exception';
import {
  DISCUSSION_HOMEPAGE_PATH_PENALTY,
  DISCUSSION_NEGATIVE_TERMS,
  DISCUSSION_PHRASE_WEIGHTS,
  DISCUSSION_POSITIVE_TERMS,
  DISCUSSION_ROLE_TOKEN_WEIGHT,
  MAX_COMPANY_NAME_CHARS,
  MAX_DISCUSSION_ORIGINS,
  MAX_DISCUSSION_PAGE_FETCHES,
  MAX_DISCUSSION_QUERIES,
  MAX_ROLE_HINT_CHARS,
  MAX_SEARCH_RESULTS_PER_QUERY,
  MAX_UNIQUE_SEARCH_RESULTS,
} from '@/modules/research/discussion/discussion.constants';
import type {
  DiscussionFailure,
  DiscussionSource,
  PublicDiscussionResearchInput,
  PublicDiscussionResearchResult,
} from '@/modules/research/discussion/discussion.type';

type PublicDiscussionResearchDependencies = {
  searchProvider: PublicSearchProvider | null;
  retrievalClient: Pick<RetrievalClient, 'retrieve'>;
  robotsPolicy: Pick<RobotsPolicyService, 'loadPolicy' | 'isUrlAllowed'>;
  pageExtraction: PageExtractionService;
  linkDiscovery: LinkDiscoveryService;
  logger: LoggerService;
  sleep?: Sleep;
  now?: Clock;
};

const defaultSleep: Sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Deterministic query set: experience + questions, plus one role query when a
// role hint exists. No LLM, no keyword explosion.
export const buildDiscussionQueries = (companyName: string, roleHint?: string): string[] => {
  const queries = [`${companyName} interview experience`, `${companyName} interview questions`];
  const role = roleHint?.replace(/\s+/g, ' ').trim();

  if (role) {
    queries.push(`${companyName} ${role} interview`);
  }

  return queries.slice(0, MAX_DISCUSSION_QUERIES);
};

// Preferred: caller hint → registrable-domain label (careers.acme.com →
// acme) → bare hostname. Pure string shaping, never an LLM identity guess.
export const resolveCompanySearchName = (companyUrl: string, hint?: string): string => {
  const cleanedHint = hint?.replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_NAME_CHARS);

  if (cleanedHint) {
    return cleanedHint;
  }

  try {
    const parsed = new URL(companyUrl.trim());
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const domain = getDomain(hostname, { allowPrivateDomains: true });

    if (domain) {
      return domain.split('.')[0] ?? hostname;
    }

    return hostname.split(':')[0] ?? hostname;
  } catch {
    return companyUrl.replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_NAME_CHARS) || 'company';
  }
};

const tokenize = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0),
  );

export type RankedDiscussionEntry = {
  result: PublicSearchResult;
  query: string;
  normalized: string;
  score: number;
};

// Deterministic ranking over title/snippet/URL signals only. Ties break by
// provider rank, then URL, so repeated runs order identically.
export const rankDiscussionResults = (
  entries: Array<{ result: PublicSearchResult; query: string; normalized: string }>,
  roleHint?: string,
): RankedDiscussionEntry[] => {
  const roleTokens = tokenize(
    roleHint?.replace(/\s+/g, ' ').trim().slice(0, MAX_ROLE_HINT_CHARS) ?? '',
  );

  const scored = entries.map((entry) => {
    const { result } = entry;
    const haystack = `${result.title} ${result.snippet ?? ''} ${result.url}`.toLowerCase();
    const tokens = tokenize(`${result.title} ${result.snippet ?? ''} ${result.url}`);
    let score = 0;

    for (const [phrase, weight] of DISCUSSION_PHRASE_WEIGHTS) {
      if (haystack.includes(phrase)) {
        score += weight;
      }
    }

    for (const [term, weight] of DISCUSSION_POSITIVE_TERMS) {
      if (tokens.has(term)) {
        score += weight;
      }
    }

    for (const [term, weight] of DISCUSSION_NEGATIVE_TERMS) {
      if (tokens.has(term)) {
        score -= weight;
      }
    }

    for (const token of roleTokens) {
      if (tokens.has(token)) {
        score += DISCUSSION_ROLE_TOKEN_WEIGHT;
      }
    }

    try {
      const path = new URL(result.url).pathname.replace(/\/+$/, '');

      if (path === '') {
        score -= DISCUSSION_HOMEPAGE_PATH_PENALTY;
      }
    } catch {
      // Unparseable URLs are dropped before ranking; ignore here.
    }

    return { result, query: entry.query, normalized: entry.normalized, score };
  });

  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    if (left.result.rank !== right.result.rank) {
      return left.result.rank - right.result.rank;
    }

    return left.result.url < right.result.url ? -1 : left.result.url > right.result.url ? 1 : 0;
  });

  return scored;
};

// Public discussion research: search → normalize → dedupe → rank → fetch top
// single pages. Company-owned pages are excluded (the company crawler owns
// them); every selected URL still passes robots and hardened retrieval; one
// failed query or page never aborts the run.
export class PublicDiscussionResearchService {
  private readonly searchProvider: PublicSearchProvider | null;
  private readonly retrievalClient: Pick<RetrievalClient, 'retrieve'>;
  private readonly robotsPolicy: Pick<RobotsPolicyService, 'loadPolicy' | 'isUrlAllowed'>;
  private readonly pageExtraction: PageExtractionService;
  private readonly linkDiscovery: LinkDiscoveryService;
  private readonly logger: LoggerService;
  private readonly sleep: Sleep;
  private readonly now: Clock;

  constructor(dependencies: PublicDiscussionResearchDependencies) {
    this.searchProvider = dependencies.searchProvider;
    this.retrievalClient = dependencies.retrievalClient;
    this.robotsPolicy = dependencies.robotsPolicy;
    this.pageExtraction = dependencies.pageExtraction;
    this.linkDiscovery = dependencies.linkDiscovery;
    this.logger = dependencies.logger;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.now = dependencies.now ?? Date.now;
  }

  async research(input: PublicDiscussionResearchInput): Promise<PublicDiscussionResearchResult> {
    const startedAt = this.now();
    const companySearchName = resolveCompanySearchName(input.companyUrl, input.companyNameHint);

    this.logger.info('discussion.started', {
      companySearchName,
      mode: input.mode,
    });

    if (!this.searchProvider) {
      return this.buildResult({
        companySearchName,
        queries: [],
        sources: [],
        failures: [
          {
            source: 'search',
            code: 'SEARCH_PROVIDER_NOT_CONFIGURED',
            detail: 'No search provider API key is configured; discussion research is unavailable.',
          },
        ],
        queriesAttempted: 0,
        searchResultsFound: 0,
        startedAt,
      });
    }

    const queries = buildDiscussionQueries(companySearchName, input.roleHint);
    const failures: DiscussionFailure[] = [];
    const bestByUrl = new Map<string, { result: PublicSearchResult; query: string }>();
    let searchResultsFound = 0;
    let queriesAttempted = 0;
    let queriesSucceeded = 0;

    for (const query of queries) {
      queriesAttempted += 1;

      try {
        const results = await this.searchProvider.search({
          query,
          limit: MAX_SEARCH_RESULTS_PER_QUERY,
        });
        queriesSucceeded += 1;
        searchResultsFound += results.length;

        for (const result of results) {
          let parsed: URL;

          try {
            parsed = new URL(result.url);
          } catch {
            failures.push({
              source: 'search',
              query,
              url: result.url,
              code: 'INVALID_SEARCH_RESULT_URL',
            });
            continue;
          }

          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            continue;
          }

          const normalized = this.linkDiscovery.normalizeCrawlUrl(result.url, parsed.origin);

          // Static assets and action paths are working-as-designed filters,
          // not failures; only unparseable URLs are recorded.
          if (normalized === null) {
            continue;
          }

          const existing = bestByUrl.get(normalized);

          if (!existing || result.rank < existing.result.rank) {
            bestByUrl.set(normalized, { result, query });
          }
        }
      } catch (error) {
        failures.push(this.searchFailure(query, error));
      }
    }

    const companyScope = this.companyScope(input.companyUrl);
    // The unique cap applies after normalize → dedupe → company exclusion →
    // rank, so a highly relevant role-query result can never be starved by
    // earlier queries filling the cap first.
    const ranked = rankDiscussionResults(
      [...bestByUrl.entries()].map(([normalized, entry]) => ({
        result: entry.result,
        query: entry.query,
        normalized,
      })),
      input.roleHint,
    )
      .filter((entry) => !this.isCompanyOwned(entry.normalized, companyScope))
      .slice(0, MAX_UNIQUE_SEARCH_RESULTS);

    const uniqueResults = ranked.length;
    const selected = this.selectSources(ranked);
    const robotsCache: RobotsPolicyCache = new Map();
    const lastStartByOrigin = new Map<string, number>();
    const originDelays = new Map<string, number>();
    // Origins already committed to page fetches; the redirect guard refuses
    // targets that would open a new origin beyond the budget.
    const fetchOrigins = new Set(
      selected
        .map((entry) => this.originOf(entry.normalized))
        .filter((origin): origin is string => origin !== null),
    );
    const sources: DiscussionSource[] = [];
    let pagesAttempted = 0;
    let pagesFetched = 0;
    let pagesSkipped = 0;
    let pagesFailed = 0;

    for (const entry of selected) {
      const domain = this.domainOf(entry.normalized);
      const source: DiscussionSource = {
        title: entry.result.title,
        url: entry.normalized,
        domain,
        trust: 'external-untrusted',
        search: {
          query: entry.query,
          rank: entry.result.rank,
          snippet: entry.result.snippet,
        },
        fetchStatus: 'not-attempted',
      };
      sources.push(source);

      const origin = this.originOf(entry.normalized);

      if (!origin) {
        source.fetchStatus = 'failed';
        pagesFailed += 1;
        failures.push({
          source: 'page',
          query: entry.query,
          url: entry.normalized,
          code: 'INVALID_SEARCH_RESULT_URL',
        });
        continue;
      }

      pagesAttempted += 1;
      const policy = await this.robotsPolicy.loadPolicy(origin, input.mode, robotsCache);
      lastStartByOrigin.set(origin, this.now());

      if (policy.crawlDelayMs !== null) {
        originDelays.set(origin, policy.crawlDelayMs);
      }

      if (!this.allowUrl(policy, entry.normalized)) {
        source.fetchStatus = 'robots-skipped';
        pagesSkipped += 1;
        failures.push({
          source: 'page',
          query: entry.query,
          url: entry.normalized,
          code: policy.state === 'unavailable' ? 'ROBOTS_UNAVAILABLE' : 'ROBOTS_DISALLOWED',
        });
        continue;
      }

      await this.paceOrigin(origin, lastStartByOrigin, originDelays);

      let pageResult: RetrievalResult;

      try {
        pageResult = await this.retrievalClient.retrieve({
          url: entry.normalized,
          mode: input.mode,
          onBeforeRedirect: this.discussionRedirectGuard(input.mode, robotsCache, fetchOrigins),
        });
      } catch (error) {
        // The redirect guard rejected a target before it was fetched.
        if (!(error instanceof RedirectBlockedError)) {
          throw error;
        }

        if (error.reason === 'ROBOTS_DISALLOWED') {
          source.fetchStatus = 'robots-skipped';
          pagesSkipped += 1;
          failures.push({
            source: 'page',
            query: entry.query,
            url: entry.normalized,
            code: 'ROBOTS_DISALLOWED',
          });
        } else {
          source.fetchStatus = 'failed';
          pagesFailed += 1;
          failures.push({
            source: 'page',
            query: entry.query,
            url: entry.normalized,
            code: 'RETRIEVAL_FAILED',
            detail: 'Redirect target outside the discussion origin budget.',
          });
        }

        continue;
      }

      if (!pageResult.ok) {
        source.fetchStatus = 'failed';
        pagesFailed += 1;
        failures.push({
          source: 'page',
          query: entry.query,
          url: entry.normalized,
          code: 'RETRIEVAL_FAILED',
          retrievalCode: pageResult.failure.code,
          ...(pageResult.failure.status !== undefined ? { status: pageResult.failure.status } : {}),
        });
        continue;
      }

      const content = this.pageExtraction.extract({
        body: pageResult.resource.body,
        contentType: pageResult.resource.contentType,
      });

      if (content.contentEmpty) {
        source.fetchStatus = 'failed';
        pagesFailed += 1;
        failures.push({
          source: 'page',
          query: entry.query,
          url: entry.normalized,
          code: 'EXTRACTION_EMPTY',
        });
        continue;
      }

      source.page = {
        requestedUrl: entry.normalized,
        finalUrl: pageResult.resource.finalUrl,
        content,
      };
      source.fetchStatus = 'fetched';
      pagesFetched += 1;

      this.logger.info('discussion.page_fetched', {
        domain,
        status: pageResult.resource.status,
        textChars: content.textChars,
      });
    }

    // Unselected ranked results stay visible as search evidence with their
    // snippets; only the bounded top set is fetched. Partitioned by
    // normalized identity: origin limits can skip middle entries, so position
    // never implies selection and every source appears exactly once.
    const selectedUrls = new Set(selected.map((entry) => entry.normalized));

    for (const entry of ranked) {
      if (selectedUrls.has(entry.normalized)) {
        continue;
      }

      sources.push({
        title: entry.result.title,
        url: entry.normalized,
        domain: this.domainOf(entry.normalized),
        trust: 'external-untrusted',
        search: {
          query: entry.query,
          rank: entry.result.rank,
          snippet: entry.result.snippet,
        },
        fetchStatus: 'not-attempted',
      });
    }

    this.logger.info('discussion.finished', {
      companySearchName,
      sources: sources.length,
      pagesFetched,
      failures: failures.length,
      durationMs: this.now() - startedAt,
    });

    return this.buildResult({
      companySearchName,
      queries,
      sources,
      failures,
      queriesAttempted,
      queriesSucceeded,
      searchResultsFound,
      startedAt,
      pagesAttempted,
      pagesFetched,
      pagesSkipped,
      pagesFailed,
      uniqueResults,
    });
  }

  private buildResult(input: {
    companySearchName: string;
    queries: string[];
    sources: DiscussionSource[];
    failures: DiscussionFailure[];
    queriesAttempted: number;
    queriesSucceeded?: number;
    searchResultsFound: number;
    startedAt: number;
    pagesAttempted?: number;
    pagesFetched?: number;
    pagesSkipped?: number;
    pagesFailed?: number;
    uniqueResults?: number;
  }): PublicDiscussionResearchResult {
    const pagesAttempted = input.pagesAttempted ?? 0;
    const pagesFetched = input.pagesFetched ?? 0;
    const pagesSkipped = input.pagesSkipped ?? 0;
    const pagesFailed = input.pagesFailed ?? 0;
    const allQueriesFailed =
      input.queriesAttempted > 0 && (input.queriesSucceeded ?? input.queriesAttempted) === 0;

    return {
      companySearchName: input.companySearchName,
      queries: input.queries,
      sources: input.sources,
      failures: input.failures,
      // No provider (or every query errored) means no discussion evidence at
      // all; any recorded failure short of that is partial, never generic.
      status:
        input.failures.length === 0
          ? 'complete'
          : allQueriesFailed || input.queriesAttempted === 0
            ? 'unavailable'
            : 'partial',
      stats: {
        queriesAttempted: input.queriesAttempted,
        searchResultsFound: input.searchResultsFound,
        uniqueResults: input.uniqueResults ?? input.sources.length,
        pagesAttempted,
        pagesFetched,
        pagesSkipped,
        pagesFailed,
      },
    };
  }

  // Redirect policy for selected discussion pages: every redirect target
  // passes the target origin's robots policy before any request to it, and
  // targets that would open a new origin beyond the budget are refused.
  private discussionRedirectGuard(
    mode: PublicDiscussionResearchInput['mode'],
    robotsCache: RobotsPolicyCache,
    fetchOrigins: Set<string>,
  ): RedirectGuard {
    return async (next) => {
      const policy = await this.robotsPolicy.loadPolicy(next.origin, mode, robotsCache);

      if (!this.allowUrl(policy, next.toString())) {
        throw new RedirectBlockedError('ROBOTS_DISALLOWED', next.toString());
      }

      if (!fetchOrigins.has(next.origin)) {
        if (fetchOrigins.size >= MAX_DISCUSSION_ORIGINS) {
          throw new RedirectBlockedError('OUT_OF_SCOPE', next.toString());
        }

        fetchOrigins.add(next.origin);
      }
    };
  }

  private allowUrl(policy: RobotsPolicy, url: string): boolean {
    try {
      return this.robotsPolicy.isUrlAllowed(policy, url);
    } catch {
      return false;
    }
  }

  private searchFailure(query: string, error: unknown): DiscussionFailure {
    if (error instanceof SearchProviderException) {
      return {
        source: 'search',
        query,
        code:
          error.code === 'RATE_LIMITED' ? 'SEARCH_PROVIDER_RATE_LIMITED' : 'SEARCH_PROVIDER_ERROR',
        ...(error.status !== undefined ? { status: error.status } : {}),
      };
    }

    this.logger.error(error, 'discussion.search_unexpected', { query });

    return { source: 'search', query, code: 'SEARCH_PROVIDER_ERROR' };
  }

  private companyScope(companyUrl: string): { domain: string | null; hostname: string | null } {
    try {
      const hostname = new URL(companyUrl.trim()).hostname.toLowerCase().replace(/\.$/, '');
      return { domain: getDomain(hostname, { allowPrivateDomains: true }), hostname };
    } catch {
      return { domain: null, hostname: null };
    }
  }

  private isCompanyOwned(
    resultUrl: string,
    scope: { domain: string | null; hostname: string | null },
  ): boolean {
    let hostname: string;

    try {
      hostname = new URL(resultUrl).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return false;
    }

    if (scope.domain) {
      return getDomain(hostname, { allowPrivateDomains: true }) === scope.domain;
    }

    return scope.hostname !== null && hostname === scope.hostname;
  }

  // Bounded single-page selection: top-ranked first, at most
  // MAX_DISCUSSION_ORIGINS distinct origins, never a recursive crawl.
  private selectSources(ranked: RankedDiscussionEntry[]): RankedDiscussionEntry[] {
    const selected: RankedDiscussionEntry[] = [];
    const origins = new Set<string>();

    for (const entry of ranked) {
      if (selected.length >= MAX_DISCUSSION_PAGE_FETCHES) {
        break;
      }

      const origin = this.originOf(entry.normalized);

      if (!origin || (origins.has(origin) === false && origins.size >= MAX_DISCUSSION_ORIGINS)) {
        continue;
      }

      origins.add(origin);
      selected.push(entry);
    }

    return selected;
  }

  private originOf(url: string): string | null {
    try {
      const parsed = new URL(url);

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      return parsed.origin;
    } catch {
      return null;
    }
  }

  private domainOf(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  // Sequential politeness pacing: at least the base interval between requests
  // to one origin, raised to the robots crawl-delay when one is known.
  private async paceOrigin(
    origin: string,
    lastStartByOrigin: Map<string, number>,
    originDelays: Map<string, number>,
  ): Promise<void> {
    const last = lastStartByOrigin.get(origin);
    const interval = Math.max(CRAWL_MIN_REQUEST_INTERVAL_MS, originDelays.get(origin) ?? 0);

    if (last !== undefined) {
      const wait = interval - (this.now() - last);

      if (wait > 0) {
        await this.sleep(wait);
      }
    }

    lastStartByOrigin.set(origin, this.now());
  }
}
