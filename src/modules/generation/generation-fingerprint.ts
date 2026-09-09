import { createHash } from 'node:crypto';
import { canonicalCompanyUrl } from '@/modules/research/retrieval/canonical-url';
import type { InterviewKit } from '@/modules/kit/kit.type';

// Explicit generation version: bump when prompts/schemas change so stale
// cached material is treated as a miss, never reused blindly.
export const GENERATION_VERSION = 'v1';

// Exact deterministic input identity: normalized JD + canonical company URL.
// Days are excluded on purpose — they affect only the deterministic schedule,
// not the expensive research/LLM material.
export const normalizeJd = (jd: string): string =>
  jd
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

export const generationFingerprint = (jd: string, companyUrl: string): string => {
  let canonical: string;

  try {
    canonical = canonicalCompanyUrl(companyUrl);
  } catch {
    canonical = companyUrl.trim();
  }

  return createHash('sha256')
    .update(`${GENERATION_VERSION}\n${canonical}\n${normalizeJd(jd)}`)
    .digest('hex');
};

// Pristine generated material only: never userId ownership, manual edits,
// editor metadata, practice confidence, or user-specific schedule state.
export type PristineGeneratedContent = {
  companyBrief: { summary: string; what_they_do: string; sources: string[] };
  role: InterviewKit['role'];
  questions: InterviewKit['questions'];
  flashcards: InterviewKit['flashcards'];
  coverage: { uncovered_requirement_ids: string[]; passes: number };
  sourceFacts: {
    company: string;
    companyUrl: string;
    role: string;
    location: string;
    jdChars: number;
    pagesUsed: string[];
  };
};

export type CachedGeneration = {
  fingerprint: string;
  content: PristineGeneratedContent;
};

// Optional cache seam for the generation pipeline. The BullMQ worker path
// passes Mongo-backed stores; the evaluator CLI passes none, keeping its
// core generation path direct (no Mongo/BullMQ/Redis required).
export type GenerationCacheStore = {
  findFresh(fingerprint: string): Promise<CachedGeneration | null>;
  upsert(input: {
    fingerprint: string;
    jd: string;
    companyUrl: string;
    content: PristineGeneratedContent;
  }): Promise<void>;
};
