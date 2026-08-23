/**
 * Closed vocabularies of the phone calendar, turned into operator English.
 *
 * ── COLOUR IS NEVER THE SIGNAL ────────────────────────────────────────
 * Every status in this file has a TEXT label, and the badge that renders it
 * shows that text. The tone only ever reinforces a word that is already
 * there. Nothing in this surface is distinguishable by hue alone, so it
 * survives greyscale, colour-blindness and a stylesheet that failed to load
 * (WCAG 1.4.1).
 *
 * ── UNKNOWN IS NOT A DEFAULT ──────────────────────────────────────────
 * The maps below are exhaustive over the API's closed vocabularies, and the
 * lookup helpers fall back to the raw code rather than to a friendly guess.
 * If the substrate gains a state this UI has not been taught, an operator
 * sees the unfamiliar code — which is true and prompts a question — instead
 * of a confident label naming the wrong thing.
 */

import type { StatusTone } from '../design';
import type {
  PhoneAppointmentStatus,
  PhoneCalendarAppointment,
  PhoneEngagementState,
  PhoneOperatorCancelReason,
  PhoneSlotRefusal,
} from '../../types';
import { formatIstLongDayLabel, formatIstTimeRange, istDateOf } from '../../lib/ist-datetime';

interface Term {
  label: string;
  tone: StatusTone;
}

