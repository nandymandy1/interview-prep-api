import { KitValidationException } from '@/common/errors/kit-validation.exception';
import { calculateCoverage } from '@/modules/coverage/coverage.service';
import { questionSchema, requirementSchema } from '@/modules/kit/kit.schema';
import type { KitQuestion, KitRequirement, KitScheduleDay } from '@/modules/kit/kit.type';
import type {
  PreparedSchedule,
  ScheduleInput,
  ScheduleResult,
} from '@/modules/schedule/schedule.type';

const SCHEDULE_ALLOCATION_ERROR = 'SCHEDULE_ALLOCATION_ERROR';

type ScheduleMaterial = {
  requirements: KitRequirement[];
  questions: KitQuestion[];
};

const parseRequirement = (value: unknown, index: number): KitRequirement => {
  const parsed = requirementSchema.safeParse(value);
  if (!parsed.success) {
    throw new KitValidationException(`Scheduled requirement at index ${index} is invalid.`, {
      details: parsed.error.flatten(),
      cause: parsed.error,
    });
  }
  return parsed.data;
};

const parseQuestion = (value: unknown, index: number): KitQuestion => {
  const parsed = questionSchema.safeParse(value);
  if (!parsed.success) {
    throw new KitValidationException(`Scheduled question at index ${index} is invalid.`, {
      details: parsed.error.flatten(),
      cause: parsed.error,
    });
  }
  return parsed.data;
};

// Canonical structural normalization first (Zod trims whitespace), then semantic
// uniqueness/reference checks on the normalized structures. Schedule logic must
// only ever consume the returned material, so whitespace-equivalent IDs cannot
// bypass uniqueness and malformed data can never influence scoring.
const parseScheduleMaterial = (
  requirements: readonly unknown[],
  questions: readonly unknown[],
): ScheduleMaterial => {
  const parsedRequirements = requirements.map((value, index) => parseRequirement(value, index));
  const parsedQuestions = questions.map((value, index) => parseQuestion(value, index));
  const requirementIds = new Set(parsedRequirements.map((requirement) => requirement.id));
  if (requirementIds.size !== parsedRequirements.length) {
    throw new KitValidationException(
      'Duplicate requirement IDs are not allowed before scheduling.',
    );
  }
  if (new Set(parsedQuestions.map((question) => question.id)).size !== parsedQuestions.length) {
    throw new KitValidationException('Duplicate question IDs are not allowed before scheduling.');
  }
  for (const question of parsedQuestions) {
    if (new Set(question.requirement_ids).size !== question.requirement_ids.length) {
      throw new KitValidationException(
        `Duplicate requirement references are not allowed before scheduling.`,
      );
    }
    if (question.requirement_ids.some((id) => !requirementIds.has(id))) {
      throw new KitValidationException('Scheduled question references an unknown requirement.');
    }
  }
  return { requirements: parsedRequirements, questions: parsedQuestions };
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
// categories (ties broken alphabetically). Days without questions stay honest
// review placeholders.
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
  return top.length > 0 ? top.join(' + ') : 'Review available role and company context';
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
  const material = parseScheduleMaterial(requirements, questions);

  const requirementsById = new Map(
    material.requirements.map((requirement) => [requirement.id, requirement]),
  );
  const questionsById = new Map(material.questions.map((question) => [question.id, question]));

  for (const requirement of material.requirements) {
    if (
      requirement.priority === 'must' &&
      !material.questions.some((question) => question.requirement_ids.includes(requirement.id))
    ) {
      throw new KitValidationException(
        `Must-have requirement ${requirement.id} has no covering question.`,
        { code: SCHEDULE_ALLOCATION_ERROR },
      );
    }
  }

  const days = Array.from({ length: daysAvailable }, (_, index): KitScheduleDay => ({
    day: index + 1,
    focus: 'Review available role and company context',
    question_ids: [],
    minutes: 0,
  }));
  const prioritizedQuestions = [...material.questions].sort((left, right) => {
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
  const material = parseScheduleMaterial(input.requirements, input.questions);
  const coverage = calculateCoverage(material.requirements, material.questions);
  return { coverage, schedule: allocateSchedule(input) };
};
