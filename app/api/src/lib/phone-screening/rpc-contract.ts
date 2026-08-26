/**
 * phone-screening/rpc-contract.ts — the fourteen phone RPCs (ten from 0042,
 * four from 0043), their exact parameter names, and their COMPLETE status
 * vocabularies.
 *
 * ── WHY THE FULL VOCABULARY, NOT JUST THE ONES WE EXPECT ──────────────
 * 0042 can answer with 44 distinct `status` strings across its ten RPCs. A
 * union that omits one turns a BENIGN REFUSAL into a thrown error on a
 * billable path — `halt_unreadable`, `attempt_required`, `ok_prereqs_pending`,
 * `not_live` and `lease_lost` are the easy ones to miss, and each of them is a
 * normal answer the caller must be able to act on. So every member is listed
 * here, and `phone-screening-rpc-contract.test.ts` EXTRACTS the vocabulary
 * from the migration text and fails on any member this file does not carry,
 * in either direction.
 *
 * ── PARAMETER NAMES ARE PART OF THE CONTRACT ──────────────────────────
 * PostgREST resolves an RPC by argument NAME. A renamed or omitted parameter
 * is not a type error, it is a 404 at runtime, so the names are written down
 * once here and the same test asserts each against the migration's signature.
 *
 * ── TIME IS INJECTED ──────────────────────────────────────────────────
 * Every time-dependent RPC takes `p_now timestamptz` as its FINAL parameter.
 * The store layer passes it explicitly so a boundary test cannot depend on the
 * host clock; production passes the same value it used for its own decisions.
 *
 * Pure declarations. No client, no I/O, no configuration.
 */

/** The seventeen service-role RPCs 0042, 0043 and 0044 expose. */
export const PHONE_RPC_NAMES = [
  'admit_phone_attempt',
  'heartbeat_phone_attempt',
  'reclaim_phone_attempt_leases',
  'apply_phone_event',
  'schedule_phone_appointment',
  'cancel_phone_appointment',
  'set_phone_halt',
  'clear_phone_halt',
  'expire_phone_appointments',
  'phone_backlog',
  // 0043 — the recording-artifact RPCs. None of them admits, dials or
  // deletes anything; three write and one reads.
  'attach_phone_attempt_recording',
  'finalize_phone_attempt_recording',
  'list_phone_engagement_recordings',
  'clear_phone_attempt_recordings',
  // 0051 — the session-level egress stamp: makes phone recordings visible to
  // the 0038 finalize convergence and the recruiter download route.
  'stamp_phone_session_egress',
  // 0044 — the assessment-persistence RPCs. One binds and snapshots, one
  // reads, one appends a completed question boundary. None of them dials,
  // records, scores or completes anything.
  'start_phone_assessment',
  'get_phone_assessment_state',
  'commit_phone_question_boundary',
  // 0045
  'heartbeat_phone_attempt_by_epoch',
  'sweep_phone_day_rolled',
  'sweep_phone_stranded_sessions',
  'claim_phone_sweep',
] as const;

export type PhoneRpcName = (typeof PHONE_RPC_NAMES)[number];

