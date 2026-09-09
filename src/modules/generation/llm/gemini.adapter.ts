import type { z } from 'zod';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import { GeminiService } from '@/modules/generation/gemini.service';
import type { LlmGenerationAdapter, LlmJsonRequest } from '@/modules/generation/llm/llm-adapter';

type GeminiGenerationAdapterDependencies = {
  apiKey?: string;
  model?: string;
  logger: LoggerService;
  httpPost?: ConstructorParameters<typeof GeminiService>[0]['httpPost'];
  sleep?: (ms: number) => Promise<void>;
};

// Gemini behind the shared contract: combines system + user prompts into the
// single text prompt the generateContent API takes and delegates to the
// unchanged GeminiService. No InterviewKit knowledge here.
export class GeminiGenerationAdapter implements LlmGenerationAdapter {
  readonly provider = 'gemini' as const;
  private readonly gemini: GeminiService;

  constructor(dependencies: GeminiGenerationAdapterDependencies) {
    this.gemini = new GeminiService({
      apiKey: dependencies.apiKey,
      model: dependencies.model,
      logger: dependencies.logger,
      ...(dependencies.httpPost !== undefined ? { httpPost: dependencies.httpPost } : {}),
      ...(dependencies.sleep !== undefined ? { sleep: dependencies.sleep } : {}),
    });
  }

  async generateJson<T>(request: LlmJsonRequest, schema: z.ZodType<T>): Promise<T> {
    return this.gemini.generateJson(`${request.systemPrompt}\n\n${request.userPrompt}`, schema);
  }
}
