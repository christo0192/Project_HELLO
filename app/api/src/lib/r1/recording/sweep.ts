/**
 * `r1.sweep`: the recording lane's housekeeping, run every 15 minutes (research/api-storage.md 7.2).
 *
 * Six independent tasks, each bounded to {@link SWEEP_BATCH} rows per run and each individually
 * try/caught, so one failing task (an R2 outage, a database error) never stops the others and the
 * job never fails because of it; the next run retries. The counters of every task come back in a
 * report (numbers only: no id, key or URL ever leaves this module).
 *
 *   A. retention   `delete_after <= now()`                                 -> erase (reason retention)
 *   B. requested   `delete_requested_at` set but not yet erased, plus the WITHDRAWAL BACKSTOP: a live
 *                  recording older than a later withdrawal/decline of its round (covers a lost
 *                  trigger job)                                            -> erase (consent_withdrawn)
 *   C. stale live  `preparing|uploading` untouched for 2 h (the worker is gone): salvage it into
 *                  `finishing` (finalize completes what reached R2, `failure_reason = worker_lost`) or,
 *                  when nothing could have been uploaded, `failed/nothing_uploaded`; plus multipart
 *                  uploads under `r1/` that no live row owns -> abort
 *   D. stuck finalize  `finishing` and idle for 30 min: re-enqueue the finalize job (the dedup key
 *                  keeps it to one); after 3 h in `finishing` give up: `failed/finalize_exhausted`
 *                  (every object is kept for the erase job and retention)
 *   E. purge outbox  rows left by a recording row that was DELETED without being erased -> erase by
 *                  prefix, verify, `done_at`
 *   F. re-verify   anything erased in the last 2 h: list the prefix and the multipart uploads again
 *                  and remove stragglers (a worker PUT on a still-valid 600 s URL can land after the
 *                  delete)
 *
 * Legal holds are honoured by the erase routine itself (erase.ts). Held rows are retried every run
 * but audited at most once a day, and sort behind fresh work in the outbox.
 */

import type { R1DbClient } from '../../../services/r1-assessment.js';
import {
  PURGE_TABLE,
  R1_SYSTEM_ACTOR_ID,
  eraseOutboxRow,
  eraseRows,
  isEraseReason,
  purgePrefix,
  sessionIdOfPrefix,
  withdrawalCutoffs,
  type R1EraseDeps,
  type R1EraseReason,
  type R1PurgeRow,
} from './erase.js';
import { STREAM_FILE, toCanonicalUuid } from './keys.js';
import { R1_RECORDING_FINALIZE_QUEUE } from './queues.js';
import { R1RecordingDbError, RECORDINGS_TABLE, loadRecording, type R1RecordingRow } from './service.js';
import { guardStore, takeListing } from './store-errors.js';
import { governanceCorrelationId, recordGovernanceAudit } from '../../retention.js';

export const SWEEP_BATCH = 50;
/** `preparing | uploading` with no activity for this long: the worker is gone. */
export const STALE_LIVE_MS = 2 * 60 * 60 * 1000;
/** `finishing` with no activity for this long gets its finalize job re-enqueued. */
export const FINALIZE_STUCK_MS = 30 * 60 * 1000;
/** `finishing` for this long: give up (`failed/finalize_exhausted`). */
export const FINALIZE_GIVE_UP_MS = 3 * 60 * 60 * 1000;
/** A multipart upload younger than this is never aborted as an orphan (a `prepare` may still be recording its id). */
export const ORPHAN_UPLOAD_MIN_AGE_MS = 15 * 60 * 1000;
/** How long after an erase the prefix is re-verified for stragglers. */
export const REVERIFY_WINDOW_MS = 2 * 60 * 60 * 1000;
/** How many live rows the withdrawal backstop reads per run. */
export const BACKSTOP_SCAN_ROWS = 1000;
const MAX_ORPHAN_SCAN = 200;

export interface R1SweepDeps extends R1EraseDeps {
  readonly enqueue: (name: string, payload: unknown, options: { dedupKey: string; maxAttempts: number }) => Promise<unknown>;
  /** A fixed category code; never a value. */
  readonly log?: (category: string) => void;
}

export interface R1SweepReport {
  readonly retention: { erased: number; blocked: number; errors: number };
  readonly requested: { erased: number; blocked: number; errors: number };
  readonly stale: { salvaged: number; failed: number; orphan_uploads_aborted: number; errors: number };
  readonly finalize: { redriven: number; exhausted: number; errors: number };
  readonly purge: { done: number; blocked: number; failed: number; errors: number };
  readonly reverify: { checked: number; stragglers_removed: number; errors: number };
}