/** Exact parameter names, in declaration order, per RPC. */
export const PHONE_RPC_PARAMETERS: Readonly<Record<PhoneRpcName, readonly string[]>> =
  Object.freeze({
    admit_phone_attempt: [
      'p_engagement_id',
      'p_kind',
      'p_lease_owner',
      'p_lease_seconds',
      'p_now',
    ],
    heartbeat_phone_attempt: ['p_attempt_id', 'p_lease_token', 'p_lease_seconds', 'p_now'],
    reclaim_phone_attempt_leases: ['p_limit', 'p_now'],
    apply_phone_event: [
      'p_source',
      'p_event_type',
      'p_attempt_id',
      'p_engagement_id',
      'p_provider_event_id',
      'p_epoch',
      'p_metadata',
      'p_now',
    ],
    schedule_phone_appointment: [
      'p_engagement_id',
      'p_starts_at',
      'p_ends_at',
      'p_source',
      'p_actor_id',
      'p_expected_version',
      'p_now',
    ],
    cancel_phone_appointment: [
      'p_appointment_id',
      'p_reason',
      'p_actor_id',
      'p_expected_version',
      'p_now',
    ],
    set_phone_halt: ['p_reason', 'p_actor_id', 'p_now'],
    clear_phone_halt: ['p_actor_id', 'p_now'],
    expire_phone_appointments: ['p_grace_seconds', 'p_limit', 'p_now'],
    phone_backlog: ['p_now'],
    attach_phone_attempt_recording: [
      'p_attempt_id',
      'p_object_key',
      'p_manifest_key',
      'p_role',
      'p_egress_id',
      'p_now',
    ],
    stamp_phone_session_egress: [
      'p_session_id',
      'p_attempt_id',
      'p_egress_id',
      'p_now',
    ],
    finalize_phone_attempt_recording: [
      'p_attempt_id',
      'p_egress_status',
      'p_egress_id',
      'p_now',
    ],
    list_phone_engagement_recordings: ['p_engagement_id'],
    clear_phone_attempt_recordings: ['p_engagement_id', 'p_actor_id', 'p_now'],
    start_phone_assessment: ['p_attempt_id', 'p_session_id', 'p_now'],
    get_phone_assessment_state: ['p_session_id'],
    commit_phone_question_boundary: [
      'p_session_id',
      'p_question_key',
      'p_expected_index',
      'p_source_event_id',
      'p_turns',
      'p_now',
    ],
    // ── 0045 ──────────────────────────────────────────────────────────
    heartbeat_phone_attempt_by_epoch: [
      'p_attempt_id',
      'p_epoch',
      'p_session_id',
      'p_lease_seconds',
      'p_now',
    ],
    sweep_phone_day_rolled: [
      'p_limit',
      'p_now',
    ],
    sweep_phone_stranded_sessions: [
      'p_limit',
      'p_now',
    ],
    claim_phone_sweep: [
      'p_sweep',
      'p_owner',
      'p_ttl_seconds',
      'p_now',
    ],
  });

// ═══════════════════════════════════════════════════════════════════════
// Per-RPC status vocabularies — complete, extracted-and-asserted
// ═══════════════════════════════════════════════════════════════════════

/** `admit_phone_attempt` — one `ok` and twenty-five distinct free refusals. */
export const ADMIT_PHONE_ATTEMPT_STATUSES = [
  'ok',
  'application_not_found',
  'application_not_live',
  'application_terminal',
  'at_capacity',
  'attempt_in_flight',
  'consent_expired',
  'consent_missing',
  'consent_not_granted',
  'consent_subset_missing',
  'consent_template_inactive',
  'daily_attempt_exists',
  'engagement_terminal',
  'halt_unreadable',
  'halted',
  'ingestion_not_ready',
  'invalid_kind',
  'kind_not_admissible',
  'mapping_not_enabled',
  'no_answer_budget_exhausted',
  'not_found',
  'not_yet_eligible',
  'phone_invalid',
  'state_not_admissible',
  'suppressed',
  'window_closed',
  // ── 0045: the two per-CANDIDATE refusals ──────────────────────────────
  // Every 0042 index is keyed by ENGAGEMENT, and a person is not: one
  // candidate applying to two roles holds two engagements with two
  // independent budgets and two independent IST-day slots. These are the
  // refusals that make the anti-harassment guarantee true of the person
  // rather than of the row.
  'candidate_call_in_flight',
  'candidate_daily_attempt_exists',
] as const;

export type AdmitPhoneAttemptStatus = (typeof ADMIT_PHONE_ATTEMPT_STATUSES)[number];

/**
 * `heartbeat_phone_attempt` — `lease_lost` covers all four losses with one
 * stable answer: unknown attempt, wrong token, already-reclaimed lease and
 * non-live attempt. It is never a silent renew.
 */
