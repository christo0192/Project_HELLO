/**
 * C8 (migration 0114): pure helpers for the same-role duplicate-application
 * hold. One person can sit on several candidate rows (Ashby creates one row
 * per application). When another row of the same person already has a live or
 * completed screen for the SAME role, the phone engagement is held in
 * `pending_prereqs` with `state_reason = 'duplicate_application'` and is never
 * dialled until a recruiter releases it. The other row is never named here.
 */

/** The stable code the API answers (409 error) and the state reason it stores. */
export const DUPLICATE_APPLICATION = 'duplicate_application';

/** The minimal cycle shape the hold check reads. */
export interface DuplicateHoldCycle {
  state: string;
  state_reason: string | null;
  terminal_at: string | null;
}

/** True when this (current) cycle is held as a same-role duplicate application. */
export function isDuplicateApplicationHold(cycle: DuplicateHoldCycle | null | undefined): boolean {
  return (
    cycle != null
    && cycle.terminal_at === null
    && cycle.state === 'pending_prereqs'
    && cycle.state_reason === DUPLICATE_APPLICATION
  );
}

/** The banner text on the phone card. Recruiter language; never PII. */
export const DUPLICATE_HOLD_NOTICE =
  'This person already has a phone screen for this role on another candidate record, so this one will not be called. '
  + 'Release the hold only if this is a genuinely separate application that should be screened again.';

/**
 * Copy for the error codes the request, booking and release routes answer for
 * a duplicate hold. Returns null for any other code so the caller keeps its
 * own message.
 */
export function duplicateHoldErrorMessage(code: string): string | null {
  switch (code) {
    case DUPLICATE_APPLICATION:
      return 'Not requested: this person already has a phone screen for this role on another candidate record. Release the hold first if this application should be screened.';
    case 'phone_hold_not_held':
      return 'There is no duplicate-application hold to release; it may already have been released.';
    case 'phone_hold_ambiguous':
      return 'More than one held screening was found for this candidate, so nothing was released. Ask an administrator to review.';
    case 'phone_hold_not_found':
      return 'The held screening could not be found. Refresh and try again.';
    case 'phone_release_unavailable':
      return 'The hold could not be released right now. Try again shortly.';
    case 'actor_required':
      return 'Your account could not be identified, so the hold was not released. Sign in again and retry.';
    default:
      return null;
  }
}
