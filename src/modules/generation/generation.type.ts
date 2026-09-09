import type { RetrievalMode } from '@/modules/research/retrieval/retrieval.type';

export type GenerationStage =
  | 'queued'
  | 'researching'
  | 'generating'
  | 'checking-coverage'
  | 'building-schedule'
  | 'completed'
  | 'failed';

export type GenerationJobData = {
  kitId: string;
  userId: string;
  jd: string;
  companyUrl: string;
  days: number;
};

export type GenerationProgressCallback = (
  stage: GenerationStage,
  message: string,
) => void | Promise<void>;

export type GenerationInput = {
  jd: string;
  companyUrl: string;
  days: number;
  mode: RetrievalMode;
  onProgress?: GenerationProgressCallback;
};

export const GENERATION_STAGES: readonly GenerationStage[] = [
  'queued',
  'researching',
  'generating',
  'checking-coverage',
  'building-schedule',
  'completed',
] as const;
