/**
 * lib/recording/health.ts — the truthful liveness surface for recording
 * finalization.
 *
 * TWO INDEPENDENT SIGNALS, for the same reason the Ashby surface has two:
 *
 *  1. A real in-process heartbeat. `index.ts` registers the live runtime here
 *     and the route reads its actual tick bookkeeping. A loop that has not
 *     ticked within its own window is `stale`.
 *
 *  2. A multi-machine-safe DURABLE backlog, read from the DATABASE. This
 *     deployment can run more than one machine, so "this process has no
 *     runtime" is not evidence that the fleet has none.
 *
 * THE BACKLOG IS NEVER DERIVED FROM COUNTERS. `lib/metrics.ts` is a no-op sink
 * by default and there is no production `setMetricSink` caller, so a
 * counter-derived gauge would report a confident zero — the most dangerous
 * possible answer for a subsystem whose failure mode is silence. Everything
 * below is a live query, and a read failure surfaces as `degraded` with
 * `backlog_unavailable`, never as a healthy zero.
 *
 * THE QUEUE IS MEASURED, NOT ASSUMED. `stuck_count` alone cannot distinguish
 * "converging slowly" from "not converging": the three sweeper bounds all
 * bound the PRODUCER. `queue_depth` and `oldest_scheduled_at` for
 * `recording.finalize` are the numbers that make that distinction, so they are
 * part of the payload rather than an inference from it.
 *
 * DISCLOSURE BOUNDARY: booleans, bounded integers, timestamps, and sanitized
 * codes. No session id, candidate field, object key, URL, or token ever
 * appears here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SchedulerLoopHealth } from '../scheduler.js';
import type { RecordingRuntimeHandle } from './runtime.js';
import { RECORDING_FINALIZE_QUEUE, TERMINAL_SESSION_STATUSES } from './config.js';
import { RECORDING_FINALIZE_DEFER_REASONS } from '../recording-egress.js';

/** Missed intervals before a loop is called `stale`. */
export const STALE_TICK_MULTIPLIER = 3;
/** Absolute floor for the staleness window, so a fast poll is not flappy. */
export const MIN_STALE_WINDOW_MS = 30_000;

/** Thresholds at which the surface reports `degraded`. */
export const DEGRADE_THRESHOLDS = {
  /** A stuck row older than this means convergence is not happening. */
  oldestStuckAgeSec: 3_600,
  /** Any exhausted row is a human decision waiting to be made. */
  exhaustedCount: 1,
  /** A finalize job waiting longer than this is not being drained. */
  oldestQueuedAgeSec: 1_800,
} as const;

// ── Process-local runtime registry ───────────────────────────────────────────

let registered: RecordingRuntimeHandle | null = null;

export function registerRecordingRuntime(runtime: RecordingRuntimeHandle): void {
  registered = runtime;
}

export function clearRecordingRuntimeRegistration(): void {
  registered = null;
}

export interface RecordingLoopHealthView {
  name: string;
  running: boolean;
  lastTickAt: string | null;
  ticks: number;
  errors: number;
  consecutiveErrors: number;
  stale: boolean;
}

export interface RecordingWorkerView {
  /** Whether THIS process has a started runtime. Never a fleet-wide claim. */
  enabled: boolean;
  running: boolean;
  loops: RecordingLoopHealthView[];
}

export function snapshotRecordingWorker(nowMs: number = Date.now()): RecordingWorkerView {
  if (!registered) return { enabled: false, running: false, loops: [] };
  const health = registered.scheduler.health();
  const intervals = registered.loopIntervalsMs;
  return {
    enabled: true,
    running: health.running,
    loops: health.loops.map((loop: SchedulerLoopHealth): RecordingLoopHealthView => {
      const interval = intervals[loop.name] ?? 0;
      const window = Math.max(MIN_STALE_WINDOW_MS, interval * STALE_TICK_MULTIPLIER);
      const last = loop.lastTickAt ? Date.parse(loop.lastTickAt) : NaN;
      const stale = health.running && (!Number.isFinite(last) || nowMs - last > window);
      return { ...loop, stale };
    }),
  };
}

