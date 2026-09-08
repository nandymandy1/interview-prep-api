import type { CoverageResult } from '@/modules/coverage/coverage.type';
import type { KitQuestion, KitRequirement, KitScheduleDay } from '@/modules/kit/kit.type';

export type ScheduleInput = {
  requirements: readonly KitRequirement[];
  questions: readonly KitQuestion[];
  daysAvailable: number;
};

export type ScheduleResult = {
  days_available: number;
  days: KitScheduleDay[];
};

export type PreparedSchedule = {
  coverage: CoverageResult;
  schedule: ScheduleResult;
};
