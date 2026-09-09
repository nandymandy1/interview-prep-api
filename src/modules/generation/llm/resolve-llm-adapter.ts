import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { LlmGenerationAdapter } from '@/modules/generation/llm/llm-adapter';
import { GeminiGenerationAdapter } from '@/modules/generation/llm/gemini.adapter';
import { OpenAiGenerationAdapter } from '@/modules/generation/llm/openai.adapter';

export type LlmProviderName = 'openai' | 'gemini';

export type LlmAdapterConfig = {
  llmProvider?: LlmProviderName;
  openaiApiKey?: string;
  openaiModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
};

type ResolveLlmAdapterDependencies = {
  logger: LoggerService;
};

// One tiny resolver, no registry/fallback chain. Exactly one provider is
// selected per process; a runtime failure retries that provider per its own
// policy and then fails gracefully — never silently switching providers.
export const resolveLlmAdapter = (
  config: LlmAdapterConfig,
  dependencies: ResolveLlmAdapterDependencies,
): LlmGenerationAdapter => {
  const hasOpenAi = Boolean(config.openaiApiKey && config.openaiModel);
  const hasGemini = Boolean(config.geminiApiKey && config.geminiModel);
  const { logger } = dependencies;

  if (config.llmProvider === 'openai') {
    if (!hasOpenAi) {
      throw new Error('LLM_PROVIDER=openai requires both OPENAI_API_KEY and OPENAI_MODEL.');
    }

    return new OpenAiGenerationAdapter({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      logger,
    });
  }

  if (config.llmProvider === 'gemini') {
    if (!hasGemini) {
      throw new Error('LLM_PROVIDER=gemini requires both GEMINI_API_KEY and GEMINI_MODEL.');
    }

    return new GeminiGenerationAdapter({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      logger,
    });
  }

  if (hasOpenAi && hasGemini) {
    throw new Error(
      'Both OpenAI and Gemini credentials are configured without LLM_PROVIDER. Set LLM_PROVIDER=openai|gemini.',
    );
  }

  if (hasOpenAi) {
    return new OpenAiGenerationAdapter({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      logger,
    });
  }

  if (hasGemini) {
    return new GeminiGenerationAdapter({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      logger,
    });
  }

  throw new Error(
    'No LLM provider is configured. Set OPENAI_API_KEY/OPENAI_MODEL or GEMINI_API_KEY/GEMINI_MODEL.',
  );
};
