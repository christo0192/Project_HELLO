/**
 * Truthful status helpers for the TA/HR workspace.
 *
 * Status vocabularies come from the DB CHECK constraints (0001/0006):
 *   - candidates.status:  new | queued | screening | screened | advanced | rejected
 *   - call_sessions.status: created | waiting | in_progress | completed |
 *                           failed | cancelled | expired
 *
 * Unknown statuses are rendered with their raw value and a neutral tone —
 * never invented labels.
 */

import type { StatusTone } from '../design/StatusBadge';

/** Human label for a candidate status (fallback: the raw value). */
export function candidateStatusLabel(status: string | null | undefined): string {
  if (typeof status !== 'string' && status != null) return 'New';
  switch (status ?? 'new') {
    case 'new':
      return 'New';
    case 'queued':
      return 'Queued';
    case 'screening':
      return 'Screening';
    case 'screened':
      return 'Screened';
    case 'advanced':
      return 'Advanced';
    case 'rejected':
      return 'Rejected';
    default:
      return (status ?? 'new').trim() || 'New';
  }
}

export function candidateStatusTone(status: string | null | undefined): StatusTone {
  switch (status) {
    case 'screened':
    case 'advanced':
      return 'success';
    case 'screening':
    case 'queued':
      return 'warning';
    case 'rejected':
      return 'danger';
    case 'new':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Human label for a session status (fallback: the raw value). */
export function sessionStatusLabel(status: string | null | undefined): string {
  if (typeof status !== 'string' && status != null) return '—';
  switch (status) {
    case 'created':
      return 'Created';
    case 'waiting':
      return 'Waiting';
    case 'in_progress':
      return 'In progress';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    default:
      return status ?? '—';
  }
}

export function sessionStatusTone(status: string | null | undefined): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'in_progress':
      return 'warning';
    case 'created':
    case 'waiting':
      return 'info';
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Human-readable duration from seconds (null-safe). */
export function formatDurationSec(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  if (minutes === 0) return `${remaining}s`;
  return `${minutes}m ${remaining}s`;
}

/** Count candidates by status — only statuses actually present are emitted. */
export function candidateStatusCounts(
  candidates: ReadonlyArray<{ status: string | null | undefined }>,
): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const status = candidate.status ?? 'new';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, value]) => ({ label: candidateStatusLabel(status), value }))
    .sort((a, b) => b.value - a.value);
}

/** Count sessions by status — only statuses actually present are emitted. */
export function sessionStatusCounts(
  sessions: ReadonlyArray<{ status: string | null | undefined }>,
): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const status = session.status ?? 'created';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, value]) => ({ label: sessionStatusLabel(status), value }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Sessions started per day over the last `days` days (UTC dates), zero-filled
 * for days with no sessions. Zero-fill is truthful: those days had none.
 */
export function sessionsPerDay(
  sessions: ReadonlyArray<{ created_at: string }>,
  days = 14,
): Array<{ label: string; value: number }> {
  const buckets = new Map<string, number>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - offset);
    buckets.set(day.toISOString().slice(0, 10), 0);
  }
  for (const session of sessions) {
    const created = new Date(session.created_at);
    if (Number.isNaN(created.getTime())) continue;
    const key = created.toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([iso, value]) => {
    const [, month, day] = iso.split('-');
    return { label: `${month}/${day}`, value };
  });
}
