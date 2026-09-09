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

describe('openai 429 classification', () => {
  const capturingLogger = () => {
    const warnings: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const logger = {
      warn: vi.fn((message: string, meta: Record<string, unknown> = {}) => {
        warnings.push({ message, meta });
      }),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    return { logger, warnings };
  };

  const adapterWithCapture = (
    httpPost: ReturnType<typeof vi.fn>,
    capture: ReturnType<typeof capturingLogger>,
    sleep?: ReturnType<typeof vi.fn>,
  ) =>
    new OpenAiGenerationAdapter({
      apiKey: 'sk-test-secret-key',
      model: 'gpt-4o-mini',
      logger: capture.logger as never,
      httpPost,
      sleep: sleep ?? vi.fn(async () => undefined),
      random: () => 0,
    });

  const providerFailure = (
    status: number,
    code: string,
    type: string,
    headers: Record<string, string> = {},
  ) => ({
    status,
    headers,
    data: { error: { code, type, message: 'provider says something verbose' } },
  });

  it('retries transient rate limits and preserves provider details', async () => {
    const httpPost = vi.fn(async () =>
      providerFailure(429, 'rate_limit_exceeded', 'requests', {
        'retry-after': '1',
        'x-request-id': 'req_123',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-remaining-tokens': '5',
        'x-ratelimit-reset-requests': '2s',
        'x-ratelimit-reset-tokens': '500ms',
      }),
    );
    const capture = capturingLogger();
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await expect(
      adapterWithCapture(httpPost, capture, sleep).generateJson(
        { systemPrompt: 's', userPrompt: 'u' },
        payloadSchema,
      ),
    ).rejects.toMatchObject({
      code: 'OPENAI_RATE_LIMITED',
      message: 'OpenAI is temporarily rate-limiting requests. Please retry in a moment.',
      status: 429,
      providerErrorCode: 'rate_limit_exceeded',
      providerErrorType: 'requests',
      requestId: 'req_123',
      retryAfterMs: 1000,
      rateLimit: {
        remainingRequests: 0,
        remainingTokens: 5,
        resetRequests: 2000,
        resetTokens: 500,
      },
    });

    expect(httpPost).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
  });

  it('fails fast on quota-style 429s without retrying', async () => {
    const httpPost = vi.fn(async () =>
      providerFailure(429, 'insufficient_quota', 'insufficient_quota'),
    );
    const capture = capturingLogger();
    const sleep = vi.fn(async () => undefined);

    await expect(
      adapterWithCapture(httpPost, capture, sleep).generateJson(
        { systemPrompt: 's', userPrompt: 'u' },
        payloadSchema,
      ),
    ).rejects.toMatchObject({
      code: 'OPENAI_CREDITS_EXHAUSTED',
      message: 'OpenAI billing quota was exhausted.',
    });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('maps project and org spend limits to distinct non-retryable codes', async () => {
    for (const [providerCode, code] of [
      ['project_quota_exceeded', 'OPENAI_PROJECT_LIMIT_EXCEEDED'],
      ['org_quota_exceeded', 'OPENAI_ORG_LIMIT_EXCEEDED'],
    ] as const) {
      const httpPost = vi.fn(async () => providerFailure(429, providerCode, providerCode));
      const capture = capturingLogger();

      await expect(
        adapterWithCapture(httpPost, capture).generateJson(
          { systemPrompt: 's', userPrompt: 'u' },
          payloadSchema,
        ),
      ).rejects.toMatchObject({ code });

      expect(httpPost).toHaveBeenCalledTimes(1);
    }
  });

  it('normalizes 403 to LLM_AUTH_INVALID without retrying', async () => {
    const httpPost = vi.fn(async () =>
      providerFailure(403, 'invalid_api_key', 'invalid_request_error'),
    );
    const capture = capturingLogger();
    const sleep = vi.fn(async () => undefined);

    await expect(
      adapterWithCapture(httpPost, capture, sleep).generateJson(
        { systemPrompt: 's', userPrompt: 'u' },
        payloadSchema,
      ),
    ).rejects.toMatchObject({ code: 'LLM_AUTH_INVALID' });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never logs the API key, auth headers, or raw provider payloads', async () => {
    const httpPost = vi.fn(async () =>
      providerFailure(429, 'insufficient_quota', 'insufficient_quota', {
        'x-request-id': 'req_quota_1',
      }),
    );
    const capture = capturingLogger();

    await expect(
      adapterWithCapture(httpPost, capture).generateJson(
        { systemPrompt: 's', userPrompt: 'u' },
        payloadSchema,
      ),
    ).rejects.toMatchObject({ code: 'OPENAI_CREDITS_EXHAUSTED' });

    expect(capture.warnings.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(capture.warnings);

    expect(serialized).not.toContain('sk-test-secret-key');
    expect(serialized).not.toContain('Authorization');
    // Offending-param logging: truncated provider message scalar is logged
    // for debugging; prompts/JD are never part of the log shape.
    expect(serialized).toContain('provider says something verbose');
    expect(serialized).toContain('insufficient_quota');
    expect(serialized).toContain('req_quota_1');
  });
});

describe('openai request compatibility', () => {
  it('does NOT send temperature or other sampling controls', async () => {
    const httpPost = vi.fn(async () => openAiSuccess({ ok: true }));
    const sleep = vi.fn(async () => undefined);

    await openAiAdapter(httpPost, sleep).generateJson(
      { systemPrompt: 's', userPrompt: 'u' },
      payloadSchema,
    );

    expect(httpPost).toHaveBeenCalledTimes(1);
    const body = (httpPost.mock.calls as unknown[][])[0]?.[1] as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('400 unsupported_value is non-retryable and keeps param logging', async () => {
    const httpPost = vi.fn(async () => ({
      status: 400,
      headers: {},
      data: {
        error: {
          code: 'unsupported_value',
          type: 'invalid_request_error',
          param: 'temperature',
          message: "Unsupported value: 'temperature' does not support 0.2 with this model.",
        },
      },
    }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      openAiAdapter(httpPost, sleep).generateJson(
        { systemPrompt: 's', userPrompt: 'u' },
        payloadSchema,
      ),
    ).rejects.toMatchObject({
      code: 'OPENAI_PROVIDER_ERROR',
      status: 400,
      providerErrorCode: 'unsupported_value',
      providerErrorParam: 'temperature',
    });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('parses providerErrorParam and truncated providerErrorMessage', async () => {
    const httpPost = vi.fn(async () => ({
      status: 400,
      headers: {},
      data: {
        error: {
          code: 'unsupported_value',
          type: 'invalid_request_error',
          param: 'top_p',
          message: 'Bad param value.',
        },
      },
    }));

    try {
      await openAiAdapter(
        httpPost,
        vi.fn(async () => undefined),
      ).generateJson({ systemPrompt: 's', userPrompt: 'u' }, payloadSchema);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        providerErrorCode: 'unsupported_value',
        providerErrorType: 'invalid_request_error',
        providerErrorParam: 'top_p',
        providerErrorMessage: 'Bad param value.',
      });
    }
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
