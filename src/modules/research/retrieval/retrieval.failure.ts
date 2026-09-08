import type { RetrievalException } from '@/modules/research/retrieval/retrieval.exception';
import type {
  RetrievalFailure,
  RetrievalFailureCode,
  RetrievalResult,
} from '@/modules/research/retrieval/retrieval.type';

const SAFE_MESSAGES: Record<RetrievalFailureCode, string> = {
  INVALID_URL: 'The provided URL is invalid.',
  UNSUPPORTED_PROTOCOL: 'Only http(s) URLs can be retrieved.',
  BLOCKED_ADDRESS: 'The URL resolves to a blocked address.',
  DNS_RESOLUTION_FAILED: 'The URL hostname could not be resolved.',
  TIMEOUT: 'The request timed out.',
  TOO_MANY_REDIRECTS: 'The URL redirected too many times.',
  UNSUPPORTED_CONTENT_TYPE: 'The response content type is not supported.',
  RESPONSE_TOO_LARGE: 'The response exceeded the maximum allowed size.',
  HTTP_ERROR: 'The remote server returned an error.',
  NETWORK_ERROR: 'A network error occurred while retrieving the URL.',
  RATE_LIMITED: 'The remote server rate-limited the request.',
};

export const toRetrievalFailure = (error: RetrievalException): RetrievalFailure => ({
  code: error.code,
  url: error.url,
  ...(error.status !== undefined ? { status: error.status } : {}),
  message: SAFE_MESSAGES[error.code],
});

export const toRetrievalResult = (error: RetrievalException): RetrievalResult => ({
  ok: false,
  failure: toRetrievalFailure(error),
});
