/**
 * Ashby vocabulary shared by every surface that shows an Ashby operation:
 * Ashby Mission Control's workflow rows and the candidate page's Ashby
 * pipeline card say a failure the same way. `humanizeEnum` covers a code
 * that is not listed here.
 */

/** A failed Ashby operation's sanitized error code, in words. */
export const ASHBY_ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  provider_5xx: 'Ashby server error',
  provider_4xx: 'Ashby refused the request',
  rate_limited: 'Ashby rate limit',
  provider_timeout: 'Ashby timed out',
  timeout: 'Timed out',
  // C3 (0114): the worker refused to write a scorecard whose interview
  // evidence was insufficient. Non-retryable by design.
  evidence_insufficient: 'Held: not enough interview evidence',
};
