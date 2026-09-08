import { load } from 'cheerio';
import {
  CRAWL_ACTION_PATH_PATTERN,
  CRAWL_STATIC_ASSET_PATTERN,
  CRAWL_TRACKING_PARAMS,
  MAX_ANCHOR_CHARS,
} from '@/modules/research/crawl/crawl.constants';

export type RawDiscoveredLink = {
  url: string;
  anchorText: string;
};

// Cheerio anchor parsing: discover links and canonicalize them for the crawl
// queue. Returns every raw anchor (including repeated URLs): the crawler
// groups by normalized URL and keeps the best deterministic signal.
export class LinkDiscoveryService {
  discoverLinks(html: string, pageUrl: string): RawDiscoveredLink[] {
    const $ = load(html);
    const links: RawDiscoveredLink[] = [];

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href')?.trim() ?? '';

      if (!href) {
        return;
      }

      const anchorText = $(element).text().replace(/\s+/g, ' ').trim().slice(0, MAX_ANCHOR_CHARS);
      const url = this.normalizeCrawlUrl(href, pageUrl);

      if (!url) {
        return;
      }

      links.push({ url, anchorText });
    });

    return links;
  }

  // Canonical queue form, or null when the href must not be enqueued.
  // Rejects non-page schemes, fragment-only navigation, static assets, and
  // obvious non-content actions. Extension filtering is a queue optimization;
  // the retrieval content-type policy stays authoritative.
  normalizeCrawlUrl(href: string, baseUrl: string): string | null {
    const trimmed = href.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      return null;
    }

    let parsed: URL;

    try {
      parsed = new URL(trimmed, baseUrl);
    } catch {
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    parsed.hash = '';

    if (CRAWL_STATIC_ASSET_PATTERN.test(parsed.pathname)) {
      return null;
    }

    if (CRAWL_ACTION_PATH_PATTERN.test(parsed.pathname)) {
      return null;
    }

    for (const key of [...parsed.searchParams.keys()]) {
      if (CRAWL_TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    return parsed.toString();
  }
}
