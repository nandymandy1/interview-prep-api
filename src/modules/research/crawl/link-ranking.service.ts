import {
  CRAWL_ANCHOR_WEIGHT,
  CRAWL_HIGH_TERMS,
  CRAWL_HIGH_WEIGHT,
  CRAWL_MEDIUM_TERMS,
  CRAWL_MEDIUM_WEIGHT,
  CRAWL_NEGATIVE_TERMS,
  CRAWL_NEGATIVE_WEIGHT,
  CRAWL_PATH_WEIGHT,
  CRAWL_VERY_HIGH_PHRASES,
  CRAWL_VERY_HIGH_TERMS,
  CRAWL_VERY_HIGH_WEIGHT,
} from '@/modules/research/crawl/crawl.constants';

export type LinkScore = {
  score: number;
  signals: string[];
};

const tokenize = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0),
  );

// Deterministic relevance score from discovered signals only: anchor text
// counts double versus URL path tokens, so `<a href="/foo">Careers</a>` ranks
// highly despite the opaque pathname. No requests, no LLM, no guessing.
export class LinkRankingService {
  scoreLink(url: string, anchorText: string): LinkScore {
    const anchorTokens = tokenize(anchorText);
    const collapsedAnchor = anchorText
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const pathTokens = this.pathTokens(url);
    let score = 0;
    const signals: string[] = [];

    for (const phrase of CRAWL_VERY_HIGH_PHRASES) {
      if (collapsedAnchor.includes(phrase)) {
        score += CRAWL_VERY_HIGH_WEIGHT * CRAWL_ANCHOR_WEIGHT;
        signals.push(`anchor-phrase:${phrase}`);
      }
    }

    const termSets = [
      { terms: CRAWL_VERY_HIGH_TERMS, weight: CRAWL_VERY_HIGH_WEIGHT },
      { terms: CRAWL_HIGH_TERMS, weight: CRAWL_HIGH_WEIGHT },
      { terms: CRAWL_MEDIUM_TERMS, weight: CRAWL_MEDIUM_WEIGHT },
      { terms: CRAWL_NEGATIVE_TERMS, weight: CRAWL_NEGATIVE_WEIGHT },
    ];

    for (const { terms, weight } of termSets) {
      for (const term of terms) {
        if (anchorTokens.has(term)) {
          score += weight * CRAWL_ANCHOR_WEIGHT;
          signals.push(`anchor:${term}`);
        }

        if (pathTokens.has(term)) {
          score += weight * CRAWL_PATH_WEIGHT;
          signals.push(`path:${term}`);
        }
      }
    }

    return { score, signals };
  }

  private pathTokens(url: string): Set<string> {
    try {
      return tokenize(new URL(url).pathname);
    } catch {
      return new Set();
    }
  }
}
