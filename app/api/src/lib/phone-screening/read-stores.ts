/**
 * phone-screening/read-stores.ts — the one place a client performs a phone READ.
 *
 * ── WHY THIS IS NOT `stores.ts` ───────────────────────────────────────
 * `stores.ts` calls `.rpc(` and nothing else, because every 0042 WRITE
 * guarantee lives inside an RPC. This file calls `.select(` and nothing else,
 * because 0042 exposes no read RPC that could answer an operator calendar —
 * `phone_backlog` returns fleet-wide counts with no per-date, per-engagement or
 * per-slot breakdown. Keeping the two capabilities in two files means the
 * structural test can assert each one's absence in the other, rather than
 * asserting a single weaker rule over both.
 *
 * ── EVERY SELECT IS AN EXPLICIT COLUMN LIST ───────────────────────────
 * No `select('*')` appears below and none may. A star select is what turns
 * "we do not expose the lease token" into "we did not expose it yet": the
 * column arrives in the row, and the only thing standing between it and a
 * response is a hand-written mapper somebody later edits. The column lists here
 * are the control, and `phone-screening-structural.test.ts` fails if a
 * forbidden column name ever appears in one.
 *
 * ── EVERY READ IS BOUNDED ─────────────────────────────────────────────
 * Each query carries an explicit `.limit()` and either a half-open range or an
 * `.in()` over a caller-bounded id list. An empty id list performs NO query at
 * all rather than issuing `in.()`, which PostgREST would answer with every row.
 *
 * ── ERRORS ARE SANITIZED, ALWAYS ──────────────────────────────────────
 * A PostgREST error carries the failing statement and sometimes row values.
 * None of it propagates: every failure becomes a bare `Error` with a stable
 * snake_case code, no interpolation and no `cause`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  PhoneAppointmentRow,
  PhoneAttemptRow,
  PhoneCandidateRow,
  PhoneEngagementRow,
  PhoneReadStore,
} from './read-ports.js';
import {
  PHONE_APPOINTMENT_SOURCES,
  PHONE_APPOINTMENT_STATUSES,
  PHONE_ATTEMPT_KINDS,
  PHONE_ATTEMPT_STATES,
  PHONE_ENGAGEMENT_STATES,
  PHONE_LIVE_APPOINTMENT_STATUSES,
  PHONE_OUTCOME_CLASSES,
  type PhoneAppointmentSource,
  type PhoneAppointmentStatus,
  type PhoneAttemptKind,
  type PhoneAttemptState,
  type PhoneEngagementState,
  type PhoneOutcomeClass,
} from './vocabulary.js';

// ═══════════════════════════════════════════════════════════════════════
// Column lists — the sanitization boundary, written down once
// ═══════════════════════════════════════════════════════════════════════

/** `phone_appointments`, minus `created_by` (an operator identity). */
const APPOINTMENT_COLUMNS =
  'id,engagement_id,starts_at,ends_at,ist_date,status,source,confirmed_at,cancel_reason,version,created_at,updated_at';

/** `phone_engagements`. `application_link_id`, `role_id`, `session_id` and
 *  `consent_record_id` are not read: none of them is shown anywhere. */
const ENGAGEMENT_COLUMNS =
  'id,candidate_id,state,state_reason,epoch,version,no_answer_attempts,reconnects_used,provider_failures,next_eligible_at,last_attempt_at,terminal_at,created_at,updated_at';

/**
 * `phone_call_attempts`, minus every provider-bearing column. `sip_call_id`,
 * `room_name`, `participant_identity`, `egress_id`, `egress_status`,
 * `lease_token`, `lease_owner`, `lease_expires_at` and `session_id` are all
 * absent by construction.
 */
const ATTEMPT_COLUMNS =
  'id,engagement_id,attempt_seq,epoch,kind,state,outcome_class,ist_date,prior_engagement_state,admitted_at,answered_at,classified_at,ended_at';

/** `candidates` — four columns. Never `email`, `phone_raw`, `phone_e164`,
 *  `phone_valid`, `parsed`, `skills` or `text_extracted`. */
const CANDIDATE_COLUMNS = 'id,name,status,ats_external_id';

/** Hard ceiling every caller-supplied limit is clamped into. */
export const PHONE_READ_MAX_ROWS = 500;

// ═══════════════════════════════════════════════════════════════════════
// Narrowing helpers — a row this layer does not recognise is refused
// ═══════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>;

function rows(data: unknown): Row[] {
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r));
}

function str(row: Row, key: string): string | undefined {
  const v = row[key];
  return typeof v === 'string' ? v : undefined;
}

