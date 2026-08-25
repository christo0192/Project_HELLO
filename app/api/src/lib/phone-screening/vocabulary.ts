/**
 * phone-screening/vocabulary.ts — the closed unions of migration 0042.
 *
 * Every union in this file MIRRORS a CHECK allowlist or a status literal that
 * already exists in `app/supabase/migrations/0042_phone_screening.sql`. The
 * database is authoritative: TypeScript may NARROW what it is willing to send,
 * it may never widen what the schema accepts, and it may never invent a member.
 * `phone-screening-vocabulary.test.ts` reads the migration text and fails if
 * any union here drifts from it in either direction.
 *
 * Nothing in this file reads configuration, touches the network, or holds a
 * phone number. Importing it has no side effect.
 */

// ═══════════════════════════════════════════════════════════════════════
// The engagement machine
// ═══════════════════════════════════════════════════════════════════════

/** `chk_phone_engagements_state` — the thirteen engagement states. */
export const PHONE_ENGAGEMENT_STATES = [
  'pending_prereqs',
  'eligible',
  'scheduled',
  'dialing',
  'in_call',
  'reconnecting',
  'awaiting_retry',
  'completed',
  'abandoned_no_answer',
  'opted_out',
  'wrong_number',
  'failed',
  'cancelled',
] as const;

export type PhoneEngagementState = (typeof PHONE_ENGAGEMENT_STATES)[number];

/**
 * `chk_phone_engagements_terminal` — the six states for which `terminal_at`
 * is NOT NULL. A terminal engagement is immutable: the transition trigger
 * refuses every subsequent row change, which is also why two of its
 * `on delete set null` foreign keys behave as `restrict` (0042 header, §2).
 */
export const PHONE_TERMINAL_ENGAGEMENT_STATES = [
  'completed',
  'abandoned_no_answer',
  'opted_out',
  'wrong_number',
  'failed',
  'cancelled',
] as const;

export type PhoneTerminalEngagementState = (typeof PHONE_TERMINAL_ENGAGEMENT_STATES)[number];

const TERMINAL_SET: ReadonlySet<string> = new Set(PHONE_TERMINAL_ENGAGEMENT_STATES);

/** True iff the state is one of the six terminal, immutable engagement states. */
export function isTerminalEngagementState(state: string): state is PhoneTerminalEngagementState {
  return TERMINAL_SET.has(state);
}

// ═══════════════════════════════════════════════════════════════════════
// The attempt
// ═══════════════════════════════════════════════════════════════════════

/** `chk_phone_call_attempts_state` — the seven attempt states. */
export const PHONE_ATTEMPT_STATES = [
  'admitted',
  'ringing',
  'answered_unclassified',
  'human',
  'machine',
  'ended',
  'abandoned',
] as const;

export type PhoneAttemptState = (typeof PHONE_ATTEMPT_STATES)[number];

/**
 * The five attempt states that hold a fleet concurrency slot — the exact list
 * `admit_phone_attempt`, `heartbeat_phone_attempt`,
 * `reclaim_phone_attempt_leases` and `phone_backlog` all count as "live".
 */
export const PHONE_LIVE_ATTEMPT_STATES = [
  'admitted',
  'ringing',
  'answered_unclassified',
  'human',
  'machine',
] as const;

export type PhoneLiveAttemptState = (typeof PHONE_LIVE_ATTEMPT_STATES)[number];

const LIVE_ATTEMPT_SET: ReadonlySet<string> = new Set(PHONE_LIVE_ATTEMPT_STATES);

/** True iff the attempt state holds a fleet slot. */
export function isLiveAttemptState(state: string): state is PhoneLiveAttemptState {
  return LIVE_ATTEMPT_SET.has(state);
}

/** `chk_phone_call_attempts_kind` — the four admissible attempt kinds. */
export const PHONE_ATTEMPT_KINDS = ['initial', 'no_answer_retry', 'reconnect', 'scheduled'] as const;

export type PhoneAttemptKind = (typeof PHONE_ATTEMPT_KINDS)[number];

/**
 * `chk_phone_call_attempts_prior_state` — EXACTLY the three engagement states
 * admission can be granted from, and therefore exactly the three a reclaim may
 * legally restore an engagement to.
 */
export const PHONE_ADMISSIBLE_PRIOR_STATES = ['eligible', 'scheduled', 'reconnecting'] as const;

