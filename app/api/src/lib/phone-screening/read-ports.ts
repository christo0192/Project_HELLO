/**
 * phone-screening/read-ports.ts — the READ seam.
 *
 * `ports.ts` declares the write seam and deliberately exposes no table
 * accessor at all: every 0042 guarantee — the admission advisory lock, the
 * pinned lock order, the per-IST-day index, the three budgets and the
 * insert-once ledger — lives inside the RPCs, so a seam that could insert a
 * row would bypass all of them at once.
 *
 * A READ bypasses nothing. There is no read RPC in 0042 beyond `phone_backlog`
 * (counts and ages only, no per-date or per-engagement breakdown), so an
 * operator calendar cannot be built from it, and adding one would be a
 * migration this phase is not allowed to write. This file therefore declares a
 * SECOND, strictly read-only port — and `phone-screening-structural.test.ts`
 * asserts mechanically that its implementation can only `.select(`, never
 * insert, update, upsert, delete or `.rpc(`.
 *
 * ── SANITIZATION IS A PROPERTY OF THIS FILE, NOT OF THE ROUTE ─────────
 * Every shape below is the projection itself. There is no `raw` variant and no
 * pass-through row anywhere: a column that is not named here cannot reach a
 * response, because nothing ever reads it. In particular NONE of these types
 * carries a phone number, a suppression digest, a SIP call id, a room name, a
 * participant identity, an egress id, a lease token, a lease owner, a provider
 * event id, provider metadata or a transcript. 0042 has no transcript and no
 * phone-number column at all; the number lives only on
 * `screening_v2.candidates.phone_e164` and is never selected here.
 */

import type {
  PhoneAppointmentSource,
  PhoneAppointmentStatus,
  PhoneAttemptKind,
  PhoneAttemptState,
  PhoneEngagementState,
  PhoneOutcomeClass,
} from './vocabulary.js';

// ═══════════════════════════════════════════════════════════════════════
// Row projections
// ═══════════════════════════════════════════════════════════════════════

/**
 * A `screening_v2.phone_appointments` row, minus `created_by`.
 *
 * `created_by` is an operator identity (or the all-zero system sentinel for a
 * deferral the substrate booked itself). It is deliberately absent: an
 * operator calendar needs to know a slot exists, never which colleague typed
 * it in, and an identity that is never read cannot be leaked.
 */