export const HEARTBEAT_PHONE_ATTEMPT_STATUSES = ['ok', 'lease_lost'] as const;

export type HeartbeatPhoneAttemptStatus = (typeof HEARTBEAT_PHONE_ATTEMPT_STATUSES)[number];

/**
 * 0045's epoch-fenced door answers with the SAME two words as the
 * token-fenced one, deliberately. A caller that has lost its lease must not
 * be able to tell WHY it lost it — "your epoch is stale" and "your lease was
 * reclaimed" are the same instruction: stop.
 */
export const HEARTBEAT_PHONE_ATTEMPT_BY_EPOCH_STATUSES = ['ok', 'lease_lost'] as const;

/** The two bounded 0045 sweeps. A bounded sweep always answers `ok`. */
export const SWEEP_PHONE_DAY_ROLLED_STATUSES = ['ok'] as const;
export const SWEEP_PHONE_STRANDED_SESSIONS_STATUSES = ['ok'] as const;

/**
 * `claim_phone_sweep` — `held_by_other` is a NORMAL answer, not a fault: it
 * is what every replica but one hears on every tick.
 */
export const CLAIM_PHONE_SWEEP_STATUSES = ['ok', 'held_by_other', 'invalid_input'] as const;

/** `reclaim_phone_attempt_leases` — a bounded sweep always answers `ok`. */
export const RECLAIM_PHONE_ATTEMPT_LEASES_STATUSES = ['ok'] as const;

export type ReclaimPhoneAttemptLeasesStatus =
  (typeof RECLAIM_PHONE_ATTEMPT_LEASES_STATUSES)[number];

/**
 * `apply_phone_event`. Note there is no `ok`: the ledger answers `applied` or
 * `ignored`, and `attempt_required` is a MALFORMED CALL that records nothing —
 * an engagement-scoped post cannot drive an attempt-scoped edge.
 */
export const APPLY_PHONE_EVENT_STATUSES = [
  'applied',
  'ignored',
  'attempt_required',
  // 0044. Like `attempt_required`, decided BEFORE the insert and recorded
  // nowhere: the `internal` source mints a DETERMINISTIC event id, so a
  // recorded refusal would be read back by every later delivery of the same
  // claim and a worker that posted one moment too early could never complete
  // the call at all.
  'assessment_missing',
  'invalid_source',
  'invalid_event_type',
  'invalid_provider_event_id',
  'provider_event_id_required',
] as const;

export type ApplyPhoneEventStatus = (typeof APPLY_PHONE_EVENT_STATUSES)[number];

/**
 * `schedule_phone_appointment`. `ok_prereqs_pending` is a SUCCESS: the slot is
 * real and HR can see it, but the engagement's prerequisites are unmet so
 * nothing will dial it. Collapsing it into `ok` would let a caller believe a
 * call is going to happen at that time.
 */
export const SCHEDULE_PHONE_APPOINTMENT_STATUSES = [
  'ok',
  'ok_prereqs_pending',
  'appointment_exists',
  'attempt_in_flight',
  'engagement_terminal',
  'invalid_slot',
  'invalid_source',
  'not_found',
  'slot_duration_invalid',
  'slot_in_past',
  'slot_straddles_ist_midnight',
  'version_conflict',
  'window_closed',
] as const;

export type SchedulePhoneAppointmentStatus =
  (typeof SCHEDULE_PHONE_APPOINTMENT_STATUSES)[number];

/** `cancel_phone_appointment`. `already_cancelled` is idempotent, not an error. */
export const CANCEL_PHONE_APPOINTMENT_STATUSES = [
  'ok',
  'already_cancelled',
  'invalid_reason',
  'not_found',
  'not_live',
  'version_conflict',
] as const;

export type CancelPhoneAppointmentStatus = (typeof CANCEL_PHONE_APPOINTMENT_STATUSES)[number];

