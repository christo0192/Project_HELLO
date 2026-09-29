/**
 * The global operator halt, as plain data: what the phone kill switch is
 * doing, what an admin may do about it from Mission Control, and what to say
 * when a request fails. The component (`OperatorHaltControl`) only renders
 * what this file decides, so every rule here is testable without a DOM.
 *
 * ── ONE HALT IS OURS, FOUR ARE NOT ────────────────────────────────────
 * 0042 allows five halt reasons. Mission Control raises exactly one of them,
 * `operator_pause`, and offers to lift only that one. A legal hold, an
 * emergency stop, a provider incident or a cost-control stop was raised for a
 * reason a button cannot judge, so for those this control shows the state
 * and points at the runbook instead of offering "Resume".
 *
 * ── UNKNOWN IS NEVER RED OR GREEN ─────────────────────────────────────
 * A failed read, a disabled phone lane, a null `admission` block and a
 * missing control row all become `unavailable`. The API itself reads a
 * missing control row as HALTED (fail closed), so presenting any of these as
 * "live" would be false, and presenting them as a resumable pause would
 * invite an admin to "resume" a stop nobody can describe.
 */

import { ApiError } from '../../api';
import type { PhoneHaltReason, PhoneHealthResponse } from '../../types';

/** The only halt this control raises, and the only one it will lift. */
export const OPERATOR_PAUSE: PhoneHaltReason = 'operator_pause';

/** Operator English for every 0042 halt reason, used after "Calling halted — ". */
export const HALT_REASON_LABELS: Record<PhoneHaltReason, string> = {
  operator_pause: 'operator pause',
  provider_incident: 'provider incident',
  cost_control: 'cost control',
  legal_hold: 'legal hold',
  emergency_stop: 'emergency stop',
};

/**
 * `halt_reason` is a plain string on the wire. `Object.hasOwn`, not a bare
 * index, so a value like `constructor` cannot resolve to an inherited
 * function. The CHECK constraint makes an unknown reason practically
 * impossible; if one ever arrives it is described as unrecognised rather than
 * guessed at.
 */
export function haltReasonLabel(reason: string | null): string {
  if (reason !== null && Object.hasOwn(HALT_REASON_LABELS, reason)) {
    return HALT_REASON_LABELS[reason as PhoneHaltReason];
  }
  return 'unrecognised reason';
}

export type HaltView =
  /** Not halted: the red "Halt all calling" button. */
  | { kind: 'live' }
  /** Halted by an operator pause: the green "Resume calling" button. */
  | { kind: 'paused' }
  /** Halted for any other reason: status only, cleared by runbook. */
  | { kind: 'locked'; reason: string | null }
  /** The switch could not be described. Neither colour; a Retry. */
  | { kind: 'unavailable'; detail: string };

const SWITCH_UNREADABLE = 'The halt switch could not be read.';

/** Decide the view from one health read. Strict on every field it trusts. */
export function haltViewFrom(health: PhoneHealthResponse): HaltView {
  const admission = health.admission;
  if (!admission) {
    return {
      kind: 'unavailable',
      detail: health.enabled === false ? 'Phone screening is turned off.' : SWITCH_UNREADABLE,
    };
  }
  // A missing control row is reported halted by the API — and is not a halt
  // anyone can clear (`/halt/clear` answers 503 `halt_unreadable`).
  if (admission.control_present !== true) {
    return { kind: 'unavailable', detail: SWITCH_UNREADABLE };
  }
  if (admission.halted === false) return { kind: 'live' };
  if (admission.halted === true) {
    return admission.halt_reason === OPERATOR_PAUSE
      ? { kind: 'paused' }
      : { kind: 'locked', reason: admission.halt_reason };
  }
  return { kind: 'unavailable', detail: SWITCH_UNREADABLE };
}

/** Why a READ of the switch failed, as the line under "Calling status unavailable". */
export function readFailureDetail(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many requests in a short time. Wait a moment, then retry.';
    if (error.status === 403) return 'Your role cannot read the calling status.';
    if (error.status === 0) return 'The server could not be reached.';
  }
  return 'The calling status could not be read.';
}

export type HaltAction = 'halt' | 'resume';

/** Every failed write is followed by a re-read, so the copy can point at it. */
const CHECK_STATUS = 'Check the status shown here before trying again.';

/**
 * Copy for a failed halt or resume. Never the raw code: the API answers with
 * stable snake_case codes, which are not English. Unmapped codes fall back to
 * a plain sentence for the action that failed.
 */
export function haltFailureMessage(error: unknown, action: HaltAction): string {
  const fallback =
    action === 'halt'
      ? `Calling could not be halted. ${CHECK_STATUS}`
      : `Calling could not be resumed. ${CHECK_STATUS}`;
  if (!(error instanceof ApiError)) return fallback;

  if (error.status === 429) {
    return 'Too many requests in a short time. Wait a moment and try again.';
  }
  if (error.status === 403) return 'Your role does not allow changing the calling status.';
  if (error.status === 0) {
    return `The server could not be reached, so the change may not have been sent. ${CHECK_STATUS}`;
  }

  const code = error.message;
  // `POST /halt` answers 409 only for `invalid_reason` — vocabulary drift, not
  // a race. Calling it "changed elsewhere" would send the admin looking for a
  // colleague who does not exist.
  if (code === 'invalid_reason') {
    return 'The server refused this halt reason, so nothing was changed. Report this to the engineering team.';
  }
  if (isHaltConflict(error)) {
    return `The calling status was changed elsewhere, so your change was not applied. ${CHECK_STATUS}`;
  }
  switch (code) {
    case 'phone_screening_disabled':
      return 'Phone screening is turned off, so calling cannot be halted or resumed from here.';
    case 'halt_state_unavailable':
    case 'halt_unreadable':
      return 'The halt switch could not be read, so calling was not resumed. Try again shortly.';
    // `POST /halt` does NOT undo a halt whose audit row failed (routes/phone.ts,
    // `auditOrFail`): the stop stays in force. `/halt/clear` re-raises the halt
    // it lifted. Either way the outcome must be checked, not assumed.
    case 'phone_audit_write_failed':
      return action === 'halt'
        ? `Calling may have been halted, but the change could not be recorded in the audit log. ${CHECK_STATUS}`
        : `The change could not be recorded in the audit log, so the server tried to put the halt back. ${CHECK_STATUS}`;
    case 'phone_rpc_unknown_status':
      return `The system did not get a clear answer about whether the change was applied. ${CHECK_STATUS}`;
    case 'phone_action_error':
      return `The change could not be completed. ${CHECK_STATUS}`;
    default:
      return fallback;
  }
}

/**
 * The switch moved under the admin: `halt_reason_mismatch`, or any other 409
 * refusal. Not `invalid_reason`, which is a request the server will never
 * accept rather than a state that changed.
 */
export function isHaltConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.message !== 'invalid_reason'
  );
}