export interface PhoneAppointmentRow {
  readonly id: string;
  readonly engagementId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly istDate: string;
  readonly status: PhoneAppointmentStatus;
  readonly source: PhoneAppointmentSource;
  /**
   * NO WRITER EXISTS IN 0042 — this is always null today. Kept because the
   * status vocabulary carries `confirmed`, and a projection that silently
   * dropped the column would hide the residual rather than show it. See
   * `residuals.ts`, whose drift test fails the moment a writer appears.
   */
  readonly confirmedAt: string | null;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A `phone_engagements` row. No `candidate_id`/`application_link_id` linkage
 *  is exposed by the calendar; the detail read resolves the candidate itself. */
export interface PhoneEngagementRow {
  readonly id: string;
  readonly candidateId: string;
  readonly state: PhoneEngagementState;
  readonly stateReason: string | null;
  readonly epoch: number;
  readonly version: number;
  readonly noAnswerAttempts: number;
  readonly reconnectsUsed: number;
  readonly providerFailures: number;
  readonly nextEligibleAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly terminalAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A `phone_call_attempts` row, minus every provider-bearing column.
 *
 * `sip_call_id`, `room_name`, `participant_identity`, `egress_id`,
 * `egress_status`, `lease_token` and `lease_owner` are ABSENT rather than
 * redacted. `lease_token` in particular is a capability — a holder can
 * heartbeat someone else's fleet slot — and `participant_identity` embeds the
 * attempt uuid. Omission is the control; a field that is never selected cannot
 * be serialized by a later edit that forgets why it was masked.
 */
export interface PhoneAttemptRow {
  readonly id: string;
  readonly engagementId: string;
  readonly attemptSeq: number;
  readonly epoch: number;
  readonly kind: PhoneAttemptKind;
  readonly state: PhoneAttemptState;
  readonly outcomeClass: PhoneOutcomeClass | null;
  readonly istDate: string;
  readonly priorEngagementState: PhoneEngagementState;
  readonly admittedAt: string;
  readonly answeredAt: string | null;
  readonly classifiedAt: string | null;
  readonly endedAt: string | null;
}

/**
 * The candidate fields an operator calendar may show.
 *
 * `name` is deliberately included — the acceptance contract asks for it and an
 * interviewer already reads it on every candidate surface in this API. `email`,
 * `phone_raw`, `phone_e164`, `phone_valid`, `parsed` and `skills` are NOT read.
 * `reference` is `candidates.ats_external_id`, the only stable external
 * reference this schema carries; it is null for a candidate that never came
 * from an ATS, and no substitute is invented for that case.
 */
export interface PhoneCandidateRow {
  readonly id: string;
  readonly name: string | null;
  readonly status: string;
  readonly reference: string | null;
}

// ═══════════════════════════════════════════════════════════════════════
// The port
// ═══════════════════════════════════════════════════════════════════════

/**
 * Every read this lane performs, and nothing else.
 *
 * Each method is BOUNDED by construction: the two range reads take an explicit
 * row limit and the two id reads take an explicit id list the caller has
 * already bounded. There is no unbounded list, no offset pagination and no
 * free-form filter, so no caller can turn one of these into a table scan.
 *
 * The id-list reads exist so a caller can resolve N rows in ONE round trip.
 * Fetching a candidate per appointment would be an N+1, and the shape of this
 * interface is what makes that impossible rather than merely discouraged.
 */
export interface PhoneReadStore {
  /**
   * Live and historical appointments whose START falls in `[fromIso, toIso)`.
   * Ordered by `starts_at` ascending. Returns at most `limit` rows; the caller
   * asks for one more than it will show in order to detect truncation.
   */
  listAppointmentsByStart(input: {
    fromIso: string;
    toIso: string;
    limit: number;
  }): Promise<readonly PhoneAppointmentRow[]>;

  /**
   * The `scheduled`/`confirmed` appointments of one IST day, for the capacity
   * projection. Bounded by the same explicit limit.
   */
  listLiveAppointmentsByStart(input: {
    fromIso: string;
    toIso: string;
    limit: number;
  }): Promise<readonly PhoneAppointmentRow[]>;

  /** One appointment by id, or null. */
  getAppointment(id: string): Promise<PhoneAppointmentRow | null>;

  /** The single live (`scheduled`/`confirmed`) appointment of an engagement. */
  getLiveAppointmentForEngagement(engagementId: string): Promise<PhoneAppointmentRow | null>;

  /** N engagements in one round trip. An empty list performs NO query. */
  listEngagementsByIds(ids: readonly string[]): Promise<readonly PhoneEngagementRow[]>;

  /** One engagement by id, or null. */
  getEngagement(id: string): Promise<PhoneEngagementRow | null>;

  /** N candidates in one round trip. An empty list performs NO query. */
  listCandidatesByIds(ids: readonly string[]): Promise<readonly PhoneCandidateRow[]>;

  /** The most recent attempts of one engagement, newest first, bounded. */
  listAttemptsForEngagement(input: {
    engagementId: string;
    limit: number;
  }): Promise<readonly PhoneAttemptRow[]>;
  /**
   * Resolve an ATTEMPT to the engagement that owns it, plus the two fields a
   * caller needs to act on it: the engagement's current state and its session.
   *
   * A read, not a write. The internal worker surface knows only an attempt id
   * — that is what a SIP participant identity encodes — while every write RPC
   * it needs is engagement-scoped, so something has to bridge the two. Doing it
   * here keeps the bridge on the READ seam, where P6 established that a read is
   * not a widening of the write seam.
   *
   * `null` when the attempt does not exist. Never throws for a missing row: an
   * unknown attempt is a normal answer on a surface a retrying worker calls.
   */
  getAttemptContext(input: { attemptId: string }): Promise<PhoneAttemptContext | null>;
}

/** The bridge from a SIP participant identity to something writable. */
export interface PhoneAttemptContext {
  readonly attemptId: string;
  readonly engagementId: string;
  readonly engagementState: PhoneEngagementState;
  readonly engagementVersion: number;
  /** `null` when the engagement has no session bound yet. */
  readonly sessionId: string | null;
}