/** `set_phone_halt` — the kill switch, with a fixed reason vocabulary. */
export const SET_PHONE_HALT_STATUSES = ['ok', 'invalid_reason'] as const;

export type SetPhoneHaltStatus = (typeof SET_PHONE_HALT_STATUSES)[number];

/**
 * `clear_phone_halt` — a MISSING control singleton answers `halt_unreadable`
 * rather than inventing a cleared one, because inventing it would turn a
 * fail-closed stop into a go.
 */
export const CLEAR_PHONE_HALT_STATUSES = ['ok', 'halt_unreadable'] as const;

export type ClearPhoneHaltStatus = (typeof CLEAR_PHONE_HALT_STATUSES)[number];

/** `expire_phone_appointments` — a bounded sweep always answers `ok`. */
export const EXPIRE_PHONE_APPOINTMENTS_STATUSES = ['ok'] as const;

export type ExpirePhoneAppointmentsStatus = (typeof EXPIRE_PHONE_APPOINTMENTS_STATUSES)[number];

/** `phone_backlog` — a read-only projection always answers `ok`. */
export const PHONE_BACKLOG_STATUSES = ['ok'] as const;

export type PhoneBacklogStatus = (typeof PHONE_BACKLOG_STATUSES)[number];

/**
 * `attach_phone_attempt_recording` (0043) — the ONLY door that binds audio.
 *
 * `disclosure_not_delivered` is the load-bearing member and the reason this
 * RPC exists at all: the engagement must already be `in_call`, which 0042
 * reaches through exactly one transition (`disclosure.delivered`). A caller
 * that starts an egress at originate, at ring, at join, while unclassified,
 * on a machine or after a refusal gets this refusal from the state machine
 * rather than from the order of two statements in a worker.
 *
 * `already_bound` is deliberately distinct from `ok`+duplicate: re-binding the
 * IDENTICAL triple is idempotent success, re-binding a DIFFERENT one is
 * refused rather than silently overwriting a key a purge may already have been
 * told to delete.
 */
export const ATTACH_PHONE_ATTEMPT_RECORDING_STATUSES = [
  'ok',
  'already_bound',
  'attempt_not_recordable',
  'authoritative_exists',
  'disclosure_not_delivered',
  'engagement_terminal',
  'invalid_egress_id',
  'invalid_manifest_key',
  'invalid_object_key',
  'invalid_role',
  'not_found',
] as const;

export const STAMP_PHONE_SESSION_EGRESS_STATUSES = [
  'ok',
  'egress_already_bound',
  'invalid_egress_id',
  'not_found',
  'recording_terminal',
  'session_already_bound',
  'session_candidate_mismatch',
  'session_not_found',
] as const;

export type StampPhoneSessionEgressStatus =
  (typeof STAMP_PHONE_SESSION_EGRESS_STATUSES)[number];

export type AttachPhoneAttemptRecordingStatus =
  (typeof ATTACH_PHONE_ATTEMPT_RECORDING_STATUSES)[number];

/** `finalize_phone_attempt_recording` (0043). */
export const FINALIZE_PHONE_ATTEMPT_RECORDING_STATUSES = [
  'ok',
  'invalid_egress_id',
  'invalid_egress_status',
  'no_recording',
  'not_found',
] as const;

export type FinalizePhoneAttemptRecordingStatus =
  (typeof FINALIZE_PHONE_ATTEMPT_RECORDING_STATUSES)[number];

/**
 * `list_phone_engagement_recordings` (0043) — what a purge must delete.
 *
 * An engagement with NO artifacts answers `ok` with an empty list, which is a
 * DISTINCT SUCCESS. Conflating "nothing exists" with "we could not tell" is
 * exactly how a purge quietly reports done.
 */
export const LIST_PHONE_ENGAGEMENT_RECORDINGS_STATUSES = ['ok', 'not_found'] as const;

