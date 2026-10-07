/**
 * R1 (WebRTC sales role-play) presentation rules for the HR surfaces.
 *
 * Pure functions only: every word HR reads about an R1 round, an availability
 * state or an API refusal is decided here, so the components stay layout and
 * the rules stay testable. The API speaks in machine codes (`r1_paused`,
 * `retake_not_allowed`); this module is the one place they become sentences.
 *
 * Invariants worth knowing before editing:
 *  - A round is LIVE while it is `invited` or `in_progress`. The database
 *    allows only one live round per candidate, so the UI never offers Send
 *    beside one.
 *  - Send is not offered again once a candidate has USED an attempt: a round
 *    that COMPLETED, or one that EXPIRED or was CANCELLED with a counted
 *    attempt (a granted retake the candidate never took, or a call cancelled
 *    mid-way). Another round would hand the candidate two fresh attempts
 *    outside the "one retake, granted by HR" rule (plan D1), and the server
 *    does not stop it, so this is the only guard. Rounds that never counted an
 *    attempt (an unused link that expired or was cancelled) do not block.
 *  - A round action (reissue, cancel, retake) is offered only to an admin or
 *    the interviewer who created the round, because that is who the API lets
 *    act on it; anyone else would get a 403 for every click.
 *  - Availability is a hint. `ready` does not promise a send will succeed;
 *    the capacity RPC decides, and its refusals are mapped here too.
 */
import type {
  R1AvailabilityState,
  R1Recommendation,
  R1Round,
  R1RoundStatus,
  R1RuntimeStatus,
  R1Settings,
  R1SettingsPatch,
  R1UsageResponse,
} from './r1-types';

/** The link lifetime the API sets on send, reissue and retake (plan decision 9). */
export const R1_LINK_VALID_HOURS = 72;

/* ── Rounds ───────────────────────────────────────────────────────── */

