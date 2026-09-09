import { describe, expect, it, vi } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { resolveLlmAdapter } from '@/modules/generation/llm/resolve-llm-adapter';
import { OpenAiGenerationAdapter } from '@/modules/generation/llm/openai.adapter';

const silentLogger = (): LoggerService => {
  const requestContext = new RequestContextService();
  return new LoggerService({ baseLogger: createBaseLogger('silent'), requestContext });
};

const openAiCreds = { openaiApiKey: 'ok', openaiModel: 'gpt-4o-mini' };
const geminiCreds = { geminiApiKey: 'gk', geminiModel: 'gemini-2.5-flash' };

describe('llm adapter resolution', () => {
  it('selects OpenAI explicitly', () => {
    const adapter = resolveLlmAdapter(
      { llmProvider: 'openai', ...openAiCreds },
      { logger: silentLogger() },
    );

    expect(adapter.provider).toBe('openai');
  });

  it('selects Gemini explicitly', () => {
    const adapter = resolveLlmAdapter(
      { llmProvider: 'gemini', ...geminiCreds },
      { logger: silentLogger() },
    );

    expect(adapter.provider).toBe('gemini');
  });

  it('auto-selects OpenAI when only its credentials exist', () => {
    const adapter = resolveLlmAdapter({ ...openAiCreds }, { logger: silentLogger() });

    expect(adapter.provider).toBe('openai');
  });

  it('auto-selects Gemini when only its credentials exist', () => {
    const adapter = resolveLlmAdapter({ ...geminiCreds }, { logger: silentLogger() });

    expect(adapter.provider).toBe('gemini');
  });

  it('fails when both credentials exist without LLM_PROVIDER', () => {
    expect(() =>
      resolveLlmAdapter({ ...openAiCreds, ...geminiCreds }, { logger: silentLogger() }),
    ).toThrow('LLM_PROVIDER');
  });

  it('fails when the selected provider lacks credentials', () => {
    expect(() => resolveLlmAdapter({ llmProvider: 'openai' }, { logger: silentLogger() })).toThrow(
      'OPENAI_API_KEY',
    );
    expect(() => resolveLlmAdapter({ llmProvider: 'gemini' }, { logger: silentLogger() })).toThrow(
      'GEMINI_API_KEY',
    );
  });

  it('fails when nothing is configured', () => {
    expect(() => resolveLlmAdapter({}, { logger: silentLogger() })).toThrow(
      'No LLM provider is configured',
    );
  });

  it('never falls back: an OpenAI runtime failure stays an OpenAI failure', async () => {
    const httpPost = vi.fn(async () => ({ status: 500, headers: {}, data: {} }));
    const adapter = new OpenAiGenerationAdapter({
      apiKey: 'ok',
      model: 'gpt-4o-mini',
      logger: silentLogger(),
      httpPost,
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      adapter.generateJson({ systemPrompt: 's', userPrompt: 'u' }, {} as never),
    ).rejects.toMatchObject({ name: 'OpenAiException' });
    // Two bounded attempts on the same provider, then stop. No Gemini call.
    expect(httpPost).toHaveBeenCalledTimes(2);
  });
});
