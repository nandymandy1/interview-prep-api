import type { KitFlashcard, KitQuestion, KitRequirement } from '@/modules/kit/kit.type';

export type StableIdPrefix = 'r' | 'q' | 'f';

// Caller-owned lifecycle state. Lives outside canonical InterviewKit.
export type KitIdSequences = {
  requirement: number;
  question: number;
  flashcard: number;
};

export type RequirementDraft = Omit<KitRequirement, 'id'>;
export type QuestionDraft = Omit<KitQuestion, 'id'>;
export type FlashcardDraft = Omit<KitFlashcard, 'id'>;
