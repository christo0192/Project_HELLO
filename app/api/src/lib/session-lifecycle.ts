/**
 * REL-07 session lifecycle — canonical state machine and compare-and-set
 * data-access layer for screening_v2.call_sessions.
 *
 * All state transitions flow through transitionSession(), which uses a
 * compare-and-set (.eq on both id and current status) to prevent races.
 * A zero-row response is a stable conflict, not success.
 *
 * Terminal reasons are REQUIRED for all terminal transitions (no null).
 * The `now` parameter is injectable for deterministic tests.
 */

import { supabase } from './supabase.js';

// ── Stable fixed error codes (never echo runtime values) ────────────

export const ERR_INVALID_TRANSITION = 'ERR_INVALID_TRANSITION';
export const ERR_INVALID_REASON = 'ERR_INVALID_REASON';
export const ERR_REASON_ON_NON_TERMINAL = 'ERR_REASON_ON_NON_TERMINAL';
export const ERR_SESSION_ID_FORMAT = 'ERR_SESSION_ID_FORMAT';
export const ERR_DURATION_BOUNDS = 'ERR_DURATION_BOUNDS';
export const ERR_EXTERNAL_ID_FORMAT = 'ERR_EXTERNAL_ID_FORMAT';
export const ERR_DB_FAILED = 'ERR_DB_FAILED';
export const ERR_INSERT_FAILED = 'ERR_INSERT_FAILED';
export const ERR_INVALID_SESSION_ID = 'ERR_INVALID_SESSION_ID';

// ── Validation helpers ──────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;
const MAX_DURATION_SEC = 86400; // 24 h
const MIN_GRACE_MS = 100;

export function isValidSessionId(id: string): boolean {
  return UUID_PATTERN.test(id);
}

export function isValidDuration(sec: number): boolean {
  return Number.isFinite(sec) && sec >= 0 && sec <= MAX_DURATION_SEC;
}

export function isValidExternalCallId(id: string | undefined): id is string {
  if (id === undefined) return true;
  return typeof id === 'string' && SAFE_IDENTIFIER_PATTERN.test(id);
}

export function isValidGraceMs(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_GRACE_MS && ms <= 300_000;
}

// ── Canonical states ─────────────────────────────────────────────────

export type SessionStatus =
  | 'created'
  | 'waiting'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

// ── Terminal reason codes (required for ALL terminal transitions) ────

export type TerminalReason =
  // completed
  | 'conversation_complete'
  | 'assessment_done'
  // failed
  | 'room_create_error'
  | 'worker_crash'
  | 'provider_error'
  | 'assessment_error'
  | 'shutdown_forced'
  | 'drain_timeout'
  // cancelled
  | 'recruiter_cancelled'
  | 'migrated_abandoned'
  | 'duplicate_session'
  | 'shutdown_drain'
  // expired
  | 'idle_timeout'
  | 'grace_timeout'
  // legacy backfill
  | 'legacy_unknown';

// ── State-machine definition ─────────────────────────────────────────

export const TERMINAL_STATES: ReadonlySet<SessionStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

export const ALLOWED_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  created: ['waiting', 'in_progress', 'cancelled', 'failed'],
  waiting: ['in_progress', 'cancelled', 'failed', 'expired'],
  in_progress: ['completed', 'failed', 'cancelled', 'expired'],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

// Per-state valid reasons.  `null` is NOT valid — terminal transitions
// MUST supply a state-compatible reason.
export const VALID_REASONS_FOR_STATUS: Readonly<
  Partial<Record<SessionStatus, ReadonlySet<TerminalReason>>>
> = {
  completed: new Set(['conversation_complete', 'assessment_done']),
  failed: new Set(['room_create_error', 'worker_crash', 'provider_error',
    'assessment_error', 'shutdown_forced', 'drain_timeout']),
  cancelled: new Set(['recruiter_cancelled', 'migrated_abandoned',
    'duplicate_session', 'shutdown_drain']),
  expired: new Set(['idle_timeout', 'grace_timeout']),
};

// Legacy catch-all allowed for backfilled rows only (0006 migration).
export const LEGACY_REASONS: ReadonlySet<TerminalReason> = new Set(['legacy_unknown']);

export const STATE_OWNER: Readonly<Record<SessionStatus, string>> = {
  created: 'api',
  waiting: 'api',
  in_progress: 'api/worker',
  completed: 'worker/api',
  failed: 'worker/api',
  cancelled: 'api',
  expired: 'reconciler (REL-09)',
};

export function isValidTransition(from: SessionStatus, to: SessionStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] as string[]).includes(to);
}

export function isValidReasonForStatus(reason: TerminalReason, status: SessionStatus): boolean {
  const valid = VALID_REASONS_FOR_STATUS[status];
  if (valid && valid.has(reason)) return true;
  if (LEGACY_REASONS.has(reason)) return true;
  return false;
}

// ── Data types ───────────────────────────────────────────────────────

export interface SessionInsertFields {
  candidate_id: string;
  role_id: string | null;
  mode: 'browser' | 'live' | 'simulation';
  provider?: string;
  /** Validated model provenance for simulation sessions; omitted for LiveKit until worker claim. */
  provenance?: object;
}

