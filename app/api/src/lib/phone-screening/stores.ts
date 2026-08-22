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
  type AdmitPhoneAttemptStatus,
  type ApplyPhoneEventStatus,
  type CancelPhoneAppointmentStatus,
  type ClearPhoneHaltStatus,
  type ExpirePhoneAppointmentsStatus,
  type HeartbeatPhoneAttemptStatus,
  type PhoneBacklogStatus,
  type ReclaimPhoneAttemptLeasesStatus,
  type SchedulePhoneAppointmentStatus,
  type SetPhoneHaltStatus,
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
  SetPhoneHaltResult,
} from './ports.js';
import {
  PHONE_ATTEMPT_KINDS,
  PHONE_ATTEMPT_STATES,
  PHONE_ENGAGEMENT_STATES,
  PHONE_EVENT_IGNORED_REASONS,
  type PhoneAttemptKind,
  type PhoneAttemptState,
  type PhoneEngagementState,
  type PhoneEventIgnoredReason,
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
        supersededAppointmentId: str(row, 'superseded_appointment_id') ?? null,
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
  };
}
