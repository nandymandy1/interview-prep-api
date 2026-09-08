import type { InterviewKit } from '@/modules/kit/kit.type';

export type KitStatus = 'queued' | 'running' | 'completed' | 'failed';

export type KitSummary = {
  id: string;
  company: string;
  role: string;
  status: KitStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateKitInput = {
  jd: string;
  companyUrl: string;
  days: number;
};

export type CreateKitResult = {
  kitId: string;
  status: KitStatus;
};

export type KitDetailResult = {
  id: string;
  status: KitStatus;
  kit: InterviewKit | null;
};

export type GenerationStep = {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  message?: string;
};

export type KitStatusResult = {
  kitId: string;
  status: KitStatus;
  progress: number;
  steps: GenerationStep[];
  error?: {
    code: string;
    message: string;
  };
};

export type RecordPracticeInput = {
  confidence: 1 | 2 | 3 | 4 | 5;
};