export type ListPhoneEngagementRecordingsStatus =
  (typeof LIST_PHONE_ENGAGEMENT_RECORDINGS_STATUSES)[number];

/** `clear_phone_attempt_recordings` (0043) — records a VERIFIED deletion. */
export const CLEAR_PHONE_ATTEMPT_RECORDINGS_STATUSES = ['ok', 'not_found'] as const;

export type ClearPhoneAttemptRecordingsStatus =
  (typeof CLEAR_PHONE_ATTEMPT_RECORDINGS_STATUSES)[number];

/**
 * `start_phone_assessment` (0044). `disclosure_not_delivered` is the
 * load-bearing member and the reason it is a refusal rather than a silent
 * no-op: the engagement must already be `in_call`, which 0042 reaches through
 * exactly one transition, so a screening cannot begin on a call nobody
 * consented to. `invalid_role_template` is the second: a malformed template is
 * refused rather than replaced by the defaults, because screening somebody
 * against questions nobody chose — while the recruiter believes their own are
 * running — is the worse of the two failures. `session_candidate_mismatch` and
 * `session_binding_mismatch` are what make the binding VERIFIED rather than
 * taken on the worker's word.
 */
export const START_PHONE_ASSESSMENT_STATUSES = [
  'ok',
  // A session that is already `completed` AND already carries a phone-sourced
  // assessment: a SCORED screening whose acknowledgement was lost. It is kept
  // DISTINCT from `session_not_active` because the two demand opposite
  // actions — one means "you cannot screen", the other means "the screening is
  // finished, go and say so". Collapsing them leaves the engagement with no
  // way to reach `completed` from any leg.
  'already_scored',
  'disclosure_not_delivered',
  'engagement_terminal',
  'invalid_role_template',
  'plan_missing',
  'session_already_bound',
  'session_binding_mismatch',
  'session_candidate_mismatch',
  'session_not_active',
  'unknown_attempt',
  'unknown_session',
] as const;

export type StartPhoneAssessmentStatus = (typeof START_PHONE_ASSESSMENT_STATUSES)[number];

/**
 * `get_phone_assessment_state` (0044) — the only read a resuming leg does.
 * `plan_missing` is deliberately distinct from `unknown_session`: the caller
 * must go and START an assessment, and must never invent a plan of its own.
 */
export const GET_PHONE_ASSESSMENT_STATE_STATUSES = [
  'ok',
  'plan_missing',
  'unknown_session',
] as const;

export type GetPhoneAssessmentStateStatus =
  (typeof GET_PHONE_ASSESSMENT_STATE_STATUSES)[number];

/**
 * `commit_phone_question_boundary` (0044).
 *
 * `key_not_current` is what stops a model choosing its own question — and
 * therefore what stops it skipping a mandatory one. `stale_cursor` covers an
 * OMITTED expected index as well as a wrong one, because a CAS a caller may
 * leave out is a guard that can be skipped. `applied` covers the duplicate
 * re-post too: a retry after a lost response is answered with the ORIGINAL
 * success rather than appending the exchange twice.
 */
export const COMMIT_PHONE_QUESTION_BOUNDARY_STATUSES = [
  'applied',
  'invalid_turns',
  'key_not_current',
  'plan_complete',
  'plan_missing',
  'session_not_active',
  'stale_cursor',
  'unknown_session',
] as const;

export type CommitPhoneQuestionBoundaryStatus =
  (typeof COMMIT_PHONE_QUESTION_BOUNDARY_STATUSES)[number];