const APPOINTMENT_STATUS_TERMS: Record<PhoneAppointmentStatus, Term> = {
  scheduled: { label: 'Scheduled', tone: 'info' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  superseded: { label: 'Superseded', tone: 'neutral' },
  fulfilled: { label: 'Fulfilled', tone: 'success' },
  missed: { label: 'Missed', tone: 'danger' },
};

/**
 * Engagement states. `dialing`, `in_call` and `reconnecting` are toned as
 * warnings not because anything is wrong but because they mean a call is
 * LIVE — an operator about to reschedule or cancel needs that to catch the
 * eye, and the substrate refuses the write anyway (`attempt_in_flight`).
 */
const ENGAGEMENT_STATE_TERMS: Record<PhoneEngagementState, Term> = {
  pending_prereqs: { label: 'Prerequisites pending', tone: 'warning' },
  eligible: { label: 'Eligible', tone: 'info' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  dialing: { label: 'Dialing', tone: 'warning' },
  in_call: { label: 'In call', tone: 'warning' },
  reconnecting: { label: 'Reconnecting', tone: 'warning' },
  awaiting_retry: { label: 'Awaiting retry', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  abandoned_no_answer: { label: 'Abandoned — no answer', tone: 'danger' },
  opted_out: { label: 'Opted out', tone: 'neutral' },
  wrong_number: { label: 'Wrong number', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** The six terminal engagement states. 0042 makes their rows immutable. */
const TERMINAL_ENGAGEMENT_STATES: ReadonlySet<PhoneEngagementState> = new Set([
  'completed',
  'abandoned_no_answer',
  'opted_out',
  'wrong_number',
  'failed',
  'cancelled',
]);

/** States in which an attempt is in flight, so no write will be accepted. */
const IN_FLIGHT_ENGAGEMENT_STATES: ReadonlySet<PhoneEngagementState> = new Set([
  'dialing',
  'in_call',
  'reconnecting',
]);

/**
 * The two statuses that make an appointment LIVE. Only a live appointment can
 * be rescheduled or cancelled; every other status is already resolved and the
 * substrate answers `not_live`.
 */
const LIVE_APPOINTMENT_STATUSES: ReadonlySet<PhoneAppointmentStatus> = new Set([
  'scheduled',
  'confirmed',
]);

export function appointmentStatusTerm(status: string): Term {
  return (
    APPOINTMENT_STATUS_TERMS[status as PhoneAppointmentStatus] ?? {
      label: status,
      tone: 'neutral',
    }
  );
}

export function engagementStateTerm(state: string | null): Term {
  if (state === null) {
    // A torn read between the batched queries. Saying "unknown" is the only
    // honest answer; guessing a state would put a wrong word on a call.
    return { label: 'State unavailable', tone: 'neutral' };
  }
  return (
    ENGAGEMENT_STATE_TERMS[state as PhoneEngagementState] ?? {
      label: state,
      tone: 'neutral',
    }
  );
}

export function isTerminalEngagementState(state: string | null): boolean {
  return state !== null && TERMINAL_ENGAGEMENT_STATES.has(state as PhoneEngagementState);
}

export function isAttemptInFlight(state: string | null): boolean {
  return state !== null && IN_FLIGHT_ENGAGEMENT_STATES.has(state as PhoneEngagementState);
}

export function isLiveAppointment(status: string): boolean {
  return LIVE_APPOINTMENT_STATUSES.has(status as PhoneAppointmentStatus);
}

/** The operator cancel reasons, in the order they are offered. */
export const OPERATOR_CANCEL_REASONS: ReadonlyArray<{
  value: PhoneOperatorCancelReason;
  label: string;
}> = [
  { value: 'candidate_request', label: 'Candidate asked to cancel' },
  { value: 'hr_cancelled', label: 'HR cancelled' },
  { value: 'engagement_cancelled', label: 'Engagement cancelled' },
  { value: 'emergency_stop', label: 'Emergency stop' },
];

/**
 * Every cancel reason that can appear on a ROW, which is a wider vocabulary
 * than the one an operator may choose: `superseded` is written by the
 * scheduling RPC and `system_deferral_expired` by the expiry sweep. A row
 * carrying either would otherwise render a bare snake_case code on a surface
 * where every other vocabulary is mapped to English.
 */
const CANCEL_REASON_LABELS: Record<string, string> = {
  candidate_request: 'Candidate asked to cancel',
  hr_cancelled: 'HR cancelled',
  engagement_cancelled: 'Engagement cancelled',
  emergency_stop: 'Emergency stop',
  superseded: 'Superseded by a reschedule',
  system_deferral_expired: 'A system deferral expired',
};

/** Operator English for a stored cancel reason; the raw code if unknown. */
export function cancelReasonLabel(reason: string | null): string {
  if (!reason) return 'Not recorded';
  return Object.hasOwn(CANCEL_REASON_LABELS, reason)
    ? CANCEL_REASON_LABELS[reason]
    : reason;
}

const SLOT_REFUSAL_LABELS: Record<PhoneSlotRefusal, string> = {
  slot_in_past: 'In the past',
  at_projected_capacity: 'At projected capacity',
};

export function slotRefusalLabel(refusal: string): string {
  return SLOT_REFUSAL_LABELS[refusal as PhoneSlotRefusal] ?? refusal;
}

/**
 * How a candidate is referred to on this surface.
 *
 * The ATS reference leads because it is what an operator quotes to a
 * colleague, and the display name follows it when the row carries one. When
 * the API returns neither, this says so. It does NOT substitute the internal
 * candidate id: that id is an addressing token, not a reference an operator
 * can act on, and printing it would train people to quote opaque ids at each
 * other. The API itself refuses to invent a reference for a candidate that
 * never came from an ATS, and this mirrors that refusal.
 */
export function candidateReferenceText(
  candidate: PhoneCalendarAppointment['candidate'],
): string {
  if (!candidate) return 'Candidate unavailable';
  const { reference, name } = candidate;
  if (reference && name) return `${reference} — ${name}`;
  if (reference) return reference;
  if (name) return name;
  return 'Candidate reference unavailable';
}

/**
 * The accessible name of an appointment control.
 *
 * It carries, in this order: who the call is with, when it is in IST, what
 * the appointment's status is and what state the engagement is in. A screen
 * reader user moving through the week grid by keyboard hears a complete,
 * self-contained sentence at every stop — none of that information is
 * available to them from spatial position or colour, which is how a sighted
 * user gets it.
 *
 * The zone is spoken every time. "2:30" is ambiguous to an operator who has
 * a browser in another zone; "14:30 IST" is not.
 */
export function appointmentAccessibleName(appt: PhoneCalendarAppointment): string {
  const who = candidateReferenceText(appt.candidate);
  const date = istDateOf(appt.starts_at);
  // The DAY is part of the name, not just the time. Tabbing between these
  // controls puts most screen readers into focus mode, where the `<th
  // scope="col">` day header is not re-announced — so a name carrying only a
  // time would leave a keyboard user unable to tell Monday's 14:30 call from
  // Thursday's. It matters most in the queue's "outside this week" group,
  // where the visible date is decorative and hidden from assistive tech.
  const when = date
    ? `${formatIstLongDayLabel(date)}, ${formatIstTimeRange(appt.starts_at, appt.ends_at)}`
    : formatIstTimeRange(appt.starts_at, appt.ends_at);
  const status = appointmentStatusTerm(appt.status).label;
  const state = engagementStateTerm(appt.engagement_state).label;
  return `${who}, ${when}, appointment ${status.toLowerCase()}, engagement ${state.toLowerCase()}`;
}
