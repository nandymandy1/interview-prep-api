export type RetrievalMode = 'production' | 'evaluation';

export type RetrievalRequest = {
  url: string;
  mode: RetrievalMode;
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
