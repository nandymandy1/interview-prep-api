import { createServer } from 'node:http';
import { createApp } from './app';
import { loadAppConfig } from './config/app.config';
import { createAppContainer } from './container/app-container';

const bootstrap = async (): Promise<void> => {
  const config = loadAppConfig();
  const container = createAppContainer(config);
  const logger = container.logger();

  // Critical infrastructure is deliberately resolved and connected at boot.
  // Application services/controllers remain lazy singletons.
  await container.mongoDatabase().connect();
  await container.redis().connect();

  const app = createApp(config, container);
  const server = createServer(app);

  server.listen(config.port, () => {
    logger.info('server.started', {
      port: config.port,
      environment: config.nodeEnv,
    });
  });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('server.shutdown.started', { signal });

    server.close(async (serverError) => {
      try {
        await Promise.allSettled([
          container.mongoDatabase().disconnect(),
          container.redis().disconnect(),
        ]);

        if (serverError) {
          logger.error(serverError, 'server.shutdown.failed');
          process.exitCode = 1;
          return;
        }

        logger.info('server.shutdown.completed');
        process.exitCode = 0;
      } catch (error) {
        logger.error(error, 'server.shutdown.failed');
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
};

bootstrap().catch((error: unknown) => {
  // Bootstrap failures can occur before the structured logger is available.
  console.error('Application bootstrap failed', error);
  process.exitCode = 1;
});
