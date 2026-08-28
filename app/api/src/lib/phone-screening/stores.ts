/**
 * phone-screening/stores.ts — the ONLY module in this directory that holds a
 * database client.
 *
 * ── EVERY WRITE GOES THROUGH AN RPC ───────────────────────────────────
 * There is no `.from('phone_…')` and no `.from('job_queue')` anywhere below,
 * and `phone-screening-structural.test.ts` asserts that mechanically. 0042's
 * guarantees — the global admission advisory lock, the pinned lock order, the
 * per-IST-day uniqueness index, the three budgets and the insert-once ledger —
 * live entirely INSIDE the RPCs. A direct insert would satisfy every type in
 * this repository and bypass all of them at once, which is exactly why the
 * capability is absent rather than merely unused.
 *
 * ── ERRORS ARE SANITIZED, ALWAYS ──────────────────────────────────────
 * A PostgREST error object carries the failing statement, constraint names and
 * sometimes row values. None of it propagates: every failure becomes a bare
 * `Error` with a stable snake_case code and no interpolation, no `cause` and
 * no phone-bearing field. An answer this layer does not recognise becomes
 * `unknown_status`, which a caller must treat as "did not happen" rather than
 * as a refusal it understands.
 *
 * ── NO NUMBER CROSSES THIS BOUNDARY ───────────────────────────────────
 * Nothing here reads, accepts, returns or logs a phone number. Admission reads
 * `candidates.phone_e164` INSIDE the database and turns it straight into a
 * digest; the number never leaves SQL.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  narrowPhoneRpcStatus,
  PHONE_RPC_UNKNOWN_STATUS,
  type AdmitPhoneAttemptStatus,
  type ApplyPhoneEventStatus,
  type CancelPhoneAppointmentStatus,
  type ClearPhoneHaltStatus,
  type ExpirePhoneAppointmentsStatus,
  type HeartbeatPhoneAttemptStatus,
  type PhoneBacklogStatus,
  type ReclaimPhoneAttemptLeasesStatus,
  type SchedulePhoneAppointmentStatus,
  type RequestPhoneRescreenStatus,
  type SetPhoneHaltStatus,
  type AttachPhoneAttemptRecordingStatus,
  StampPhoneSessionEgressStatus,
  type FinalizePhoneAttemptRecordingStatus,
  type ListPhoneEngagementRecordingsStatus,
  type ClearPhoneAttemptRecordingsStatus,
  type CommitPhoneQuestionBoundaryStatus,
  type GetPhoneAssessmentStateStatus,
  type RecordPhoneProbeStatus,
  type ConsentAndStartPhoneAssessmentStatus,
  type StartPhoneAssessmentStatus,
} from './rpc-contract.js';
import type {
  AdmitPhoneAttemptInput,
  AdmitPhoneAttemptResult,
  ApplyPhoneEventInput,
  ApplyPhoneEventResult,
  CancelPhoneAppointmentInput,
  CancelPhoneAppointmentResult,
  ClearPhoneHaltResult,
  ExpirePhoneAppointmentsResult,
  HeartbeatPhoneAttemptInput,
  HeartbeatPhoneAttemptResult,
  PhoneAdmissionRefusalDetail,
  PhoneBacklogResult,
  PhoneStores,
  ReclaimPhoneAttemptLeasesResult,
  SchedulePhoneAppointmentInput,
  SchedulePhoneAppointmentResult,
  RequestPhoneRescreenInput,
  RequestPhoneRescreenResult,
  SetPhoneHaltResult,
  AttachPhoneAttemptRecordingInput,
  AttachPhoneAttemptRecordingResult,
  StampPhoneSessionEgressResult,
  FinalizePhoneAttemptRecordingResult,
  ListPhoneEngagementRecordingsResult,
  ClearPhoneAttemptRecordingsResult,
  PhoneRecordingArtifact,
  CommitPhoneQuestionBoundaryInput,
  CommitPhoneQuestionBoundaryResult,
  RecordPhoneProbeInput,
  RecordPhoneProbeResult,
  ConsentAndStartPhoneAssessmentInput,
  ConsentAndStartPhoneAssessmentResult,
  PhoneAssessmentState,
  PhoneAssessmentTurn,
  PhonePlanQuestion,
  StartPhoneAssessmentInput,
  HeartbeatPhoneAttemptByEpochInput,
  SweepPhoneDayRolledResult,
  SweepPhoneStrandedSessionsResult,
  ClaimPhoneSweepResult,
} from './ports.js';
import {
  PHONE_ATTEMPT_KINDS,
  PHONE_ATTEMPT_STATES,
  PHONE_ENGAGEMENT_STATES,
  PHONE_EVENT_IGNORED_REASONS,
  PHONE_RECORDING_ROLES,
  type PhoneAttemptKind,
  type PhoneAttemptState,
  type PhoneEngagementState,
  type PhoneEventIgnoredReason,
  type PhoneRecordingRole,
} from './vocabulary.js';

/**
 * The documented all-zero SYSTEM sentinel (the 0024 precedent). Operator
 * actions — the two halt RPCs and a named calendar action — pass a real admin
 * identity instead, and 0042 falls back to the house recruiter sentinel.
 */
