import type { Job } from 'bullmq';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import { loadAppConfig } from '@/config/app.config';
import { createAppContainer } from '@/container/app-container';
import {
  publishProgress,
  type GenerationProgressEvent,
} from '@/modules/generation/kit-generation.queue';
import type { KitGenerationService } from '@/modules/generation/kit-generation.service';
import type { KitRepository } from '@/modules/kit/kit.repository';
import type { GenerationJobData, GenerationStage } from '@/modules/generation/generation.type';

export type GenerationJobRunnerDependencies = {
  kitRepository: Pick<KitRepository, 'updateGenerationState' | 'saveGeneratedKit'>;
  generation: Pick<KitGenerationService, 'generate'>;
  publish: (event: Omit<GenerationProgressEvent, 'timestamp'>) => Promise<void>;
  logger: Pick<LoggerService, 'info' | 'error'>;
};

// The runnable core, exported for tests: persist each stage to Mongo (source
// of truth), mirror to Pub/Sub (best-effort), persist the canonical kit on
// success or a safe failure on error.
export const runGenerationJob = async (
  data: GenerationJobData,
  dependencies: GenerationJobRunnerDependencies,
): Promise<void> => {
  const { kitId, userId, jd, companyUrl, days } = data;
  const { kitRepository, generation, publish, logger } = dependencies;

  const report = async (stage: GenerationStage, message: string): Promise<void> => {
    const status = stage === 'completed' ? 'completed' : 'running';
    await kitRepository.updateGenerationState(userId, kitId, {
      status,
      stage,
      stageMessage: message,
    });
    await publish({ kitId, stage, message });
  };

  try {
    await report('researching', 'Researching the company site and public discussions.');
    const { kit, sequences } = await generation.generate({
      jd,
      companyUrl,
      days,
      mode: 'production',
      onProgress: report,
    });

    await kitRepository.saveGeneratedKit(userId, kitId, kit, sequences);
    await publish({ kitId, stage: 'completed', message: 'Kit completed.' });
    logger.info('generation.job_completed', { kitId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Generation failed.';
    await kitRepository.updateGenerationState(userId, kitId, {
      status: 'failed',
      stageMessage: message,
      error: { code: 'GENERATION_FAILED', message },
    });
    await publish({ kitId, stage: 'failed', message });
    logger.error(error, 'generation.job_failed');
    throw error;
  }
};

// BullMQ sandboxed processor: runs in a worker thread off the Express event
// loop, so research/scraping/LLM work never blocks HTTP. This file is only an
// adapter — the pipeline lives in KitGenerationService, shared with the
// evaluator CLI.
export default async function processKitGeneration(job: Job<GenerationJobData>): Promise<void> {
  const config = loadAppConfig();
  const container = createAppContainer(config);
  const logger = container.logger();

  await container.mongoDatabase().connect();
  await container.redis().connect();

  const redisClient = container.redis().getClient();

  await runGenerationJob(job.data, {
    kitRepository: container.kitRepository(),
    generation: container.kitGenerationService(),
    publish: (event) => publishProgress(redisClient, event),
    logger,
  });
}