function nullableStr(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

function int(row: Row, key: string): number | undefined {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Narrow to a member of a closed vocabulary, or `undefined`.
 *
 * A value 0042 accepts but this build does not know about makes the whole ROW
 * fail rather than making one FIELD vanish. A vanished field is the silent
 * failure mode the P2 lane already paid for once: the parser drops what it does
 * not recognise, so drift shows up as a missing key in a response instead of an
 * error anybody notices.
 */
function member<T extends string>(row: Row, key: string, allowed: readonly string[]): T | undefined {
  const v = row[key];
  return typeof v === 'string' && allowed.includes(v) ? (v as T) : undefined;
}

/** Clamp a caller's row limit into `[1, PHONE_READ_MAX_ROWS]`. */
export function boundedRowLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 1;
  return limit > PHONE_READ_MAX_ROWS ? PHONE_READ_MAX_ROWS : limit;
}

function mapAppointment(row: Row): PhoneAppointmentRow {
  const id = str(row, 'id');
  const engagementId = str(row, 'engagement_id');
  const startsAt = str(row, 'starts_at');
  const endsAt = str(row, 'ends_at');
  const istDate = str(row, 'ist_date');
  const status = member<PhoneAppointmentStatus>(row, 'status', PHONE_APPOINTMENT_STATUSES);
  const source = member<PhoneAppointmentSource>(row, 'source', PHONE_APPOINTMENT_SOURCES);
  const version = int(row, 'version');
  const createdAt = str(row, 'created_at');
  const updatedAt = str(row, 'updated_at');
  if (
    id === undefined || engagementId === undefined || startsAt === undefined ||
    endsAt === undefined || istDate === undefined || status === undefined ||
    source === undefined || version === undefined || createdAt === undefined ||
    updatedAt === undefined
  ) {
    throw new Error('phone_appointment_row_invalid');
  }
  return {
    id,
    engagementId,
    startsAt,
    endsAt,
    istDate,
    status,
    source,
    confirmedAt: nullableStr(row, 'confirmed_at'),
    cancelReason: nullableStr(row, 'cancel_reason'),
    version,
    createdAt,
    updatedAt,
  };
}

function mapEngagement(row: Row): PhoneEngagementRow {
  const id = str(row, 'id');
  const candidateId = str(row, 'candidate_id');
  const state = member<PhoneEngagementState>(row, 'state', PHONE_ENGAGEMENT_STATES);
  const epoch = int(row, 'epoch');
  const version = int(row, 'version');
  const noAnswerAttempts = int(row, 'no_answer_attempts');
  const reconnectsUsed = int(row, 'reconnects_used');
  const providerFailures = int(row, 'provider_failures');
  const createdAt = str(row, 'created_at');
  const updatedAt = str(row, 'updated_at');
  if (
    id === undefined || candidateId === undefined || state === undefined ||
    epoch === undefined || version === undefined || noAnswerAttempts === undefined ||
    reconnectsUsed === undefined || providerFailures === undefined ||
    createdAt === undefined || updatedAt === undefined
  ) {
    throw new Error('phone_engagement_row_invalid');
  }
  return {
    id,
    candidateId,
    state,
    stateReason: nullableStr(row, 'state_reason'),
    epoch,
    version,
    noAnswerAttempts,
    reconnectsUsed,
    providerFailures,
    nextEligibleAt: nullableStr(row, 'next_eligible_at'),
    lastAttemptAt: nullableStr(row, 'last_attempt_at'),
    terminalAt: nullableStr(row, 'terminal_at'),
    createdAt,
    updatedAt,
  };
}

function mapAttempt(row: Row): PhoneAttemptRow {
  const id = str(row, 'id');
  const engagementId = str(row, 'engagement_id');
  const attemptSeq = int(row, 'attempt_seq');
  const epoch = int(row, 'epoch');
  const kind = member<PhoneAttemptKind>(row, 'kind', PHONE_ATTEMPT_KINDS);
  const state = member<PhoneAttemptState>(row, 'state', PHONE_ATTEMPT_STATES);
  const istDate = str(row, 'ist_date');
  const prior = member<PhoneEngagementState>(
    row,
    'prior_engagement_state',
    PHONE_ENGAGEMENT_STATES,
  );
  const admittedAt = str(row, 'admitted_at');
  if (
    id === undefined || engagementId === undefined || attemptSeq === undefined ||
    epoch === undefined || kind === undefined || state === undefined ||
    istDate === undefined || prior === undefined || admittedAt === undefined
  ) {
    throw new Error('phone_attempt_row_invalid');
  }
  // `outcome_class` is nullable in 0042 (a live attempt has none). A NULL is a
  // legitimate answer; a non-null value outside the eleven is drift, and the
  // row is refused rather than reported with the field quietly missing.
  const rawOutcome = row.outcome_class;
  let outcomeClass: PhoneOutcomeClass | null;
  if (rawOutcome === null || rawOutcome === undefined) {
    outcomeClass = null;
  } else {
    const narrowed = member<PhoneOutcomeClass>(row, 'outcome_class', PHONE_OUTCOME_CLASSES);
    if (narrowed === undefined) throw new Error('phone_attempt_row_invalid');
    outcomeClass = narrowed;
  }
  return {
    id,
    engagementId,
    attemptSeq,
    epoch,
    kind,
    state,
    outcomeClass,
    istDate,
    priorEngagementState: prior,
    admittedAt,
    answeredAt: nullableStr(row, 'answered_at'),
    classifiedAt: nullableStr(row, 'classified_at'),
    endedAt: nullableStr(row, 'ended_at'),
  };
}

function mapCandidate(row: Row): PhoneCandidateRow {
  const id = str(row, 'id');
  const status = str(row, 'status');
  if (id === undefined || status === undefined) throw new Error('phone_candidate_row_invalid');
  return {
    id,
    name: nullableStr(row, 'name'),
    status,
    reference: nullableStr(row, 'ats_external_id'),
  };
}

/**
 * Unique, non-empty ids in input order. Bounded by the same ceiling every read
 * uses, so a caller that somehow assembled a huge list still issues one bounded
 * query rather than a URL PostgREST would refuse.
 */
function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= PHONE_READ_MAX_ROWS) break;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// The production store
// ═══════════════════════════════════════════════════════════════════════

