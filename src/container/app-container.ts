import { RequestContextService } from '../common/context/request-context.service';
import { createWrapRoute, type WrapRoute } from '../common/http/wrap-route';
import { singleton, type Provider } from '../common/providers/provider';
import type { AppConfig } from '../config/app.config';
import { createBaseLogger, LoggerService } from '../infrastructure/logger/logger.service';
import { MongoDatabaseService } from '../infrastructure/database/mongo-database.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { AuthController } from '../modules/auth/auth.controller';
import { createRequireAuthMiddleware } from '../modules/auth/auth.middleware';
import { AuthService } from '../modules/auth/auth.service';
import { PasswordService } from '../modules/auth/password.service';
import { HealthController } from '../modules/health/health.controller';
import { UserModel } from '../modules/user/user.model';
import { UserRepository } from '../modules/user/user.repository';
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
  };
};
