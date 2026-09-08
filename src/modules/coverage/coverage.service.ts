import type { CoverageResult } from '@/modules/coverage/coverage.type';
import type { KitQuestion, KitRequirement } from '@/modules/kit/kit.type';

export const calculateCoverage = (
  requirements: readonly KitRequirement[],
  questions: readonly KitQuestion[],
): CoverageResult => {
  const coveredIds = new Set(questions.flatMap((question) => question.requirement_ids));

  return {
    uncovered_requirement_ids: requirements
      .filter((requirement) => requirement.priority === 'must' && !coveredIds.has(requirement.id))
      .map((requirement) => requirement.id),
  };
};
