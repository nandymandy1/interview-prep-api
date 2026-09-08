export type RetrievalMode = 'production' | 'evaluation';

// Caller redirect policy: invoked after the redirect target passes shape and
// DNS/address validation but BEFORE the next request is performed. May throw
// RedirectBlockedError to abort the redirect; the rejection propagates to the
// retrieve() caller instead of becoming a RetrievalResult.
export type RedirectGuard = (next: URL, from: URL) => Promise<void>;

export type RedirectBlockReason = 'ROBOTS_DISALLOWED' | 'OUT_OF_SCOPE';

export type RetrievalRequest = {
  url: string;
  mode: RetrievalMode;
  onBeforeRedirect?: RedirectGuard;
};

export type RetrievedResource = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
};

export type RetrievalFailureCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROTOCOL'
  | 'BLOCKED_ADDRESS'
  | 'DNS_RESOLUTION_FAILED'
  | 'TIMEOUT'
  | 'TOO_MANY_REDIRECTS'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'RESPONSE_TOO_LARGE'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED';

export type RetrievalFailure = {
  code: RetrievalFailureCode;
  url: string;
  status?: number;
  message: string;
};

export type RetrievalResult =
  | {
      ok: true;
      resource: RetrievedResource;
    }
  | {
      ok: false;
      failure: RetrievalFailure;
    };