export const PHONE_SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

type Row = Record<string, unknown> | null;

function asRow(data: unknown): Row {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

function str(row: Row, key: string): string | undefined {
  const v = row?.[key];
  return typeof v === 'string' ? v : undefined;
}

function num(row: Row, key: string): number | undefined {
  const v = row?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(row: Row, key: string): boolean | undefined {
  const v = row?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

function boundedResumeFacts(row: Row): Readonly<Record<string, unknown>> {
  const raw = row?.candidate_evidence;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    'name', 'current_role', 'experience_years', 'skills', 'summary',
    'recent_role', 'prior_roles', 'career_highlights', 'education', 'certifications',
  ]) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number' || value === null) {
      out[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 30)
        .map((item) => item.slice(0, 240));
    } else if (value && typeof value === 'object') {
      out[key] = value;
    }
  }
  return out;
}

/** `timestamptz` arrives as an ISO string; anything else is dropped. */
function iso(row: Row, key: string): string | undefined {
  return str(row, key);
}

/** Narrow a value to a member of a closed vocabulary, or drop it. */
function member<T extends string>(
  row: Row,
  key: string,
  allowed: readonly string[],
): T | undefined {
  const v = row?.[key];
  return typeof v === 'string' && allowed.includes(v) ? (v as T) : undefined;
}

// The four closed vocabularies `member()` narrows against are IMPORTED, never
// re-declared. A hand-copied second list here would be the exact drift the
// lane exists to prevent, and it would fail SILENTLY: `member()` drops a value
// it does not recognise, so a missing state would make the field vanish from
// the result rather than raise anything.

/**
 * Refusal detail, read field by field. Only the sanitized keys 0042 actually
 * emits are carried; anything else in the body is discarded rather than
 * forwarded, so a future migration cannot widen what crosses this boundary
 * without this file changing.
 */
function refusalDetail(row: Row): PhoneAdmissionRefusalDetail | undefined {
  const detail: Record<string, unknown> = {};
  const s = (k: string, out: string): void => {
    const v = str(row, k);
    if (v !== undefined) detail[out] = v;
  };
  const n = (k: string, out: string): void => {
    const v = num(row, k);
    if (v !== undefined) detail[out] = v;
  };
  s('state', 'state');
  s('kind', 'kind');
  s('terminal_state', 'terminalState');
  s('lifecycle', 'lifecycle');
  s('mapping_status', 'mappingStatus');
  s('ingestion_state', 'ingestionState');
  s('consent_status', 'consentStatus');
  s('next_eligible_at', 'nextEligibleAt');
  s('ist_date', 'istDate');
  s('constraint', 'constraint');
  n('no_answer_attempts', 'noAnswerAttempts');
  n('live', 'live');
  n('max_concurrent', 'maxConcurrent');
  return Object.keys(detail).length > 0 ? (detail as PhoneAdmissionRefusalDetail) : undefined;
}

