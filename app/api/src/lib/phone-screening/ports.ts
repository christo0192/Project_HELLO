/**
 * phone-screening/ports.ts — the DB-free seam.
 *
 * Every result shape a 0042/0043/0044 RPC can produce, declared without importing a
 * Supabase client. The domain facade depends on THIS file; `stores.ts` is the
 * one place a client appears. Tests drive in-memory fakes through the same
 * interface production wires the thin RPC adapters into — the ports/stores
 * pattern the Ashby lane already uses.
 *
 * SECURITY: opaque ids, counts, timestamps and sanitized status codes only.
 * No phone number, no digest, no provider payload and no lease secret beyond
 * the token a caller must hold to heartbeat.
 */

import type {
  AdmitPhoneAttemptStatus,
  ApplyPhoneEventStatus,
  CancelPhoneAppointmentStatus,
  ClearPhoneHaltStatus,
  ExpirePhoneAppointmentsStatus,
  HeartbeatPhoneAttemptStatus,
  PhoneBacklogStatus,
  ReclaimPhoneAttemptLeasesStatus,
  SchedulePhoneAppointmentStatus,
  SetPhoneHaltStatus,
  AttachPhoneAttemptRecordingStatus,
  FinalizePhoneAttemptRecordingStatus,
  ListPhoneEngagementRecordingsStatus,
  ClearPhoneAttemptRecordingsStatus,
  CommitPhoneQuestionBoundaryStatus,
  GetPhoneAssessmentStateStatus,
  StartPhoneAssessmentStatus,
  PHONE_RPC_UNKNOWN_STATUS,
} from './rpc-contract.js';
import type {
  PhoneAppointmentCancelReason,
  PhoneAppointmentSource,
  PhoneAttemptKind,
  PhoneAttemptState,
  PhoneEngagementState,
  PhoneEventIgnoredReason,
  PhoneEventSource,
  PhoneHaltReason,
  PhoneRecordingRole,
} from './vocabulary.js';

/** Every store result carries either a declared status or `unknown_status`. */
type OrUnknown<T extends string> = T | typeof PHONE_RPC_UNKNOWN_STATUS;

// ═══════════════════════════════════════════════════════════════════════
// admit_phone_attempt
// ═══════════════════════════════════════════════════════════════════════

export interface AdmitPhoneAttemptInput {
  readonly engagementId: string;
  readonly kind: PhoneAttemptKind;
  readonly leaseOwner?: string | null;
  readonly leaseSeconds?: number;
  /** Injected. Passed through as `p_now`; never defaulted to the host clock here. */
  readonly now: Date;
}

export interface AdmitPhoneAttemptResult {
  readonly status: OrUnknown<AdmitPhoneAttemptStatus>;
  /** Present only on `ok`. Returning `ok` means live work exists. */
  readonly attemptId?: string;
  readonly attemptSeq?: number;
  readonly kind?: PhoneAttemptKind;
  readonly epoch?: number;
  readonly istDate?: string;
  /** The concurrency-lease token this caller must heartbeat with. */
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: string;
  readonly liveBefore?: number;
  /** Refusal detail, when the refusal carries one. Codes and counts only. */
  readonly detail?: PhoneAdmissionRefusalDetail;
}

/**
 * The sanitized extra fields the refusal branches carry. Every member is a
 * code, a count or an instant — nothing here is free text and nothing is
 * derived from a provider payload.
 */
