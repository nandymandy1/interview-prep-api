import type {
  InterviewKit,
  KitFlashcard,
  KitQuestion,
  QuestionCategory,
  QuestionDifficulty,
} from '@/modules/kit/kit.type';

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
  practiceRecords: PracticeRecordResult[];
};

export type PracticeRecordResult = {
  flashcardId: string;
  confidence: number;
  recordedAt: string;
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
  updatedAt: string;
};

export type RecordPracticeInput = {
  confidence: 1 | 2 | 3 | 4 | 5;
};

export type UpdateQuestionInput = Partial<
  Pick<KitQuestion, 'prompt' | 'answer_outline' | 'category' | 'difficulty'>
>;

export type AddQuestionInput = {
  prompt: string;
  answer_outline: string;
  category: QuestionCategory;
  difficulty?: QuestionDifficulty;
  requirement_ids?: string[];
};

export type ReorderQuestionsInput = {
  questionIds: string[];
};

export type RegenerateSectionInput =
  | { section: 'company_brief' }
  | { section: 'schedule' }
  | { section: 'questions'; category: QuestionCategory };

export type AddFlashcardInput = {
  front: string;
  back: string;
  requirement_ids?: string[];
};

export type UpdateFlashcardInput = Partial<Pick<KitFlashcard, 'front' | 'back'>>;

export type UpdateBriefInput = {
  summary?: string;
  what_they_do?: string;
};