/** The per-RPC vocabularies, keyed by RPC name. */
export const PHONE_RPC_STATUSES: Readonly<Record<PhoneRpcName, readonly string[]>> =
  Object.freeze({
    admit_phone_attempt: ADMIT_PHONE_ATTEMPT_STATUSES,
    heartbeat_phone_attempt: HEARTBEAT_PHONE_ATTEMPT_STATUSES,
    reclaim_phone_attempt_leases: RECLAIM_PHONE_ATTEMPT_LEASES_STATUSES,
    apply_phone_event: APPLY_PHONE_EVENT_STATUSES,
    schedule_phone_appointment: SCHEDULE_PHONE_APPOINTMENT_STATUSES,
    cancel_phone_appointment: CANCEL_PHONE_APPOINTMENT_STATUSES,
    set_phone_halt: SET_PHONE_HALT_STATUSES,
    clear_phone_halt: CLEAR_PHONE_HALT_STATUSES,
    expire_phone_appointments: EXPIRE_PHONE_APPOINTMENTS_STATUSES,
    phone_backlog: PHONE_BACKLOG_STATUSES,
    attach_phone_attempt_recording: ATTACH_PHONE_ATTEMPT_RECORDING_STATUSES,
    stamp_phone_session_egress: STAMP_PHONE_SESSION_EGRESS_STATUSES,
    finalize_phone_attempt_recording: FINALIZE_PHONE_ATTEMPT_RECORDING_STATUSES,
    list_phone_engagement_recordings: LIST_PHONE_ENGAGEMENT_RECORDINGS_STATUSES,
    clear_phone_attempt_recordings: CLEAR_PHONE_ATTEMPT_RECORDINGS_STATUSES,
    start_phone_assessment: START_PHONE_ASSESSMENT_STATUSES,
    get_phone_assessment_state: GET_PHONE_ASSESSMENT_STATE_STATUSES,
    commit_phone_question_boundary: COMMIT_PHONE_QUESTION_BOUNDARY_STATUSES,
    heartbeat_phone_attempt_by_epoch: HEARTBEAT_PHONE_ATTEMPT_BY_EPOCH_STATUSES,
    sweep_phone_day_rolled: SWEEP_PHONE_DAY_ROLLED_STATUSES,
    sweep_phone_stranded_sessions: SWEEP_PHONE_STRANDED_SESSIONS_STATUSES,
    claim_phone_sweep: CLAIM_PHONE_SWEEP_STATUSES,
  });

/**
 * The union of every status any phone RPC can return. The count is pinned by
 * the drift test so a migration that adds a refusal cannot land without this
 * file being revisited.
 */
export const PHONE_RPC_STATUS_UNION: readonly string[] = Object.freeze(
  Array.from(new Set(PHONE_RPC_NAMES.flatMap((n) => PHONE_RPC_STATUSES[n]))).sort(),
);

/**
 * Number of DISTINCT statuses across all seventeen RPCs, as of 0044.
 *
 * 0042 contributed 44. 0043 adds ten members that were not already in the
 * union — `already_bound`, `attempt_not_recordable`, `authoritative_exists`,
 * `disclosure_not_delivered`, `invalid_egress_id`, `invalid_egress_status`,
 * `invalid_manifest_key`, `invalid_object_key`, `invalid_role` and
 * `no_recording`. Its other members (`ok`, `not_found`, `engagement_terminal`)
 * were already present, which is why that was 54 and not 57.
 *
 * 0044 adds the assessment RPCs plus `assessment_missing`, the new pre-insert
 * refusal on `apply_phone_event`. Several of their members were already in the
 * union (`ok`, `applied`, `disclosure_not_delivered`, `engagement_terminal`,
 * `unknown_attempt`), which is why the increment is smaller than the member
 * count. The exact number is RE-DERIVED by the drift test from the migration
 * text, so this constant is a tripwire and never the source.
 *
 * 0045 took it from 68 to 72: `candidate_call_in_flight` and
 * `candidate_daily_attempt_exists` on admission, and `held_by_other` and
 * `invalid_input` on the sweep claim. The two sweeps and the epoch-fenced
 * heartbeat added no new members — `ok` and `lease_lost` were already in the
 * union, which is the whole reason the increment is smaller than the number
 * of RPCs added.
 */
export const PHONE_RPC_STATUS_COUNT = 75;

