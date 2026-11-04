/**
 * Ashby vocabulary shared by every surface that shows an Ashby operation:
 * Ashby Mission Control's workflow rows and the candidate page's Ashby
 * pipeline card say a failure the same way. `humanizeEnum` covers a code
 * that is not listed here.
 */
import { humanizeEnum } from './humanize';

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
  // M027 (0134): the Christy verdict tag lane. None of these touches a scorecard.
  // Each says the cause only: the same code is shown while the operation waits
  // (Pending) and after its wait ran out (Failed), and the state beside it says
  // which. So none of them promises a retry.
  ashby_tag_permission_denied: 'Ashby API key lacks permission for tags',
  ashby_tag_not_found: 'Christy tag not found in Ashby',
  ashby_tag_ambiguous: 'More than one active Christy tag with this title in Ashby',
  ashby_tag_transient: 'Ashby was unavailable',
  ashby_tag_write_rejected: 'Ashby refused the tag change',
  ashby_tag_verdict_unreadable: 'Christy verdict could not be read',
  ashby_tag_contended: 'Christy tags changed during the update',
  candidate_id_missing: 'Ashby candidate id not found',
  recommendation_tag_sink_unavailable: 'Christy tag writer not configured',
  // The catch-all several lanes record for an error they did not expect. Neutral,
  // because it is not only the tag lane's.
  operation_error: 'Unexpected error',
};

/**
 * One error code in words. Some codes carry a sanitized suffix from Ashby
 * (`ashby_tag_write_rejected:<endpoint code>`), so a code with no label of its
 * own is looked up by the part before its first `:`. The exact code stays one
 * hover away (`title`) on every surface that shows this.
 */
export function ashbyErrorCodeLabel(code: string | null | undefined): string {
  if (!code) return '';
  const exact = ASHBY_ERROR_CODE_LABELS[code];
  if (exact) return exact;
  const colon = code.indexOf(':');
  const prefixed = colon > 0 ? ASHBY_ERROR_CODE_LABELS[code.slice(0, colon)] : undefined;
  return prefixed ?? humanizeEnum(code);
}
