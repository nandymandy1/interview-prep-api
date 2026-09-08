export type RequirementKind = 'technical' | 'behavioural' | 'domain';
export type RequirementPriority = 'must' | 'nice';
export type QuestionCategory = 'technical' | 'behavioural' | 'system-design' | 'company-fit';
export type QuestionDifficulty = 1 | 2 | 3;

export type KitRequirement = {
  id: string;
  text: string;
  kind: RequirementKind;
  priority: RequirementPriority;
};

export type KitQuestion = {
  id: string;
  requirement_ids: string[];
  category: QuestionCategory;
  prompt: string;
  answer_outline: string;
  difficulty: QuestionDifficulty;
};

export type KitFlashcard = {
  id: string;
  front: string;
  back: string;
  requirement_ids: string[];
};

export type KitScheduleDay = {
  day: number;
  focus: string;
  question_ids: string[];
  minutes: number;
};

export type InterviewKit = {
  source: {
    company: string;
    company_url: string;
    role: string;
    location: string;
    jd_chars: number;
    researched_at: string;
    pages_used: string[];
  };
  company_brief: {
    summary: string;
    what_they_do: string;
    sources: string[];
  };
  role: {
    title: string;
    seniority: string;
    responsibilities: string[];
    requirements: KitRequirement[];
  };
  questions: KitQuestion[];
  flashcards: KitFlashcard[];
  schedule: {
    days_available: number;
    days: KitScheduleDay[];
  };
  coverage: {
    uncovered_requirement_ids: string[];
    passes: number;
  };
};
