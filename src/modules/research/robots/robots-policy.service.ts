import robotsParser from 'robots-parser';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import { ROBOTS_PATH, ROBOTS_USER_AGENT_TOKEN } from '@/modules/research/robots/robots.constants';
import type { RobotsPolicy } from '@/modules/research/robots/robots.type';
import type { RetrievalClient } from '@/modules/research/retrieval/retrieval-client.service';
import type { RetrievalMode } from '@/modules/research/retrieval/retrieval.type';
import { sanitizeUrlForLogging } from '@/modules/research/retrieval/url-safety.service';

export type RobotsPolicyCache = Map<string, RobotsPolicy>;

type RobotsPolicyServiceDependencies = {
  retrievalClient: Pick<RetrievalClient, 'retrieve'>;
  logger: LoggerService;
};

// Dedicated robots policy component. Fetches and parses robots.txt per origin
// through the hardened retrieval client; never guesses company paths. The
// per-crawl cache is owned by the caller (CompanyCrawlerService) so policies
// never leak across crawls.
export class RobotsPolicyService {
  private readonly retrievalClient: Pick<RetrievalClient, 'retrieve'>;
  private readonly logger: LoggerService;

  constructor(dependencies: RobotsPolicyServiceDependencies) {
    this.retrievalClient = dependencies.retrievalClient;
    this.logger = dependencies.logger;
  }

  buildRobotsUrl(origin: string): string {
    return new URL(ROBOTS_PATH, origin).toString();
  }

  async loadPolicy(
    origin: string,
    mode: RetrievalMode,
    cache: RobotsPolicyCache,
  ): Promise<RobotsPolicy> {
    const cached = cache.get(origin);

    if (cached) {
      return cached;
    }

    const policy = await this.fetchPolicy(origin, mode);
    cache.set(origin, policy);
    return policy;
  }

  isUrlAllowed(policy: RobotsPolicy, url: string): boolean {
    if (policy.state !== 'ok') {
      return policy.state === 'missing';
    }

    return policy.allows(url);
  }

  private async fetchPolicy(origin: string, mode: RetrievalMode): Promise<RobotsPolicy> {
    const robotsUrl = this.buildRobotsUrl(origin);
    this.logger.debug('robots.fetch', { origin: sanitizeUrlForLogging(origin) });

    const result = await this.retrievalClient.retrieve({ url: robotsUrl, mode });

    // Retrieval failures carry the HTTP status when one exists: 404/410 mean
    // robots is absent (allowed under normal discipline); other non-429 4xx
    // are treated as absent (documented, matching common crawler practice);
    // 429/5xx/network/timeout/DNS/blocked stay unavailable, never allow-all.
    if (!result.ok) {
      const failure = result.failure;

      if (failure.status === 404 || failure.status === 410) {
        return this.missing(origin, failure.status);
      }

      if (
        failure.status !== undefined &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 429
      ) {
        return this.missing(origin, failure.status);
      }

      this.logger.warn('robots.unavailable', {
        origin: sanitizeUrlForLogging(origin),
        code: failure.code,
      });

      return {
        origin,
        state: 'unavailable',
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        failureCode: failure.code,
        crawlDelayMs: null,
        allows: () => false,
      };
    }

    const resource = result.resource;

    if (resource.status === 429 || resource.status >= 500) {
      this.logger.warn('robots.unavailable', {
        origin: sanitizeUrlForLogging(origin),
        status: resource.status,
      });

      return {
        origin,
        state: 'unavailable',
        status: resource.status,
        crawlDelayMs: null,
        allows: () => false,
      };
    }

    if (resource.status >= 400) {
      return this.missing(origin, resource.status);
    }

    const parsed = robotsParser(robotsUrl, resource.body);
    const delaySeconds = parsed.getCrawlDelay(ROBOTS_USER_AGENT_TOKEN);

    this.logger.info('robots.loaded', {
      origin: sanitizeUrlForLogging(origin),
      status: resource.status,
    });

    return {
      origin,
      state: 'ok',
      status: resource.status,
      crawlDelayMs: delaySeconds === undefined ? null : delaySeconds * 1000,
      allows: (url: string) => parsed.isAllowed(url, ROBOTS_USER_AGENT_TOKEN) !== false,
    };
  }

  private missing(origin: string, status: number): RobotsPolicy {
    return {
      origin,
      state: 'missing',
      status,
      crawlDelayMs: null,
      allows: () => true,
    };
  }
}
