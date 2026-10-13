/**
 * `GET /api/admin/r1/recording-health` (admin): the operator's view of the recording lane. Counts and
 * ages only; no id, key, URL or candidate data.
 *
 *   counts_by_status    recordings per status (all seven statuses present, zero when none)
 *   oldest_live_seconds age of the oldest recording that has not reached a final state
 *                       (preparing | uploading | finishing), or null
 *   retention_overdue   recordings still holding objects more than an hour past `delete_after`
 *                       (the sweep runs every 15 minutes; a recording held by a legal hold stays here)
 *   purge_backlog       open rows in the purge outbox
 *   finalize_failed     finalize jobs that exhausted their retries into the DLQ
 *
 * The retention promise ("90 days, then it is deleted") depends on the R1 runtime, which exists only
 * while `R1_ENABLED=true`: `retention_overdue` is how an operator notices it has stopped.
 */

import type { R1DbClient } from '../../../services/r1-assessment.js';
import { R1_RECORDING_FINALIZE_QUEUE } from './queues.js';
import { PURGE_TABLE } from './erase.js';
import { R1RecordingDbError, RECORDINGS_TABLE } from './service.js';

export const RECORDING_STATUSES = ['preparing', 'uploading', 'finishing', 'ready', 'partial', 'failed', 'deleted'] as const;
/** Past `delete_after` by more than this counts as overdue. */
export const RETENTION_OVERDUE_GRACE_MS = 60 * 60 * 1000;

export interface R1RecordingHealth {
  counts_by_status: Record<(typeof RECORDING_STATUSES)[number], number>;
  oldest_live_seconds: number | null;
  retention_overdue: number;
  purge_backlog: number;
  finalize_failed: number;
}

async function countRows(db: R1DbClient, table: string, build: (query: any) => any): Promise<number> {
  const { count, error } = await build(db.from(table).select('*', { count: 'exact', head: true }));
  if (error || typeof count !== 'number') throw new R1RecordingDbError();
  return count;
}

export async function readRecordingHealth(db: R1DbClient, nowMs: number = Date.now()): Promise<R1RecordingHealth> {
  const counts = {} as R1RecordingHealth['counts_by_status'];
  for (const status of RECORDING_STATUSES) counts[status] = await countRows(db, RECORDINGS_TABLE, (q) => q.eq('status', status));

  const { data: oldest, error: oldestError } = await db
    .from(RECORDINGS_TABLE)
    .select('created_at')
    .in('status', ['preparing', 'uploading', 'finishing'])
    .order('created_at', { ascending: true })
    .limit(1);
  if (oldestError) throw new R1RecordingDbError();
  const oldestMs = Array.isArray(oldest) && oldest.length > 0 ? Date.parse(String((oldest[0] as { created_at?: unknown }).created_at)) : Number.NaN;

  const overdueBefore = new Date(nowMs - RETENTION_OVERDUE_GRACE_MS).toISOString();
  return {
    counts_by_status: counts,
    oldest_live_seconds: Number.isFinite(oldestMs) ? Math.max(0, Math.floor((nowMs - oldestMs) / 1000)) : null,
    retention_overdue: await countRows(db, RECORDINGS_TABLE, (q) => q.is('deleted_at', null).lt('delete_after', overdueBefore)),
    purge_backlog: await countRows(db, PURGE_TABLE, (q) => q.is('done_at', null)),
    finalize_failed: await countRows(db, 'job_dlq', (q) => q.eq('name', R1_RECORDING_FINALIZE_QUEUE)),
  };
}
