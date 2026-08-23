/**
 * Turning a phone-API refusal into a sentence an operator can act on.
 *
 * ── THE ERROR BODY IS ALREADY SAFE, AND STILL NOT SHOWABLE ────────────
 * The phone surface answers with a stable snake_case code and never a driver
 * message, a constraint name or a row value — so there is no leak risk in the
 * string itself. But `version_conflict` is not English, and an operator
 * cannot tell from it what to do next. Every code this UI can provoke is
 * mapped here to what happened and what to do about it.
 *
 * An UNMAPPED code falls back to a generic sentence and does NOT print the
 * raw code into the page. That is deliberate on a surface whose whole premise
 * is that provider and contact identifiers must never reach the DOM: the
 * mapped set is an allowlist, so a future substrate error that happens to
 * carry something richer than a bare code cannot be rendered by default.
 *
 * ── 429 IS NOT A HEALTH SIGNAL ────────────────────────────────────────
 * The phone routes sit on the default per-user rate-limit bucket precisely so
 * that an operator polling the calendar cannot throttle themselves into
 * looking like an outage. A 429 therefore renders as "you are going too fast,
 * retry shortly" and must never be reported as degraded service — that would
 * turn a client-side pacing issue into a false incident.
 */

import { ApiError } from '../../api';

const CODE_MESSAGES: Record<string, string> = {
  // ── Feature state ──
  phone_screening_disabled:
    'Phone screening is turned off, so this change was not made.',

  // ── Optimistic concurrency and liveness ──
  // Deliberately does NOT say "nothing was changed". On the reschedule path
  // the API reports `appointment_rolled_back`, and when that is false a stray
  // appointment WAS inserted and could not be undone (routes/phone.ts, the
  // PATCH lost-update compensation). The shared client keeps only the error
  // code, so this copy cannot distinguish the two cases — and the safe copy
  // is the one that is true in both.
  version_conflict:
    'This appointment changed since the calendar was loaded, so your change was refused. The calendar has been refreshed — check the current times before trying again.',
  not_live:
    'This appointment is no longer live — it has already been cancelled, superseded, fulfilled or missed. The calendar has been refreshed.',
  not_found: 'This appointment or engagement no longer exists.',
  appointment_exists:
    'This engagement already has a live appointment. Reschedule the existing one instead of booking a second.',

  // ── Slot rules, all decided by the substrate under a row lock ──
  slot_in_past: 'That slot is in the past. Pick a later one.',
  window_closed:
    'That time is outside the approved calling window, so it was refused.',
  slot_duration_invalid:
    'That slot is not a permitted length, so it was refused.',
  slot_straddles_ist_midnight:
    'A call cannot cross midnight IST. Pick a slot inside one calendar day.',
  invalid_slot: 'That slot was refused as invalid.',

  // ── Engagement state ──
  engagement_terminal:
    'This engagement has reached a final state and can no longer be scheduled.',
  attempt_in_flight:
    'A call attempt is in progress for this engagement, so it cannot be changed right now.',
  invalid_reason: 'That cancellation reason was refused.',
  invalid_source: 'That booking source was refused.',

  // ── Server-side failures ──
  phone_read_error:
    'The calendar could not be read. Nothing is known to be wrong with the schedule itself — try again.',
  phone_action_error: 'The change could not be completed. Try again.',
  phone_rpc_unknown_status:
    'The system did not get a clear answer about whether this change was applied. Refresh the calendar and check before retrying.',
  // NOT "so it was not applied". `auditOrFail` only undoes the mutation when
  // a compensation is supplied, and none of the three appointment routes
  // supplies one — POST /halt/clear is the only route that does. So on this
  // path the appointment really was created, superseded or cancelled, and
  // only the audit record is missing. Telling the operator it did not happen
  // would send them to book it a second time.
  phone_audit_write_failed:
    'The change may have been applied, but it could not be recorded in the audit log. The calendar has been refreshed — check whether it took effect before trying again.',
};

/** Codes after which the caller must re-read the calendar before acting again. */
const REFRESH_REQUIRED = new Set([
  'version_conflict',
  'not_live',
  'not_found',
  'appointment_exists',
  'phone_rpc_unknown_status',
  // The mutation may have committed with only its audit record missing, so
  // the loaded calendar can no longer be trusted.
  'phone_audit_write_failed',
  // Both of these are proof the loaded `engagement_state` disagrees with the
  // substrate: the UI HIDES the write controls when it believes an
  // engagement is in flight or terminal, so being refused for either reason
  // means the row on screen is stale.
  'attempt_in_flight',
  'engagement_terminal',
]);

const GENERIC =
  'The request was refused. Refresh the calendar and try again; if it keeps happening, contact an administrator.';

/**
 * Operator-facing copy for a failure.
 *
 * A 401 never reaches here as page copy — the client dispatches the
 * unauthorized event and the auth provider clears the session — and a 403 is
 * phrased as a permission fact rather than an error, because for an
 * interviewer it is the expected answer, not a fault.
 */
export function phoneErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return GENERIC;

  if (error.status === 429) {
    return 'Too many requests in a short time. Wait a moment and try again — this is a pacing limit on your account, not a problem with phone screening.';
  }
  if (error.status === 403) {
    return 'Your role does not allow this change. Reads stay available.';
  }
  if (error.status === 0) {
    return 'The server could not be reached. Check your connection and try again.';
  }

  // `Object.hasOwn`, not a bare index: a server code of `constructor` or
  // `toString` would otherwise resolve to an inherited Function typed as a
  // string, which React refuses to render.
  return Object.hasOwn(CODE_MESSAGES, error.message)
    ? CODE_MESSAGES[error.message]
    : GENERIC;
}

/** True when the calendar must be re-read before the operator acts again. */
export function phoneErrorRequiresRefresh(error: unknown): boolean {
  return error instanceof ApiError && REFRESH_REQUIRED.has(error.message);
}

/**
 * True for the one refusal that means "your view is stale", which the page
 * announces differently: it is not a failure the operator caused, and the
 * remedy (re-read, re-check, retry) is already done for them.
 */
export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.message === 'version_conflict';
}