const clockOf = (deps: R1SweepDeps): (() => Date) => deps.now ?? ((): Date => new Date());

async function selectRows(
  db: R1DbClient,
  table: string,
  build: (query: any) => any,
): Promise<any[]> {
  const { data, error } = await build(db.from(table).select('*'));
  if (error) throw new R1RecordingDbError();
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------- A. retention

async function sweepRetention(deps: R1SweepDeps): Promise<R1SweepReport['retention']> {
  const nowIso = clockOf(deps)().toISOString();
  const rows = (await selectRows(deps.db, RECORDINGS_TABLE, (q) =>
    q.is('deleted_at', null).lte('delete_after', nowIso).order('delete_after', { ascending: true }).limit(SWEEP_BATCH),
  )) as R1RecordingRow[];
  const { result } = await eraseRows(deps, rows, () => 'retention');
  return { erased: result.erased, blocked: result.blocked, errors: result.errors };
}

// ---------------------------------------------------------------- B. requested + withdrawal backstop

async function sweepRequested(deps: R1SweepDeps): Promise<R1SweepReport['requested']> {
  const total = { erased: 0, blocked: 0, errors: 0 };
  const add = (r: { erased: number; blocked: number; errors: number }): void => {
    total.erased += r.erased;
    total.blocked += r.blocked;
    total.errors += r.errors;
  };

  const requested = (await selectRows(deps.db, RECORDINGS_TABLE, (q) =>
    q.is('deleted_at', null).not('delete_requested_at', 'is', null).order('delete_requested_at', { ascending: true }).limit(SWEEP_BATCH),
  )) as R1RecordingRow[];
  const reasonOf = (row: R1RecordingRow): R1EraseReason => (isEraseReason(row.delete_reason) ? row.delete_reason : 'consent_withdrawn');
  add((await eraseRows(deps, requested, reasonOf)).result);

  // The backstop: live rows made at or before a LATER withdrawal/decline of their round.
  const budget = SWEEP_BATCH - requested.length;
  if (budget > 0) {
    const live = (await selectRows(deps.db, RECORDINGS_TABLE, (q) =>
      q.is('deleted_at', null).is('delete_requested_at', null).order('created_at', { ascending: true }).limit(BACKSTOP_SCAN_ROWS),
    )) as R1RecordingRow[];
    if (live.length > 0) {
      const cutoffs = await withdrawalCutoffs(deps.db, [...new Set(live.map((row) => row.round_id))]);
      const due = live.filter((row) => {
        const cutoff = cutoffs.get(row.round_id);
        return cutoff !== undefined && Date.parse(row.created_at) <= cutoff;
      }).slice(0, budget);
      add((await eraseRows(deps, due, () => 'consent_withdrawn')).result);
    }
  }
  return total;
}

// ---------------------------------------------------------------- C. stale live rows + orphan uploads

const ORPHAN_KEY = /^r1\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/stream\.mp4$/;

async function sweepStale(deps: R1SweepDeps): Promise<R1SweepReport['stale']> {
  const report = { salvaged: 0, failed: 0, orphan_uploads_aborted: 0, errors: 0 };
  const now = clockOf(deps)();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - STALE_LIVE_MS).toISOString();

  const stale = (await selectRows(deps.db, RECORDINGS_TABLE, (q) =>
    q.in('status', ['preparing', 'uploading']).lt('updated_at', cutoff).is('delete_requested_at', null).order('updated_at', { ascending: true }).limit(SWEEP_BATCH),
  )) as R1RecordingRow[];

  for (const row of stale) {
    try {
      // No URL was ever issued (or the upload never started): nothing can be in R2.
      const nothing = row.upload_id === null || (row.parts_issued === 0 && row.urls_issued === 0);
      if (nothing) {
        if (row.upload_id) await guardStore(() => deps.store.abortMultipart(`${row.prefix}${STREAM_FILE}`, row.upload_id!));
        const { data, error } = await deps.db
          .from(RECORDINGS_TABLE)
          .update({ status: 'failed', failure_reason: 'nothing_uploaded', upload_id: null, finalized_at: nowIso, updated_at: nowIso })
          .eq('session_id', row.session_id)
          .eq('status', row.status)
          .eq('updated_at', row.updated_at)
          .is('delete_requested_at', null)
          .select('session_id');
        if (error) throw new R1RecordingDbError();
        if (Array.isArray(data) && data.length === 1) report.failed += 1;
      } else {
        // finalize salvages what reached R2; the 0127 trigger enqueues it on the status flip.
        const { data, error } = await deps.db
          .from(RECORDINGS_TABLE)
          .update({ status: 'finishing', failure_reason: 'worker_lost', finalize_requested_at: nowIso, updated_at: nowIso })
          .eq('session_id', row.session_id)
          .eq('status', row.status)
          .eq('updated_at', row.updated_at)
          .is('delete_requested_at', null)
          .select('session_id');
        if (error) throw new R1RecordingDbError();
        if (Array.isArray(data) && data.length === 1) report.salvaged += 1;
      }
    } catch {
      report.errors += 1;
    }
  }

  // Multipart uploads under r1/ that no live row owns (a prepare CAS loser whose abort failed, a
  // deleted row's leftover). Foreign keys (anything not r1/<uuid>/<uuid>/stream.mp4) are never touched.
  try {
    const uploads = await takeListing(deps.store.listMultipartUploads('r1/'), MAX_ORPHAN_SCAN);
    for (const upload of uploads) {
      const match = ORPHAN_KEY.exec(upload.key);
      const round = toCanonicalUuid(match?.[1]);
      const session = toCanonicalUuid(match?.[2]);
      if (!match || !round || !session || upload.key !== `r1/${round}/${session}/${STREAM_FILE}`) continue;
      if (now.getTime() - upload.initiatedAt.getTime() < ORPHAN_UPLOAD_MIN_AGE_MS) continue;
      try {
        const row = await loadRecording(deps.db, session);
        const owned = row !== null && row.deleted_at === null && row.status !== 'deleted' && row.upload_id === upload.uploadId;
        if (owned) continue;
        await guardStore(() => deps.store.abortMultipart(upload.key, upload.uploadId));
        report.orphan_uploads_aborted += 1;
      } catch {
        report.errors += 1;
      }
    }
  } catch {
    report.errors += 1;
  }
  return report;
}

