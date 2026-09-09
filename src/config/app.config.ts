import 'dotenv/config';

export type NodeEnvironment = 'development' | 'test' | 'production';

export type LlmProviderName = 'openai' | 'gemini';

export type AppConfig = {
  nodeEnv: NodeEnvironment;
  port: number;
  frontendOrigin: string;
  mongodbUri: string;
  redisUrl: string;
  sessionSecret: string;
  sessionCookieName: string;
  logLevel: string;
  braveSearchApiKey?: string;
  llmProvider?: LlmProviderName;
  openaiApiKey?: string;
  openaiModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  generationCacheTtlDays: number;
  researchCacheTtlHours: number;
};

const required = (name: string): string => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const parseNodeEnvironment = (value: string | undefined): NodeEnvironment => {
  if (value === 'production' || value === 'test' || value === 'development') {
    return value;
  }

  return 'development';
};

const parsePort = (value: string | undefined): number => {
  const parsed = Number(value ?? 4000);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return parsed;
};

export const loadAppConfig = (): AppConfig => {
  const nodeEnv = parseNodeEnvironment(process.env.NODE_ENV);
  const sessionSecret = required('SESSION_SECRET');

  if (nodeEnv === 'production' && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }

  return {
    nodeEnv,
    port: parsePort(process.env.PORT),
    frontendOrigin: required('FRONTEND_ORIGIN'),
    mongodbUri: required('MONGODB_URI'),
    redisUrl: required('REDIS_URL'),
    sessionSecret,
    sessionCookieName: process.env.SESSION_COOKIE_NAME?.trim() || 'interview_prep.sid',
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    // Optional degradable integration: public discussion research reports
    // SEARCH_PROVIDER_NOT_CONFIGURED when absent and never blocks boot.
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
    // Optional: kit generation fails with a clear error when absent, but boot
    // and every deterministic pipeline stay unaffected.
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
    geminiModel: process.env.GEMINI_MODEL?.trim() || undefined,
    llmProvider: parseLlmProvider(process.env.LLM_PROVIDER),
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    openaiModel: process.env.OPENAI_MODEL?.trim() || undefined,
    generationCacheTtlDays: parsePositiveInt(process.env.GENERATION_CACHE_TTL_DAYS, 7),
    researchCacheTtlHours: parsePositiveInt(process.env.RESEARCH_CACHE_TTL_HOURS, 24),
  };
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined || !value.trim()) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('Cache TTL values must be positive integers when set.');
  }

  return parsed;
};

const parseLlmProvider = (value: string | undefined): LlmProviderName | undefined => {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (normalized === 'openai' || normalized === 'gemini') {
    return normalized;
  }

  throw new Error('LLM_PROVIDER must be openai or gemini when set.');
};
