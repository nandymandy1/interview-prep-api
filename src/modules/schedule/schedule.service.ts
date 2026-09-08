import { KitValidationException } from '@/common/errors/kit-validation.exception';
import { calculateCoverage } from '@/modules/coverage/coverage.service';
import type { KitQuestion, KitRequirement, KitScheduleDay } from '@/modules/kit/kit.type';
import type {
  PreparedSchedule,
  ScheduleInput,
  ScheduleResult,
} from '@/modules/schedule/schedule.type';

const SCHEDULE_ALLOCATION_ERROR = 'SCHEDULE_ALLOCATION_ERROR';

const requirementKinds = new Set(['technical', 'behavioural', 'domain']);
const requirementPriorities = new Set(['must', 'nice']);
const questionCategories = new Set(['technical', 'behavioural', 'system-design', 'company-fit']);
const questionDifficulties = new Set([1, 2, 3]);

const isMeaningful = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

// Material validation runs before any scoring so malformed generated-like
// structures (duplicate IDs/refs, unknown refs, blank content) can never
// influence schedule priority. Throws KitValidationException, never HTTP errors.
const assertValidScheduleMaterial = (
  requirements: readonly KitRequirement[],
  questions: readonly KitQuestion[],
): void => {
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  if (requirementIds.size !== requirements.length) {
    throw new KitValidationException(
      'Duplicate requirement IDs are not allowed before scheduling.',
    );
  }
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new KitValidationException(
      'Duplicate question IDs are not allowed before scheduling.',
    );
  }
  for (const requirement of requirements) {
    if (
      !isMeaningful(requirement.id) ||
      !isMeaningful(requirement.text) ||
      !requirementKinds.has(requirement.kind) ||
      !requirementPriorities.has(requirement.priority)
    ) {
      throw new KitValidationException('Scheduled requirements must have meaningful content.');
    }
  }
  for (const question of questions) {
    if (new Set(question.requirement_ids).size !== question.requirement_ids.length) {
      throw new KitValidationException(
        `Duplicate requirement references are not allowed before scheduling.`,
      );
    }
    if (
      !isMeaningful(question.id) ||
      !question.requirement_ids.every(isMeaningful) ||
      !questionCategories.has(question.category) ||
      !isMeaningful(question.prompt) ||
      !isMeaningful(question.answer_outline) ||
      !questionDifficulties.has(question.difficulty) ||
      question.requirement_ids.some((id) => !requirementIds.has(id))
    ) {
      throw new KitValidationException(
        'Scheduled questions must have valid references, category, and difficulty.',
      );
    }
  }
};

const questionScore = (
  question: KitQuestion,
  requirementsById: ReadonlyMap<string, KitRequirement>,
): number =>
  question.requirement_ids.reduce(
    (score, requirementId) =>
      score + (requirementsById.get(requirementId)?.priority === 'must' ? 100 : 0),
    question.difficulty * 10,
  );

const categoryLabel: Record<KitQuestion['category'], string> = {
  technical: 'Technical',
  behavioural: 'Behavioural',
  'system-design': 'System Design',
  'company-fit': 'Company Fit',
};

// Deterministic day focus from scheduled material: up to two dominant question
// categories (ties broken alphabetically). Days without questions stay open review.
const dayFocus = (
  questionIds: readonly string[],
  questionsById: ReadonlyMap<string, KitQuestion>,
): string => {
  const counts = new Map<KitQuestion['category'], number>();
  for (const id of questionIds) {
    const category = questionsById.get(id)?.category;
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 2)
    .map(([category]) => categoryLabel[category]);
  return top.length > 0 ? top.join(' + ') : 'Open review';
};

export const allocateSchedule = ({
  requirements,
  questions,
  daysAvailable,
}: ScheduleInput): ScheduleResult => {
  if (!Number.isInteger(daysAvailable) || daysAvailable < 1) {
    throw new KitValidationException('daysAvailable must be a positive integer.', {
      code: SCHEDULE_ALLOCATION_ERROR,
    });
  }
  assertValidScheduleMaterial(requirements, questions);

  const requirementsById = new Map(
    requirements.map((requirement) => [requirement.id, requirement]),
  );
  const questionsById = new Map(questions.map((question) => [question.id, question]));

  for (const requirement of requirements) {
    if (
      requirement.priority === 'must' &&
      !questions.some((question) => question.requirement_ids.includes(requirement.id))
    ) {
      throw new KitValidationException(
        `Must-have requirement ${requirement.id} has no covering question.`,
        { code: SCHEDULE_ALLOCATION_ERROR },
      );
    }
  }

  const days = Array.from({ length: daysAvailable }, (_, index): KitScheduleDay => ({
    day: index + 1,
    focus: 'Open review',
    question_ids: [],
    minutes: 0,
  }));
  const prioritizedQuestions = [...questions].sort((left, right) => {
    const scoreDifference =
      questionScore(right, requirementsById) - questionScore(left, requirementsById);
    return scoreDifference || left.id.localeCompare(right.id, undefined, { numeric: true });
  });

  const activeDays = Math.min(daysAvailable, prioritizedQuestions.length);
  for (const [index, question] of prioritizedQuestions.entries()) {
    const day = days[Math.floor((index * activeDays) / prioritizedQuestions.length)];
    if (!day) {
      throw new KitValidationException('Unable to allocate schedule day.', {
        code: SCHEDULE_ALLOCATION_ERROR,
      });
    }
    day.question_ids.push(question.id);
    day.minutes += 30;
  }

  for (const day of days) {
    day.focus = dayFocus(day.question_ids, questionsById);
  }

  for (const day of days) {
    if (
      !Number.isInteger(day.minutes) ||
      day.question_ids.some((questionId) => !questionsById.has(questionId))
    ) {
      throw new KitValidationException('Schedule contains an invalid question allocation.', {
        code: SCHEDULE_ALLOCATION_ERROR,
      });
    }
  }

  return { days_available: daysAvailable, days };
};

// Deterministic pipeline order: validate material → coverage → schedule.
// Final kit validation runs later on the assembled InterviewKit.
export const prepareSchedule = (input: ScheduleInput): PreparedSchedule => {
  assertValidScheduleMaterial(input.requirements, input.questions);
  const coverage = calculateCoverage(input.requirements, input.questions);
  return { coverage, schedule: allocateSchedule(input) };
};
