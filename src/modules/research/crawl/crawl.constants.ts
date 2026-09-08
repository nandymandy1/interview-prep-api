export const MAX_CRAWL_PAGE_REQUESTS = 8;
export const MAX_CRAWL_DEPTH = 2;
export const CRAWL_CONCURRENCY = 2;
export const CRAWL_MIN_REQUEST_INTERVAL_MS = 200;
export const MAX_SITE_CRAWL_DURATION_MS = 30_000;
export const MAX_DISCOVERED_LINKS_PER_PAGE = 200;
export const MAX_CRAWL_CANDIDATES = 500;
export const MAX_ANCHOR_CHARS = 200;

// Stripped for queue deduplication only (crawl-queue optimization). Sites may
// legitimately route on other query params, which are preserved.
export const CRAWL_TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
]);

// Skipped from the crawl queue as obvious non-content. The retrieval client's
// content-type restriction remains the authoritative boundary.
export const CRAWL_STATIC_ASSET_PATTERN =
  /\.(?:jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|tar|gz|mp4|mp3|css|js|map|woff|woff2|ttf)(?:$|[?#])/i;

export const CRAWL_ACTION_PATH_PATTERN = /(?:logout|signout)/i;

// Deterministic ranking weights. Anchor matches count double: visible link
// text is at least as meaningful as URL path tokens.
export const CRAWL_ANCHOR_WEIGHT = 2;
export const CRAWL_PATH_WEIGHT = 1;

export const CRAWL_VERY_HIGH_TERMS: ReadonlySet<string> = new Set([
  'hiring',
  'careers',
  'career',
  'jobs',
  'job',
  'joinus',
  'recruiting',
  'recruitment',
  'interview',
]);

export const CRAWL_VERY_HIGH_WEIGHT = 50;

export const CRAWL_HIGH_TERMS: ReadonlySet<string> = new Set([
  'about',
  'company',
  'mission',
  'values',
  'culture',
  'team',
  'people',
]);

export const CRAWL_HIGH_WEIGHT = 25;

export const CRAWL_MEDIUM_TERMS: ReadonlySet<string> = new Set([
  'engineering',
  'technology',
  'tech',
  'developers',
  'blog',
  'handbook',
]);

export const CRAWL_MEDIUM_WEIGHT = 10;

export const CRAWL_NEGATIVE_TERMS: ReadonlySet<string> = new Set([
  'login',
  'signin',
  'signup',
  'privacy',
  'terms',
  'legal',
  'cookie',
  'cart',
  'checkout',
  'account',
]);

export const CRAWL_NEGATIVE_WEIGHT = -30;

export const CRAWL_VERY_HIGH_PHRASES: readonly string[] = [
  'join us',
  'hiring process',
  'work with us',
];
