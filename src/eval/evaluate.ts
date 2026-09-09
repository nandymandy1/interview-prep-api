import { readFileSync, writeFileSync } from 'node:fs';
import { RequestContextService } from '@/common/context/request-context.service';
import type { AppConfig } from '@/config/app.config';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { CompanyCrawlerService } from '@/modules/research/crawl/company-crawler.service';
import { LinkDiscoveryService } from '@/modules/research/crawl/link-discovery.service';
import { LinkRankingService } from '@/modules/research/crawl/link-ranking.service';
import { CompanyResearchService } from '@/modules/research/company-research.service';
import { PublicDiscussionResearchService } from '@/modules/research/discussion/public-discussion-research.service';
import { PageExtractionService } from '@/modules/research/extraction/page-extraction.service';
import { RetrievalClient } from '@/modules/research/retrieval/retrieval-client.service';
import { UrlSafetyService } from '@/modules/research/retrieval/url-safety.service';
import { RobotsPolicyService } from '@/modules/research/robots/robots-policy.service';
import { InProcessBraveGate } from '@/modules/research/search/brave-gate';
import { BraveSearchProvider } from '@/modules/research/search/brave-search.provider';
import { resolveLlmAdapter } from '@/modules/generation/llm/resolve-llm-adapter';
import { KitGenerationService } from '@/modules/generation/kit-generation.service';
import type { InterviewKit } from '@/modules/kit/kit.type';

export type EvaluationCase = {
  id?: string;
  jd: string;
  company_url: string;
  days?: number;
};

export type EvaluationKitEntry = {
  id: string;
  status: 'ok' | 'failed';
  kit: InterviewKit | null;
  error: { code: string; message: string } | null;
};

export type EvaluationReport = {
  version: '1.0';
  generated_at: string;
  kits: EvaluationKitEntry[];
};

export type EvaluationGenerate = Pick<KitGenerationService, 'generate'>;

// Sequential, isolated, Mongo-free: one failed case never aborts the rest.
// Partial research can still report ok when a valid honest kit results.
export const runEvaluation = async (
  cases: EvaluationCase[],
  generate: EvaluationGenerate,
  onStage?: (caseId: string, stage: string, message: string) => void,
): Promise<EvaluationReport> => {
  const kits: EvaluationKitEntry[] = [];

  for (let index = 0; index < cases.length; index += 1) {
    const evaluationCase = cases[index] as EvaluationCase;
    const caseId = evaluationCase.id ?? `case-${index + 1}`;

    try {
      const { kit } = await generate.generate({
        jd: evaluationCase.jd,
        companyUrl: evaluationCase.company_url,
        days: evaluationCase.days ?? 5,
        mode: 'evaluation',
        onProgress: async (stage, message) => {
          onStage?.(caseId, stage, message);
        },
      });

      kits.push({ id: caseId, status: 'ok', kit, error: null });
    } catch (error) {
      kits.push({
        id: caseId,
        status: 'failed',
        kit: null,
        error: {
          code: 'EVALUATION_CASE_FAILED',
          message: error instanceof Error ? error.message : 'Case failed.',
        },
      });
    }
  }

  return { version: '1.0', generated_at: new Date().toISOString(), kits };
};

const parseArgs = (argv: readonly string[]): { input: string; output: string } => {
  const inputFlag = argv.indexOf('--input');
  const outputFlag = argv.indexOf('--output');
  const input = inputFlag >= 0 ? argv[inputFlag + 1] : undefined;
  const output = outputFlag >= 0 ? argv[outputFlag + 1] : undefined;

  if (!input || !output) {
    throw new Error('Usage: npm run evaluate -- --input <cases.json> --output <kits.json>');
  }

  return { input, output };
};

const parseCases = (raw: unknown): EvaluationCase[] => {
  const list = Array.isArray(raw) ? raw : (raw as { cases?: unknown }).cases;

  if (!Array.isArray(list)) {
    throw new Error('Input must be an array of cases or { "cases": [...] }.');
  }

  return list.map((entry, index) => {
    const candidate = entry as Partial<EvaluationCase>;

    if (typeof candidate.jd !== 'string' || !candidate.jd.trim()) {
      throw new Error(`Case ${index + 1}: jd is required.`);
    }

    if (typeof candidate.company_url !== 'string' || !candidate.company_url.trim()) {
      throw new Error(`Case ${index + 1}: company_url is required.`);
    }

    return {
      ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
      jd: candidate.jd,
      company_url: candidate.company_url,
      ...(candidate.days !== undefined ? { days: candidate.days } : {}),
    };
  });
};