export interface SessionRow {
  id: string;
  status: SessionStatus;
  terminal_reason: TerminalReason | null;
  started_at: string;
  ended_at: string | null;
  waiting_at: string | null;
  candidate_id: string;
  role_id: string | null;
}

// Closed set of extra columns that may be set atomically during a transition.
export interface TransitionExtra {
  external_call_id?: string;
  duration_sec?: number;
}

// ── CAS result with stable error codes only ──────────────────────────

export interface TransitionResultOk {
  ok: true;
}
export interface TransitionResultConflict {
  ok: false;
  conflict: true;
  code?: undefined;
}
export interface TransitionResultError {
  ok: false;
  conflict: false;
  code: string; // stable error code only — never runtime values
}

export type TransitionResult = TransitionResultOk | TransitionResultConflict | TransitionResultError;

// ── createSession ────────────────────────────────────────────────────

/**
 * Inserts a new session in the `created` state.  Constructs a closed
 * payload — never spreads caller fields directly into the insert.
 */
export async function createSession(
  fields: SessionInsertFields,
): Promise<{ data: SessionRow; error: null } | { data: null; error: Error }> {
  // Construct closed insert payload.
  const payload: Record<string, unknown> = {
    candidate_id: fields.candidate_id,
    role_id: fields.role_id ?? null,
    mode: fields.mode,
    status: 'created',
  };
  if (fields.provider !== undefined) {
    payload.provider = fields.provider;
  }
  if (fields.provenance !== undefined) {
    payload.provenance = fields.provenance;
  }

  const { data, error } = await supabase
    .from('call_sessions')
    .insert(payload)
    .select()
    .single();

  if (error) return { data: null, error: new Error(ERR_INSERT_FAILED) };
  return { data: data as SessionRow, error: null };
}

// ── transitionSession (compare-and-set) ──────────────────────────────

/**
 * Atomically transitions a session from `expectedStatus` → `newStatus`.
 *
 * Preflight checks (no DB call):
 *   - sessionId must be valid UUID
 *   - Transition must be in ALLOWED_TRANSITIONS
 *   - terminalReason must be state-compatible (via isValidReasonForStatus)
 *   - Non-terminal newStatus must not receive a terminalReason
 *   - duration_sec (if provided) must be finite nonnegative ≤ 86400
 *   - external_call_id (if provided) must match safe identifier pattern
 *
 * Terminal transitions REQUIRE a state-compatible reason — no null.
 * Errors return stable `code` strings only (no runtime values echoed).
 */
export async function transitionSession(
  sessionId: string,
  expectedStatus: SessionStatus,
  newStatus: SessionStatus,
  terminalReason?: TerminalReason,
  extra?: TransitionExtra,
  now: () => string = () => new Date().toISOString(),
): Promise<TransitionResult> {
  // ── Preflight: validate session ID format ────────────────────────
  if (!isValidSessionId(sessionId)) {
    return { ok: false, conflict: false, code: ERR_SESSION_ID_FORMAT };
  }

  // ── Preflight: validate transition ───────────────────────────────
  if (!isValidTransition(expectedStatus, newStatus)) {
    return { ok: false, conflict: false, code: ERR_INVALID_TRANSITION };
  }

  // ── Preflight: validate reason is present and compatible ─────────
  if (TERMINAL_STATES.has(newStatus)) {
    if (!terminalReason) {
      return { ok: false, conflict: false, code: ERR_INVALID_REASON };
    }
    if (!isValidReasonForStatus(terminalReason, newStatus)) {
      return { ok: false, conflict: false, code: ERR_INVALID_REASON };
    }
  } else if (terminalReason !== undefined) {
    return { ok: false, conflict: false, code: ERR_REASON_ON_NON_TERMINAL };
  }

  // ── Preflight: validate extra fields ─────────────────────────────
  if (extra?.duration_sec !== undefined && !isValidDuration(extra.duration_sec)) {
    return { ok: false, conflict: false, code: ERR_DURATION_BOUNDS };
  }
  if (extra?.external_call_id !== undefined && !isValidExternalCallId(extra.external_call_id)) {
    return { ok: false, conflict: false, code: ERR_EXTERNAL_ID_FORMAT };
  }

  // ── Build closed update payload ──────────────────────────────────
  const updates: Record<string, unknown> = { status: newStatus };

  updates.terminal_reason = terminalReason;

  if (TERMINAL_STATES.has(newStatus)) {
    updates.ended_at = now();
  }

  if (newStatus === 'waiting') {
    updates.waiting_at = now();
  }

  if (extra?.external_call_id !== undefined) {
    updates.external_call_id = extra.external_call_id;
  }
  if (extra?.duration_sec !== undefined) {
    updates.duration_sec = extra.duration_sec;
  }

  // ── CAS query ────────────────────────────────────────────────────
  const { data, error } = await supabase
    .from('call_sessions')
    .update(updates)
    .eq('id', sessionId)
    .eq('status', expectedStatus)
    .select('id');

  if (error) {
    return { ok: false, conflict: false, code: ERR_DB_FAILED };
  }

  // Primary key CAS: exactly 0 or 1 rows.
  if (!Array.isArray(data) || data.length !== 1) {
    return { ok: false, conflict: true };
  }

  return { ok: true };
}
