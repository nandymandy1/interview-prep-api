// Fetched company content is UNTRUSTED EXTERNAL DATA: pages may contain
// prompt-injection text ("ignore previous instructions", fake system
// messages). P2.3 removes executable/hidden markup and normalizes visible
// text, but cannot identify every injection. P3 must wrap this content as
// data and keep system/developer instructions structurally separate.
// "Prompt injection fully solved" is NOT claimed.
export type ExternalContentTrust = 'external-untrusted';

export type ExtractedPageContent = {
  title: string | null;
  description: string | null;
  headings: string[];
  text: string;
  textChars: number;
  truncated: boolean;
  contentEmpty: boolean;
  contentHash: string;
  trust: ExternalContentTrust;
};

export type ExtractPageInput = {
  body: string;
  contentType: string;
};
