import type { z } from 'zod';

// The single application-facing LLM contract. Provider adapters own only
// request shape, auth, bounded retries, JSON extraction, and error
// normalization; domain validation stays in the caller.
export type LlmJsonRequest = {
  systemPrompt: string;
  userPrompt: string;
};

export type LlmGenerationAdapter = {
  readonly provider: 'openai' | 'gemini';
  generateJson<T>(request: LlmJsonRequest, schema: z.ZodType<T>): Promise<T>;
};
