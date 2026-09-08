import { isIP } from 'node:net';
import { getDomain } from 'tldts';
import {
  CRAWL_CONCURRENCY,
  CRAWL_MIN_REQUEST_INTERVAL_MS,
  MAX_CRAWL_CANDIDATES,
  MAX_CRAWL_DEPTH,
  MAX_CRAWL_PAGE_REQUESTS,
  MAX_DISCOVERED_LINKS_PER_PAGE,
  MAX_SITE_CRAWL_DURATION_MS,
} from '@/modules/research/crawl/crawl.constants';
import type {
  CompanyCrawlResult,
  CrawlCandidate,
  CrawlFailure,
  CrawlInput,
  CrawlPage,
  CrawlSkip,
  CrawlStats,
  CrawlTruncationReason,
} from '@/modules/research/crawl/crawl.type';
import type { LinkDiscoveryService } from '@/modules/research/crawl/link-discovery.service';
import type { LinkRankingService } from '@/modules/research/crawl/link-ranking.service';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { PageExtractionService } from '@/modules/research/extraction/page-extraction.service';
import { MAX_CRAWL_ORIGINS } from '@/modules/research/robots/robots.constants';
import type { RobotsPolicyService } from '@/modules/research/robots/robots-policy.service';
import type {
  RobotsOriginStatus,
  RobotsPolicy,
  RobotsPolicyCache,
} from '@/modules/research/robots/robots.type';
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
  robotsPolicy: Pick<RobotsPolicyService, 'loadPolicy' | 'isUrlAllowed'>;
  pageExtraction: PageExtractionService;
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

