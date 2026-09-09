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
// Presence means non-empty after trimming; no fragile prefix checks on keys.
export const resolveLlmAdapter = (
  config: LlmAdapterConfig,
  dependencies: ResolveLlmAdapterDependencies,
): LlmGenerationAdapter => {
  const openaiApiKey = config.openaiApiKey?.trim() ? config.openaiApiKey.trim() : undefined;
  const openaiModel = config.openaiModel?.trim() ? config.openaiModel.trim() : undefined;
  const geminiApiKey = config.geminiApiKey?.trim() ? config.geminiApiKey.trim() : undefined;
  const geminiModel = config.geminiModel?.trim() ? config.geminiModel.trim() : undefined;
  const hasOpenAi = Boolean(openaiApiKey && openaiModel);
  const hasGemini = Boolean(geminiApiKey && geminiModel);
  const { logger } = dependencies;

  if (config.llmProvider === 'openai') {
    if (!openaiApiKey && !openaiModel) {
      throw new Error('LLM_PROVIDER=openai requires both OPENAI_API_KEY and OPENAI_MODEL.');
    }

    if (!openaiApiKey) {
      throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY (OPENAI_MODEL is set).');
    }

    if (!openaiModel) {
      throw new Error('LLM_PROVIDER=openai requires OPENAI_MODEL (OPENAI_API_KEY is set).');
    }

    return new OpenAiGenerationAdapter({ apiKey: openaiApiKey, model: openaiModel, logger });
  }

  if (config.llmProvider === 'gemini') {
    if (!geminiApiKey && !geminiModel) {
      throw new Error('LLM_PROVIDER=gemini requires both GEMINI_API_KEY and GEMINI_MODEL.');
    }

    if (!geminiApiKey) {
      throw new Error('LLM_PROVIDER=gemini requires GEMINI_API_KEY (GEMINI_MODEL is set).');
    }

    if (!geminiModel) {
      throw new Error('LLM_PROVIDER=gemini requires GEMINI_MODEL (GEMINI_API_KEY is set).');
    }

    return new GeminiGenerationAdapter({ apiKey: geminiApiKey, model: geminiModel, logger });
  }

  if (hasOpenAi && hasGemini) {
    throw new Error(
      'Both OpenAI and Gemini credentials are configured without LLM_PROVIDER. Set LLM_PROVIDER=openai|gemini.',
    );
  }

  if (hasOpenAi) {
    return new OpenAiGenerationAdapter({ apiKey: openaiApiKey, model: openaiModel, logger });
  }

  if (hasGemini) {
    return new GeminiGenerationAdapter({ apiKey: geminiApiKey, model: geminiModel, logger });
  }

  throw new Error(
    'No LLM provider is configured. Set OPENAI_API_KEY/OPENAI_MODEL or GEMINI_API_KEY/GEMINI_MODEL.',
  );
};
