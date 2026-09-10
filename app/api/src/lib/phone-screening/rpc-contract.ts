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
  'confirm_candidate_voice_callback',
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
  'commit_phone_question_boundary_with_coverage',
  // 0045
  'heartbeat_phone_attempt_by_epoch',
  'sweep_phone_day_rolled',
  'sweep_phone_stranded_sessions',
  'claim_phone_sweep',
  // 0057 — governed immutable cycle operations. Number verification is
  // deliberately outside this domain contract because its input is PII.
  'request_phone_rescreen',
  // 0060 — max-one candidate-specific same-objective probe.
  'record_phone_probe',
  'consent_and_start_phone_assessment',
  // 0063 — exclusive candidate-scoped production test gate.
  'arm_phone_test_gate',
  'admit_phone_test_attempt',
  // 0071 — per-item transcript persistence (X4) and the crashed-session
  // recording-finalization backstop sweep (X5b).
  'commit_phone_item_turn',
  'sweep_phone_stranded_recordings',
  // 0072 — server-side partial-finalize on a non-terminal-ending call.
  'finalize_phone_partial_sessions',
  // 0083 — immediate same-IST-day abandonment for a pre-originate infra defer
  // (worker_not_ready). Restores the engagement to its prior state; charges no
  // budget. Paired with the 0083 narrowed per-IST-day index.
  'abandon_phone_attempt_infra',
  // 0094 — the do-not-call write path. `phone_suppressions` had been READ by
  // admission since 0042 with nothing anywhere able to write it; these are
  // that missing door. All three take a candidate id and never a number.
  'suppress_candidate_phone',
  'release_candidate_phone_suppression',
  'phone_suppression_state',
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
    confirm_candidate_voice_callback: ['p_attempt_id', 'p_starts_at', 'p_now'],
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
      'p_egress_started_at_ms',
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
      // 0086 (Finding B): defaulted, BEFORE p_now — time injection stays the
      // final parameter of every time-dependent RPC (contract invariant).
      'p_disposition',
      'p_now',
    ],
    commit_phone_question_boundary_with_coverage: [
      'p_session_id',
      'p_question_key',
      'p_expected_index',
      'p_source_event_id',
      'p_turns',
      'p_covered_question_keys',
      // 0086 (Finding B): forwarded to the base commit, which validates it.
      'p_disposition',
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
    request_phone_rescreen: [
      'p_candidate_id',
      'p_reason',
      'p_request_id',
      'p_source',
      'p_actor_id',
      'p_now',
    ],
    record_phone_probe: [
      'p_session_id',
      'p_question_key',
      'p_expected_index',
      'p_source_event_id',
      'p_now',
    ],
    consent_and_start_phone_assessment: [
      'p_attempt_id', 'p_session_id', 'p_epoch', 'p_now',
    ],
    arm_phone_test_gate: [
      'p_candidate_id', 'p_engagement_id', 'p_actor_id', 'p_request_id', 'p_expires_at', 'p_now',
    ],
    admit_phone_test_attempt: [
      'p_test_gate_id', 'p_engagement_id', 'p_kind', 'p_lease_owner', 'p_lease_seconds', 'p_now',
    ],
    // 0071.
    commit_phone_item_turn: [
      'p_session_id', 'p_speaker', 'p_text', 'p_source_item_id',
      'p_turn_started_at_ms', 'p_now',
    ],
    sweep_phone_stranded_recordings: [
      'p_limit', 'p_grace_seconds', 'p_now',
    ],
    // 0072.
    finalize_phone_partial_sessions: [
      'p_limit', 'p_grace_seconds', 'p_now',
    ],
    // 0083 (P3 adds p_backoff_seconds between the attempt id and p_now).
    abandon_phone_attempt_infra: ['p_attempt_id', 'p_backoff_seconds', 'p_now'],
    // 0094 — the do-not-call write path. No `p_phone`: the number is read
    // from the candidate row inside the RPC and digested there.
    suppress_candidate_phone: [
      'p_candidate_id', 'p_reason', 'p_source', 'p_actor_id', 'p_now',
    ],
    release_candidate_phone_suppression: ['p_candidate_id', 'p_actor_id', 'p_now'],
    phone_suppression_state: ['p_candidate_id'],
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
  // ── 0094: the FLEET daily cap ─────────────────────────────────────────
  // Every daily refusal above is scoped to one engagement or one person.
  // This one is scoped to the whole system: `phone_max_daily_dials()` cold
  // calls per IST day, counted under the admission lock. It is the
  // compensating control that lets `PHONE_DIAL_SCOPE=pipeline` retire the
  // hand-maintained digest allowlist without giving up a bound on how many
  // DISTINCT people a bug could ring. Deliberately NOT `at_capacity`: that
  // is simultaneity and clears itself as calls end, while this clears at
  // IST midnight.
  'fleet_daily_cap_reached',
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

/**
 * `abandon_phone_attempt_infra` (0083) — immediate same-IST-day abandonment of
 * a pre-originate infra defer. `abandoned` on success, `already_ended` when the
 * attempt is already terminal (a duplicate refusal — idempotent no-op),
 * `unknown_attempt` when the id is unknown, `invalid_request` on a null id.
 */
export const ABANDON_PHONE_ATTEMPT_INFRA_STATUSES = [
  'abandoned',
  'already_ended',
  'unknown_attempt',
  'invalid_request',
] as const;

export type ReclaimPhoneAttemptLeasesStatus =
  (typeof RECLAIM_PHONE_ATTEMPT_LEASES_STATUSES)[number];

/** `request_phone_rescreen` (0057) — explicit, bounded cycle intent. */
export const REQUEST_PHONE_RESCREEN_STATUSES = [
  'ok',
  'already_requested',
  'active_cycle',
  'application_not_found',
  'application_not_live',
  'candidate_not_found',
  'consent_expired',
  'consent_not_granted',
  'cycle_limit_reached',
  'engagement_not_found',
  'idempotency_conflict',
  'invalid_reason',
  'invalid_request_id',
  'invalid_source',
  'not_eligible',
  'opted_out',
  'wrong_number_unverified',
  'actor_required',
] as const;
export type RequestPhoneRescreenStatus = (typeof REQUEST_PHONE_RESCREEN_STATUSES)[number];


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

export const CONFIRM_CANDIDATE_VOICE_CALLBACK_STATUSES = [
  'ok', 'already_confirmed', 'invalid_input', 'unknown_attempt',
  'engagement_terminal', 'attempt_in_flight', 'lead_time_too_short',
  'window_closed', 'slot_straddles_ist_midnight', 'slot_not_yet_eligible',
  'daily_attempt_exists', 'slot_full',
] as const;
export type ConfirmCandidateVoiceCallbackStatus =
  (typeof CONFIRM_CANDIDATE_VOICE_CALLBACK_STATUSES)[number];

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

/**
 * `suppress_candidate_phone` (0094) — the do-not-call write path.
 *
 * Takes a CANDIDATE ID, never a number: the RPC reads `phone_e164` from the
 * candidate row and digests it itself, so no caller can supply or learn one.
 * `ok` is returned for a repeat too — the result carries `already_suppressed`
 * — because the outcome the caller asked for is true either way, and an error
 * on a second click is how operators learn to click twice.
 */
export const SUPPRESS_CANDIDATE_PHONE_STATUSES = [
  'ok',
  'candidate_not_found',
  'invalid_reason',
  'invalid_source',
  'phone_absent',
] as const;

export type SuppressCandidatePhoneStatus = (typeof SUPPRESS_CANDIDATE_PHONE_STATUSES)[number];

/**
 * `release_candidate_phone_suppression` (0094) — lifting the promise.
 *
 * `not_suppressed` is distinct from `ok` on purpose: this is the direction
 * that can cause a call, so "there was nothing to lift" must not read as
 * "lifted".
 */
export const RELEASE_CANDIDATE_PHONE_SUPPRESSION_STATUSES = [
  'ok',
  'candidate_not_found',
  'not_suppressed',
  'phone_absent',
] as const;

export type ReleaseCandidatePhoneSuppressionStatus =
  (typeof RELEASE_CANDIDATE_PHONE_SUPPRESSION_STATUSES)[number];

/** `phone_suppression_state` (0094) — a read; never returns the digest. */
export const PHONE_SUPPRESSION_STATE_STATUSES = ['ok', 'candidate_not_found'] as const;

export type PhoneSuppressionStateStatus = (typeof PHONE_SUPPRESSION_STATE_STATUSES)[number];

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
  'invalid_egress_started_at',
  'not_found',
  'recording_terminal',
  'session_already_bound',
  'session_binding_mismatch',
  'session_candidate_mismatch',
  'session_not_active',
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
  // 0086 (Finding B): a non-null disposition outside the closed vocabulary
  // is refused before anything is written — the database defends its own
  // column even though the API schema gates the same enum a round trip
  // earlier.
  'invalid_disposition',
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

/**
 * 0086 (Codex review Finding B) — the closed per-key boundary outcome
 * vocabulary. The worker computes exactly one of these at commit time;
 * `phone_session_progress.disposition` records it (NULL = not measured).
 * Cursor advancement must not imply asked or covered — this is the durable
 * record of which it was.
 */
export const PHONE_BOUNDARY_DISPOSITIONS = [
  'asked_answered',
  'volunteered_with_evidence',
  'asked_declined',
  'asked_unanswered',
  'not_delivered',
  'skipped_bounded',
] as const;
export type PhoneBoundaryDisposition = (typeof PHONE_BOUNDARY_DISPOSITIONS)[number];

export const COMMIT_PHONE_QUESTION_BOUNDARY_WITH_COVERAGE_STATUSES = [
  ...COMMIT_PHONE_QUESTION_BOUNDARY_STATUSES,
  'invalid_coverage',
  'duplicate',
] as const;
export type CommitPhoneQuestionBoundaryWithCoverageStatus =
  (typeof COMMIT_PHONE_QUESTION_BOUNDARY_WITH_COVERAGE_STATUSES)[number];

export const RECORD_PHONE_PROBE_STATUSES = [
  'probe_recorded', 'probe_denied', 'duplicate', 'invalid_input',
  'unknown_session', 'plan_missing', 'session_not_active', 'stale_cursor', 'key_not_current',
] as const;
export type RecordPhoneProbeStatus = (typeof RECORD_PHONE_PROBE_STATUSES)[number];

export const CONSENT_AND_START_PHONE_ASSESSMENT_STATUSES = ['ok', 'invalid_input', 'consent_start_failed'] as const;
export type ConsentAndStartPhoneAssessmentStatus = (typeof CONSENT_AND_START_PHONE_ASSESSMENT_STATUSES)[number];

export const ARM_PHONE_TEST_GATE_STATUSES = [
  'ok', 'already_armed', 'actor_required', 'invalid_request_id', 'invalid_expiry',
  'halt_unreadable', 'test_gate_requires_halt', 'test_gate_halt_not_permitted',
  'candidate_mismatch', 'application_not_found',
  'engagement_not_found', 'test_gate_not_eligible', 'test_gate_already_armed',
  // 0081: a `scheduled` engagement can be armed on its existing cycle only
  // when its live appointment is genuinely due (starts_at <= now < ends_at);
  // otherwise the RPC refuses with this status.
  'test_gate_appointment_not_due',
  'idempotency_conflict',
] as const;
export type ArmPhoneTestGateStatus = (typeof ARM_PHONE_TEST_GATE_STATUSES)[number];

export const ADMIT_PHONE_TEST_ATTEMPT_STATUSES = ['ok', 'halted'] as const;
export type AdmitPhoneTestAttemptStatus = (typeof ADMIT_PHONE_TEST_ATTEMPT_STATUSES)[number];

/**
 * `commit_phone_item_turn` (0071 / X4) — the per-item transcript writer.
 * `applied` on both a fresh write and an idempotent duplicate; `invalid_turn`
 * (SINGULAR — distinct from the boundary's `invalid_turns`) on a bad shape;
 * the two live-session refusals otherwise.
 */
export const COMMIT_PHONE_ITEM_TURN_STATUSES = [
  'applied', 'invalid_turn', 'unknown_session', 'session_not_active',
] as const;
export type CommitPhoneItemTurnStatus = (typeof COMMIT_PHONE_ITEM_TURN_STATUSES)[number];

/** `sweep_phone_stranded_recordings` (0071 / X5b) — a bounded sweep answers `ok`. */
export const SWEEP_PHONE_STRANDED_RECORDINGS_STATUSES = ['ok'] as const;
export type SweepPhoneStrandedRecordingsStatus =
  (typeof SWEEP_PHONE_STRANDED_RECORDINGS_STATUSES)[number];

/** `finalize_phone_partial_sessions` (0072) — a bounded sweep answers `ok`. */
export const FINALIZE_PHONE_PARTIAL_SESSIONS_STATUSES = ['ok'] as const;
export type FinalizePhonePartialSessionsStatus =
  (typeof FINALIZE_PHONE_PARTIAL_SESSIONS_STATUSES)[number];

/** The per-RPC vocabularies, keyed by RPC name. */
export const PHONE_RPC_STATUSES: Readonly<Record<PhoneRpcName, readonly string[]>> =
  Object.freeze({
    admit_phone_attempt: ADMIT_PHONE_ATTEMPT_STATUSES,
    heartbeat_phone_attempt: HEARTBEAT_PHONE_ATTEMPT_STATUSES,
    reclaim_phone_attempt_leases: RECLAIM_PHONE_ATTEMPT_LEASES_STATUSES,
    apply_phone_event: APPLY_PHONE_EVENT_STATUSES,
    schedule_phone_appointment: SCHEDULE_PHONE_APPOINTMENT_STATUSES,
    confirm_candidate_voice_callback: CONFIRM_CANDIDATE_VOICE_CALLBACK_STATUSES,
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
    commit_phone_question_boundary_with_coverage: COMMIT_PHONE_QUESTION_BOUNDARY_WITH_COVERAGE_STATUSES,
    heartbeat_phone_attempt_by_epoch: HEARTBEAT_PHONE_ATTEMPT_BY_EPOCH_STATUSES,
    sweep_phone_day_rolled: SWEEP_PHONE_DAY_ROLLED_STATUSES,
    sweep_phone_stranded_sessions: SWEEP_PHONE_STRANDED_SESSIONS_STATUSES,
    claim_phone_sweep: CLAIM_PHONE_SWEEP_STATUSES,
    request_phone_rescreen: REQUEST_PHONE_RESCREEN_STATUSES,
    record_phone_probe: RECORD_PHONE_PROBE_STATUSES,
    consent_and_start_phone_assessment: CONSENT_AND_START_PHONE_ASSESSMENT_STATUSES,
    arm_phone_test_gate: ARM_PHONE_TEST_GATE_STATUSES,
    admit_phone_test_attempt: ADMIT_PHONE_TEST_ATTEMPT_STATUSES,
    commit_phone_item_turn: COMMIT_PHONE_ITEM_TURN_STATUSES,
    sweep_phone_stranded_recordings: SWEEP_PHONE_STRANDED_RECORDINGS_STATUSES,
    finalize_phone_partial_sessions: FINALIZE_PHONE_PARTIAL_SESSIONS_STATUSES,
    abandon_phone_attempt_infra: ABANDON_PHONE_ATTEMPT_INFRA_STATUSES,
    suppress_candidate_phone: SUPPRESS_CANDIDATE_PHONE_STATUSES,
    release_candidate_phone_suppression: RELEASE_CANDIDATE_PHONE_SUPPRESSION_STATUSES,
    phone_suppression_state: PHONE_SUPPRESSION_STATE_STATUSES,
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
 *
 * 0071 takes it from 102 to 103: `commit_phone_item_turn` adds exactly ONE new
 * member, `invalid_turn` (SINGULAR — the boundary's `invalid_turns` is a
 * different string). Its other members (`applied`, `unknown_session`,
 * `session_not_active`) were already in the union, and
 * `sweep_phone_stranded_recordings` answers only `ok`, which was too — so a
 * two-RPC migration moves the count by one. The exact number is RE-DERIVED by
 * the drift test from the migration text; this constant is only a tripwire.
 *
 * 0081 takes it from 104 to 105: `arm_phone_test_gate` gains exactly ONE new
 * member, `test_gate_appointment_not_due` (the scheduled-but-not-due refusal).
 *
 * 0083 takes it from 105 to 108: `abandon_phone_attempt_infra` adds three new
 * members — `abandoned`, `already_ended` and `invalid_request`. Its fourth
 * member `unknown_attempt` was already in the union (from
 * `confirm_candidate_voice_callback` / `apply_phone_event`). The exact number is
 * RE-DERIVED by the drift test from the migration text; this constant is only a
 * tripwire.
 */
/*
 * 0086 takes it from 108 to 109: the boundary commit gains exactly ONE new
 * member, `invalid_disposition` (the closed-vocabulary refusal for the
 * Finding B per-key outcome column).
 */
/*
 * 0094 takes it from 109 to 112 — THREE new members across four new refusals:
 * `fleet_daily_cap_reached` (admit), `invalid_source` (suppress) and
 * `not_suppressed` (release). The fourth, `phone_absent`, was already in the
 * union, as were `ok`, `invalid_reason` (from `set_phone_halt`) and
 * `candidate_not_found` — which is why three new RPCs move the count by three
 * rather than by the seven statuses they name. The exact number is RE-DERIVED
 * by the drift test from the migration text; this constant is only a tripwire.
 */
export const PHONE_RPC_STATUS_COUNT = 112;

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
  confirm_candidate_voice_callback: [
    'appointment_id',
    'version',
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
  request_phone_rescreen: ['engagement_id', 'cycle_number', 'predecessor_engagement_id', 'request_id'],
  arm_phone_test_gate: ['gate_id', 'candidate_id', 'engagement_id', 'expires_at'],
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
