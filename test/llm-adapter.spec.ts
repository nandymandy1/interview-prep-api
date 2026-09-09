import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { resolveLlmAdapter } from '@/modules/generation/llm/resolve-llm-adapter';
import { OpenAiGenerationAdapter } from '@/modules/generation/llm/openai.adapter';
import { GeminiService } from '@/modules/generation/gemini.service';

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
    // Three bounded attempts on the same provider, then stop. No Gemini call.
    expect(httpPost).toHaveBeenCalledTimes(3);
  });

  it('fails openai selection when only the key exists (missing model)', () => {
    expect(() =>
      resolveLlmAdapter({ llmProvider: 'openai', openaiApiKey: 'ok' }, { logger: silentLogger() }),
    ).toThrow('OPENAI_MODEL');
  });

  it('fails gemini selection when only the model exists (missing key)', () => {
    expect(() =>
      resolveLlmAdapter(
        { llmProvider: 'gemini', geminiModel: 'gemini-2.5-flash' },
        { logger: silentLogger() },
      ),
    ).toThrow('GEMINI_API_KEY');
  });
});

const payloadSchema = z.object({ ok: z.boolean() });

const openAiSuccess = (body: unknown) => ({
  status: 200,
  headers: {},
  data: { choices: [{ message: { content: JSON.stringify(body) } }] },
});

const geminiSuccess = (body: unknown) => ({
  status: 200,
  headers: {},
  data: { candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] },
});

const openAiAdapter = (httpPost: ReturnType<typeof vi.fn>, sleep: ReturnType<typeof vi.fn>) =>
  new OpenAiGenerationAdapter({
    apiKey: 'ok',
    model: 'gpt-4o-mini',
    logger: silentLogger(),
    httpPost,
    sleep,
    random: () => 0,
  });

const geminiService = (httpPost: ReturnType<typeof vi.fn>, sleep: ReturnType<typeof vi.fn>) =>
  new GeminiService({
    apiKey: 'gk',
    model: 'gemini-2.5-flash',
    logger: silentLogger(),
    httpPost,
    sleep,
    random: () => 0,
  });

describe('openai retry policy', () => {
  it('429 with Retry-After waits at least Retry-After, then succeeds', async () => {
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '2' }, data: {} })
      .mockResolvedValueOnce(openAiSuccess({ ok: true }));
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const result = await openAiAdapter(httpPost, sleep).generateJson(
      { systemPrompt: 's', userPrompt: 'u' },
      payloadSchema,
    );

    expect(result).toEqual({ ok: true });
    expect(httpPost).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(delays[0]).toBeGreaterThanOrEqual(2_000);
  });

  it('retries 500 with exponential backoff, then succeeds', async () => {
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, headers: {}, data: {} })
      .mockResolvedValueOnce(openAiSuccess({ ok: true }));
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await openAiAdapter(httpPost, sleep).generateJson(
      { systemPrompt: 's', userPrompt: 'u' },
      payloadSchema,
    );

    expect(httpPost).toHaveBeenCalledTimes(2);
    expect(delays[0]).toBe(750);
  });

  it('401 makes exactly one attempt and normalizes to LLM_AUTH_INVALID', async () => {
    const httpPost = vi.fn(async () => ({ status: 401, headers: {}, data: {} }));
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await expect(
      openAiAdapter(httpPost, sleep).generateJson(
        { systemPrompt: 's', userPrompt: 'u' },
        payloadSchema,
      ),
    ).rejects.toMatchObject({ code: 'LLM_AUTH_INVALID' });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never retries 400 client errors', async () => {
    const httpPost = vi.fn(async () => ({ status: 400, headers: {}, data: {} }));
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await expect(
      openAiAdapter(httpPost, sleep).generateJson(
        { systemPrompt: 's', userPrompt: 'u' },
        payloadSchema,
      ),
    ).rejects.toMatchObject({ code: 'OPENAI_HTTP_ERROR' });

    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it('never retries malformed JSON envelopes', async () => {
    const httpPost = vi.fn(async () => openAiSuccess({ unexpected: 1 }));
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await expect(
      openAiAdapter(httpPost, sleep).generateJson(
        { systemPrompt: 's', userPrompt: 'u' },
        payloadSchema,
      ),
    ).rejects.toMatchObject({ code: 'OPENAI_INVALID_RESPONSE' });

    expect(httpPost).toHaveBeenCalledTimes(1);
  });
});

describe('gemini retry policy', () => {
  it('retries transient 503 with bounded exponential backoff, then succeeds', async () => {
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, headers: {}, data: {} })
      .mockResolvedValueOnce(geminiSuccess({ ok: true }));
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const result = await geminiService(httpPost, sleep).generateJson('prompt', payloadSchema);

    expect(result).toEqual({ ok: true });
    expect(httpPost).toHaveBeenCalledTimes(2);
    expect(delays[0]).toBe(750);
  });

  it('respects Retry-After sent by Gemini', async () => {
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '3' }, data: {} })
      .mockResolvedValueOnce(geminiSuccess({ ok: true }));
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await geminiService(httpPost, sleep).generateJson('prompt', payloadSchema);

    expect(delays[0]).toBeGreaterThanOrEqual(3_000);
  });

  it('403 makes exactly one attempt and normalizes to LLM_AUTH_INVALID', async () => {
    const httpPost = vi.fn(async () => ({ status: 403, headers: {}, data: {} }));
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await expect(
      geminiService(httpPost, sleep).generateJson('prompt', payloadSchema),
    ).rejects.toMatchObject({ code: 'LLM_AUTH_INVALID' });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
