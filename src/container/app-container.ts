import { RequestContextService } from '@/common/context/request-context.service';
import { createWrapRoute, type WrapRoute } from '@/common/http/wrap-route';
import { singleton, type Provider } from '@/common/providers/provider';
import type { AppConfig } from '@/config/app.config';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { MongoDatabaseService } from '@/infrastructure/database/mongo-database.service';
import { RedisService } from '@/infrastructure/redis/redis.service';
import { AuthController } from '@/modules/auth/auth.controller';
import { createRequireAuthMiddleware } from '@/modules/auth/auth.middleware';
import { AuthService } from '@/modules/auth/auth.service';
import { PasswordService } from '@/modules/auth/password.service';
import { HealthController } from '@/modules/health/health.controller';
import { KitController } from '@/modules/kit/kit.controller';
import { KitModel } from '@/modules/kit/kit.model';
import { KitRepository } from '@/modules/kit/kit.repository';
import { KitService } from '@/modules/kit/kit.service';
import { RetrievalClient } from '@/modules/research/retrieval/retrieval-client.service';
import { UrlSafetyService } from '@/modules/research/retrieval/url-safety.service';
import { CompanyCrawlerService } from '@/modules/research/crawl/company-crawler.service';
import { LinkDiscoveryService } from '@/modules/research/crawl/link-discovery.service';
import { LinkRankingService } from '@/modules/research/crawl/link-ranking.service';
import { RobotsPolicyService } from '@/modules/research/robots/robots-policy.service';
import { PageExtractionService } from '@/modules/research/extraction/page-extraction.service';
import { BraveSearchProvider } from '@/modules/research/search/brave-search.provider';
import type { PublicSearchProvider } from '@/modules/research/search/search.type';
import { PublicDiscussionResearchService } from '@/modules/research/discussion/public-discussion-research.service';
import { CompanyResearchService } from '@/modules/research/company-research.service';
import { UserModel } from '@/modules/user/user.model';
import { UserRepository } from '@/modules/user/user.repository';
import type { RequestHandler } from 'express';

export type AppContainer = {
  requestContext: Provider<RequestContextService>;
  logger: Provider<LoggerService>;
  mongoDatabase: Provider<MongoDatabaseService>;
  redis: Provider<RedisService>;
  wrapRoute: Provider<WrapRoute>;
  requireAuth: Provider<RequestHandler>;
  userRepository: Provider<UserRepository>;
  passwordService: Provider<PasswordService>;
  authService: Provider<AuthService>;
  authController: Provider<AuthController>;
  healthController: Provider<HealthController>;
  kitRepository: Provider<KitRepository>;
  kitService: Provider<KitService>;
  kitController: Provider<KitController>;
  urlSafetyService: Provider<UrlSafetyService>;
  retrievalClient: Provider<RetrievalClient>;
  linkDiscoveryService: Provider<LinkDiscoveryService>;
  linkRankingService: Provider<LinkRankingService>;
  companyCrawlerService: Provider<CompanyCrawlerService>;
  robotsPolicyService: Provider<RobotsPolicyService>;
  pageExtractionService: Provider<PageExtractionService>;
  publicSearchProvider: Provider<PublicSearchProvider | null>;
  publicDiscussionResearchService: Provider<PublicDiscussionResearchService>;
  companyResearchService: Provider<CompanyResearchService>;
};

export const createAppContainer = (config: AppConfig): AppContainer => {
  const requestContext = singleton(() => new RequestContextService());

  const logger = singleton(
    () =>
      new LoggerService({
        baseLogger: createBaseLogger(config.logLevel),
        requestContext: requestContext(),
      }),
  );

  const mongoDatabase = singleton(
    () =>
      new MongoDatabaseService({
        uri: config.mongodbUri,
        logger: logger(),
      }),
  );

  const redis = singleton(
    () =>
      new RedisService({
        url: config.redisUrl,
        logger: logger(),
      }),
  );

  const wrapRoute = singleton(() => createWrapRoute({ logger: logger() }));

  const requireAuth = singleton(() =>
    createRequireAuthMiddleware({ requestContext: requestContext() }),
  );

  const userRepository = singleton(
    () =>
      new UserRepository({
        userModel: UserModel,
        logger: logger(),
      }),
  );

  const passwordService = singleton(() => new PasswordService());

  const authService = singleton(
    () =>
      new AuthService({
        userRepository: userRepository(),
        passwordService: passwordService(),
        logger: logger(),
      }),
  );

  const authController = singleton(
    () =>
      new AuthController({
        authService: authService(),
      }),
  );

  const healthController = singleton(() => new HealthController());

  const kitRepository = singleton(
    () =>
      new KitRepository({
        kitModel: KitModel,
        logger: logger(),
      }),
  );

  const kitService = singleton(
    () =>
      new KitService({
        kitRepository: kitRepository(),
        logger: logger(),
      }),
  );

  const kitController = singleton(
    () =>
      new KitController({
        kitService: kitService(),
      }),
  );

  const urlSafetyService = singleton(() => new UrlSafetyService());

  const retrievalClient = singleton(
    () =>
      new RetrievalClient({
        urlSafety: urlSafetyService(),
        logger: logger(),
      }),
  );

  const linkDiscoveryService = singleton(() => new LinkDiscoveryService());

  const linkRankingService = singleton(() => new LinkRankingService());

  const robotsPolicyService = singleton(
    () =>
      new RobotsPolicyService({
        retrievalClient: retrievalClient(),
        logger: logger(),
      }),
  );

  const pageExtractionService = singleton(() => new PageExtractionService());

  const companyCrawlerService = singleton(
    () =>
      new CompanyCrawlerService({
        retrievalClient: retrievalClient(),
        urlSafety: urlSafetyService(),
        linkDiscovery: linkDiscoveryService(),
        linkRanking: linkRankingService(),
        robotsPolicy: robotsPolicyService(),
        pageExtraction: pageExtractionService(),
        logger: logger(),
      }),
  );

  // Null without BRAVE_SEARCH_API_KEY: discussion research degrades to a
  // structured unavailable result instead of blocking boot or fabricating.
  const publicSearchProvider = singleton<PublicSearchProvider | null>(() =>
    config.braveSearchApiKey
      ? new BraveSearchProvider({ apiKey: config.braveSearchApiKey, logger: logger() })
      : null,
  );

  const publicDiscussionResearchService = singleton(
    () =>
      new PublicDiscussionResearchService({
        searchProvider: publicSearchProvider(),
        retrievalClient: retrievalClient(),
        robotsPolicy: robotsPolicyService(),
        pageExtraction: pageExtractionService(),
        linkDiscovery: linkDiscoveryService(),
        logger: logger(),
      }),
  );

  const companyResearchService = singleton(
    () =>
      new CompanyResearchService({
        companyCrawler: companyCrawlerService(),
        discussionResearch: publicDiscussionResearchService(),
        logger: logger(),
      }),
  );

  return {
    requestContext,
    logger,
    mongoDatabase,
    redis,
    wrapRoute,
    requireAuth,
    userRepository,
    passwordService,
    authService,
    authController,
    healthController,
    kitRepository,
    kitService,
    kitController,
    urlSafetyService,
    retrievalClient,
    linkDiscoveryService,
    linkRankingService,
    companyCrawlerService,
    robotsPolicyService,
    pageExtractionService,
    publicSearchProvider,
    publicDiscussionResearchService,
    companyResearchService,
  };
};
