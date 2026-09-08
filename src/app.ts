import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AppConfig } from '@/config/app.config';
import type { AppContainer } from '@/container/app-container';
import { createRequestContextMiddleware } from '@/common/middleware/request-context.middleware';
import { notFoundMiddleware } from '@/common/middleware/not-found.middleware';
import { createErrorHandlerMiddleware } from '@/common/middleware/error-handler.middleware';
import { createSessionMiddleware } from '@/infrastructure/session/session.middleware';
import { createRouterDependencies } from '@/routes/router-dependencies';
import { registerRoutes } from '@/routes';

export const createApp = (config: AppConfig, container: AppContainer): Express => {
  const app = express();
  const logger = container.logger();
  const requestContext = container.requestContext();
  const redisClient = container.redis().getClient();

  if (config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }

  app.set('sessionCookieName', config.sessionCookieName);
  app.disable('x-powered-by');

  app.use(
    cors({
      origin: config.frontendOrigin,
      credentials: true,
    }),
  );

  app.use(helmet());
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  app.use(
    createRequestContextMiddleware({
      requestContext,
      logger,
    }),
  );

  app.use(createSessionMiddleware(redisClient, config));
  registerRoutes(app, createRouterDependencies(container));
  app.use(notFoundMiddleware);
  app.use(createErrorHandlerMiddleware(logger));

  return app;
};
