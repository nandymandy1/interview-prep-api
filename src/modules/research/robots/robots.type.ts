import type { RetrievalFailureCode } from '@/modules/research/retrieval/retrieval.type';

export type RobotsPolicyState = 'ok' | 'missing' | 'unavailable';

export type RobotsPolicy = {
  origin: string;
  state: RobotsPolicyState;
  status?: number;
  failureCode?: RetrievalFailureCode;
  crawlDelayMs: number | null;
  allows: (url: string) => boolean;
};

export type RobotsOriginStatus = {
  origin: string;
  status: RobotsPolicyState;
};

export type RobotsPolicyCache = Map<string, RobotsPolicy>;