/**
 * Serialize an injected instant. Every RPC is handed `p_now` EXPLICITLY, so
 * none falls back to the database clock, and an unusable Date is refused
 * BEFORE the call rather than becoming a `null` the RPC would silently default.
 */
function isoInstant(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new Error('phone_now_invalid');
  }
  return at.toISOString();
}


/**
 * Project the 0044 assessment-state payload, field by field.
 *
 * Nothing is spread. The RPC's answer is read key by key and anything it does
 * not name here is DISCARDED rather than forwarded, so a future migration
 * cannot widen what crosses this boundary — and reaches a voice worker and a
 * language model — without this function changing.
 *
 * A question or a turn that does not have the exact shape declared is dropped
 * rather than coerced, and the drop is visible: a plan whose questions came
 * back malformed has fewer of them than `questionCount` says, which the API
 * layer refuses.
 */
function projectAssessmentState(
  rpc: 'start_phone_assessment' | 'get_phone_assessment_state',
  data: unknown,
): PhoneAssessmentState {
  const row = asRow(data);
  const status =
    rpc === 'start_phone_assessment'
      ? narrowPhoneRpcStatus<StartPhoneAssessmentStatus>(rpc, row)
      : narrowPhoneRpcStatus<GetPhoneAssessmentStateStatus>(rpc, row);

  const questions: PhonePlanQuestion[] = [];
  const rawQuestions = row?.questions;
  if (Array.isArray(rawQuestions)) {
    for (const entry of rawQuestions) {
      const q = asRow(entry);
      const key = str(q, 'key');
      const text = str(q, 'text');
      if (key === undefined || text === undefined) continue;
      questions.push({ key, text, mandatory: bool(q, 'mandatory') === true, hint: str(q, 'hint') ?? null });
    }
  }

  const turns: PhoneAssessmentTurn[] = [];
  const rawTurns = row?.turns;
  if (Array.isArray(rawTurns)) {
    for (const entry of rawTurns) {
      const t = asRow(entry);
      const turnIndex = num(t, 'turn_index');
      const speaker = member<'bot' | 'candidate'>(t, 'speaker', ['bot', 'candidate']);
      const text = str(t, 'text');
      if (turnIndex === undefined || speaker === undefined || text === undefined) continue;
      turns.push({
        turnIndex,
        speaker,
        text,
        turnStartedAtMs: num(t, 'turn_started_at_ms') ?? null,
      });
    }
  }

  const rawCompleted = row?.completed_keys;
  const completedKeys = Array.isArray(rawCompleted)
    ? rawCompleted.filter((k): k is string => typeof k === 'string')
    : undefined;

  return {
    status,
    sessionId: str(row, 'session_id'),
    sessionStatus: str(row, 'session_status'),
    terminalReason: row && 'terminal_reason' in row ? (str(row, 'terminal_reason') ?? null) : undefined,
    candidateName: row && 'candidate_name' in row ? (str(row, 'candidate_name') ?? null) : undefined,
    roleTitle: row && 'role_title' in row ? (str(row, 'role_title') ?? null) : undefined,
    roleFocus: row && 'role_focus' in row ? (str(row, 'role_focus') ?? null) : undefined,
    roleRequiredSkills: Array.isArray(row?.role_required_skills)
      ? row!.role_required_skills.filter((v): v is string => typeof v === 'string').slice(0, 100)
      : undefined,
    interviewerInstructions: row && 'interviewer_instructions' in row
      ? (str(row, 'interviewer_instructions') ?? null) : undefined,
    resumeFacts: boundedResumeFacts(row),
    planSource: str(row, 'plan_source'),
    questionCount: num(row, 'question_count'),
    questions: Array.isArray(rawQuestions) ? questions : undefined,
    cursor: num(row, 'cursor'),
    nextKey: row && 'next_key' in row ? (str(row, 'next_key') ?? null) : undefined,
    completedKeys,
    turns: Array.isArray(rawTurns) ? turns : undefined,
    assessmentExists: bool(row, 'assessment_exists'),
    alreadyScored: bool(row, 'already_scored'),
    planComplete: bool(row, 'plan_complete'),
  };
}

