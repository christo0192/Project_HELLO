// The same module the component imports it from, so `instanceof` agrees with it.
import { ApiError } from '../api';
import {
  isBrowserScreeningRetired,
  RETIRED_LINK_CANDIDATE_MESSAGE,
} from './browser-screening-retired';

/** Candidate-facing copy for a failed audio readiness test. */
export function messageFor(error: unknown): string {
  // PR-L: the legacy lane is retired; a retry cannot help.
  if (isBrowserScreeningRetired(error)) return RETIRED_LINK_CANDIDATE_MESSAGE;
  if (error instanceof ApiError && error.message === 'consent_required') {
    return 'Your consent is no longer valid. Please return and review it again.';
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission is blocked. Allow microphone access in your browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No usable microphone was found. Connect a microphone and try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Your microphone could not be started. Close other apps using it and try again.';
  }
  if (error instanceof ApiError && error.message === 'screening_room_unavailable') {
    return 'The connection test is unavailable right now. Your invite is still valid; please retry.';
  }
  return 'Your connection did not meet the minimum requirements. Check your microphone and internet, then retry.';
}
