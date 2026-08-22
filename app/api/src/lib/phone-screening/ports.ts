/**
 * phone-screening/ports.ts — the DB-free seam.
 *
 * Every result shape a 0042 RPC can produce, declared without importing a
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
}