/**
 * Production `PhoneStores` backed by the 0042 RPCs. The client is INJECTED —
 * this module never imports the process-wide singleton, so a test drives a
 * fake and nothing here can reach a database by accident.
 */
export function createPhoneStores(client: SupabaseClient): PhoneStores {
  return {
    async admitAttempt(input: AdmitPhoneAttemptInput): Promise<AdmitPhoneAttemptResult> {
      const { data, error } = await client.rpc('admit_phone_attempt', {
        p_engagement_id: input.engagementId,
        p_kind: input.kind,
        p_lease_owner: input.leaseOwner ?? null,
        p_lease_seconds: input.leaseSeconds ?? 60,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_admit_attempt_error');
      const row = asRow(data);
      const status = narrowPhoneRpcStatus<AdmitPhoneAttemptStatus>('admit_phone_attempt', row);
      if (status !== 'ok') return { status, detail: refusalDetail(row) };
      return {
        status,
        attemptId: str(row, 'attempt_id'),
        attemptSeq: num(row, 'attempt_seq'),
        kind: member<PhoneAttemptKind>(row, 'kind', PHONE_ATTEMPT_KINDS),
        epoch: num(row, 'epoch'),
        istDate: str(row, 'ist_date'),
        leaseToken: str(row, 'lease_token'),
        leaseExpiresAt: iso(row, 'lease_expires_at'),
        liveBefore: num(row, 'live_before'),
      };
    },

    async heartbeatAttempt(
      input: HeartbeatPhoneAttemptInput,
    ): Promise<HeartbeatPhoneAttemptResult> {
      const { data, error } = await client.rpc('heartbeat_phone_attempt', {
        p_attempt_id: input.attemptId,
        p_lease_token: input.leaseToken,
        p_lease_seconds: input.leaseSeconds ?? 60,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_heartbeat_attempt_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<HeartbeatPhoneAttemptStatus>('heartbeat_phone_attempt', row),
        leaseExpiresAt: iso(row, 'lease_expires_at'),
      };
    },

    async heartbeatAttemptByEpoch(input): Promise<HeartbeatPhoneAttemptResult> {
      const { data, error } = await client.rpc('heartbeat_phone_attempt_by_epoch', {
        p_attempt_id: input.attemptId,
        p_epoch: input.epoch,
        p_session_id: input.sessionId,
        p_lease_seconds: input.leaseSeconds ?? 60,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_heartbeat_attempt_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<HeartbeatPhoneAttemptStatus>(
          'heartbeat_phone_attempt_by_epoch', row,
        ),
        leaseExpiresAt: iso(row, 'lease_expires_at'),
      };
    },

    async sweepDayRolled(input): Promise<SweepPhoneDayRolledResult> {
      const { data, error } = await client.rpc('sweep_phone_day_rolled', {
        p_limit: input.limit ?? 25,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_sweep_day_rolled_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<'ok'>('sweep_phone_day_rolled', row),
        examined: num(row, 'examined'),
        rolled: num(row, 'rolled'),
        skipped: num(row, 'skipped'),
      };
    },

    async sweepStrandedSessions(input): Promise<SweepPhoneStrandedSessionsResult> {
      const { data, error } = await client.rpc('sweep_phone_stranded_sessions', {
        p_limit: input.limit ?? 25,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_sweep_stranded_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<'ok'>('sweep_phone_stranded_sessions', row),
        examined: num(row, 'examined'),
        completed: num(row, 'completed'),
        failed: num(row, 'failed'),
        skipped: num(row, 'skipped'),
      };
    },

    async claimSweep(input): Promise<ClaimPhoneSweepResult> {
      const { data, error } = await client.rpc('claim_phone_sweep', {
        p_sweep: input.sweep,
        p_owner: input.owner,
        p_ttl_seconds: input.ttlSeconds ?? 60,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_claim_sweep_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<'ok' | 'held_by_other' | 'invalid_input'>(
          'claim_phone_sweep', row,
        ),
        expiresAt: iso(row, 'expires_at'),
      };
    },

    async reclaimAttemptLeases(input): Promise<ReclaimPhoneAttemptLeasesResult> {
      const { data, error } = await client.rpc('reclaim_phone_attempt_leases', {
        p_limit: input.limit ?? 50,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_reclaim_leases_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<ReclaimPhoneAttemptLeasesStatus>(
          'reclaim_phone_attempt_leases',
          row,
        ),
        reclaimed: num(row, 'reclaimed'),
        limit: num(row, 'limit'),
      };
    },

    async applyEvent(input: ApplyPhoneEventInput): Promise<ApplyPhoneEventResult> {
      const { data, error } = await client.rpc('apply_phone_event', {
        p_source: input.source,
        p_event_type: input.eventType,
        p_attempt_id: input.attemptId ?? null,
        p_engagement_id: input.engagementId ?? null,
        p_provider_event_id: input.providerEventId ?? null,
        p_epoch: input.epoch ?? null,
        p_metadata: input.metadata ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_apply_event_error');
      const row = asRow(data);
      const ignored = member<PhoneEventIgnoredReason>(row, 'ignored_reason', PHONE_EVENT_IGNORED_REASONS);
      return {
        status: narrowPhoneRpcStatus<ApplyPhoneEventStatus>('apply_phone_event', row),
        applied: bool(row, 'applied'),
        // `null` and "absent" are different answers: an APPLIED event has an
        // explicit null reason, a refusal has none at all.
        ignoredReason: row && 'ignored_reason' in row ? (ignored ?? null) : undefined,
        eventId: str(row, 'event_id'),
        duplicate: bool(row, 'duplicate'),
        engagementState: member<PhoneEngagementState>(
          row,
          'engagement_state',
          PHONE_ENGAGEMENT_STATES,
        ),
        attemptState: member<PhoneAttemptState>(row, 'attempt_state', PHONE_ATTEMPT_STATES),
        eventType: str(row, 'event_type'),
      };
    },

    async scheduleAppointment(
      input: SchedulePhoneAppointmentInput,
    ): Promise<SchedulePhoneAppointmentResult> {
      const { data, error } = await client.rpc('schedule_phone_appointment', {
        p_engagement_id: input.engagementId,
        p_starts_at: isoInstant(input.startsAt),
        p_ends_at: isoInstant(input.endsAt),
        p_source: input.source,
        p_actor_id: input.actorId ?? null,
        p_expected_version: input.expectedVersion ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_schedule_appointment_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<SchedulePhoneAppointmentStatus>(
          'schedule_phone_appointment',
          row,
        ),
        appointmentId: str(row, 'appointment_id'),
        version: num(row, 'version'),
        engagementState: member<PhoneEngagementState>(
          row,
          'engagement_state',
          PHONE_ENGAGEMENT_STATES,
        ),
        // `null` and "absent" are DIFFERENT answers, exactly as they are for
        // `ignored_reason` above. The API classifies a reschedule that
        // superseded NOTHING as a lost update and cancels the row it just
        // created, so collapsing a renamed or missing key into `null` would
        // turn a contract break into silent slot destruction on every
        // legitimate reschedule.
        supersededAppointmentId:
          row && 'superseded_appointment_id' in row
            ? (str(row, 'superseded_appointment_id') ?? null)
            : undefined,
      };
    },

    async requestRescreen(
      input: RequestPhoneRescreenInput,
    ): Promise<RequestPhoneRescreenResult> {
      const { data, error } = await client.rpc('request_phone_rescreen', {
        p_candidate_id: input.candidateId,
        p_reason: input.reason,
        p_request_id: input.requestId,
        p_source: input.source,
        p_actor_id: input.actorId ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_request_rescreen_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<RequestPhoneRescreenStatus>('request_phone_rescreen', row),
        engagementId: str(row, 'engagement_id'),
        cycleNumber: num(row, 'cycle_number'),
        predecessorEngagementId: str(row, 'predecessor_engagement_id'),
        requestId: str(row, 'request_id'),
      };
    },

    async cancelAppointment(
      input: CancelPhoneAppointmentInput,
    ): Promise<CancelPhoneAppointmentResult> {
      const { data, error } = await client.rpc('cancel_phone_appointment', {
        p_appointment_id: input.appointmentId,
        p_reason: input.reason,
        p_actor_id: input.actorId ?? null,
        p_expected_version: input.expectedVersion ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_cancel_appointment_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<CancelPhoneAppointmentStatus>(
          'cancel_phone_appointment',
          row,
        ),
        appointmentId: str(row, 'appointment_id'),
        version: num(row, 'version'),
        appointmentStatus: str(row, 'appointment_status'),
      };
    },

    async expireAppointments(input): Promise<ExpirePhoneAppointmentsResult> {
      const { data, error } = await client.rpc('expire_phone_appointments', {
        p_grace_seconds: input.graceSeconds ?? 900,
        p_limit: input.limit ?? 50,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_expire_appointments_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<ExpirePhoneAppointmentsStatus>(
          'expire_phone_appointments',
          row,
        ),
        expired: num(row, 'expired'),
        graceSeconds: num(row, 'grace_seconds'),
        limit: num(row, 'limit'),
      };
    },

    async setHalt(input): Promise<SetPhoneHaltResult> {
      const { data, error } = await client.rpc('set_phone_halt', {
        p_reason: input.reason,
        p_actor_id: input.actorId ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_set_halt_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<SetPhoneHaltStatus>('set_phone_halt', row),
        alreadyHalted: bool(row, 'already_halted'),
      };
    },

    async clearHalt(input): Promise<ClearPhoneHaltResult> {
      const { data, error } = await client.rpc('clear_phone_halt', {
        p_actor_id: input.actorId ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_clear_halt_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<ClearPhoneHaltStatus>('clear_phone_halt', row),
        wasHalted: bool(row, 'was_halted'),
      };
    },

    async backlog(input): Promise<PhoneBacklogResult> {
      const { data, error } = await client.rpc('phone_backlog', { p_now: isoInstant(input.now) });
      if (error) throw new Error('phone_backlog_error');
      const row = asRow(data);
      const status = narrowPhoneRpcStatus<PhoneBacklogStatus>('phone_backlog', row);
      if (status !== 'ok') return { status };
      const admission = asRow(row?.admission);
      const attempts = asRow(row?.attempts);
      const appointments = asRow(row?.appointments);
      const events = asRow(row?.events);
      const byState = asRow(row?.engagements_by_state);
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(byState ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
      }
      return {
        status,
        admission: {
          controlPresent: bool(admission, 'control_present') ?? false,
          // A missing or unreadable singleton reads as HALTED. The health
          // surface must never present an unreadable kill switch as normal.
          halted: bool(admission, 'halted') ?? true,
          haltReason: str(admission, 'halt_reason') ?? null,
        },
        engagementsByState: counts,
        attempts: {
          live: num(attempts, 'live') ?? 0,
          liveWithUnexpiredLease: num(attempts, 'live_with_unexpired_lease') ?? 0,
          maxConcurrent: num(attempts, 'max_concurrent') ?? 0,
          oldestLiveAgeSeconds: num(attempts, 'oldest_live_age_seconds') ?? 0,
        },
        appointments: {
          live: num(appointments, 'live') ?? 0,
          overdue: num(appointments, 'overdue') ?? 0,
        },
        events: {
          ignoredLast24h: num(events, 'ignored_last_24h') ?? 0,
          unknownAttemptLast24h: num(events, 'unknown_attempt_last_24h') ?? 0,
          staleEpochLast24h: num(events, 'stale_epoch_last_24h') ?? 0,
          terminalLast24h: num(events, 'terminal_last_24h') ?? 0,
          unexpectedEventLast24h: num(events, 'unexpected_event_last_24h') ?? 0,
        },
        windowOpen: bool(row, 'window_open') ?? false,
        istDate: str(row, 'ist_date'),
      };
    },
    async attachAttemptRecording(
      input: AttachPhoneAttemptRecordingInput,
    ): Promise<AttachPhoneAttemptRecordingResult> {
      const { data, error } = await client.rpc('attach_phone_attempt_recording', {
        p_attempt_id: input.attemptId,
        p_object_key: input.objectKey,
        p_manifest_key: input.manifestKey ?? null,
        p_role: input.role,
        p_egress_id: input.egressId ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_attach_recording_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<AttachPhoneAttemptRecordingStatus>(
          'attach_phone_attempt_recording',
          row,
        ),
        attemptId: str(row, 'attempt_id'),
        role: member<PhoneRecordingRole>(row, 'role', PHONE_RECORDING_ROLES),
        duplicate: bool(row, 'duplicate'),
        engagementState: member<PhoneEngagementState>(
          row,
          'engagement_state',
          PHONE_ENGAGEMENT_STATES,
        ),
        attemptState: member<PhoneAttemptState>(row, 'attempt_state', PHONE_ATTEMPT_STATES),
      };
    },

    async stampSessionEgress(input): Promise<StampPhoneSessionEgressResult> {
      const { data, error } = await client.rpc('stamp_phone_session_egress', {
        p_session_id: input.sessionId,
        p_attempt_id: input.attemptId,
        p_egress_id: input.egressId,
        p_egress_started_at_ms: input.egressStartedAtMs ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_stamp_session_egress_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<StampPhoneSessionEgressStatus>(
          'stamp_phone_session_egress',
          row,
        ),
        duplicate: bool(row, 'duplicate'),
      };
    },

    async finalizeAttemptRecording(input): Promise<FinalizePhoneAttemptRecordingResult> {
      const { data, error } = await client.rpc('finalize_phone_attempt_recording', {
        p_attempt_id: input.attemptId,
        p_egress_status: input.egressStatus,
        p_egress_id: input.egressId ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_finalize_recording_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<FinalizePhoneAttemptRecordingStatus>(
          'finalize_phone_attempt_recording',
          row,
        ),
        attemptId: str(row, 'attempt_id'),
        egressStatus: str(row, 'egress_status'),
        role: member<PhoneRecordingRole>(row, 'role', PHONE_RECORDING_ROLES),
      };
    },

    async listEngagementRecordings(input): Promise<ListPhoneEngagementRecordingsResult> {
      const { data, error } = await client.rpc('list_phone_engagement_recordings', {
        p_engagement_id: input.engagementId,
      });
      if (error) throw new Error('phone_list_recordings_error');
      const row = asRow(data);
      const status = narrowPhoneRpcStatus<ListPhoneEngagementRecordingsStatus>(
        'list_phone_engagement_recordings',
        row,
      );
      // `artifacts` is left UNDEFINED unless the RPC answered `ok` AND sent an
      // array. A purge treats absent as "we never got an answer" and refuses
      // to proceed; treating it as an empty list would delete nothing and then
      // report success, which is the failure this whole path exists to avoid.
      if (status !== 'ok') return { status };
      const raw = row?.artifacts;
      if (!Array.isArray(raw)) return { status };
      const artifacts: PhoneRecordingArtifact[] = [];
      for (const item of raw) {
        const entry = asRow(item);
        const attemptId = str(entry, 'attempt_id');
        const objectKey = str(entry, 'object_key');
        const role = member<PhoneRecordingRole>(entry, 'role', PHONE_RECORDING_ROLES);
        // A row missing any of the three is DROPPED rather than half-read —
        // but dropping it would hide an artifact from the purge, so the whole
        // answer is refused instead.
        if (attemptId === undefined || objectKey === undefined || role === undefined) {
          return { status: PHONE_RPC_UNKNOWN_STATUS };
        }
        artifacts.push({
          attemptId,
          objectKey,
          role,
          manifestKey: str(entry, 'manifest_key') ?? null,
          egressId: str(entry, 'egress_id') ?? null,
          egressStatus: str(entry, 'egress_status') ?? null,
        });
      }
      return { status, artifacts, count: num(row, 'count') ?? artifacts.length };
    },

    async clearAttemptRecordings(input): Promise<ClearPhoneAttemptRecordingsResult> {
      const { data, error } = await client.rpc('clear_phone_attempt_recordings', {
        p_engagement_id: input.engagementId,
        p_actor_id: input.actorId ?? null,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_clear_recordings_error');
      const row = asRow(data);
      return {
        status: narrowPhoneRpcStatus<ClearPhoneAttemptRecordingsStatus>(
          'clear_phone_attempt_recordings',
          row,
        ),
        cleared: num(row, 'cleared'),
      };
    },

    async startAssessment(input: StartPhoneAssessmentInput): Promise<PhoneAssessmentState> {
      const { data, error } = await client.rpc('start_phone_assessment', {
        p_attempt_id: input.attemptId,
        p_session_id: input.sessionId,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_start_assessment_error');
      return projectAssessmentState('start_phone_assessment', data);
    },

    async assessmentState(input): Promise<PhoneAssessmentState> {
      const { data, error } = await client.rpc('get_phone_assessment_state', {
        p_session_id: input.sessionId,
      });
      if (error) throw new Error('phone_assessment_state_error');
      return projectAssessmentState('get_phone_assessment_state', data);
    },

    async commitQuestionBoundary(
      input: CommitPhoneQuestionBoundaryInput,
    ): Promise<CommitPhoneQuestionBoundaryResult> {
      const { data, error } = await client.rpc('commit_phone_question_boundary', {
        p_session_id: input.sessionId,
        p_question_key: input.questionKey,
        p_expected_index: input.expectedIndex,
        p_source_event_id: input.sourceEventId,
        // Serialized here rather than passed through, so nothing but
        // `speaker` and `text` can reach the database however the caller
        // shaped its objects.
        p_turns: input.turns.map((t) => ({
          speaker: t.speaker,
          text: t.text,
          turn_started_at_ms: t.turnStartedAtMs ?? null,
        })),
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_commit_boundary_error');
      const row = asRow(data);
      const status = narrowPhoneRpcStatus<CommitPhoneQuestionBoundaryStatus>(
        'commit_phone_question_boundary',
        row,
      );
      return {
        status,
        // `applied` is read from the ANSWER, never inferred from the status:
        // a body that said `applied` without the flag is one this layer did
        // not understand, and a caller must not treat it as a durable write.
        applied: bool(row, 'applied') === true && status === 'applied',
        duplicate: bool(row, 'duplicate') === true,
        questionKey: str(row, 'question_key'),
        questionIndex: num(row, 'question_index'),
        firstTurnIndex: num(row, 'first_turn_index'),
        lastTurnIndex: num(row, 'last_turn_index'),
        cursor: num(row, 'cursor'),
        questionCount: num(row, 'question_count'),
        planComplete: bool(row, 'plan_complete'),
        expectedKey: str(row, 'expected_key'),
        sessionStatus: str(row, 'session_status'),
      };
    },

    async consentAndStart(input: ConsentAndStartPhoneAssessmentInput): Promise<ConsentAndStartPhoneAssessmentResult> {
      const { data, error } = await client.rpc('consent_and_start_phone_assessment', {
        p_attempt_id: input.attemptId,
        p_session_id: input.sessionId,
        p_epoch: input.epoch,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_consent_start_error');
      const row = asRow(data);
      const status = narrowPhoneRpcStatus<ConsentAndStartPhoneAssessmentStatus>(
        'consent_and_start_phone_assessment', row,
      );
      return {
        status,
        state: status === 'ok' ? projectAssessmentState('start_phone_assessment', data) : undefined,
      };
    },

    async recordProbe(input: RecordPhoneProbeInput): Promise<RecordPhoneProbeResult> {
      const { data, error } = await client.rpc('record_phone_probe', {
        p_session_id: input.sessionId,
        p_question_key: input.questionKey,
        p_expected_index: input.expectedIndex,
        p_source_event_id: input.sourceEventId,
        p_now: isoInstant(input.now),
      });
      if (error) throw new Error('phone_record_probe_error');
      const row = asRow(data);
      const status = narrowPhoneRpcStatus<RecordPhoneProbeStatus>('record_phone_probe', row);
      return {
        status,
        duplicate: status === 'duplicate',
        probeCount: num(row, 'probe_count'),
        questionKey: str(row, 'question_key'),
        questionIndex: num(row, 'question_index'),
      };
    },
  };
}