export const R1_STATUS_LABEL: Readonly<Record<R1RoundStatus, string>> = {
  invited: 'Link sent',
  in_progress: 'In progress',
  completed: 'Completed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export type R1Tone = 'neutral' | 'accent' | 'positive' | 'caution' | 'negative';

export const R1_STATUS_TONE: Readonly<Record<R1RoundStatus, R1Tone>> = {
  invited: 'accent',
  in_progress: 'accent',
  completed: 'positive',
  expired: 'neutral',
  cancelled: 'neutral',
};

export function r1StatusLabel(status: string): string {
  return (R1_STATUS_LABEL as Readonly<Record<string, string>>)[status] ?? status;
}

export function r1StatusTone(status: string): R1Tone {
  return (R1_STATUS_TONE as Readonly<Record<string, R1Tone>>)[status] ?? 'neutral';
}

export const R1_RECOMMENDATION_LABEL: Readonly<Record<R1Recommendation, string>> = {
  advance: 'Advance',
  hold: 'Hold',
  reject: 'Reject',
};

export function isLiveRound(round: Pick<R1Round, 'status'>): boolean {
  return round.status === 'invited' || round.status === 'in_progress';
}

/** Reissue replaces the link, which only exists while nothing has started. */
export function canReissue(round: Pick<R1Round, 'status'>): boolean {
  return round.status === 'invited';
}

/** Cancelling is possible while the round is live; it releases the reserved minutes. */
export function canCancel(round: Pick<R1Round, 'status'>): boolean {
  return isLiveRound(round);
}

/**
 * The server grants a retake only for a completed round with exactly one
 * counted attempt and one left. Mirrors `r1_transition_round('grant-retake')`;
 * the server stays the authority and answers `retake_not_allowed` otherwise.
 */
export function canGrantRetake(
  round: Pick<R1Round, 'status' | 'attempts_allowed' | 'attempts_counted'>,
): boolean {
  return (
    round.status === 'completed' &&
    round.attempts_counted === 1 &&
    round.attempts_allowed > 1
  );
}

export type R1SendGate =
  | { kind: 'open' }
  | { kind: 'live'; round: R1Round }
  | { kind: 'completed'; round: R1Round }
  | { kind: 'attempt_used'; round: R1Round };

/**
 * What the Send control may do, given the candidate's rounds (newest first or
 * not). A live round wins; then a completed one; then a round that ended
 * without completing but did count an attempt.
 */
export function sendGate(rounds: readonly R1Round[]): R1SendGate {
  const live = rounds.find(isLiveRound);
  if (live) return { kind: 'live', round: live };
  const completed = rounds.find((round) => round.status === 'completed');
  if (completed) return { kind: 'completed', round: completed };
  const used = rounds.find((round) => round.attempts_counted > 0);
  if (used) return { kind: 'attempt_used', round: used };
  return { kind: 'open' };
}

/** Why Send is not offered, in words; null when it is (or a live round says it all). */
export function sendGateNotice(gate: R1SendGate): string | null {
  if (gate.kind === 'completed') {
    return (
      'This candidate has completed R1, so a new link cannot be sent. If a retake is owed, ' +
      'grant it from the round below.'
    );
  }
  if (gate.kind === 'attempt_used') {
    return (
      'This candidate has already used an R1 attempt, so a new link cannot be sent. A retake ' +
      'is granted once, from a completed round.'
    );
  }
  return null;
}

/**
 * Whether this person may act on this round. Mirrors the API's `roundAccess`:
 * an admin, or the interviewer who created the round. A viewer never.
 */
export function canActOnRound(
  round: Pick<R1Round, 'created_by'>,
  role: 'admin' | 'interviewer' | 'viewer',
  userId: string | null,
): boolean {
  if (role === 'admin') return true;
  return role === 'interviewer' && userId !== null && round.created_by === userId;
}

/** "Attempt 1 of 2" is wrong while none has started; say what is true. */
export function attemptsLabel(
  round: Pick<R1Round, 'attempts_allowed' | 'attempts_counted'>,
): string {
  const used = Math.max(0, round.attempts_counted);
  const allowed = Math.max(used, round.attempts_allowed);
  return `${used} of ${allowed} attempts used`;
}

/* ── Availability ─────────────────────────────────────────────────── */

export interface R1AvailabilityCopy {
  title: string;
  detail: string;
}

export const R1_AVAILABILITY_COPY: Readonly<
  Record<Exclude<R1AvailabilityState, 'ready'>, R1AvailabilityCopy>
> = {
  not_deployed: {
    title: 'R1 is not live on this server yet',
    detail:
      'The server is not running R1, so no R1 links can be sent. This is a deployment ' +
      'setting; R1 settings cannot change it.',
  },
  disabled: {
    title: 'R1 is switched off',
    detail: 'No new R1 links can be sent. An admin can switch R1 on in R1 settings.',
  },
  paused: {
    title: 'R1 is paused',
    detail: 'Sending is blocked while R1 is paused. An admin can resume it in R1 settings.',
  },
  capacity_exhausted: {
    title: 'This month’s R1 allowance is used up',
    detail:
      'The shared WebRTC allowance, which phone calls also use, has no room for another R1 ' +
      'link. It reopens when the allowance is raised or the month rolls over.',
  },
  role_not_configured: {
    title: 'R1 is not set up yet',
    detail: 'The Sales Program Advisor role has not been created. Ask an admin to finish setup.',
  },
  config_invalid: {
    title: 'R1 is off because of a configuration problem',
    detail: 'The server has an invalid R1 setting, so R1 is off. Ask an admin to check it.',
  },
};

/** States whose fix is in R1 settings, so an admin is offered the way there. */
export function availabilityFixableInSettings(state: R1AvailabilityState): boolean {
  return state === 'disabled' || state === 'paused' || state === 'capacity_exhausted';
}

/* ── API refusals, in words ───────────────────────────────────────── */

const SHARED_ERRORS: Readonly<Record<string, string>> = {
  r1_disabled: 'R1 is switched off, so nothing was changed.',
  r1_paused: 'R1 is paused, so nothing was changed.',
  r1_capacity_exhausted: 'This month’s R1 allowance is used up.',
  r1_role_not_configured: 'The Sales Program Advisor role has not been set up yet.',
  role_not_configured: 'The Sales Program Advisor role has not been set up yet.',
  access_denied: 'You do not have access to this candidate’s R1.',
  'Insufficient permissions': 'Your role cannot do this.',
  not_found: 'That candidate or round no longer exists.',
  service_unavailable: 'R1 is temporarily unavailable. Try again in a moment.',
};

const SEND_ERRORS: Readonly<Record<string, string>> = {
  ...SHARED_ERRORS,
  india_location_attestation_required: 'Confirm the candidate is located in India first.',
  decision_use_blocked:
    'Decision use is blocked for this candidate (for example, an open appeal), so R1 cannot ' +
    'be sent.',
  round_active: 'An R1 link is already out for this candidate.',
  phone_engagement_active:
    'A phone screening is in progress or scheduled for this candidate. Finish or cancel it first.',
  phone_assessment_pending:
    'The candidate’s phone screening is still being scored. Try again shortly.',
  candidate_ineligible: 'This candidate is not eligible for R1.',
  candidate_ownership_conflict: 'Another recruiter has just claimed this candidate.',
};

const ROUND_ERRORS: Readonly<Record<string, string>> = {
  ...SHARED_ERRORS,
  retake_not_allowed:
    'A retake can be granted once, after the first attempt has finished and was counted.',
  round_transition_conflict:
    'This round changed while you were looking at it. It has been refreshed; try again.',
};

export type R1ErrorKind = 'send' | 'round';

/** Words for an `ApiError.message` (the API puts its machine code there). */
export function r1ErrorMessage(code: string, kind: R1ErrorKind): string {
  const table = kind === 'send' ? SEND_ERRORS : ROUND_ERRORS;
  const known = table[code];
  if (known) return known;
  return kind === 'send'
    ? 'R1 could not be sent. Try again, or ask an admin if it keeps failing.'
    : 'That change could not be made. Try again, or ask an admin if it keeps failing.';
}

/**
 * Refusals that mean "the availability this card showed is out of date".
 * The card re-reads availability on these instead of leaving a live button
 * that is known to fail.
 */
export function isAvailabilityRefusal(code: string): boolean {
  return (
    code === 'r1_disabled' ||
    code === 'r1_paused' ||
    code === 'r1_capacity_exhausted' ||
    code === 'r1_role_not_configured' ||
    code === 'role_not_configured'
  );
}

/* ── Admin settings form ──────────────────────────────────────────── */

/** The editable fields, as the strings a form holds. */
export interface R1SettingsDraft {
  enabled: boolean;
  paused: boolean;
  auto_status_enabled: boolean;
  monthly_cap_minutes: string;
  pause_line_minutes: string;
  advance_threshold: string;
  hold_threshold: string;
}

export type R1SettingsDraftErrors = Partial<Record<keyof R1SettingsDraft, string>>;

export function draftFromSettings(settings: R1Settings): R1SettingsDraft {
  return {
    enabled: settings.enabled,
    paused: settings.paused,
    auto_status_enabled: settings.auto_status_enabled,
    monthly_cap_minutes: String(settings.monthly_cap_minutes),
    pause_line_minutes: String(settings.pause_line_minutes),
    advance_threshold: String(settings.advance_threshold),
    hold_threshold: String(settings.hold_threshold),
  };
}

/**
 * Carry a draft across a change of the saved row that the draft's owner did
 * not make (another admin saved, or the dashboard-reading form did). A field
 * the person has not touched follows the server; a field they edited keeps
 * their edit. Without this the form turns "dirty" on the other admin's change
 * and the next Save would send it back, silently undoing it (for example
 * lifting a deploy-safety pause).
 */
export function rebaseDraft(
  draft: R1SettingsDraft,
  previous: R1Settings,
  next: R1Settings,
): R1SettingsDraft {
  const before = draftFromSettings(previous);
  const after = draftFromSettings(next);
  const rebased: R1SettingsDraft = { ...draft };
  for (const key of Object.keys(draft) as Array<keyof R1SettingsDraft>) {
    if (draft[key] === before[key]) {
      (rebased as unknown as Record<string, unknown>)[key] = after[key];
    }
  }
  return rebased;
}

/** Whole, positive minutes. Mirrors the server's `validInt`. */
function parsePositiveInteger(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 0-100, up to two decimals (the column is `numeric(5,2)`). */
function parseScore(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= 100 ? value : null;
}

/** Non-negative minutes, up to two decimals (the column is `numeric(10,2)`). */
export function parseDashboardMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function validateSettingsDraft(draft: R1SettingsDraft): R1SettingsDraftErrors {
  const errors: R1SettingsDraftErrors = {};
  if (parsePositiveInteger(draft.monthly_cap_minutes) === null) {
    errors.monthly_cap_minutes = 'Enter a whole number of minutes, 1 or more.';
  }
  if (parsePositiveInteger(draft.pause_line_minutes) === null) {
    errors.pause_line_minutes = 'Enter a whole number of minutes, 1 or more.';
  }
  const advance = parseScore(draft.advance_threshold);
  const hold = parseScore(draft.hold_threshold);
  if (advance === null) {
    errors.advance_threshold = 'Enter a score from 0 to 100, with at most two decimals.';
  }
  if (hold === null) {
    errors.hold_threshold = 'Enter a score from 0 to 100, with at most two decimals.';
  }
  if (advance !== null && hold !== null && hold > advance) {
    errors.hold_threshold = 'The hold threshold cannot be above the advance threshold.';
  }
  return errors;
}

/**
 * Only the fields that differ from what the server last said, so two admins
 * editing different fields never overwrite each other. A draft that does not
 * validate yields an empty patch: callers validate first.
 */
export function settingsPatch(draft: R1SettingsDraft, saved: R1Settings): R1SettingsPatch {
  if (Object.keys(validateSettingsDraft(draft)).length > 0) return {};
  const patch: R1SettingsPatch = {};
  if (draft.enabled !== saved.enabled) patch.enabled = draft.enabled;
  if (draft.paused !== saved.paused) patch.paused = draft.paused;
  if (draft.auto_status_enabled !== saved.auto_status_enabled) {
    patch.auto_status_enabled = draft.auto_status_enabled;
  }
  const cap = parsePositiveInteger(draft.monthly_cap_minutes);
  if (cap !== null && cap !== Number(saved.monthly_cap_minutes)) patch.monthly_cap_minutes = cap;
  const line = parsePositiveInteger(draft.pause_line_minutes);
  if (line !== null && line !== Number(saved.pause_line_minutes)) patch.pause_line_minutes = line;
  const advance = parseScore(draft.advance_threshold);
  if (advance !== null && advance !== Number(saved.advance_threshold)) {
    patch.advance_threshold = advance;
  }
  const hold = parseScore(draft.hold_threshold);
  if (hold !== null && hold !== Number(saved.hold_threshold)) patch.hold_threshold = hold;
  return patch;
}

/** The settings that change real behaviour and so ask for a second click. */
export function needsConfirmation(patch: R1SettingsPatch): string[] {
  const reasons: string[] = [];
  if (patch.enabled === true) reasons.push('switch R1 on, so HR can send candidate links');
  if (patch.auto_status_enabled === true) {
    reasons.push(
      'let R1 change candidate status automatically (advance now, reject after 24 hours)',
    );
  }
  if (patch.auto_status_enabled === false) reasons.push('stop R1 changing candidate status');
  if (patch.enabled === false) reasons.push('switch R1 off, which blocks new sends and starts');
  // Unpausing is the step an operator takes after a deploy-safety pause, so it is
  // never one stray click away from taking effect.
  if (patch.paused === false) {
    reasons.push('resume R1, so new sends and interview starts are allowed');
  }
  return reasons;
}

/* ── Usage, for Mission Control ───────────────────────────────────── */

/**
 * The capacity figures come from the API, which applies the capacity RPCs'
 * own arithmetic (see `R1UsageResponse`): the allowance is a ceiling on the
 * SHARED WebRTC pool plus R1's holds, not an R1-only budget. This module only
 * displays them, so a figure here can never disagree with what a send does.
 */
type UsageFigures = Pick<
  R1UsageResponse,
  'monthly_cap_minutes' | 'pause_line_minutes' | 'minutes_reserved' | 'committed_minutes'
>;

/** The lower of the cap and the pause line is the ceiling the admission RPC enforces. */
export function r1Ceiling(
  usage: Pick<UsageFigures, 'monthly_cap_minutes' | 'pause_line_minutes'>,
): number {
  return Math.min(usage.monthly_cap_minutes, usage.pause_line_minutes);
}

/** Minutes of the ceiling still unclaimed by the pool or by held links (never negative). */
export function r1FreeMinutes(
  usage: Pick<UsageFigures, 'monthly_cap_minutes' | 'pause_line_minutes' | 'committed_minutes'>,
): number {
  return Math.max(0, r1Ceiling(usage) - usage.committed_minutes);
}

/** The part of the committed minutes that is the pool itself, before held links. */
export function r1PoolMinutes(
  usage: Pick<UsageFigures, 'minutes_reserved' | 'committed_minutes'>,
): number {
  return Math.max(0, usage.committed_minutes - usage.minutes_reserved);
}

/**
 * True when the LiveKit dashboard reading was taken in an earlier UTC month
 * than `monthStart` (`YYYY-MM-01`, the API's current month). The capacity
 * guard adds the reading in EVERY month until a new one is recorded, so an old
 * month-to-date figure keeps blocking sends. No reading is not stale.
 */
export function isReadingStale(readAt: string | null, monthStart: string): boolean {
  if (!readAt) return false;
  const when = new Date(readAt);
  if (Number.isNaN(when.getTime())) return false;
  return when.toISOString().slice(0, 7) < monthStart.slice(0, 7);
}

/** `YYYY-MM-01` for the UTC month of `now`, as the API names its month. */
export function currentMonthStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

/** "September 2026" for a reading's UTC month. */
export function readingMonthLabel(readAt: string): string {
  return new Date(readAt).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export type UsageTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Alert bands from the plan (§3.3): 60 / 75 / 90 % of the line. */
export function usageTone(percent: number | null): UsageTone {
  if (percent === null) return 'neutral';
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warning';
  if (percent >= 60) return 'info';
  return 'success';
}

/** Whole-number percentage of `part` in `whole`, or null when there is no whole. */
export function percentOf(part: number, whole: number): number | null {
  if (!(whole > 0) || !Number.isFinite(part)) return null;
  return Math.max(0, Math.round((part / whole) * 100));
}

export function formatMinutes(value: number): string {
  return Math.round(value).toLocaleString('en-IN');
}

/** A dashboard reading is typed in with decimals, so show it back exactly. */
export function formatReading(value: number): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/* ── Run state, for Mission Control and the settings page ─────────── */

export interface R1RunState {
  label: 'On' | 'Paused' | 'Off' | 'Off at the API' | 'Configuration error';
  tone: UsageTone;
  detail: string;
}

/**
 * R1 takes sends only when BOTH switches agree: the API process's own
 * `R1_ENABLED` (the routes check it first) and the database switch the admin
 * edits (the capacity RPCs check it). Saying "On" while either is off would
 * send an operator hunting for a problem that is not where they look.
 */
export function r1RunState(
  settings: Pick<R1Settings, 'enabled' | 'paused' | 'auto_status_enabled'>,
  runtime: R1RuntimeStatus | undefined,
): R1RunState {
  const auto = settings.auto_status_enabled
    ? 'Automatic status changes are on.'
    : 'Automatic status changes are off.';
  if (runtime?.status === 'invalid') {
    return {
      label: 'Configuration error',
      tone: 'danger',
      detail: 'The API has an invalid R1 setting, so R1 is off. Check R1_ENABLED.',
    };
  }
  if (runtime && !runtime.enabled) {
    return {
      label: 'Off at the API',
      tone: 'warning',
      detail: 'R1_ENABLED is not "true" on the API, so the database switch has no effect yet.',
    };
  }
  if (!settings.enabled) {
    return { label: 'Off', tone: 'neutral', detail: `Switched off in R1 settings. ${auto}` };
  }
  if (settings.paused) {
    return { label: 'Paused', tone: 'warning', detail: `New sends are blocked. ${auto}` };
  }
  return { label: 'On', tone: 'success', detail: auto };
}
