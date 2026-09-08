import { isIP } from 'node:net';
import { getDomain } from 'tldts';
import {
  CRAWL_CONCURRENCY,
  CRAWL_MIN_REQUEST_INTERVAL_MS,
  MAX_CRAWL_DEPTH,
  MAX_CRAWL_PAGES,
  MAX_SITE_CRAWL_DURATION_MS,
} from '@/modules/research/crawl/crawl.constants';
import type {
  CompanyCrawlResult,
  CrawlCandidate,
  CrawlFailure,
  CrawlInput,
  CrawlPage,
} from '@/modules/research/crawl/crawl.type';
import type { LinkDiscoveryService } from '@/modules/research/crawl/link-discovery.service';
import type { LinkRankingService } from '@/modules/research/crawl/link-ranking.service';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type {
  RetrievalClient,
  Sleep,
  Clock,
} from '@/modules/research/retrieval/retrieval-client.service';
import type { RetrievedResource } from '@/modules/research/retrieval/retrieval.type';
import { sanitizeUrlForLogging } from '@/modules/research/retrieval/url-safety.service';

type CompanyCrawlerDependencies = {
  retrievalClient: Pick<RetrievalClient, 'retrieve'>;
  linkDiscovery: LinkDiscoveryService;
  linkRanking: LinkRankingService;
  logger: LoggerService;
  sleep?: Sleep;
  now?: Clock;
};

type CrawlScope =
  { kind: 'domain'; registrableDomain: string } | { kind: 'origin'; origin: string };

type CrawlPacing = {
  lastStartByOrigin: Map<string, number>;
  gatesByOrigin: Map<string, Promise<void>>;
};

const defaultSleep: Sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Deterministic candidate order: score DESC, depth ASC, normalized URL ASC.
// Never depends on Set iteration or completion order.
export const compareCrawlCandidates = (left: CrawlCandidate, right: CrawlCandidate): number => {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  if (left.depth !== right.depth) {
    return left.depth - right.depth;
  }

  return left.url < right.url ? -1 : left.url > right.url ? 1 : 0;
};

export class CompanyCrawlerService {
  private readonly retrievalClient: Pick<RetrievalClient, 'retrieve'>;
  private readonly linkDiscovery: LinkDiscoveryService;
  private readonly linkRanking: LinkRankingService;
  private readonly logger: LoggerService;
  private readonly sleep: Sleep;
  private readonly now: Clock;

  constructor(dependencies: CompanyCrawlerDependencies) {
    this.retrievalClient = dependencies.retrievalClient;
    this.linkDiscovery = dependencies.linkDiscovery;
    this.linkRanking = dependencies.linkRanking;
    this.logger = dependencies.logger;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.now = dependencies.now ?? Date.now;
  }

