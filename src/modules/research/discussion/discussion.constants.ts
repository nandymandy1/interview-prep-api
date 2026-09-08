// Bounded deterministic discussion research: a few queries, a few results
// per query, a few single-page fetches. Never a recursive site crawl.
export const MAX_DISCUSSION_QUERIES = 3;
export const MAX_SEARCH_RESULTS_PER_QUERY = 5;
export const MAX_UNIQUE_SEARCH_RESULTS = 10;
export const MAX_DISCUSSION_PAGE_FETCHES = 5;
export const MAX_DISCUSSION_ORIGINS = 4;

export const MAX_COMPANY_NAME_CHARS = 100;
export const MAX_ROLE_HINT_CHARS = 100;

// Deterministic relevance signals over title/snippet/URL tokens. A provider
// snippet is evidence, not verified page text; scoring never fabricates it.
export const DISCUSSION_PHRASE_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ['interview experience', 30],
  ['interview questions', 30],
  ['hiring process', 12],
  ['technical interview', 12],
];

export const DISCUSSION_POSITIVE_TERMS: ReadonlyArray<readonly [string, number]> = [
  ['interview', 12],
  ['interviews', 12],
  ['onsite', 8],
  ['screening', 8],
  ['recruiter', 6],
  ['coding', 6],
  ['assessment', 6],
  ['leetcode', 5],
  ['round', 4],
  ['rounds', 4],
];

export const DISCUSSION_NEGATIVE_TERMS: ReadonlyArray<readonly [string, number]> = [
  ['salary', 15],
  ['salaries', 15],
  ['stock', 10],
  ['pricing', 8],
  ['features', 8],
  ['demo', 8],
];

export const DISCUSSION_HOMEPAGE_PATH_PENALTY = 12;
export const DISCUSSION_ROLE_TOKEN_WEIGHT = 8;