export interface PhoneAdmissionRefusalDetail {
  readonly state?: string;
  readonly kind?: string;
  readonly terminalState?: string;
  readonly lifecycle?: string;
  readonly mappingStatus?: string;
  readonly ingestionState?: string;
  readonly consentStatus?: string;
  readonly nextEligibleAt?: string;
  readonly noAnswerAttempts?: number;
  readonly istDate?: string;
  readonly live?: number;
  readonly maxConcurrent?: number;
  readonly constraint?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// heartbeat / reclaim
// ═══════════════════════════════════════════════════════════════════════

export interface HeartbeatPhoneAttemptInput {
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly leaseSeconds?: number;
  readonly now: Date;
}

export interface HeartbeatPhoneAttemptResult {
  readonly status: OrUnknown<HeartbeatPhoneAttemptStatus>;
  readonly leaseExpiresAt?: string;
}

export interface ReclaimPhoneAttemptLeasesResult {
  readonly status: OrUnknown<ReclaimPhoneAttemptLeasesStatus>;
  readonly reclaimed?: number;
  readonly limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// apply_phone_event
// ═══════════════════════════════════════════════════════════════════════

export interface ApplyPhoneEventInput {
  readonly source: PhoneEventSource;
  readonly eventType: string;
  readonly attemptId?: string | null;
  readonly engagementId?: string | null;
  readonly providerEventId?: string | null;
  readonly epoch?: number | null;
  /**
   * Sanitized metadata only. The RPC drops an unsanitized envelope and stores
   * `{"metadata_rejected": true}` instead — the event is never lost, and the
   * marker says plainly that something was discarded.
   */
  readonly metadata?: Record<string, unknown> | null;
  readonly now: Date;
}

export interface ApplyPhoneEventResult {
  readonly status: OrUnknown<ApplyPhoneEventStatus>;
  readonly applied?: boolean;
  readonly ignoredReason?: PhoneEventIgnoredReason | null;
  readonly eventId?: string;
  /** A duplicate delivery writes NO second row and returns the FIRST answer. */
  readonly duplicate?: boolean;
  readonly engagementState?: PhoneEngagementState;
  readonly attemptState?: PhoneAttemptState;
  /** Present on `attempt_required`, which records nothing. */
  readonly eventType?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// The internal calendar
// ═══════════════════════════════════════════════════════════════════════

export interface SchedulePhoneAppointmentInput {
  readonly engagementId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly source: PhoneAppointmentSource;
  readonly actorId?: string | null;
  readonly expectedVersion?: number | null;
  readonly now: Date;
}

export interface SchedulePhoneAppointmentResult {
  readonly status: OrUnknown<SchedulePhoneAppointmentStatus>;
  readonly appointmentId?: string;
  readonly version?: number;
  readonly engagementState?: PhoneEngagementState;
  readonly supersededAppointmentId?: string | null;
}

export interface CancelPhoneAppointmentInput {
  readonly appointmentId: string;
  readonly reason: PhoneAppointmentCancelReason;
  readonly actorId?: string | null;
  readonly expectedVersion?: number | null;
  readonly now: Date;
}

export interface CancelPhoneAppointmentResult {
  readonly status: OrUnknown<CancelPhoneAppointmentStatus>;
  readonly appointmentId?: string;
  readonly version?: number;
  readonly appointmentStatus?: string;
}

export interface ExpirePhoneAppointmentsResult {
  readonly status: OrUnknown<ExpirePhoneAppointmentsStatus>;
  readonly expired?: number;
  readonly graceSeconds?: number;
  readonly limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// The kill switch
// ═══════════════════════════════════════════════════════════════════════

export interface SetPhoneHaltResult {
  readonly status: OrUnknown<SetPhoneHaltStatus>;
  /** True when a halt was ALREADY in force; the original instant is preserved. */
  readonly alreadyHalted?: boolean;
}

export interface ClearPhoneHaltResult {
  readonly status: OrUnknown<ClearPhoneHaltStatus>;
  readonly wasHalted?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// phone_backlog — counts and ages only
// ═══════════════════════════════════════════════════════════════════════

export interface PhoneBacklogResult {
  readonly status: OrUnknown<PhoneBacklogStatus>;
  readonly admission?: {
    readonly controlPresent: boolean;
    /** A MISSING singleton reports halted TRUE. Never read as running normally. */
    readonly halted: boolean;
    readonly haltReason: string | null;
  };
  readonly engagementsByState?: Readonly<Record<string, number>>;
  readonly attempts?: {
    readonly live: number;
    readonly liveWithUnexpiredLease: number;
    readonly maxConcurrent: number;
    readonly oldestLiveAgeSeconds: number;
  };
  readonly appointments?: { readonly live: number; readonly overdue: number };
  readonly events?: {
    readonly ignoredLast24h: number;
    readonly unknownAttemptLast24h: number;
    readonly staleEpochLast24h: number;
    readonly terminalLast24h: number;
    readonly unexpectedEventLast24h: number;
  };
  readonly windowOpen?: boolean;
  readonly istDate?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 0043 — recording artifacts
// ═══════════════════════════════════════════════════════════════════════

export interface AttachPhoneAttemptRecordingInput {
  readonly attemptId: string;
  readonly objectKey: string;
  readonly manifestKey?: string | null;
  readonly role: PhoneRecordingRole;
  readonly egressId?: string | null;
  readonly now: Date;
}

export interface AttachPhoneAttemptRecordingResult {
  readonly status: AttachPhoneAttemptRecordingStatus | typeof PHONE_RPC_UNKNOWN_STATUS;
  readonly attemptId?: string;
  readonly role?: PhoneRecordingRole;
  /** True when the IDENTICAL triple was already bound. Success, not a refusal. */
  readonly duplicate?: boolean;
  /** Present on `disclosure_not_delivered`, so a caller can log WHY it refused. */
  readonly engagementState?: string;
  readonly attemptState?: string;
}

export interface FinalizePhoneAttemptRecordingResult {
  readonly status: FinalizePhoneAttemptRecordingStatus | typeof PHONE_RPC_UNKNOWN_STATUS;
  readonly attemptId?: string;
  readonly egressStatus?: string;
  readonly role?: PhoneRecordingRole;
}

/**
 * One attempt's artifacts. BOTH keys are carried, because deleting the
 * recording and forgetting the manifest is a documented trap, and the role is
 * carried so a caller can prove it purged the supplementary ones too.
 */
export interface PhoneRecordingArtifact {
  readonly attemptId: string;
  readonly role: PhoneRecordingRole;
  readonly objectKey: string;
  readonly manifestKey: string | null;
  /**
   * The provider's egress id, when one was recorded. Carried because a purge
   * must be able to STOP a running egress, and it cannot stop what it cannot
   * name.
   */
  readonly egressId: string | null;
  /**
   * `active` means the egress is still writing, and the object has NOT been
   * uploaded yet. A purge that deleted at this point would delete nothing,
   * verify the absence of a file that does not exist yet, and report success
   * moments before the recording landed.
   */
  readonly egressStatus: string | null;
}

export interface ListPhoneEngagementRecordingsResult {
  readonly status: ListPhoneEngagementRecordingsStatus | typeof PHONE_RPC_UNKNOWN_STATUS;
  /**
   * ABSENT is not the same as EMPTY. An empty array means "this engagement has
   * nothing to purge", a distinct success; `undefined` means we never got an
   * answer and the caller must NOT proceed to a terminal event.
   */
  readonly artifacts?: readonly PhoneRecordingArtifact[];
  readonly count?: number;
}

export interface ClearPhoneAttemptRecordingsResult {
  readonly status: ClearPhoneAttemptRecordingsStatus | typeof PHONE_RPC_UNKNOWN_STATUS;
  /** Rows whose keys were forgotten. `0` is a distinct success. */
  readonly cleared?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 0044 — assessment persistence, keyed resume, truthful completion
// ═══════════════════════════════════════════════════════════════════════

/** One question in the immutable, session-scoped plan. */
export interface PhonePlanQuestion {
  readonly key: string;
  readonly text: string;
  readonly mandatory: boolean;
  readonly hint: string | null;
}

/** One persisted turn of the assessment transcript. */
export interface PhoneAssessmentTurn {
  readonly turnIndex: number;
  readonly speaker: 'bot' | 'candidate';
  readonly text: string;
}

/**
 * Everything a resuming leg needs, in one answer.
 *
 * `candidateName` and `sessionStatus` are a strict SUBSET of the worker
 * context the browser path has always resolved; nothing here carries a phone
 * number, a SIP or provider identifier, a room name, an attempt id or raw
 * resume text.
 */
export interface PhoneAssessmentState {
  readonly status: PhoneAssessmentStateStatus;
  readonly sessionId?: string;
  readonly sessionStatus?: string;
  readonly terminalReason?: string | null;
  /** The session's own start instant, so a completion can report a real duration. */
  readonly startedAt?: string | null;
  readonly candidateName?: string | null;
  readonly planSource?: string;
  readonly questionCount?: number;
  readonly questions?: readonly PhonePlanQuestion[];
  readonly cursor?: number;
  readonly nextKey?: string | null;
  readonly completedKeys?: readonly string[];
  readonly turns?: readonly PhoneAssessmentTurn[];
  readonly assessmentExists?: boolean;
  readonly planComplete?: boolean;
}

export type PhoneAssessmentStateStatus =
  | GetPhoneAssessmentStateStatus
  | StartPhoneAssessmentStatus
  | typeof PHONE_RPC_UNKNOWN_STATUS;

export interface StartPhoneAssessmentInput {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly now: Date;
}

/** One ordered exchange belonging to a single question boundary. */
export interface PhoneBoundaryTurn {
  readonly speaker: 'bot' | 'candidate';
  readonly text: string;
}

export interface CommitPhoneQuestionBoundaryInput {
  readonly sessionId: string;
  readonly questionKey: string;
  /**
   * The cursor the caller believes it is advancing. A CAS, not a hint — the
   * RPC refuses a null as firmly as a mismatch, because a compare-and-swap a
   * caller may omit is a guard that can be skipped.
   */
  readonly expectedIndex: number;
  /** The caller's idempotency key. A retry MUST reuse it. */
  readonly sourceEventId: string;
  readonly turns: readonly PhoneBoundaryTurn[];
  readonly now: Date;
}

export interface CommitPhoneQuestionBoundaryResult {
  readonly status: CommitPhoneQuestionBoundaryStatus | typeof PHONE_RPC_UNKNOWN_STATUS;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly questionKey?: string;
  readonly questionIndex?: number;
  readonly firstTurnIndex?: number;
  readonly lastTurnIndex?: number;
  readonly cursor?: number;
  readonly questionCount?: number;
  readonly planComplete?: boolean;
  /** Present on `key_not_current`: the key the cursor actually owes. */
  readonly expectedKey?: string;
  readonly sessionStatus?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// The port
// ═══════════════════════════════════════════════════════════════════════

/**
 * Every durable phone write and read, and NOTHING ELSE. There is deliberately
 * no generic table accessor on this interface: `0042`'s guarantees — the
 * advisory lock, the pinned lock order, the per-IST-day index, the budgets and
 * the append-only ledger — live entirely inside the RPCs, so a seam that could
 * insert a row directly would be a seam that can bypass all of them.
 */
export interface PhoneStores {
  admitAttempt(input: AdmitPhoneAttemptInput): Promise<AdmitPhoneAttemptResult>;
  heartbeatAttempt(input: HeartbeatPhoneAttemptInput): Promise<HeartbeatPhoneAttemptResult>;
  reclaimAttemptLeases(input: {
    limit?: number;
    now: Date;
  }): Promise<ReclaimPhoneAttemptLeasesResult>;
  applyEvent(input: ApplyPhoneEventInput): Promise<ApplyPhoneEventResult>;
  scheduleAppointment(
    input: SchedulePhoneAppointmentInput,
  ): Promise<SchedulePhoneAppointmentResult>;
  cancelAppointment(input: CancelPhoneAppointmentInput): Promise<CancelPhoneAppointmentResult>;
  expireAppointments(input: {
    graceSeconds?: number;
    limit?: number;
    now: Date;
  }): Promise<ExpirePhoneAppointmentsResult>;
  setHalt(input: {
    reason: PhoneHaltReason;
    actorId?: string | null;
    now: Date;
  }): Promise<SetPhoneHaltResult>;
  clearHalt(input: { actorId?: string | null; now: Date }): Promise<ClearPhoneHaltResult>;
  backlog(input: { now: Date }): Promise<PhoneBacklogResult>;
  attachAttemptRecording(
    input: AttachPhoneAttemptRecordingInput,
  ): Promise<AttachPhoneAttemptRecordingResult>;
  finalizeAttemptRecording(input: {
    attemptId: string;
    egressStatus: 'active' | 'complete' | 'failed';
    /** Supplied when the egress id was not known at attach time. */
    egressId?: string | null;
    now: Date;
  }): Promise<FinalizePhoneAttemptRecordingResult>;
  listEngagementRecordings(input: {
    engagementId: string;
  }): Promise<ListPhoneEngagementRecordingsResult>;
  /**
   * Records that every artifact has ALREADY been deleted and verified absent.
   * Deletes nothing. See `recording-purge.ts` for the ordering this must obey.
   */
  clearAttemptRecordings(input: {
    engagementId: string;
    actorId?: string | null;
    now: Date;
  }): Promise<ClearPhoneAttemptRecordingsResult>;
  /**
   * Binds the session, activates it and snapshots the plan — all idempotently.
   * Returns the full assessment state on success, so a resuming leg needs one
   * round trip rather than two it could observe between.
   */
  startAssessment(input: StartPhoneAssessmentInput): Promise<PhoneAssessmentState>;
  assessmentState(input: { sessionId: string }): Promise<PhoneAssessmentState>;
  commitQuestionBoundary(
    input: CommitPhoneQuestionBoundaryInput,
  ): Promise<CommitPhoneQuestionBoundaryResult>;
}
