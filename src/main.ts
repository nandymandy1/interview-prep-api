import { createServer } from 'node:http';
import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { createApp } from '@/app';
import { loadAppConfig } from '@/config/app.config';
import { createAppContainer } from '@/container/app-container';
import {
  startGenerationWorker,
  startProgressSubscriber,
} from '@/modules/generation/kit-generation.queue';
import type { GenerationJobData } from '@/modules/generation/generation.type';

const bootstrap = async (): Promise<void> => {
  const config = loadAppConfig();
  const container = createAppContainer(config);
  const logger = container.logger();

  // Critical infrastructure is deliberately resolved and connected at boot.
  // Application services/controllers remain lazy singletons.
  try {
    await container.mongoDatabase().connect();
    await container.redis().connect();
  } catch (error) {
    logger.error(error, 'infrastructure.connect_failed');

    await Promise.allSettled([
      container.mongoDatabase().disconnect(),
      container.redis().disconnect(),
    ]);

    process.exitCode = 1;
    return;
  }

  // Same deployment: the BullMQ worker (sandboxed thread) and the progress
  // subscriber start with the API. No second service required. A worker that
  // cannot start aborts boot: an API that listens but can never process a
  // generation job would strand kits in queued forever.
  let worker: Worker<GenerationJobData> | null = null;
  let subscriber: Redis | null = null;

  try {
    worker = startGenerationWorker(config.redisUrl, logger);
    await worker.waitUntilReady();
    subscriber = await startProgressSubscriber(container.redis().getClient(), logger);
  } catch (error) {
    // Clean failure: close everything opened so far (worker, Mongo, Redis)
    // so the backend does not linger alive on open sockets, then exit. No
    // HTTP server has started listening at this point.
    logger.error(error, 'worker.startup_failed');

    await Promise.allSettled([
      ...(worker ? [worker.close()] : []),
      container.mongoDatabase().disconnect(),
      container.redis().disconnect(),
    ]);

    process.exitCode = 1;
    return;
  }

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
          worker.close(),
          container
            .generationQueue()
            .close()
            .then(() => container.generationQueue().disconnect()),
          subscriber.quit(),
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