export type PhoneAdmissiblePriorState = (typeof PHONE_ADMISSIBLE_PRIOR_STATES)[number];

// ═══════════════════════════════════════════════════════════════════════
// The eleven outcome classes — and nothing else
// ═══════════════════════════════════════════════════════════════════════

/**
 * `chk_phone_call_attempts_outcome` — EXACTLY eleven members.
 *
 * A twelfth member in this union would produce a value the database rejects on
 * write. In particular COLD START IS NOT AN OUTCOME: a runtime that is not yet
 * ready has not made a call, so it is a PRE-CLAIM deferral or refusal
 * (`PhoneDeferralCode` in `admission.ts`), never an `outcome_class`.
 */
export const PHONE_OUTCOME_CLASSES = [
  'completed',
  'disconnected',
  'no_answer',
  'busy',
  'voicemail',
  'declined',
  'wrong_number',
  'opt_out',
  'provider_error',
  'window_closed',
  'cancelled',
  /**
   * 0043: the candidate ANSWERED and hung up before the recording
   * disclosure was delivered.
   *
   * Deliberately NOT folded into `disconnected`. `disconnected` means a
   * conversation dropped and carries a reconnect grant; this means there was
   * no conversation yet, carries no grant and charges no budget at all. An
   * operator filtering for calls that reached a human cannot recover the
   * difference after the fact if the two share a label.
   */
  'abandoned_pre_disclosure',
] as const;

export type PhoneOutcomeClass = (typeof PHONE_OUTCOME_CLASSES)[number];

const OUTCOME_SET: ReadonlySet<string> = new Set(PHONE_OUTCOME_CLASSES);

/** True iff the value is one of the twelve `outcome_class` members. */
export function isPhoneOutcomeClass(value: string): value is PhoneOutcomeClass {
  return OUTCOME_SET.has(value);
}

/**
 * `chk_phone_call_attempts_recording_role` (0043).
 *
 * The FIRST consented attempt of an engagement is `authoritative`; every
 * reconnect that follows is `supplementary`. This is a DATA distinction, not
 * a documentary one: a partial unique index makes a second authoritative
 * binding unrepresentable, and an authoritative reader filters on the column
 * rather than trusting a comment.
 */
export const PHONE_RECORDING_ROLES = ['authoritative', 'supplementary'] as const;

export type PhoneRecordingRole = (typeof PHONE_RECORDING_ROLES)[number];

const RECORDING_ROLE_SET: ReadonlySet<string> = new Set(PHONE_RECORDING_ROLES);

/** True iff the value is one of the two `recording_role` members. */
export function isPhoneRecordingRole(value: string): value is PhoneRecordingRole {
  return RECORDING_ROLE_SET.has(value);
}

/**
 * The EXACT derived MP3 artifact names 0043/0050's CHECKs admit. Both are functions of
 * the attempt id alone: a key the dialer cannot derive is a key the purge
 * cannot name, and 0043 refuses to store one.
 */
export function phoneAttemptRecordingObjectKey(attemptId: string): string {
  return `phone-${attemptId}-egress.mp3`;
}

/**
 * The manifest is a SECOND object with its own suffix. Deleting the recording
 * and forgetting the manifest is a trap this lane has already hit once, so the
 * manifest name is derived here rather than assembled at each call site.
 */
export function phoneAttemptRecordingManifestKey(attemptId: string): string {
  return `${phoneAttemptRecordingObjectKey(attemptId)}.json`;
}

// ═══════════════════════════════════════════════════════════════════════
// The internal calendar
// ═══════════════════════════════════════════════════════════════════════

/** `chk_phone_appointments_status`. */
export const PHONE_APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'cancelled',
  'superseded',
  'fulfilled',
  'missed',
] as const;

export type PhoneAppointmentStatus = (typeof PHONE_APPOINTMENT_STATUSES)[number];

/** The two statuses `cancel_phone_appointment` and the expiry sweeper act on. */
export const PHONE_LIVE_APPOINTMENT_STATUSES = ['scheduled', 'confirmed'] as const;

/** `chk_phone_appointments_source` / `schedule_phone_appointment`'s allowlist. */
export const PHONE_APPOINTMENT_SOURCES = ['candidate_voice', 'hr_manual', 'system_deferral'] as const;

export type PhoneAppointmentSource = (typeof PHONE_APPOINTMENT_SOURCES)[number];

