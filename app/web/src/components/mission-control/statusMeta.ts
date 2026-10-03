/**
 * Pure, testable status/message helpers for the Mission Control (ops/SRE)
 * area. Everything here derives from real API response shapes — nothing is
 * estimated or invented.
 *
 * Status vocabularies mirror the backend contracts:
 *   - allowlist entries: active + linked_user_id → linked | pending | disabled
 *   - sessions: created | waiting | in_progress | completed | failed |
 *     cancelled | expired | abandoned (terminals are immutable)
 *   - mutation errors: the API returns stable error codes with stable
 *     HTTP statuses; `stableMutationMessage` maps them to operator-facing
 *     copy without leaking internals.
 */

import type {
  AdminAllowlistEntry,
  AdminAuditRow,
  PublicStatus,
} from '../../types';
import type { StatusTone } from '../design/StatusBadge';

/* ── Allowlist entry state ───────────────────────────────────────────── */

export type AllowlistEntryState = 'pending' | 'linked' | 'disabled';

export function allowlistEntryState(
  entry: Pick<AdminAllowlistEntry, 'active' | 'linked_user_id'>,
): AllowlistEntryState {
  if (!entry.active) return 'disabled';
  return entry.linked_user_id != null ? 'linked' : 'pending';
}

export function allowlistStateLabel(state: AllowlistEntryState): string {
  switch (state) {
    case 'linked':
      return 'Linked';
    case 'pending':
      return 'Pending';
    case 'disabled':
      return 'Disabled';
  }
}

export function allowlistStateTone(state: AllowlistEntryState): StatusTone {
  switch (state) {
    case 'linked':
      return 'success';
    case 'pending':
      return 'info';
    case 'disabled':
      return 'neutral';
  }
}

/**
 * Number of entries that are active, linked (have signed in) and admin —
 * the count the backend's "last linked active admin" guard protects.
 */
export function countLinkedActiveAdmins(
  entries: ReadonlyArray<AdminAllowlistEntry>,
): number {
  return entries.filter(
    (e) => e.active && e.linked_user_id != null && e.role === 'admin',
  ).length;
}

/**
 * Normalized-email preview for the add form. The server is authoritative;
 * this mirrors the visible normalization (trim + lowercase) so operators
 * see what will be stored before they submit.
 */
