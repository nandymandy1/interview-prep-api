import { KitValidationException } from '@/common/errors/kit-validation.exception';
import { calculateCoverage } from '@/modules/coverage/coverage.service';
import { interviewKitSchema } from '@/modules/kit/kit.schema';
import type { InterviewKit } from '@/modules/kit/kit.type';

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length)
    throw new KitValidationException(`Duplicate ${label} IDs are not allowed.`);
};

// Shape, primitives, enums, meaningful content, and exact canonical keys are
// enforced by the strict Zod schema above. This validator owns only semantic
// invariants: uniqueness, referential integrity, and truthful coverage.
export const validateInterviewKit = (value: unknown): InterviewKit => {
  const parsed = interviewKitSchema.safeParse(value);
  if (!parsed.success) {
    throw new KitValidationException('Interview kit has an invalid structure.', {
      details: parsed.error.flatten(),
      cause: parsed.error,
    });
  }
  const kit = parsed.data;
  const { requirements } = kit.role;
  const { questions, flashcards } = kit;
  const { days } = kit.schedule;

  assertUnique(
    requirements.map((requirement) => requirement.id),
    'requirement',
  );
  assertUnique(
    questions.map((question) => question.id),
    'question',
  );
  assertUnique(
    flashcards.map((flashcard) => flashcard.id),
    'flashcard',
  );
  assertUnique(kit.coverage.uncovered_requirement_ids, 'uncovered requirement');
  questions.forEach((question) =>
    assertUnique(question.requirement_ids, `question ${question.id} requirement`),
  );
  flashcards.forEach((flashcard) =>
    assertUnique(flashcard.requirement_ids, `flashcard ${flashcard.id} requirement`),
  );
  days.forEach((day) => assertUnique(day.question_ids, `schedule day ${day.day} question`));
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const questionIds = new Set(questions.map((question) => question.id));
  const mustRequirementIds = new Set(
    requirements
      .filter((requirement) => requirement.priority === 'must')
      .map((requirement) => requirement.id),
  );
  const calculatedCoverage = calculateCoverage(requirements, questions).uncovered_requirement_ids;

  if (
    questions.some((question) => question.requirement_ids.some((id) => !requirementIds.has(id))) ||
    flashcards.some((flashcard) =>
      flashcard.requirement_ids.some((id) => !requirementIds.has(id)),
    ) ||
    days.some(
      (day, index) => day.day !== index + 1 || day.question_ids.some((id) => !questionIds.has(id)),
    ) ||
    days.length !== kit.schedule.days_available ||
    kit.coverage.uncovered_requirement_ids.some((id) => !mustRequirementIds.has(id)) ||
    kit.coverage.uncovered_requirement_ids.length !== calculatedCoverage.length ||
    kit.coverage.uncovered_requirement_ids.some((id) => !calculatedCoverage.includes(id))
  ) {
    throw new KitValidationException('Interview kit has invalid references or schedule days.');
  }

  return kit;
};

// Domain boundary: KitValidationException carries no HTTP semantics. A future HTTP input
// boundary may translate it into 400 when the client payload itself is invalid; generation
// orchestration must translate it into retry/repair handling instead.
export const validateFinalInterviewKit = (value: unknown): InterviewKit => {
  const kit = validateInterviewKit(value);
  if (kit.role.requirements.length < 1) {
    throw new KitValidationException('Final interview kit must contain at least one requirement.');
  }
  if (kit.questions.length < 1) {
    throw new KitValidationException('Final interview kit must contain at least one question.');
  }
  if (kit.coverage.passes < 1 || kit.coverage.uncovered_requirement_ids.length > 0) {
    throw new KitValidationException(
      'Final interview kit must have completed coverage with no uncovered requirements.',
    );
  }
  const scheduledQuestionIds = new Set(kit.schedule.days.flatMap((day) => day.question_ids));
  const scheduledQuestionIdList = kit.schedule.days.flatMap((day) => day.question_ids);
  const scheduledRequirementIds = new Set(
    kit.questions
      .filter((question) => scheduledQuestionIds.has(question.id))
      .flatMap((question) => question.requirement_ids),
  );
  if (
    kit.role.requirements.some(
      (requirement) =>
        requirement.priority === 'must' && !scheduledRequirementIds.has(requirement.id),
    )
  ) {
    throw new KitValidationException(
      'Final interview kit must schedule every must-have requirement.',
    );
  }
  if (
    scheduledQuestionIds.size !== scheduledQuestionIdList.length ||
    scheduledQuestionIds.size !== kit.questions.length
  ) {
    throw new KitValidationException(
      'Final interview kit must schedule every question exactly once.',
    );
  }
  return kit;
};
