// The only intentionally constructed well-known path in the crawler.
// Company content URLs still come exclusively from the seed or discoveries.
export const ROBOTS_PATH = '/robots.txt';

// Product token used for robots group matching. The HTTP User-Agent remains
// InterviewPrepResearchBot/1.0; the token is what the parser matches.
export const ROBOTS_USER_AGENT_TOKEN = 'InterviewPrepResearchBot';

// Bounds robots infrastructure requests: at most one fetch per origin, and
// never more origins than this per company crawl.
export const MAX_CRAWL_ORIGINS = 3;