export function normalizeEmailPreview(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when an allowlist entry belongs to the signed-in operator. */
export function isSelfEntry(
  entryEmail: string,
  meEmail: string | null | undefined,
): boolean {
  if (!meEmail) return false;
  return normalizeEmailPreview(entryEmail) === normalizeEmailPreview(meEmail);
}

/* ── Session statuses ────────────────────────────────────────────────── */

/** Terminal session states — the backend forbids changing them (409). */
const TERMINAL_SESSION_STATUSES = new Set([
  'failed',
  'cancelled',
  'expired',
  'deleted',
]);

export function isTerminalSessionStatus(
  status: string | null | undefined,
): boolean {
  return status != null && TERMINAL_SESSION_STATUSES.has(status);
}

export const OVERRIDE_TARGET_STATUSES = [
  'created',
  'waiting',
  'in_progress',
  'failed',
  'cancelled',
  'completed',
] as const;

/** Statuses accepted by the admin session list filter (backend enum). */
export const SESSION_FILTER_STATUSES = [
  'created',
  'waiting',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'abandoned',
] as const;

/* ── Maintenance / service state ─────────────────────────────────────── */

export function maintenanceMeta(
  status: PublicStatus | null,
): { label: string; tone: StatusTone; detail: string } {
  if (!status) {
    return {
      label: 'Unknown',
      tone: 'neutral',
      detail: 'No status data available.',
    };
  }
  const maintenance = status.maintenance;
  if (maintenance?.enabled) {
    return {
      label: 'Maintenance mode',
      tone: 'warning',
      detail: maintenance.reason ?? 'No reason provided.',
    };
  }
  if (status.status === 'degraded') {
    return {
      label: 'Degraded',
      tone: 'warning',
      detail: 'Service reports degraded — no maintenance window is active.',
    };
  }
  return {
    label: 'Operational',
    tone: 'success',
    detail: 'No maintenance window is active.',
  };
}

/* ── Audit ───────────────────────────────────────────────────────────── */

/** Events in the last `hours` hours within a bounded recent page. */
export function auditEventsInWindow(
  rows: ReadonlyArray<AdminAuditRow>,
  hours: number,
  now: number = Date.now(),
): number {
  const cutoff = now - hours * 3_600_000;
  return rows.filter((row) => {
    const time = new Date(row.created_at).getTime();
    return !Number.isNaN(time) && time >= cutoff;
  }).length;
}

/* ── Stable mutation messages (400/409 etc.) ─────────────────────────── */

const STABLE_MESSAGES: Record<string, string> = {
  invalid_email:
    'That email address cannot be added to this workspace (only @interviewkickstart.com is accepted).',
  invalid_role: "That role isn't supported here.",
  invalid_reason: 'A reason is required for this change.',
  invalid_target: 'That status change is not allowed.',
  no_changes: 'No changes were made — the entry is already as requested.',
  not_found: 'That item no longer exists. Refresh the list and try again.',
  session_not_found:
    'That session no longer exists. Refresh the list and try again.',
  duplicate: 'That email is already on the access list.',
  self_modification_denied:
    "You can't change your own access entry — self-modification is protected.",
  last_linked_active_admin:
    'That is the last linked active admin — it cannot be removed or demoted.',
  resurrection_denied:
    'Sessions in a terminal state (failed, cancelled, expired, deleted) cannot be changed.',
  deleted_denied: 'Deleted sessions cannot be changed.',
  allowlist_add_failed: 'The access entry could not be added. Try again.',
  allowlist_update_failed: 'The access entry could not be updated. Try again.',
};

/**
 * Map a backend error code to a stable operator-facing message. Unknown
 * codes fall back to the caller's generic copy — never a raw stack/leak.
 */
export function stableMutationMessage(
  code: string | null | undefined,
  fallback: string,
): string {
  if (code && Object.prototype.hasOwnProperty.call(STABLE_MESSAGES, code)) {
    return STABLE_MESSAGES[code];
  }
  return fallback;
}

/* ── Phone lane health reasons (GET /api/phone/health) ───────────────── */

/**
 * Operator copy for every reason `GET /api/phone/health` can carry. The codes
 * are the API's closed vocabulary (`openapi.yaml`, PhoneHealthResponse
 * reasons); an unknown code is shown as itself rather than guessed at.
 */
const PHONE_HEALTH_REASON_LABELS: Record<string, string> = {
  phone_screening_disabled: 'Phone screening is turned off.',
  backlog_unavailable: 'The calling backlog could not be read.',
  halt_unreadable: 'The calling switch could not be read, so calling is stopped.',
  admission_halted: 'Calling is paused.',
  attempt_leases_expired: 'Some calls lost contact with their worker and are being recovered.',
  fleet_at_capacity: 'Every calling slot is in use.',
  appointments_overdue: 'Some booked calls are past their time.',
  phone_runtime_stopped: 'The calling loops on this server are stopped.',
  phone_loop_stale: 'A calling loop on this server has stopped ticking.',
  phone_loop_erroring: 'A calling loop on this server is failing.',
  phone_due_halted: 'The dialler is holding because calling is paused or unreadable.',
  phone_sweep_not_ok: 'A calling clean-up job is failing.',
  phone_runtime_start_failed: 'The calling loops failed to start on this server.',
  // 0114 (C10d).
  phone_due_starved:
    'Calls are due but none are being placed (for example, no call session could be prepared). Check the dialler.',
};

/** Label for a phone health reason; unknown codes fall back to the code. */
export function phoneHealthReasonLabel(reason: string): string {
  return Object.prototype.hasOwnProperty.call(PHONE_HEALTH_REASON_LABELS, reason)
    ? PHONE_HEALTH_REASON_LABELS[reason]
    : reason;
}

/** Tone for a phone health reason: starvation and start failures are errors. */
export function phoneHealthReasonTone(reason: string): StatusTone {
  if (
    reason === 'phone_due_starved'
    || reason === 'phone_runtime_start_failed'
    || reason === 'halt_unreadable'
  ) {
    return 'danger';
  }
  if (reason === 'admission_halted' || reason === 'phone_due_halted') return 'info';
  return 'warning';
}

/* ── Resume scanner warnings (Ashby health `scanner.warnings`) ───────── */

const SCANNER_WARNING_LABELS: Record<string, string> = {
  scanner_updater_failing:
    'Virus-definition updates keep failing. Résumé scanning will stop if this continues.',
  scanner_signatures_aging:
    'Virus definitions are getting old. Résumé scanning stops when they reach 24 hours.',
};

/** Label for a WARNING-ONLY scanner code (0114, C10c); unknown → the code. */
export function scannerWarningLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(SCANNER_WARNING_LABELS, code)
    ? SCANNER_WARNING_LABELS[code]
    : code;
}

/* ── Small display helpers ───────────────────────────────────────────── */

/** Localized date-time, with a truthful placeholder for missing data. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

/** Opaque-ID shortening for display (never emails/PII). */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 13 ? `${id.slice(0, 13)}…` : id;
}
