/**
 * Truthful status helpers for the TA/HR workspace.
 *
 * Status vocabularies come from the DB CHECK constraints (0001/0006):
 *   - candidates.status:  new | queued | screening | screened | advanced | rejected
 *   - call_sessions.status: created | waiting | in_progress | completed |
 *                           failed | cancelled | expired
 *
 * Unknown statuses are rendered through `humanizeEnum` ("custom_state" →
 * "Custom state") with a neutral tone: the same words, never an invented
 * label. Callers keep the raw value in `title` where an operator may quote it.
 */

import type { StatusTone } from '../design/StatusBadge';
import { humanizeEnum } from '../../lib/humanize';

/** Human label for a candidate status (fallback: the raw value). */
export function candidateStatusLabel(status: string | null | undefined): string {
  if (typeof status !== 'string' && status != null) return 'New';
  switch (status ?? 'new') {
    case 'new':
      return 'New';
    case 'queued':
      return 'Queued';
    case 'screening':
      return 'Screening';
    case 'screened':
      return 'Screened';
    case 'advanced':
      return 'Advanced';
    case 'rejected':
      return 'Rejected';
    case 'consent_declined':
      return 'Consent declined';
    default:
      return humanizeEnum((status ?? 'new').trim()) || 'New';
  }
}

export function candidateStatusTone(status: string | null | undefined): StatusTone {
  switch (status) {
    case 'screened':
    case 'advanced':
      return 'success';
    case 'screening':
    case 'queued':
      return 'warning';
    case 'rejected':
      return 'danger';
    case 'new':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Human label for a session status (fallback: the raw value). */
export function sessionStatusLabel(status: string | null | undefined): string {
  if (typeof status !== 'string' && status != null) return '—';
  switch (status) {
    case 'created':
      return 'Created';
    case 'waiting':
      return 'Waiting';
    case 'in_progress':
      return 'In progress';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'abandoned':
      return 'Abandoned';
    case 'deleted':
      return 'Deleted';
    default:
      return humanizeEnum(status) || '—';
  }
}

/* ── Phone call attempts ─────────────────────────────────────────────
 *
 * The words a recruiter reads for one dial. The vocabularies are the closed
 * CHECK allowlists on `phone_call_attempts` (0042, extended by 0043, 0095 and 0114;
 * mirrored in app/api/src/lib/phone-screening/vocabulary.ts). The OUTCOME is
 * what a recruiter acts on, so it is the word shown; the attempt STATE is
 * only shown while no outcome has been recorded yet (a dial in flight).
 */

const ATTEMPT_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  completed: 'Screening completed',
  // A conversation that started and then dropped. Carries a reconnect grant.
  disconnected: 'Dropped mid-call',
  no_answer: 'No answer',
  busy: 'Line busy',
  voicemail: 'Voicemail',
  // The candidate refused. Terminal: they are never dialled again.
  declined: 'Declined',
  wrong_number: 'Wrong number',
  opt_out: 'Opted out',
  // The carrier refused the call before it rang (sip originate rejected).
  provider_error: "Couldn't connect",
  window_closed: 'Calling window closed',
  cancelled: 'Cancelled',
  // 0043: answered, then hung up BEFORE the recording notice was delivered.
  // There was no conversation yet, so this is not "dropped mid-call".
  abandoned_pre_disclosure: 'Hung up before the recording notice',
  // 0095: OUR consent gate failed (malformed RPC, classifier error). Not the
  // candidate declining: they are owed the call and it is retried.
  consent_failed: 'Consent check failed on our side',
  // 0114: the candidate asked mid-call to be called back and no slot could be
  // booked. Not a screening and not a drop: they are redialled next day.
  callback_deferred: 'Asked to be called back later',
  // Values the offline e2e fixtures use for the same situations. Harmless in
  // production (the allowlist never produces them) and they keep the fixture
  // screenshots in plain words. `dropped_at_gate` is a call that ended at the
  // identity / recording-consent gate, before screening questions began.
  answered: 'Answered',
  dropped_at_gate: 'Dropped at the consent check',
};

const ATTEMPT_STATE_LABELS: Readonly<Record<string, string>> = {
  admitted: 'Dialling',
  ringing: 'Ringing',
  answered_unclassified: 'Answered',
  human: 'Answered',
  machine: 'Answering machine',
  ended: 'Ended',
  // `abandoned` is split by `abandon_reason` (0083) in attemptOutcomeLabel:
  // only an infra defer was never placed; a lease reclaim (reason NULL) was a
  // real call, usually answered, that our side lost mid-call.
  abandoned: 'Call interrupted',
  completed: 'Completed',
};

/**
 * What happened on one dial, in a recruiter's words (humanized floor).
 *
 * An `abandoned` attempt with no outcome reads "Not placed" ONLY when its
 * `abandon_reason` is 'infra_deferred' (no carrier was contacted). Every
 * other abandoned attempt, including a missing reason, is a lease reclaim:
 * the call was placed and then interrupted, so it never claims "Not placed"
 * beside a call that may have a recording.
 */
export function attemptOutcomeLabel(
  outcome: string | null | undefined,
  state: string | null | undefined,
  abandonReason?: string | null,
): string {
  if (outcome) return humanizeEnum(outcome, ATTEMPT_OUTCOME_LABELS);
  if (state === 'abandoned' && abandonReason === 'infra_deferred') return 'Not placed';
  return humanizeEnum(state, ATTEMPT_STATE_LABELS) || 'Unknown';
}

/** The raw pair, for `title`: what an operator quotes to engineering. */
export function attemptRawStatus(
  outcome: string | null | undefined,
  state: string | null | undefined,
  abandonReason?: string | null,
): string {
  return [
    state ? `state: ${state}` : null,
    abandonReason ? `abandon_reason: ${abandonReason}` : null,
    outcome ? `outcome: ${outcome}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/* ── Phone engagement state reasons ─────────────────────────────────
 *
 * `phone_engagements.state_reason`: WHY a screening cycle is in its state.
 * Not a closed CHECK (the event-derived cancel reasons are written as the
 * event type with its dot replaced), so unknown values fall through to
 * `humanizeEnum`. The vocabulary mirrors PHONE_OUTCOME_MIGRATION_REASONS in
 * app/api/src/lib/phone-screening/budget.ts plus 0114's late-score reason.
 */

const ENGAGEMENT_REASON_LABELS: Readonly<Record<string, string>> = {
  no_answer_budget_exhausted: 'No answer after every attempt',
  reconnect_budget_exhausted: 'Dropped too many times',
  provider_budget_exhausted: 'Could not connect after every attempt',
  window_closed: 'Waiting for the next calling window',
  assessment_aborted: 'Interview ended before it finished',
  wrong_number: 'Wrong number',
  disclosure_refused: 'Declined the recording notice',
  candidate_opt_out: 'Candidate opted out',
  hr_cancelled: 'Cancelled by HR',
  emergency_stop: 'Stopped by the emergency stop',
  ashby_stage_left: 'Left the Ashby stage',
  prereq_lost: 'Prerequisites no longer met',
  abandoned_pre_disclosure: 'Hung up before the recording notice',
  consent_gate_failed: 'Consent check failed on our side',
  // 0114 (C2): the candidate asked mid-call to be called back and no slot
  // could be booked. Redialled at the next day's window, budget untouched.
  callback_deferred_in_call: 'Asked to be called back; redial next day',
  // 0114 (C2): the third such request. The cycle stops rather than deferring
  // for ever.
  callback_deferral_limit: 'Asked to be called back too many times',
  // 0114 (C2): the interview was marked aborted by the stranded sweep, then
  // its score landed. Completed late, with the original end time kept.
  late_score_after_stranded_abort: 'Completed (score arrived late)',
};

/** Why a screening cycle is in its state, in a recruiter's words. */
export function engagementReasonLabel(reason: string | null | undefined): string {
  if (typeof reason !== 'string' || reason.trim() === '') return '';
  return humanizeEnum(reason, ENGAGEMENT_REASON_LABELS);
}

/* ── Appeals ─────────────────────────────────────────────────────────
 * `appeal_requests.status` (0015): open → under_review → granted | denied.
 * `category` is the candidate's own choice on the appeal form.
 */

const APPEAL_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Open',
  under_review: 'Under review',
  granted: 'Granted',
  denied: 'Denied',
};

export function appealStatusLabel(status: string | null | undefined): string {
  return humanizeEnum(status, APPEAL_STATUS_LABELS) || 'Unknown';
}

/** Still awaiting a decision, i.e. something a recruiter has to act on. */
export function isAppealPending(status: string | null | undefined): boolean {
  return status === 'open' || status === 'under_review';
}

const APPEAL_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  scoring: 'Scoring appeal',
  recording: 'Recording appeal',
  accessibility: 'Accessibility appeal',
  other: 'Appeal',
};

export function appealCategoryLabel(category: string | null | undefined): string {
  if (!category) return 'Appeal';
  return APPEAL_CATEGORY_LABELS[category] ?? `${humanizeEnum(category)} appeal`;
}

export function sessionStatusTone(status: string | null | undefined): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'in_progress':
      return 'warning';
    case 'created':
    case 'waiting':
      return 'info';
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Human-readable duration from seconds (null-safe). */
export function formatDurationSec(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  if (minutes === 0) return `${remaining}s`;
  return `${minutes}m ${remaining}s`;
}

/** Count candidates by status — only statuses actually present are emitted. */
export function candidateStatusCounts(
  candidates: ReadonlyArray<{ status: string | null | undefined }>,
): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const status = candidate.status ?? 'new';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, value]) => ({ label: candidateStatusLabel(status), value }))
    .sort((a, b) => b.value - a.value);
}

/** Count sessions by status — only statuses actually present are emitted. */
export function sessionStatusCounts(
  sessions: ReadonlyArray<{ status: string | null | undefined }>,
): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const status = session.status ?? 'created';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, value]) => ({ label: sessionStatusLabel(status), value }))
    .sort((a, b) => b.value - a.value);
}
