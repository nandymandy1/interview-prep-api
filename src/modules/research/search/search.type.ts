export type PublicSearchQuery = {
  query: string;
  limit: number;
};

export type PublicSearchResult = {
  title: string;
  url: string;
  snippet: string | null;
  rank: number;
};

export type SearchProviderFailureCode =
  'RATE_LIMITED' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'INVALID_RESPONSE';

// Exactly one concrete provider implements this contract. Vendor-specific
// response shapes never cross this boundary.
export type PublicSearchProvider = {
  search(input: PublicSearchQuery): Promise<PublicSearchResult[]>;
};