/**
 * RESULT KEYS the API's behaviour DEPENDS on, per RPC.
 *
 * `PHONE_RPC_PARAMETERS` pins what we send; this pins what we read. The two are
 * not the same risk. A renamed parameter is a 404 at runtime — loud. A renamed
 * RESULT key is silent, and at least one of these is load-bearing in a
 * destructive direction: the calendar API classifies a reschedule whose
 * `superseded_appointment_id` is absent-or-null as a lost update and CANCELS
 * the appointment it just created. If 0042 renamed that key, every legitimate
 * reschedule would destroy its own slot and report `version_conflict`.
 *
 * `phone-screening-rpc-contract.test.ts` asserts each key appears in the
 * corresponding function body, so the rename cannot land unnoticed.
 */
export const PHONE_RPC_RESULT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  schedule_phone_appointment: [
    'appointment_id',
    'version',
    'engagement_state',
    'superseded_appointment_id',
  ],
  cancel_phone_appointment: ['appointment_id', 'version'],
  set_phone_halt: ['already_halted'],
  clear_phone_halt: ['was_halted'],
  admit_phone_attempt: ['attempt_id', 'lease_token', 'lease_expires_at'],
  apply_phone_event: ['applied', 'ignored_reason', 'event_id', 'duplicate'],
  // 0043. `artifacts` is load-bearing in the same destructive direction as
  // `superseded_appointment_id`: a purge that read an absent key as an empty
  // list would delete nothing and then report success.
  list_phone_engagement_recordings: ['artifacts', 'count'],
  clear_phone_attempt_recordings: ['cleared'],
  attach_phone_attempt_recording: ['attempt_id', 'role', 'duplicate'],
  stamp_phone_session_egress: ['duplicate'],
  finalize_phone_attempt_recording: ['attempt_id', 'egress_status', 'role'],
  // 0044. Every one of these is load-bearing for a decision the worker makes
  // on the wire. `next_key` and `cursor` decide which question is asked next;
  // `questions` is the plan the model is bound to; `turns` rehydrates the
  // conversation; `assessment_exists` and `plan_complete` gate the completion
  // claim. A key that silently went missing would read as "nothing done yet"
  // and re-ask a question the candidate already answered.
  //
  // `start_phone_assessment` is deliberately absent: on success it returns
  // `get_phone_assessment_state`'s payload verbatim, so pinning the same keys
  // against a body that does not contain them would be a vacuous assertion.
  get_phone_assessment_state: [
    'questions',
    'question_count',
    'cursor',
    'next_key',
    'completed_keys',
    'turns',
    'assessment_exists',
    'already_scored',
    'plan_complete',
  ],
  commit_phone_question_boundary: [
    'question_key',
    'question_index',
    'first_turn_index',
    'last_turn_index',
    'cursor',
    'plan_complete',
    'expected_key',
  ],
});

/**
 * The status a store adapter reports when the RPC could not be reached or
 * answered with something outside its own vocabulary. It is deliberately NOT
 * a member of any RPC's vocabulary, so a caller can never confuse "the
 * database refused" with "we never got an answer".
 */
export const PHONE_RPC_UNKNOWN_STATUS = 'unknown_status';

/**
 * Narrow an RPC answer to that RPC's declared vocabulary. Anything else —
 * a null body, a missing `status`, a status from a newer migration — becomes
 * `unknown_status`, which callers must treat as "did not happen" rather than
 * as a refusal they recognise.
 */
export function narrowPhoneRpcStatus<T extends string>(
  rpc: PhoneRpcName,
  data: unknown,
): T | typeof PHONE_RPC_UNKNOWN_STATUS {
  const raw = (data as { status?: unknown } | null | undefined)?.status;
  if (typeof raw !== 'string') return PHONE_RPC_UNKNOWN_STATUS;
  return (PHONE_RPC_STATUSES[rpc] as readonly string[]).includes(raw)
    ? (raw as T)
    : PHONE_RPC_UNKNOWN_STATUS;
}