  // Seed-only crawl: fetches the company URL plus pages actually discovered
  // from fetched HTML. Never probes guessed paths. Failures are recorded per
  // source without aborting the crawl; a failed seed returns an honest result.
  async crawlCompanySite(input: CrawlInput): Promise<CompanyCrawlResult> {
    const crawlStartedAt = this.now();
    const deadlineAt = crawlStartedAt + MAX_SITE_CRAWL_DURATION_MS;
    const pacing: CrawlPacing = { lastStartByOrigin: new Map(), gatesByOrigin: new Map() };

    this.logger.info('crawl.started', { url: sanitizeUrlForLogging(input.companyUrl) });

    const seedResult = await this.retrievalClient.retrieve({
      url: input.companyUrl,
      mode: input.mode,
    });

    if (!seedResult.ok) {
      const failure = seedResult.failure;
      this.logger.warn('crawl.seed_failed', {
        url: sanitizeUrlForLogging(input.companyUrl),
        code: failure.code,
      });

      return {
        seedUrl: input.companyUrl,
        finalSeedUrl: null,
        pages: [],
        failures: [
          {
            url: failure.url,
            discoveredFrom: null,
            depth: 0,
            code: failure.code,
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            message: failure.message,
          },
        ],
        rankedLinks: [],
        truncated: false,
      };
    }

    const seed = seedResult.resource;
    const scope = this.buildScope(seed.finalUrl);
    const pages: CrawlPage[] = [];
    const failures: CrawlFailure[] = [];
    const rankedLinks: CrawlCandidate[] = [];
    const visitedRequested = new Set<string>([seed.requestedUrl]);
    const visitedFinal = new Set<string>();
    let truncated = false;

    const seedPage = this.toPage(seed, 0, null);
    pages.push(seedPage);
    visitedFinal.add(seed.finalUrl);

    let queue = this.expandCandidates(seed, 0, scope, visitedRequested, rankedLinks);

    while (pages.length < MAX_CRAWL_PAGES && queue.length > 0) {
      if (this.now() >= deadlineAt) {
        truncated = true;
        break;
      }

      queue.sort(compareCrawlCandidates);

      // Never schedule beyond the remaining page budget, even in-flight.
      const remaining = MAX_CRAWL_PAGES - pages.length;
      const batch = queue.slice(0, Math.min(CRAWL_CONCURRENCY, remaining));
      queue = queue.slice(batch.length);

      for (const candidate of batch) {
        visitedRequested.add(candidate.url);
      }

      const fetched = await Promise.all(
        batch.map((candidate) => this.fetchCandidate(candidate, pacing, deadlineAt, input.mode)),
      );

      for (const outcome of fetched) {
        if (!outcome) {
          continue;
        }

        if (outcome.failure) {
          failures.push(outcome.failure);
          continue;
        }

        if (!outcome.page || visitedFinal.has(outcome.page.finalUrl)) {
          continue;
        }

        // A same-company link may redirect off-site; scope applies to the
        // final page, which is then neither stored nor expanded.
        if (!this.isInScope(new URL(outcome.page.finalUrl), scope)) {
          this.logger.info('crawl.page_out_of_scope', {
            url: sanitizeUrlForLogging(outcome.page.finalUrl),
          });
          visitedFinal.add(outcome.page.finalUrl);
          continue;
        }

        if (pages.length >= MAX_CRAWL_PAGES) {
          truncated = true;
          break;
        }

        pages.push(outcome.page);
        visitedFinal.add(outcome.page.finalUrl);

        if (outcome.page.depth < MAX_CRAWL_DEPTH) {
          queue.push(
            ...this.expandCandidates(
              outcome.page,
              outcome.page.depth,
              scope,
              visitedRequested,
              rankedLinks,
            ),
          );
        }
      }

      if (pages.length >= MAX_CRAWL_PAGES && queue.length > 0) {
        truncated = true;
      }
    }

    if (queue.length > 0 && pages.length >= MAX_CRAWL_PAGES) {
      truncated = true;
    }

    rankedLinks.sort(compareCrawlCandidates);

    this.logger.info('crawl.finished', {
      url: sanitizeUrlForLogging(input.companyUrl),
      pages: pages.length,
      failures: failures.length,
      truncated,
      durationMs: this.now() - crawlStartedAt,
    });

    return {
      seedUrl: input.companyUrl,
      finalSeedUrl: seed.finalUrl,
      pages,
      failures,
      rankedLinks: rankedLinks.map((candidate) => ({
        url: candidate.url,
        discoveredFrom: candidate.discoveredFrom,
        depth: candidate.depth,
        anchorText: candidate.anchorText,
        score: candidate.score,
        signals: candidate.signals,
      })),
      truncated,
    };
  }

  private toPage(
    resource: RetrievedResource,
    depth: number,
    discoveredFrom: string | null,
  ): CrawlPage {
    const { score } = this.linkRanking.scoreLink(resource.finalUrl, '');

    this.logger.debug('crawl.page', {
      url: sanitizeUrlForLogging(resource.finalUrl),
      depth,
      score,
    });

    return {
      requestedUrl: resource.requestedUrl,
      finalUrl: resource.finalUrl,
      depth,
      discoveredFrom,
      status: resource.status,
      contentType: resource.contentType,
      body: resource.body,
      relevanceScore: score,
    };
  }

