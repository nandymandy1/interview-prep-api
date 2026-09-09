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
import { OpenAiException } from '@/modules/generation/llm/openai.adapter';
import { GeminiException } from '@/modules/generation/gemini.exception';

export type GenerationJobRunnerDependencies = {
  kitRepository: Pick<KitRepository, 'updateGenerationState' | 'saveGeneratedKit'>;
  generation: Pick<KitGenerationService, 'generate'>;
  publish: (event: Omit<GenerationProgressEvent, 'timestamp'>) => Promise<void>;
  logger: Pick<LoggerService, 'info' | 'warn' | 'error'>;
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

    // Best-effort: a Pub/Sub failure must never fail an otherwise successful
    // generation. Mongo above stays the source of truth.
    try {
      await publish({ kitId, stage, message });
    } catch {
      logger.warn('generation.progress_publish_failed', { kitId, stage });
    }
  };

  try {
    await report(
      'researching',
      'Researching the company website and public interview discussions.',
    );
    const { kit, sequences } = await generation.generate({
      jd,
      companyUrl,
      days,
      mode: 'production',
      onProgress: report,
    });

    await kitRepository.saveGeneratedKit(userId, kitId, kit, sequences);

    try {
      await publish({ kitId, stage: 'completed', message: 'Kit completed.' });
    } catch {
      logger.warn('generation.progress_publish_failed', { kitId, stage: 'completed' });
    }

    logger.info('generation.job_completed', { kitId });
  } catch (error) {
    // Provider adapters normalize to safe fixed messages, so their code and
    // message persist verbatim. Anything else stays a generic failure — raw
    // provider payloads never reach the browser.
    const failure = failureOf(error);
    await kitRepository.updateGenerationState(userId, kitId, {
      status: 'failed',
      stageMessage: failure.message,
      error: { code: failure.code, message: failure.message },
    });

    try {
      await publish({ kitId, stage: 'failed', message: failure.message });
    } catch {
      logger.warn('generation.progress_publish_failed', { kitId, stage: 'failed' });
    }

    logger.error(error, 'generation.job_failed');
    throw error;
  }
};

const failureOf = (error: unknown): { code: string; message: string } => {
  if (error instanceof OpenAiException || error instanceof GeminiException) {
    return { code: error.code, message: error.message };
  }

  const message = error instanceof Error ? error.message : 'Generation failed.';
  return { code: 'GENERATION_FAILED', message };
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
    // Deferred: resolving the generation service builds the LLM adapter,
    // which throws when unconfigured. It must throw inside runGenerationJob
    // (after the researching stage persists), never before it.
    generation: {
      generate: (input) => container.kitGenerationService().generate(input),
    },
    publish: (event) => publishProgress(redisClient, event),
    logger,
  });
}
