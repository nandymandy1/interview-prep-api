import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_EXTRACTED_TEXT_CHARS,
  MAX_HEADING_CHARS,
  MAX_HEADINGS,
  MAX_TITLE_CHARS,
} from '@/modules/research/extraction/extraction.constants';
import type { ExtractedPageContent } from '@/modules/research/extraction/extraction.type';
import { isHtmlContentType } from '@/modules/research/retrieval/retrieval.constants';

const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dt, dd';

// Chrome stripped before usefulness is judged: a <main> holding only
// navigation/scripts must not shadow an <article> with real text.
const CHROME_SELECTOR =
  'script, style, noscript, template, svg, canvas, iframe, form, nav, footer, aside, [hidden], [aria-hidden="true"]';

// Static retrieved HTML only: no JavaScript execution, no browser, no SPA
// rendering. Converts one bounded page into research-ready text.
export class PageExtractionService {
  extract(input: { body: string; contentType: string }): ExtractedPageContent {
    if (!isHtmlContentType(input.contentType)) {
      return this.fromPlainText(input.body);
    }

    const $ = load(input.body);

    const title = this.boundText(
      $('title').first().text() || $('meta[property="og:title"]').attr('content') || '',
      MAX_TITLE_CHARS,
    );
    const description = this.boundText(
      $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        '',
      MAX_DESCRIPTION_CHARS,
    );

    const root = this.contentRoot($);
    root.find(CHROME_SELECTOR).remove();

    const headings: string[] = [];

    root.find('h1, h2, h3').each((_, element) => {
      if (headings.length >= MAX_HEADINGS) {
        return;
      }

      const heading = this.normalize($(element).text());

      if (heading) {
        const bounded = this.boundText(heading, MAX_HEADING_CHARS);

        if (bounded) {
          headings.push(bounded);
        }
      }
    });

    const lines: string[] = [];

    root.find(BLOCK_SELECTOR).each((_, element) => {
      const line = this.normalize($(element).text());

      if (line && line !== lines[lines.length - 1]) {
        lines.push(line);
      }
    });

    if (lines.length === 0) {
      const fallback = this.normalize(root.text());

      if (fallback) {
        lines.push(fallback);
      }
    }

    const { text, truncated } = truncateText(lines.join('\n'), MAX_EXTRACTED_TEXT_CHARS);

    return this.buildContent({ title, description, headings, text, truncated });
  }

  private fromPlainText(body: string): ExtractedPageContent {
    const lines = body
      .split('\n')
      .map((line) => this.normalize(line))
      .filter((line) => line.length > 0);
    const { text, truncated } = truncateText(lines.join('\n'), MAX_EXTRACTED_TEXT_CHARS);

    return this.buildContent({ title: null, description: null, headings: [], text, truncated });
  }

  private buildContent(input: {
    title: string | null;
    description: string | null;
    headings: string[];
    text: string;
    truncated: boolean;
  }): ExtractedPageContent {
    return {
      title: input.title,
      description: input.description,
      headings: input.headings,
      text: input.text,
      textChars: input.text.length,
      truncated: input.truncated,
      contentEmpty: input.text.length === 0,
      contentHash: createHash('sha256').update(input.text, 'utf8').digest('hex'),
      trust: 'external-untrusted',
    };
  }

  private contentRoot($: ReturnType<typeof load>) {
    // header is deliberately kept: page H1/title content may live there.
    // Usefulness is judged after chrome removal, so a main holding only
    // navigation/scripts falls back to the next candidate with real text.
    const candidates = ['main', 'article', '[role="main"]', 'body'];

    for (const selector of candidates) {
      const root = $(selector).first();

      if (root.length === 0) {
        continue;
      }

      if (selector === 'body') {
        return root;
      }

      const cleaned = root.clone();
      cleaned.find(CHROME_SELECTOR).remove();

      if (this.normalize(cleaned.text())) {
        return root;
      }
    }

    return $('body');
  }

  private normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private boundText(value: string, max: number): string | null {
    const normalized = this.normalize(value);

    if (!normalized) {
      return null;
    }

    return truncateText(normalized, max).text;
  }
}

// Truncates near a whitespace/newline boundary without splitting UTF-16
// surrogate pairs. Reports whether shortening happened.
export const truncateText = (text: string, max: number): { text: string; truncated: boolean } => {
  if (text.length <= max) {
    return { text, truncated: false };
  }

  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);

  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }

  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));

  if (boundary > max / 2) {
    cut = cut.slice(0, boundary);
  }

  return { text: cut, truncated: true };
};