// ---------------------------------------------------------------- D. stuck finalize

async function sweepFinalize(deps: R1SweepDeps): Promise<R1SweepReport['finalize']> {
  const report = { redriven: 0, exhausted: 0, errors: 0 };
  const now = clockOf(deps)();
  const nowIso = now.toISOString();
  const idleCutoff = new Date(now.getTime() - FINALIZE_STUCK_MS).toISOString();
  const rows = (await selectRows(deps.db, RECORDINGS_TABLE, (q) =>
    q.eq('status', 'finishing').lt('updated_at', idleCutoff).is('delete_requested_at', null).order('updated_at', { ascending: true }).limit(SWEEP_BATCH),
  )) as R1RecordingRow[];

  for (const row of rows) {
    try {
      const since = Date.parse(row.finalize_requested_at ?? row.created_at);
      if (Number.isFinite(since) && now.getTime() - since >= FINALIZE_GIVE_UP_MS) {
        const { data, error } = await deps.db
          .from(RECORDINGS_TABLE)
          .update({ status: 'failed', failure_reason: 'finalize_exhausted', finalized_at: nowIso, updated_at: nowIso })
          .eq('session_id', row.session_id)
          .eq('status', 'finishing')
          .eq('updated_at', row.updated_at)
          .is('delete_requested_at', null)
          .select('session_id');
        if (error) throw new R1RecordingDbError();
        if (Array.isArray(data) && data.length === 1) report.exhausted += 1;
        continue;
      }
      // The dedup key keeps this to ONE live job; a completed or dead-lettered one does not block it.
      await deps.enqueue(
        R1_RECORDING_FINALIZE_QUEUE,
        { session_id: row.session_id },
        { dedupKey: `${R1_RECORDING_FINALIZE_QUEUE}:${row.session_id}`, maxAttempts: 5 },
      );
      report.redriven += 1;
    } catch {
      report.errors += 1;
    }
  }
  return report;
}

// ---------------------------------------------------------------- E. purge outbox

