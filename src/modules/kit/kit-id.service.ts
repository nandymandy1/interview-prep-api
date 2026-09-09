import { KitValidationException } from '@/common/errors/kit-validation.exception';
import type { KitFlashcard, KitQuestion, KitRequirement } from '@/modules/kit/kit.type';
import type {
  FlashcardDraft,
  KitIdSequences,
  QuestionDraft,
  RequirementDraft,
  StableIdPrefix,
} from '@/modules/kit/kit-id.type';

const sequenceKey: Record<StableIdPrefix, keyof KitIdSequences> = {
  r: 'requirement',
  q: 'question',
  f: 'flashcard',
};

const assertValidSequences = (sequences: KitIdSequences): void => {
  for (const value of Object.values(sequences)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new KitValidationException('Kit ID sequences must be non-negative integers.');
    }
  }
};

const assertIncrementable = (counter: number): void => {
  if (counter >= Number.MAX_SAFE_INTEGER) {
    throw new KitValidationException('Kit ID sequence has reached its maximum safe value.');
  }
};

export const createInitialSequences = (): KitIdSequences => ({
  requirement: 0,
  question: 0,
  flashcard: 0,
});

// Cache-hit kits reuse pristine IDs verbatim; the sequences resume from the
// highest allocated index so later builder additions never collide.
export const sequencesFromContent = (
  requirements: readonly { id: string }[],
  questions: readonly { id: string }[],
  flashcards: readonly { id: string }[],
): KitIdSequences => {
  const maxIndex = (items: readonly { id: string }[], prefix: StableIdPrefix): number => {
    let max = 0;

    for (const item of items) {
      const match = new RegExp(`^${prefix}(\\d+)$`).exec(item.id);

      if (match) {
        max = Math.max(max, Number(match[1]));
      }
    }

    return max;
  };

  return {
    requirement: maxIndex(requirements, 'r'),
    question: maxIndex(questions, 'q'),
    flashcard: maxIndex(flashcards, 'f'),
  };
};

export const allocateStableId = (sequences: KitIdSequences, prefix: StableIdPrefix): string => {
  assertValidSequences(sequences);
  const key = sequenceKey[prefix];
  assertIncrementable(sequences[key]);
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