type ToPageOptions = {
  depth: number;
  discoveredFrom: string | null;
  relevanceScore: number;
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

const compareScoredLinks = (
  left: { url: string; score: number; anchorText: string },
  right: { url: string; score: number; anchorText: string },
): number => {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  if (left.anchorText !== right.anchorText) {
    return left.anchorText < right.anchorText ? -1 : 1;
  }

  return left.url < right.url ? -1 : left.url > right.url ? 1 : 0;
};

export class CompanyCrawlerService {
  private readonly retrievalClient: Pick<RetrievalClient, 'retrieve'>;
  private readonly linkDiscovery: LinkDiscoveryService;
  private readonly linkRanking: LinkRankingService;
  private readonly robotsPolicy: Pick<RobotsPolicyService, 'loadPolicy' | 'isUrlAllowed'>;
  private readonly pageExtraction: PageExtractionService;
  private readonly logger: LoggerService;
  private readonly sleep: Sleep;
  private readonly now: Clock;

  constructor(dependencies: CompanyCrawlerDependencies) {
    this.retrievalClient = dependencies.retrievalClient;
    this.linkDiscovery = dependencies.linkDiscovery;
    this.linkRanking = dependencies.linkRanking;
    this.robotsPolicy = dependencies.robotsPolicy;
    this.pageExtraction = dependencies.pageExtraction;
    this.logger = dependencies.logger;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.now = dependencies.now ?? Date.now;
  }

  // Seed-only crawl: fetches the company URL plus pages actually discovered
  // from fetched HTML. Never probes guessed paths. Failures are recorded per
  // source without aborting the crawl; a failed seed returns an honest result.
  // Every page retrieval attempt (success or failure) consumes the shared
  // MAX_CRAWL_PAGE_REQUESTS budget.
  async crawlCompanySite(input: CrawlInput): Promise<CompanyCrawlResult> {
    const crawlStartedAt = this.now();
    const deadlineAt = crawlStartedAt + MAX_SITE_CRAWL_DURATION_MS;
    const pacing: CrawlPacing = { lastStartByOrigin: new Map(), gatesByOrigin: new Map() };
    const robotsCache: RobotsPolicyCache = new Map();
    const pendingRobotsLoads = new Map<string, Promise<RobotsPolicy>>();
    const originDelays = new Map<string, number>();

    this.logger.info('crawl.started', { url: sanitizeUrlForLogging(input.companyUrl) });

    // Robots policy for the seed origin loads before any content request.
    // A disallowed or conservatively unavailable seed is never fetched.
    let seedOrigin: string | null = null;

    try {
      seedOrigin = new URL(input.companyUrl).origin;
    } catch {
      seedOrigin = null;
    }

    if (seedOrigin) {
      const seedPolicy = await this.policyForOrigin(
        seedOrigin,
        input.mode,
        robotsCache,
        pendingRobotsLoads,
      );

      if (seedPolicy && !this.checkAllowed(seedPolicy, input.companyUrl)) {
        const skip = this.skipForPolicy(seedPolicy, input.companyUrl, null, 0);
        this.logger.warn('crawl.seed_skipped', {
          url: sanitizeUrlForLogging(input.companyUrl),
          reason: skip.reason,
        });

        return {
          seedUrl: input.companyUrl,
          finalSeedUrl: null,
          pages: [],
          failures: [],
          skipped: [skip],
          rankedLinks: [],
          truncated: false,
          truncationReasons: [],
          robots: this.robotsStatuses(robotsCache),
          stats: this.buildStats(0, 0, 0, 1),
        };
      }

      if (seedPolicy?.crawlDelayMs !== null && seedPolicy?.crawlDelayMs !== undefined) {
        originDelays.set(seedOrigin, seedPolicy.crawlDelayMs);
      }

      // The seed shares the per-origin pacing discipline so the first
      // discovered page cannot start immediately after it.
      await this.paceOrigin(
        seedOrigin,
        pacing,
        deadlineAt,
        this.effectiveInterval(seedOrigin, originDelays),
      );
    }

    let pageRequestsAttempted = 0;
    const seedResult = await this.retrievalClient.retrieve({
      url: input.companyUrl,
      mode: input.mode,
    });
    pageRequestsAttempted += 1;

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
        skipped: [],
        rankedLinks: [],
        truncated: false,
        truncationReasons: [],
        robots: this.robotsStatuses(robotsCache),
        stats: this.buildStats(pageRequestsAttempted, 0, 1, 0),
      };
    }

    const seed = seedResult.resource;
    const scope = this.buildScope(seed.finalUrl);
    const pages: CrawlPage[] = [];
    const failures: CrawlFailure[] = [];
    const skipped: CrawlSkip[] = [];
    const bestByUrl = new Map<string, CrawlCandidate>();
    const enqueuedUrls = new Set<string>([seed.requestedUrl]);
    const visitedFinal = new Set<string>();
    const truncationReasons = new Set<CrawlTruncationReason>();
    let depthExcluded = false;
    let candidateLimitHit = false;
    let pagesFailed = 0;

    const seedPage = this.toPage(seed, {
      depth: 0,
      discoveredFrom: null,
      relevanceScore: this.linkRanking.scoreLink(seed.finalUrl, '').score,
    });
    pages.push(seedPage);
    visitedFinal.add(seed.finalUrl);

    const seedExpansion = this.expandCandidates(seed, 0, scope, enqueuedUrls, bestByUrl);
    depthExcluded = seedExpansion.droppedDepth;
    candidateLimitHit = seedExpansion.hitCandidateLimit;
    let queue = seedExpansion.candidates;

    while (pageRequestsAttempted < MAX_CRAWL_PAGE_REQUESTS && queue.length > 0) {
      if (this.now() >= deadlineAt) {
        truncationReasons.add('deadline');
        break;
      }

      queue.sort(compareCrawlCandidates);

      // Robots gating precedes the request budget: skipped URLs are never
      // retrieved and consume no page-request budget. Gating overshoots the
      // remaining budget slightly so skips can be backfilled in one round.
      const remaining = MAX_CRAWL_PAGE_REQUESTS - pageRequestsAttempted;
      const provisional = queue.slice(0, remaining + CRAWL_CONCURRENCY);
      queue = queue.slice(provisional.length);

      const gated = await Promise.all(
        provisional.map((candidate) =>
          this.gateCandidate(
            candidate,
            scope,
            input.mode,
            robotsCache,
            pendingRobotsLoads,
            originDelays,
          ),
        ),
      );

      const batch: CrawlCandidate[] = [];
      const overflow: CrawlCandidate[] = [];
      const batchCap = Math.min(remaining, CRAWL_CONCURRENCY);

      for (const entry of gated) {
        if (entry.skip) {
          skipped.push(entry.skip);
          continue;
        }

        if (batch.length < batchCap) {
          batch.push(entry.candidate);
        } else {
          overflow.push(entry.candidate);
        }
      }

      queue.unshift(...overflow);
      pageRequestsAttempted += batch.length;

      const fetched = await Promise.all(
        batch.map((candidate) =>
          this.fetchCandidate(
            candidate,
            pacing,
            deadlineAt,
            input.mode,
            originDelays,
            scope,
            robotsCache,
            pendingRobotsLoads,
          ),
        ),
      );

      if (fetched.some((outcome) => outcome === null) && this.now() >= deadlineAt) {
        truncationReasons.add('deadline');
      }

      for (const outcome of fetched) {
        if (!outcome) {
          continue;
        }

        if (outcome.skip) {
          skipped.push(outcome.skip);
          continue;
        }

        if (outcome.failure) {
          failures.push(outcome.failure);
          pagesFailed += 1;
          continue;
        }

        if (!outcome.page || !outcome.resource || visitedFinal.has(outcome.page.finalUrl)) {
          continue;
        }

        // A same-company link may redirect off-site; scope applies to the
        // final page, which is recorded as a skip and never expanded.
        if (!this.isInScope(new URL(outcome.page.finalUrl), scope)) {
          this.logger.info('crawl.page_out_of_scope', {
            url: sanitizeUrlForLogging(outcome.page.finalUrl),
          });
          visitedFinal.add(outcome.page.finalUrl);
          skipped.push({
            url: outcome.page.finalUrl,
            reason: 'OUT_OF_SCOPE',
            discoveredFrom: outcome.page.discoveredFrom,
            depth: outcome.page.depth,
          });
          continue;
        }

        pages.push(outcome.page);
        visitedFinal.add(outcome.page.finalUrl);

        // Every fetched page is expanded for discovery truth (including
        // max-depth pages, whose deeper links are recorded but not queued).
        const expansion = this.expandCandidates(
          outcome.resource,
          outcome.page.depth,
          scope,
          enqueuedUrls,
          bestByUrl,
        );
        queue.push(...expansion.candidates);
        depthExcluded = depthExcluded || expansion.droppedDepth;
        candidateLimitHit = candidateLimitHit || expansion.hitCandidateLimit;
      }

      const capped = this.capQueue(queue);
      queue = capped.queue;
      candidateLimitHit = candidateLimitHit || capped.trimmed;
    }

    if (pageRequestsAttempted >= MAX_CRAWL_PAGE_REQUESTS && queue.length > 0) {
      truncationReasons.add('page-request-limit');
    }

    if (candidateLimitHit) {
      truncationReasons.add('candidate-limit');
    }

    if (depthExcluded) {
      truncationReasons.add('depth-limit');
    }

    const rankedLinks = [...bestByUrl.values()].sort(compareCrawlCandidates);
    const truncated = truncationReasons.size > 0;

    this.logger.info('crawl.finished', {
      url: sanitizeUrlForLogging(input.companyUrl),
      pages: pages.length,
      failures: failures.length,
      truncated,
      pageRequestsAttempted,
      durationMs: this.now() - crawlStartedAt,
    });

    return {
      seedUrl: input.companyUrl,
      finalSeedUrl: seed.finalUrl,
      pages,
      failures,
      skipped,
      rankedLinks: rankedLinks.map((candidate) => ({
        url: candidate.url,
        discoveredFrom: candidate.discoveredFrom,
        depth: candidate.depth,
        anchorText: candidate.anchorText,
        score: candidate.score,
        signals: candidate.signals,
      })),
      truncated,
      truncationReasons: [...truncationReasons],
      robots: this.robotsStatuses(robotsCache),
      stats: this.buildStats(pageRequestsAttempted, pages.length, pagesFailed, skipped.length),
    };
  }

  private buildStats(
    pageRequestsAttempted: number,
    pagesSucceeded: number,
    pagesFailed: number,
    pagesSkipped: number,
  ): CrawlStats {
    return { pageRequestsAttempted, pagesSucceeded, pagesFailed, pagesSkipped };
  }

  private toPage(resource: RetrievedResource, options: ToPageOptions): CrawlPage {
    const content = this.pageExtraction.extract({
      body: resource.body,
      contentType: resource.contentType,
    });

    this.logger.debug('crawl.page', {
      url: sanitizeUrlForLogging(resource.finalUrl),
      depth: options.depth,
      score: options.relevanceScore,
      textChars: content.textChars,
      contentTruncated: content.truncated,
    });

    return {
      requestedUrl: resource.requestedUrl,
      finalUrl: resource.finalUrl,
      depth: options.depth,
      discoveredFrom: options.discoveredFrom,
      status: resource.status,
      contentType: resource.contentType,
      content,
      relevanceScore: options.relevanceScore,
    };
  }

  // Discovers links from a fetched page, keeps the best deterministic signal
  // per normalized URL, scores, and ranks before capping so a later DOM
  // Careers link is never discarded for an early low-value link.
  private expandCandidates(
    resource: Pick<RetrievedResource, 'requestedUrl' | 'finalUrl' | 'body'>,
    depth: number,
    scope: CrawlScope,
    enqueuedUrls: Set<string>,
    bestByUrl: Map<string, CrawlCandidate>,
  ): { candidates: CrawlCandidate[]; droppedDepth: boolean; hitCandidateLimit: boolean } {
    let droppedDepth = false;
    let hitCandidateLimit = false;

    const discovered = this.linkDiscovery.discoverLinks(resource.body, resource.finalUrl);
    const byUrl = new Map<string, { anchorText: string; score: number; signals: string[] }>();

    for (const link of discovered) {
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
      const existing = byUrl.get(link.url);

      if (
        !existing ||
        compareScoredLinks(
          { url: link.url, score, anchorText: link.anchorText },
          { url: link.url, score: existing.score, anchorText: existing.anchorText },
        ) < 0
      ) {
        byUrl.set(link.url, { anchorText: link.anchorText, score, signals });
      }
    }

    const ranked = [...byUrl.entries()]
      .map(([url, entry]) => ({ url, ...entry }))
      .sort(compareScoredLinks)
      .slice(0, MAX_DISCOVERED_LINKS_PER_PAGE);

    if (byUrl.size > ranked.length) {
      hitCandidateLimit = true;
    }

    const candidates: CrawlCandidate[] = [];

    for (const entry of ranked) {
      const candidateDepth = depth + 1;
      const global = bestByUrl.get(entry.url);

      if (global) {
        // A stronger later signal upgrades the shared representation,
        // including pending queue entries that reference the same object.
        if (
          compareScoredLinks(
            { url: entry.url, score: entry.score, anchorText: entry.anchorText },
            { url: entry.url, score: global.score, anchorText: global.anchorText },
          ) < 0
        ) {
          global.anchorText = entry.anchorText;
          global.score = entry.score;
          global.signals = entry.signals;
        }

        continue;
      }

      const candidate: CrawlCandidate = {
        url: entry.url,
        discoveredFrom: resource.finalUrl,
        depth: candidateDepth,
        anchorText: entry.anchorText,
        score: entry.score,
        signals: entry.signals,
      };
      bestByUrl.set(entry.url, candidate);

      if (candidateDepth > MAX_CRAWL_DEPTH) {
        droppedDepth = true;
        continue;
      }

      if (enqueuedUrls.has(entry.url)) {
        continue;
      }

      enqueuedUrls.add(entry.url);
      candidates.push(candidate);
    }

    return { candidates, droppedDepth, hitCandidateLimit };
  }

  // Keeps the highest-value candidates when the queue exceeds its bound.
  private capQueue(queue: CrawlCandidate[]): { queue: CrawlCandidate[]; trimmed: boolean } {
    if (queue.length <= MAX_CRAWL_CANDIDATES) {
      return { queue, trimmed: false };
    }

    queue.sort(compareCrawlCandidates);
    return { queue: queue.slice(0, MAX_CRAWL_CANDIDATES), trimmed: true };
  }

  private async fetchCandidate(
    candidate: CrawlCandidate,
    pacing: CrawlPacing,
    deadlineAt: number,
    mode: CrawlInput['mode'],
    originDelays: Map<string, number>,
    scope: CrawlScope,
    robotsCache: RobotsPolicyCache,
    pendingRobotsLoads: Map<string, Promise<RobotsPolicy>>,
  ): Promise<{
    page?: CrawlPage;
    resource?: RetrievedResource;
    failure?: CrawlFailure;
    skip?: CrawlSkip;
  } | null> {
    if (this.now() >= deadlineAt) {
      return null;
    }

    const origin = new URL(candidate.url).origin;
    await this.paceOrigin(origin, pacing, deadlineAt, this.effectiveInterval(origin, originDelays));

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

    // Redirect finals get their own origin policy check before they become
    // company pages: an in-scope request may still land out of policy.
    const finalOrigin = new URL(result.resource.finalUrl).origin;
    const finalPolicy = await this.policyForOrigin(
      finalOrigin,
      mode,
      robotsCache,
      pendingRobotsLoads,
    );

    if (finalPolicy && !this.checkAllowed(finalPolicy, result.resource.finalUrl)) {
      this.logger.warn('crawl.page_skipped', {
        url: sanitizeUrlForLogging(result.resource.finalUrl),
        reason: 'redirect-target robots policy',
      });

      return {
        skip: this.skipForPolicy(
          finalPolicy,
          result.resource.finalUrl,
          candidate.discoveredFrom,
          candidate.depth,
        ),
      };
    }

    // The fetched page keeps the candidate relevance that selected it; the
    // opaque URL alone must not reset the score that ranked it highly.
    // The raw body travels alongside for link discovery only and never
    // reaches the final crawl result.
    return {
      page: this.toPage(result.resource, {
        depth: candidate.depth,
        discoveredFrom: candidate.discoveredFrom,
        relevanceScore: candidate.score,
      }),
      resource: result.resource,
    };
  }

  // Pre-request robots gate. Returns a skip without consuming page-request
  // budget when the origin is unknown-over-cap or the URL is disallowed.
  private async gateCandidate(
    candidate: CrawlCandidate,
    scope: CrawlScope,
    mode: CrawlInput['mode'],
    robotsCache: RobotsPolicyCache,
    pendingRobotsLoads: Map<string, Promise<RobotsPolicy>>,
    originDelays: Map<string, number>,
  ): Promise<{ candidate: CrawlCandidate; skip?: CrawlSkip }> {
    void scope;
    const origin = new URL(candidate.url).origin;
    const policy = await this.policyForOrigin(origin, mode, robotsCache, pendingRobotsLoads);

    if (!policy) {
      this.logger.warn('crawl.page_skipped', {
        url: sanitizeUrlForLogging(candidate.url),
        reason: 'robots origin limit',
      });

      return {
        candidate,
        skip: {
          url: candidate.url,
          reason: 'ORIGIN_LIMIT',
          discoveredFrom: candidate.discoveredFrom,
          depth: candidate.depth,
        },
      };
    }

    if (!this.checkAllowed(policy, candidate.url)) {
      this.logger.warn('crawl.page_skipped', {
        url: sanitizeUrlForLogging(candidate.url),
        reason: policy.state,
      });

      return {
        candidate,
        skip: this.skipForPolicy(policy, candidate.url, candidate.discoveredFrom, candidate.depth),
      };
    }

    if (policy.crawlDelayMs !== null) {
      originDelays.set(origin, policy.crawlDelayMs);
    }

    return { candidate };
  }

  // One cached policy per origin per crawl, with in-flight dedupe so a
  // concurrent batch never fetches one origin's robots.txt twice. Returns
  // null when the origin budget is exhausted.
  private async policyForOrigin(
    origin: string,
    mode: CrawlInput['mode'],
    robotsCache: RobotsPolicyCache,
    pendingRobotsLoads: Map<string, Promise<RobotsPolicy>>,
  ): Promise<RobotsPolicy | null> {
    const cached = robotsCache.get(origin);

    if (cached) {
      return cached;
    }

    const inFlight = pendingRobotsLoads.get(origin);

    if (inFlight) {
      return inFlight;
    }

    if (robotsCache.size + pendingRobotsLoads.size >= MAX_CRAWL_ORIGINS) {
      return null;
    }

    const loading = this.robotsPolicy.loadPolicy(origin, mode, robotsCache);
    pendingRobotsLoads.set(origin, loading);

    try {
      return await loading;
    } finally {
      pendingRobotsLoads.delete(origin);
    }
  }

  private checkAllowed(policy: RobotsPolicy, url: string): boolean {
    try {
      return this.robotsPolicy.isUrlAllowed(policy, url);
    } catch {
      // Malformed targets defer to retrieval for a precise failure.
      return true;
    }
  }

  private skipForPolicy(
    policy: RobotsPolicy,
    url: string,
    discoveredFrom: string | null,
    depth: number,
  ): CrawlSkip {
    return {
      url,
      reason: policy.state === 'unavailable' ? 'ROBOTS_UNAVAILABLE' : 'ROBOTS_DISALLOWED',
      discoveredFrom,
      depth,
    };
  }

  private robotsStatuses(robotsCache: RobotsPolicyCache): RobotsOriginStatus[] {
    return [...robotsCache.values()]
      .map((policy) => ({ origin: policy.origin, status: policy.state }))
      .sort((left, right) =>
        left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0,
      );
  }

  private effectiveInterval(origin: string, originDelays: Map<string, number>): number {
    return Math.max(CRAWL_MIN_REQUEST_INTERVAL_MS, originDelays.get(origin) ?? 0);
  }

  // One request-start gate per origin: concurrent batches serialize here so
  // the minimum interval holds even under CRAWL_CONCURRENCY. The interval is
  // the configured base or the origin's robots crawl-delay, whichever is
  // larger; a delay past the deadline defers to the crawl deadline check.
  private async paceOrigin(
    origin: string,
    pacing: CrawlPacing,
    deadlineAt: number,
    minIntervalMs: number = CRAWL_MIN_REQUEST_INTERVAL_MS,
  ): Promise<void> {
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
        const wait = Math.min(minIntervalMs - (this.now() - last), remaining);

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

    const domain = getDomain(hostname, { allowPrivateDomains: true });

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
    // Private-suffix hosts (e.g. github.io tenants) scope per registrable
    // domain, so company.github.io never admits attacker.github.io.
    if (candidate.port !== '') {
      return false;
    }

    return (
      getDomain(candidate.hostname.toLowerCase(), { allowPrivateDomains: true }) ===
      scope.registrableDomain
    );
  }
}