/**
 * Production `PhoneReadStore` over the service-role client.
 *
 * The client is INJECTED. This module never imports the process-wide singleton,
 * so a test drives a fake and nothing here can reach a database by accident —
 * the same rule `stores.ts` follows.
 *
 * 0042 enables RLS on all six phone tables and creates NO policy for `anon` or
 * `authenticated`, so these reads are only answerable by the service role. That
 * is why the route in front of this store carries the entire authorization
 * decision: the database will not second-guess it.
 */
export function createPhoneReadStore(client: SupabaseClient): PhoneReadStore {
  async function selectAppointments(build: (q: any) => any): Promise<PhoneAppointmentRow[]> {
    const { data, error } = await build(
      client.from('phone_appointments').select(APPOINTMENT_COLUMNS),
    );
    if (error) throw new Error('phone_appointment_read_error');
    return rows(data).map(mapAppointment);
  }

  return {
    async listAppointmentsByStart(input): Promise<readonly PhoneAppointmentRow[]> {
      return selectAppointments((q) =>
        q
          .gte('starts_at', input.fromIso)
          .lt('starts_at', input.toIso)
          .order('starts_at', { ascending: true })
          .limit(boundedRowLimit(input.limit)),
      );
    },

    async listLiveAppointmentsByStart(input): Promise<readonly PhoneAppointmentRow[]> {
      return selectAppointments((q) =>
        q
          .in('status', [...PHONE_LIVE_APPOINTMENT_STATUSES])
          .gte('starts_at', input.fromIso)
          .lt('starts_at', input.toIso)
          .order('starts_at', { ascending: true })
          .limit(boundedRowLimit(input.limit)),
      );
    },

    async getAppointment(id: string): Promise<PhoneAppointmentRow | null> {
      const found = await selectAppointments((q) => q.eq('id', id).limit(1));
      return found[0] ?? null;
    },

    async getLiveAppointmentForEngagement(
      engagementId: string,
    ): Promise<PhoneAppointmentRow | null> {
      const found = await selectAppointments((q) =>
        q
          .eq('engagement_id', engagementId)
          .in('status', [...PHONE_LIVE_APPOINTMENT_STATUSES])
          .limit(1),
      );
      return found[0] ?? null;
    },

    async listEngagementsByIds(ids): Promise<readonly PhoneEngagementRow[]> {
      const wanted = uniqueIds(ids);
      // An empty `.in()` is a query PostgREST answers with EVERY row. Not
      // issuing it is the control; clamping the result afterwards would not be.
      if (wanted.length === 0) return [];
      const { data, error } = await client
        .from('phone_engagements')
        .select(ENGAGEMENT_COLUMNS)
        .in('id', wanted)
        .limit(wanted.length);
      if (error) throw new Error('phone_engagement_read_error');
      return rows(data).map(mapEngagement);
    },

    async getEngagement(id: string): Promise<PhoneEngagementRow | null> {
      const { data, error } = await client
        .from('phone_engagements')
        .select(ENGAGEMENT_COLUMNS)
        .eq('id', id)
        .limit(1);
      if (error) throw new Error('phone_engagement_read_error');
      const found = rows(data).map(mapEngagement);
      return found[0] ?? null;
    },

    async listCandidatesByIds(ids): Promise<readonly PhoneCandidateRow[]> {
      const wanted = uniqueIds(ids);
      if (wanted.length === 0) return [];
      const { data, error } = await client
        .from('candidates')
        .select(CANDIDATE_COLUMNS)
        .in('id', wanted)
        .limit(wanted.length);
      if (error) throw new Error('phone_candidate_read_error');
      return rows(data).map(mapCandidate);
    },

    async listAttemptsForEngagement(input): Promise<readonly PhoneAttemptRow[]> {
      const { data, error } = await client
        .from('phone_call_attempts')
        .select(ATTEMPT_COLUMNS)
        .eq('engagement_id', input.engagementId)
        .order('attempt_seq', { ascending: false })
        .limit(boundedRowLimit(input.limit));
      if (error) throw new Error('phone_attempt_read_error');
      return rows(data).map(mapAttempt);
    },
  };
}