// Evaluator-only wiring: the SAME provider, research, and generation classes
// as the web path, constructed explicitly without the Express container. The
// gate differs (in-process: evaluation runs sequentially anyway). No BullMQ,
// no Mongo, no auth; infra values below are never connected.
const createEvaluatorGeneration = (config: AppConfig): KitGenerationService => {
  const logger = new LoggerService({
    baseLogger: createBaseLogger(config.logLevel),
    requestContext: new RequestContextService(),
  });

  const urlSafety = new UrlSafetyService();
  const retrievalClient = new RetrievalClient({ urlSafety, logger });
  const linkDiscovery = new LinkDiscoveryService();
  const linkRanking = new LinkRankingService();
  const robotsPolicy = new RobotsPolicyService({ retrievalClient, logger });
  const pageExtraction = new PageExtractionService();

  const searchProvider = config.braveSearchApiKey
    ? new BraveSearchProvider({
        apiKey: config.braveSearchApiKey,
        gate: new InProcessBraveGate(),
        logger,
      })
    : null;

  const discussionResearch = new PublicDiscussionResearchService({
    searchProvider,
    retrievalClient,
    robotsPolicy,
    pageExtraction,
    linkDiscovery,
    logger,
  });
  const companyCrawler = new CompanyCrawlerService({
    retrievalClient,
    urlSafety,
    linkDiscovery,
    linkRanking,
    robotsPolicy,
    pageExtraction,
    logger,
  });
  const research = new CompanyResearchService({
    companyCrawler,
    discussionResearch,
    logger,
  });
  const llm = resolveLlmAdapter(
    {
      llmProvider: config.llmProvider,
      openaiApiKey: config.openaiApiKey,
      openaiModel: config.openaiModel,
      geminiApiKey: config.geminiApiKey,
      geminiModel: config.geminiModel,
    },
    { logger },
  );

  return new KitGenerationService({ research, llm, logger });
};

const main = async (): Promise<void> => {
  const { input, output } = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(input, 'utf8')) as unknown;
  const cases = parseCases(raw);

  const config: AppConfig = {
    nodeEnv: 'development',
    port: 4000,
    frontendOrigin: 'http://localhost:3000',
    mongodbUri: 'mongodb://127.0.0.1:27017/interview_prep_unused',
    redisUrl: 'redis://127.0.0.1:6379',
    sessionSecret: 'evaluator-never-connects-sessions-or-mongo',
    sessionCookieName: 'interview_prep.sid',
    generationCacheTtlDays: 7,
    researchCacheTtlHours: 24,
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    ...(process.env.BRAVE_SEARCH_API_KEY?.trim()
      ? { braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY.trim() }
      : {}),
    ...(process.env.LLM_PROVIDER?.trim().toLowerCase() === 'openai' ||
    process.env.LLM_PROVIDER?.trim().toLowerCase() === 'gemini'
      ? { llmProvider: process.env.LLM_PROVIDER.trim().toLowerCase() as 'openai' | 'gemini' }
      : {}),
    ...(process.env.OPENAI_API_KEY?.trim()
      ? { openaiApiKey: process.env.OPENAI_API_KEY.trim() }
      : {}),
    ...(process.env.OPENAI_MODEL?.trim() ? { openaiModel: process.env.OPENAI_MODEL.trim() } : {}),
    ...(process.env.GEMINI_API_KEY?.trim()
      ? { geminiApiKey: process.env.GEMINI_API_KEY.trim() }
      : {}),
    ...(process.env.GEMINI_MODEL?.trim() ? { geminiModel: process.env.GEMINI_MODEL.trim() } : {}),
  };

  const generation = createEvaluatorGeneration(config);
  const report = await runEvaluation(cases, generation, (caseId, stage, message) => {
    process.stderr.write(`[${caseId}] ${stage}: ${message}\n`);
  });

  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

  const failed = report.kits.filter((entry) => entry.status === 'failed').length;
  process.stderr.write(`evaluated ${report.kits.length} case(s), ${failed} failed → ${output}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
