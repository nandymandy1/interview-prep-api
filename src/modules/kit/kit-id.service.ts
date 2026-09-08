import { KitValidationException } from '@/common/errors/kit-validation.exception';
import type {
  FlashcardDraft,
  KitIdSequences,
  QuestionDraft,
  RequirementDraft,
  StableIdPrefix,
} from '@/modules/kit/kit-id.type';
import type { KitFlashcard, KitQuestion, KitRequirement } from '@/modules/kit/kit.type';

const sequenceKey: Record<StableIdPrefix, keyof KitIdSequences> = {
  r: 'requirement',
  q: 'question',
  f: 'flashcard',
};

const assertValidSequences = (sequences: KitIdSequences): void => {
  for (const value of Object.values(sequences)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new KitValidationException('Kit ID sequences must be non-negative integers.');
    }
  }
};

export const createInitialSequences = (): KitIdSequences => ({
  requirement: 0,
  question: 0,
  flashcard: 0,
});

export const allocateStableId = (
  sequences: KitIdSequences,
  prefix: StableIdPrefix,
): string => {
  assertValidSequences(sequences);
  const key = sequenceKey[prefix];
  sequences[key] += 1;
  return `${prefix}${sequences[key]}`;
};

const allocateIds = <T>(
  items: readonly T[],
  prefix: StableIdPrefix,
  sequences: KitIdSequences,
): Array<T & { id: string }> =>
  items.map((item) => ({ ...item, id: allocateStableId(sequences, prefix) }));

export const allocateRequirementIds = (
  drafts: readonly RequirementDraft[],
  sequences: KitIdSequences,
): KitRequirement[] => allocateIds(drafts, 'r', sequences);

export const allocateQuestionIds = (
  drafts: readonly QuestionDraft[],
  sequences: KitIdSequences,
): KitQuestion[] => allocateIds(drafts, 'q', sequences);

export const allocateFlashcardIds = (
  drafts: readonly FlashcardDraft[],
  sequences: KitIdSequences,
): KitFlashcard[] => allocateIds(drafts, 'f', sequences);
