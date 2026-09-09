import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import type { RedisClientType } from 'redis';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { GenerationJobData, GenerationStage } from '@/modules/generation/generation.type';

export const KIT_GENERATION_QUEUE = 'kit-generation';
export const KIT_GENERATION_PROGRESS_CHANNEL = 'kit-generation-progress';

// One worker, concurrency 1: Brave allows 2 req/s and the LLM is free-tier.
// Reliability beats throughput; no horizontal scaling in this assessment.
export const GENERATION_WORKER_CONCURRENCY = 1;

export type GenerationProgressEvent = {
  kitId: string;
  stage: GenerationStage;
  message: string;
  timestamp: string;
};

type QueueLogger = Pick<LoggerService, 'info' | 'warn' | 'error'>;

// REDIS_URL (redis://...) is the only supported form; BullMQ needs
// host/port options, so parse once here instead of adding a new package.
const bullmqConnection = (redisUrl: string): { host: string; port: number; password?: string } => {
  const parsed = new URL(redisUrl);

  if (parsed.protocol !== 'redis:') {
    throw new Error('REDIS_URL must use the redis:// scheme for the generation queue.');
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
};

// __dirname is src/modules/generation in dev and dist/modules/generation
// after build; up three levels is the package root either way.
const rootDir = (): string => join(__dirname, '..', '..', '..');

// The external processor file, compiled to dist. Worker threads are plain
// Node without ts path aliases, so dev must `npm run build` first; a missing
// file fails loudly at worker start instead of silently dropping jobs.
export const generationProcessorFile = (): string => {
  const file = join(rootDir(), 'dist/modules/generation/kit-generation.processor.js');

  if (!existsSync(file)) {
    throw new Error(
      `Generation processor not found at ${file}. Run "npm run build" before starting the API.`,
    );
  }

  return file;
};

export const createGenerationQueue = (redisUrl: string): Queue<GenerationJobData> =>
  new Queue<GenerationJobData>(KIT_GENERATION_QUEUE, {
    connection: bullmqConnection(redisUrl),
  });

// jobId = kitId: the same kit can never be enqueued twice. attempts = 1
// because provider/retrieval layers already bound their retries and replaying
// a whole generation wastes quota.
export const enqueueKitGeneration = async (
  queue: Queue<GenerationJobData>,
  data: GenerationJobData,
): Promise<void> => {
  await queue.add('generate', data, {
    jobId: data.kitId,
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
};

export const startGenerationWorker = (
  redisUrl: string,
  logger: QueueLogger,
): Worker<GenerationJobData> => {
  const worker = new Worker<GenerationJobData>(KIT_GENERATION_QUEUE, generationProcessorFile(), {
    connection: bullmqConnection(redisUrl),
    concurrency: GENERATION_WORKER_CONCURRENCY,
    useWorkerThreads: true,
  });

  worker.on('failed', (job, error) => {
    logger.warn('generation.job_failed', { jobId: job?.id, message: error.message });
  });

  return worker;
};

export const publishProgress = async (
  client: RedisClientType,
  event: Omit<GenerationProgressEvent, 'timestamp'>,
): Promise<void> => {
  const payload: GenerationProgressEvent = { ...event, timestamp: new Date().toISOString() };
  await client.publish(KIT_GENERATION_PROGRESS_CHANNEL, JSON.stringify(payload));
};

// Best-effort notification only: Mongo kit status stays the source of truth,
// so a lost message never corrupts GET /status. The subscriber just logs.
export const startProgressSubscriber = async (
  client: RedisClientType,
  logger: QueueLogger,
): Promise<RedisClientType> => {
  const subscriber = client.duplicate();
  await subscriber.connect();
  await subscriber.subscribe(KIT_GENERATION_PROGRESS_CHANNEL, (message) => {
    try {
      const event = JSON.parse(message) as GenerationProgressEvent;
      logger.info('generation.progress', {
        kitId: event.kitId,
        stage: event.stage,
        message: event.message,
      });
    } catch {
      logger.warn('generation.progress_malformed', {});
    }
  });

  return subscriber;
};
