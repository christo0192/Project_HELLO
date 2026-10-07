/**
 * PR-L: stable server code returned with HTTP 410 by every retired legacy
 * browser screening entry point (start, invite, preflight, exchange, and the
 * Ashby manual invite). See app/api/src/lib/legacy-browser-screening.ts.
 */
export const BROWSER_SCREENING_RETIRED = 'browser_screening_retired';

/**
 * True for the 410 `browser_screening_retired` answer. Never throws. Matches on
 * the error's shape (status / message) rather than `instanceof ApiError`, so it
 * holds for an ApiError from any module instance, including a test double.
 */
export function isBrowserScreeningRetired(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, message } = error as { status?: unknown; message?: unknown };
  return status === 410 || message === BROWSER_SCREENING_RETIRED;
}

/** What a candidate holding a legacy link sees. Names no internal detail. */
export const RETIRED_LINK_CANDIDATE_MESSAGE =
  'This screening link is no longer active. ' +
  'Please contact your recruiter, who can send you a new one.';

/** What a recruiter sees when an invite action reaches the retired lane. */
export const RETIRED_INVITE_RECRUITER_MESSAGE =
  'Browser voice screening has been retired, so no invite link can be issued.';