async function sweepPurge(deps: R1SweepDeps): Promise<R1SweepReport['purge']> {
  const report = { done: 0, blocked: 0, failed: 0, errors: 0 };
  // Fresh rows first; a row that keeps failing (attempts) sinks behind them instead of starving them.
  const rows = (await selectRows(deps.db, PURGE_TABLE, (q) =>
    q.is('done_at', null).order('attempts', { ascending: true }).order('queued_at', { ascending: true }).limit(SWEEP_BATCH),
  )) as R1PurgeRow[];
  for (const row of rows) {
    const outcome = await eraseOutboxRow(deps, row);
    if (outcome.kind === 'done') report.done += 1;
    else if (outcome.kind === 'blocked') report.blocked += 1;
    else report.failed += 1;
  }
  return report;
}

// ---------------------------------------------------------------- F. post-delete re-verify

async function reverifyPrefix(deps: R1SweepDeps, prefix: string): Promise<number> {
  const listed = await takeListing(deps.store.listPrefix(prefix), 1);
  const uploads = await takeListing(deps.store.listMultipartUploads(prefix), 1);
  if (listed.length === 0 && uploads.length === 0) return 0;
  const purged = await purgePrefix(deps.store, prefix, []);
  const sessionId = sessionIdOfPrefix(prefix);
  await recordGovernanceAudit({
    action: 'data_deleted',
    actorId: R1_SYSTEM_ACTOR_ID,
    actorType: 'system',
    entityType: 'recording',
    entityId: sessionId,
    details: { resource: 'r1_recording', reason: 'straggler', objects: purged.objects, uploads_aborted: purged.uploads },
    outcome: 'success',
    correlationId: governanceCorrelationId(),
  }, deps.db as never);
  return purged.objects + purged.uploads;
}

async function sweepReverify(deps: R1SweepDeps): Promise<R1SweepReport['reverify']> {
  const report = { checked: 0, stragglers_removed: 0, errors: 0 };
  const since = new Date(clockOf(deps)().getTime() - REVERIFY_WINDOW_MS).toISOString();
  const prefixes: string[] = [];
  const erasedRows = (await selectRows(deps.db, RECORDINGS_TABLE, (q) =>
    q.eq('status', 'deleted').gte('deleted_at', since).order('deleted_at', { ascending: false }).limit(SWEEP_BATCH),
  )) as R1RecordingRow[];
  for (const row of erasedRows) if (row.bucket === deps.bucket) prefixes.push(row.prefix);
  const drained = (await selectRows(deps.db, PURGE_TABLE, (q) =>
    q.gte('done_at', since).order('done_at', { ascending: false }).limit(SWEEP_BATCH),
  )) as R1PurgeRow[];
  for (const row of drained) if (row.bucket === deps.bucket) prefixes.push(row.prefix);

  for (const prefix of new Set(prefixes)) {
    try {
      report.checked += 1;
      report.stragglers_removed += await reverifyPrefix(deps, prefix);
    } catch {
      report.errors += 1;
    }
  }
  return report;
}

// ---------------------------------------------------------------- the run

const EMPTY: R1SweepReport = {
  retention: { erased: 0, blocked: 0, errors: 0 },
  requested: { erased: 0, blocked: 0, errors: 0 },
  stale: { salvaged: 0, failed: 0, orphan_uploads_aborted: 0, errors: 0 },
  finalize: { redriven: 0, exhausted: 0, errors: 0 },
  purge: { done: 0, blocked: 0, failed: 0, errors: 0 },
  reverify: { checked: 0, stragglers_removed: 0, errors: 0 },
};

/** Run every task once. Never throws: a task that fails outright counts one error and the rest still run. */
export async function runR1Sweep(deps: R1SweepDeps): Promise<R1SweepReport> {
  const report: { -readonly [K in keyof R1SweepReport]: R1SweepReport[K] } = JSON.parse(JSON.stringify(EMPTY));
  const run = async <K extends keyof R1SweepReport>(name: K, task: () => Promise<R1SweepReport[K]>): Promise<void> => {
    try {
      report[name] = await task();
    } catch {
      (report[name] as { errors: number }).errors += 1;
      deps.log?.(`r1_sweep_${name}_error`);
    }
  };
  await run('retention', () => sweepRetention(deps));
  await run('requested', () => sweepRequested(deps));
  await run('stale', () => sweepStale(deps));
  await run('finalize', () => sweepFinalize(deps));
  await run('purge', () => sweepPurge(deps));
  await run('reverify', () => sweepReverify(deps));
  return report;
}

/** True when any task of the report counted an error (the handler logs a category, it does not fail the job). */
export function sweepHadErrors(report: R1SweepReport): boolean {
  return Object.values(report).some((task) => (task as { errors: number }).errors > 0);
}