/** Read the halt state through the registered runtime's cached reader. */
export async function snapshotRecordingHalt(): Promise<{
  halted: boolean;
  reason: string | null;
  since: string | null;
  degraded: boolean;
} | null> {
  if (!registered) return null;
  return registered.halt.read();
}

export interface RecordingBacklogView {
  /** Sessions matching the exact stuck shape, still retryable. */
  stuckCount: number;
  /** Age of the oldest such session, or null when there are none. */
  oldestStuckAgeSec: number | null;
  /** Sessions that exhausted their deferral budget and stopped being swept. */
  exhaustedCount: number;
  /** Per-reason counts across all rows currently carrying a defer reason. */
  deferredByReason: Record<string, number>;
  /** Live `recording.finalize` jobs (pending/active/delayed). */
  queueDepth: number;
  /** Earliest `scheduled_at` among live finalize jobs, or null. */
  oldestScheduledAt: string | null;
  /** Age of that job in seconds, or null. */
  oldestQueuedAgeSec: number | null;
  /** Dead-lettered finalize jobs. */
  dlqDepth: number;
}

interface CountQuery {
  eq(column: string, value: unknown): CountQuery;
  in(column: string, values: readonly unknown[]): CountQuery;
  is(column: string, value: unknown): CountQuery;
  not(column: string, op: string, value: unknown): CountQuery;
  then<T>(onOk: (r: { count: number | null; error: unknown }) => T): Promise<T>;
}

async function countRows(
  client: SupabaseClient,
  table: string,
  filter: (q: CountQuery) => CountQuery,
): Promise<number> {
  const base = client.from(table).select('*', { count: 'exact', head: true }) as unknown as CountQuery;
  const { count, error } = await filter(base).then((r) => r);
  if (error) throw new Error('recording_health_count_error');
  return typeof count === 'number' ? count : 0;
}

/** The stuck-shape predicate, applied identically wherever it is needed. */
function stuckShape(q: CountQuery): CountQuery {
  return q
    .in('status', [...TERMINAL_SESSION_STATUSES])
    .not('recording_egress_id', 'is', null)
    .is('recording_object_key', null)
    .eq('recording_egress_status', 'active')
    .is('recording_finalize_exhausted_at', null)
    .is('recording_deleted_at', null)
    .is('recording_revoked_at', null)
    .eq('recording_quarantined', false);
}

/**
 * Read the durable backlog. Correct on any machine, including one that never
 * started a runtime. Throws `recording_health_count_error` on any read
 * failure — the caller turns that into `degraded`/`backlog_unavailable`
 * rather than into a confident zero.
 */
