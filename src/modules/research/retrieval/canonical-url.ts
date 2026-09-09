// One deterministic canonicalizer for company-URL identity: generation
// fingerprints and the research cache key share it, so the same company
// always maps to the same key. Throws on unparseable input; callers fall
// back to the trimmed raw URL.
export const canonicalCompanyUrl = (raw: string): string => {
  const url = new URL(raw.trim());

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  url.hash = '';

  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  url.searchParams.sort();

  return url.toString();
};