/** `cancel_phone_appointment`'s FIXED reason vocabulary — never free text. */
export const PHONE_APPOINTMENT_CANCEL_REASONS = [
  'candidate_request',
  'hr_cancelled',
  'system_deferral_expired',
  'emergency_stop',
  'engagement_cancelled',
  'superseded',
] as const;

export type PhoneAppointmentCancelReason = (typeof PHONE_APPOINTMENT_CANCEL_REASONS)[number];

/** `chk_phone_appointments_duration` — 15 to 60 minutes, in seconds. */
export const PHONE_APPOINTMENT_MIN_SECONDS = 900;
export const PHONE_APPOINTMENT_MAX_SECONDS = 3600;

// ═══════════════════════════════════════════════════════════════════════
// The append-only ingress ledger
// ═══════════════════════════════════════════════════════════════════════

/** `chk_phone_call_events_source` / `apply_phone_event`'s allowlist. */
export const PHONE_EVENT_SOURCES = [
  'livekit_webhook',
  'provider_callback',
  'provider_poll',
  'internal',
  'reconciliation',
] as const;

export type PhoneEventSource = (typeof PHONE_EVENT_SOURCES)[number];

/**
 * `chk_phone_call_events_ignored_reason` — exactly four verdicts.
 * `duplicate` is deliberately absent: a duplicate delivery writes NO second
 * row, so a row claiming to be one could never exist.
 */
export const PHONE_EVENT_IGNORED_REASONS = [
  'stale_epoch',
  'unknown_attempt',
  'terminal',
  'unexpected_event',
] as const;

export type PhoneEventIgnoredReason = (typeof PHONE_EVENT_IGNORED_REASONS)[number];

/**
 * `chk_phone_call_events_type` — a FORMAT rule, not a closed allowlist, so an
 * unrecognised event stays recordable and answerable with `unexpected_event`.
 */
export const PHONE_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.]{1,63}$/;

/** `chk_phone_call_events_provider_id` — opaque identifiers only. */
export const PHONE_PROVIDER_EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

// ═══════════════════════════════════════════════════════════════════════
// The kill switch
// ═══════════════════════════════════════════════════════════════════════

/** `set_phone_halt`'s reason allowlist. */
export const PHONE_HALT_REASONS = [
  'operator_pause',
  'provider_incident',
  'cost_control',
  'legal_hold',
  'emergency_stop',
] as const;

export type PhoneHaltReason = (typeof PHONE_HALT_REASONS)[number];

/** The single `phone_control` row every admission reads. */
export const PHONE_CONTROL_KEY = 'default';

// ═══════════════════════════════════════════════════════════════════════
// Budget ceilings — CHECK-enforced, mirrored, never re-decided here
// ═══════════════════════════════════════════════════════════════════════

/**
 * The three budget ceilings, each carried by a CHECK constraint in 0042:
 * `chk_phone_engagements_no_answer` (0..3), `chk_phone_engagements_reconnects`
 * (0..3) and `chk_phone_engagements_failures` (0..5).
 *
 * These are MIRRORS, asserted against the migration text by the vocabulary
 * drift test. The charge that lands ON the ceiling is the terminal one — see
 * `budget.ts`, which is the only place that decision is written down.
 */
export const PHONE_BUDGET_CEILINGS = {
  noAnswer: 3,
  reconnect: 3,
  providerFailure: 5,
} as const;

// ═══════════════════════════════════════════════════════════════════════
// The queue name — a NAME, not an ashby_operations type
// ═══════════════════════════════════════════════════════════════════════

/** The `job_queue.name` admission enqueues under. */
export const PHONE_DIAL_QUEUE_NAME = 'phone.dial';

/** `phone.dial:<attempt_id>` — the dedup key admission and reclaim agree on. */
export function phoneDialDedupKey(attemptId: string): string {
  return `${PHONE_DIAL_QUEUE_NAME}:${attemptId}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Consent — read-only mirrors of 0013
// ═══════════════════════════════════════════════════════════════════════

/** `consent_records.status` — the three-member CHECK from 0013. */
export const CONSENT_RECORD_STATUSES = ['granted', 'declined', 'withdrawn'] as const;

export type ConsentRecordStatus = (typeof CONSENT_RECORD_STATUSES)[number];

/** `screening_v2.consent_type` — the enum from 0013. */
export const CONSENT_TYPES = [
  'ai_interview',
  'recording',
  'purpose',
  'data_processing',
  'retention',
  'rights',
  'job_application',
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];