export async function readRecordingBacklog(
  client: SupabaseClient,
  nowMs: number = Date.now(),
): Promise<RecordingBacklogView> {
  const [stuckCount, exhaustedCount, queueDepth, dlqDepth] = await Promise.all([
    countRows(client, 'call_sessions', stuckShape),
    countRows(client, 'call_sessions', (q) =>
      q.not('recording_finalize_exhausted_at', 'is', null)),
    countRows(client, 'job_queue', (q) =>
      q.eq('name', RECORDING_FINALIZE_QUEUE).in('status', ['pending', 'active', 'delayed'])),
    countRows(client, 'job_dlq', (q) => q.eq('name', RECORDING_FINALIZE_QUEUE)),
  ]);

  // Oldest stuck session — one row, ended_at only, no identifier leaves the DB.
  // Written out rather than reusing `stuckShape` because this builder ends in
  // order/limit/maybeSingle rather than a head count; the predicate is
  // identical and must stay so.
  const { data: oldestStuck, error: stuckErr } = await client
    .from('call_sessions')
    .select('ended_at')
    .in('status', [...TERMINAL_SESSION_STATUSES])
    .not('recording_egress_id', 'is', null)
    .is('recording_object_key', null)
    .eq('recording_egress_status', 'active')
    .is('recording_finalize_exhausted_at', null)
    .is('recording_deleted_at', null)
    .is('recording_revoked_at', null)
    .eq('recording_quarantined', false)
    .order('ended_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (stuckErr) throw new Error('recording_health_count_error');
  const stuckAt = (oldestStuck as { ended_at?: string | null } | null)?.ended_at ?? null;
  const oldestStuckAgeSec = stuckAt
    ? Math.max(0, Math.round((nowMs - Date.parse(stuckAt)) / 1000))
    : null;

  // Oldest live finalize job — the number that separates "converging slowly"
  // from "not converging at all".
  const { data: oldestJob, error: jobErr } = await client
    .from('job_queue')
    .select('scheduled_at')
    .eq('name', RECORDING_FINALIZE_QUEUE)
    .in('status', ['pending', 'active', 'delayed'])
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (jobErr) throw new Error('recording_health_count_error');
  const scheduledAt = (oldestJob as { scheduled_at?: string | null } | null)?.scheduled_at ?? null;
  const oldestQueuedAgeSec = scheduledAt
    ? Math.max(0, Math.round((nowMs - Date.parse(scheduledAt)) / 1000))
    : null;

  // Per-reason deferral counts. Bounded: one count per allowlisted code, and
  // the codes are a fixed enum, so the response shape cannot grow with data.
  const reasonCounts = await Promise.all(
    RECORDING_FINALIZE_DEFER_REASONS.map((reason) =>
      countRows(client, 'call_sessions', (q) =>
        q.eq('recording_finalize_defer_reason', reason).is('recording_object_key', null))),
  );
  const deferredByReason: Record<string, number> = {};
  RECORDING_FINALIZE_DEFER_REASONS.forEach((reason, i) => {
    deferredByReason[reason] = reasonCounts[i];
  });

  return {
    stuckCount,
    oldestStuckAgeSec,
    exhaustedCount,
    deferredByReason,
    queueDepth,
    oldestScheduledAt: scheduledAt,
    oldestQueuedAgeSec,
    dlqDepth,
  };
}

export interface RecordingHealthView {
  worker: RecordingWorkerView;
  halt: { halted: boolean; reason: string | null; since: string | null; degraded: boolean } | null;
  backlog: RecordingBacklogView | null;
  degraded: boolean;
  reasons: string[];
}

/**
 * Assemble the health view. Never throws: an unreadable backlog is reported
 * AS unreadable.
 */
export async function readRecordingHealth(
  client: SupabaseClient,
  nowMs: number = Date.now(),
): Promise<RecordingHealthView> {
  const worker = snapshotRecordingWorker(nowMs);
  const reasons: string[] = [];

  let halt: RecordingHealthView['halt'] = null;
  try {
    halt = await snapshotRecordingHalt();
  } catch {
    halt = null;
  }
  if (halt?.halted) reasons.push('sweep_halted');
  if (halt?.degraded) reasons.push('halt_flag_unavailable');

  let backlog: RecordingBacklogView | null = null;
  try {
    backlog = await readRecordingBacklog(client, nowMs);
  } catch {
    // The one answer that must never be a zero.
    reasons.push('backlog_unavailable');
  }

  if (backlog) {
    if (backlog.exhaustedCount >= DEGRADE_THRESHOLDS.exhaustedCount) {
      reasons.push('finalize_exhausted');
    }
    if ((backlog.oldestStuckAgeSec ?? 0) > DEGRADE_THRESHOLDS.oldestStuckAgeSec) {
      reasons.push('stuck_backlog_aging');
    }
    if ((backlog.oldestQueuedAgeSec ?? 0) > DEGRADE_THRESHOLDS.oldestQueuedAgeSec) {
      reasons.push('queue_not_draining');
    }
    if (backlog.dlqDepth > 0) reasons.push('finalize_dead_lettered');
  }

  for (const loop of worker.loops) {
    if (loop.stale) reasons.push('loop_stale');
  }

  return { worker, halt, backlog, degraded: reasons.length > 0, reasons: [...new Set(reasons)] };
}