  // Discovers links from a fetched page, keeps in-scope unseen ones, scores
  // them, and records every discovery for the ranked output.
  private expandCandidates(
    resource: Pick<RetrievedResource, 'requestedUrl' | 'finalUrl' | 'body'>,
    depth: number,
    scope: CrawlScope,
    visitedRequested: Set<string>,
    rankedLinks: CrawlCandidate[],
  ): CrawlCandidate[] {
    const discovered = this.linkDiscovery.discoverLinks(resource.body, resource.finalUrl);
    const candidates: CrawlCandidate[] = [];
    const seenInBatch = new Set<string>();

    for (const link of discovered) {
      if (seenInBatch.has(link.url) || visitedRequested.has(link.url)) {
        continue;
      }

      seenInBatch.add(link.url);

      let parsed: URL;

      try {
        parsed = new URL(link.url);
      } catch {
        continue;
      }

      if (!this.isInScope(parsed, scope)) {
        continue;
      }

      const { score, signals } = this.linkRanking.scoreLink(link.url, link.anchorText);
      const candidate: CrawlCandidate = {
        url: link.url,
        discoveredFrom: resource.finalUrl,
        depth: depth + 1,
        anchorText: link.anchorText,
        score,
        signals,
      };

      rankedLinks.push(candidate);

      if (candidate.depth <= MAX_CRAWL_DEPTH) {
        candidates.push(candidate);
      }
    }

    return candidates;
  }

  private async fetchCandidate(
    candidate: CrawlCandidate,
    pacing: CrawlPacing,
    deadlineAt: number,
    mode: CrawlInput['mode'],
  ): Promise<{ page?: CrawlPage; failure?: CrawlFailure } | null> {
    if (this.now() >= deadlineAt) {
      return null;
    }

    await this.paceOrigin(new URL(candidate.url).origin, pacing, deadlineAt);

    if (this.now() >= deadlineAt) {
      return null;
    }

    const result = await this.retrievalClient.retrieve({ url: candidate.url, mode });

    if (!result.ok) {
      const failure = result.failure;

      this.logger.warn('crawl.page_failed', {
        url: sanitizeUrlForLogging(candidate.url),
        depth: candidate.depth,
        code: failure.code,
      });

      const crawlFailure: CrawlFailure = {
        url: failure.url,
        discoveredFrom: candidate.discoveredFrom,
        depth: candidate.depth,
        code: failure.code,
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        message: failure.message,
      };

      return { failure: crawlFailure };
    }

    return { page: this.toPage(result.resource, candidate.depth, candidate.discoveredFrom) };
  }
  // One request-start gate per origin: concurrent batches serialize here so
  // the minimum interval holds even under CRAWL_CONCURRENCY.
  private async paceOrigin(origin: string, pacing: CrawlPacing, deadlineAt: number): Promise<void> {
    const previous = pacing.gatesByOrigin.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    pacing.gatesByOrigin.set(
      origin,
      previous.then(() => current),
    );
    await previous;

    try {
      const last = pacing.lastStartByOrigin.get(origin);

      if (last !== undefined) {
        const remaining = Math.max(0, deadlineAt - this.now());
        const wait = Math.min(CRAWL_MIN_REQUEST_INTERVAL_MS - (this.now() - last), remaining);

        if (wait > 0) {
          await this.sleep(wait);
        }
      }

      pacing.lastStartByOrigin.set(origin, this.now());
    } finally {
      release();
    }
  }

  private buildScope(finalSeedUrl: string): CrawlScope {
    const parsed = new URL(finalSeedUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');

    // Localhost / IP-literal / evaluator seeds stay exact-origin scoped so
    // unrelated local services are never scanned.
    if (hostname === 'localhost' || isIP(hostname.replace(/^\[(.*)\]$/, '$1')) !== 0) {
      return { kind: 'origin', origin: parsed.origin };
    }

    const domain = getDomain(hostname);

    if (!domain) {
      return { kind: 'origin', origin: parsed.origin };
    }

    return { kind: 'domain', registrableDomain: domain };
  }

  private isInScope(candidate: URL, scope: CrawlScope): boolean {
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
      return false;
    }

    if (scope.kind === 'origin') {
      return candidate.origin === scope.origin;
    }

    // Public company scope: same registrable domain (apex, www, careers, jobs
    // subdomains) with standard ports only; HTTP(S) transitions allowed.
    if (candidate.port !== '') {
      return false;
    }

    return getDomain(candidate.hostname.toLowerCase()) === scope.registrableDomain;
  }
}
