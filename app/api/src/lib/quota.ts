/**
 * Phase 9 L2 — quota reservation client for the service-role RPCs
 * (`check_and_reserve_quota`, `commit_quota_reservation`,
 * `release_quota_reservation`).
 *
 * Truthful semantics (invariant 11):
 *   - Reservation is keyed by a BOUNDED Idempotency-Key (1..128 chars).
 *   - The cost units are read from the policy by the RPC — NEVER from the
 *     client.
 *   - A repeated key returns the SAME stable reservation (never
 *     double-reserves / never adds units).
 *   - commit is idempotent (already-committed is a no-op); release is the
 *     compensation for failed session creation (no usage increment).
 *   - Enforcement only engages when at least one quota_policy is enabled
 *     (quota_policies disabled by default). When nothing is configured the
 *     start routes preserve legacy behavior.
 */

import type { Request } from 'express';
import { supabase } from './supabase.js';

// ── Bounded Idempotency-Key ─────────────────────────────────────────

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** RFC 3986 unreserved + ~ - _ (bounded, safe for headers and DB). */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._~-]{1,128}$/;

export function isValidIdempotencyKey(key: string | undefined): key is string {
  return typeof key === 'string' && IDEMPOTENCY_KEY_RE.test(key);
}

/** Extract the bounded Idempotency-Key header (case-insensitive). */
export function extractIdempotencyKey(req: Request): string | null {
  const raw = req.get('Idempotency-Key') ?? req.get('idempotency-key');
  if (!raw) return null;
  return isValidIdempotencyKey(raw.trim()) ? raw.trim() : null;
}

// ── Types ───────────────────────────────────────────────────────────

export type QuotaMode = 'simulation' | 'live';

export interface QuotaReservationOk {
  status: 'ok';
  allowed: true;
  reservationId: string;
  remainingSessions: number | null;
  remainingCostUnits: number | null;
  warningReached: boolean;
}

export interface QuotaDuplicate {
  status: 'duplicate';
  allowed: true;
  reservationId: string;
  reservationStatus: 'reserved' | 'committed' | 'released';
}

export interface QuotaExceeded {
  status: 'quota_exceeded';
  allowed: false;
  remainingSessions: number | null;
  remainingCostUnits: number | null;
}

export interface QuotaNoPolicy {
  status: 'no_policy';
  allowed: false;
}

export interface QuotaRpcError {
  status: 'rpc_error';
  allowed: false;
}

export type ReserveQuotaResult =
  | QuotaReservationOk
  | QuotaDuplicate
  | QuotaExceeded
  | QuotaNoPolicy
  | QuotaRpcError;

export interface CommitResult {
  ok: boolean;
  code: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ── RPC clients ─────────────────────────────────────────────────────

/** Atomically check both caps and reserve one session slot. */
export async function reserveQuota(opts: {
  requesterId: string;
  mode: QuotaMode;
  idempotencyKey: string;
}): Promise<ReserveQuotaResult> {
  const { data, error } = await supabase.rpc('check_and_reserve_quota', {
    p_requester_id: opts.requesterId,
    p_mode: opts.mode,
    p_idempotency_key: opts.idempotencyKey,
  });
  if (error) return { status: 'rpc_error', allowed: false };
  const r = asRecord(data);
  if (!r) return { status: 'rpc_error', allowed: false };

  switch (r.status) {
    case 'ok':
      return {
        status: 'ok',
        allowed: true,
        reservationId: String(r.reservation_id),
        remainingSessions: numOrNull(r.remaining_sessions),
        remainingCostUnits: numOrNull(r.remaining_cost_units),
        warningReached: r.warning_reached === true,
      };
    case 'duplicate': {
      const rs = String(r.reservation_status ?? 'reserved');
      return {
        status: 'duplicate',
        allowed: true,
        reservationId: String(r.reservation_id),
        reservationStatus: rs === 'committed' || rs === 'released' ? rs : 'reserved',
      };
    }
    case 'quota_exceeded':
      return {
        status: 'quota_exceeded',
        allowed: false,
        remainingSessions: numOrNull(r.remaining_sessions),
        remainingCostUnits: numOrNull(r.remaining_cost_units),
      };
    case 'no_policy':
      return { status: 'no_policy', allowed: false };
    default:
      return { status: 'rpc_error', allowed: false };
  }
}

/** Idempotent CAS reserved→committed (increments usage). */
export async function commitReservation(reservationId: string): Promise<CommitResult> {
  const { data, error } = await supabase.rpc('commit_quota_reservation', {
    p_reservation_id: reservationId,
  });
  if (error) return { ok: false, code: 'rpc_error' };
  const r = asRecord(data);
  const status = r ? String(r.status) : 'rpc_error';
  return { ok: status === 'committed' || status === 'already_committed', code: status };
}

/** Idempotent CAS reserved→released (compensation; no usage increment). */
export async function releaseReservation(reservationId: string): Promise<CommitResult> {
  const { data, error } = await supabase.rpc('release_quota_reservation', {
    p_reservation_id: reservationId,
  });
  if (error) return { ok: false, code: 'rpc_error' };
  const r = asRecord(data);
  const status = r ? String(r.status) : 'rpc_error';
  return { ok: status === 'released' || status === 'already_released', code: status };
}

// ── Enforcement flag ────────────────────────────────────────────────

export interface EnforcementResult {
  ok: boolean;
  enabled: boolean;
}

/**
 * Quota enforcement engages only when at least one quota_policy is enabled
 * (quota_policies are DISABLED by default). `{ ok: false }` on DB failure
 * — start gates fail closed (503) rather than proceed unverified.
 */
export async function quotaEnforcementEnabled(): Promise<EnforcementResult> {
  const { data, error } = await supabase
    .from('quota_policies')
    .select('id')
    .eq('enabled', true)
    .limit(1);
  if (error) return { ok: false, enabled: false };
  return { ok: true, enabled: Array.isArray(data) && data.length > 0 };
}

// ── Reservation lifecycle runner ────────────────────────────────────

/**
 * Thrown by a start handler AFTER it already wrote a non-201 response
 * (e.g. a mid-flow 409/403). Signals runWithQuotaReservation that the
 * reservation must be released but the error must NOT reach next().
 */
export class ResponseSentError extends Error {
  constructor() {
    super('response already sent by handler');
    this.name = 'ResponseSentError';
  }
}

export interface QuotaRunOutcome {
  /** true when the handler already sent a (non-201) response itself. */
  handled: boolean;
}

/**
 * Run the session-creation handler under a confirmed reservation:
 *   - handler resolves  → COMMIT the reservation (usage counted).
 *   - handler rejects   → RELEASE the reservation (compensation) and
 *     rethrow unless it was a ResponseSentError (response already sent).
 * Commit failure after a successful creation leaves a dangling 'reserved'
 * row — truthful residual: stale-reservation reconciliation (L3+) must
 * expire reserved rows.
 */
export async function runWithQuotaReservation(
  reservation: QuotaReservationOk,
  fn: () => Promise<void>,
  deps: { commit?: typeof commitReservation; release?: typeof releaseReservation } = {},
): Promise<QuotaRunOutcome> {
  const commit = deps.commit ?? commitReservation;
  const release = deps.release ?? releaseReservation;
  try {
    await fn();
    const c = await commit(reservation.reservationId);
    void c;
    return { handled: false };
  } catch (err) {
    await release(reservation.reservationId).catch(() => {});
    if (err instanceof ResponseSentError) return { handled: true };
    throw err;
  }
}
