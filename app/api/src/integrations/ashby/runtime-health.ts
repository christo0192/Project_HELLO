/**
 * ashby/runtime-health.ts — the truthful liveness surface.
 *
 * Review finding M3: `GET …/mission-control/health` reported CONFIGURATION and
 * called it health. Its own comment named "the operation/queue backlog" as the
 * substitute liveness signal, but the response carried no backlog fields at
 * all; the runbook named `ashby_scheduler_tick` metrics, but the default metric
 * sink is a no-op with no production `setMetricSink` caller, so counters
 * reached only a debug log and gauges were dropped entirely; and
 * `no_progress_runs` — the chosen reconciliation-progress strategy — was
 * exposed by nothing. If the scheduler died, health still said `active: true`.
 *
 * This module fixes that with two independent signals:
 *
 *  1. **A real in-process heartbeat.** `index.ts` registers the live scheduler
 *     handle here; the router reads its actual tick bookkeeping. A loop that
 *     has not ticked within its own expected window is reported `stale`.
 *
 *  2. **Multi-machine-safe DB backlog.** The heartbeat is per-process and this
 *     deployment can run more than one machine (`auto_start_machines`), so a
 *     process that never registered a scheduler is NOT evidence that no
 *     scheduler exists anywhere. The durable signals — queue depth, DLQ depth,
 *     oldest pending age, operations awaiting delivery, and the reconciliation
 *     checkpoint's `no_progress_runs` — are read from the database and are
 *     correct regardless of which machine answers the request.
 *
 * Everything exposed is a boolean, a bounded integer, or a timestamp. No id,
 * URL, hostname, secret, token, or candidate field ever appears.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AshbySchedulerHandle, SchedulerLoopHealth } from './scheduler.js';
import { ASHBY_SIGNAL_QUEUE, ASHBY_IMPORT_QUEUE } from './signal-worker.js';
import { ASHBY_INGESTION_QUEUE } from './runtime-workers.js';
import { DEFAULT_CHECKPOINT_KEY } from './reconciliation.js';

/**
 * How many missed intervals before a loop is called `stale`. Three gives a
 * slow tick and one jittered backoff room to complete before we accuse a live
 * scheduler of being dead.
 */
export const STALE_TICK_MULTIPLIER = 3;

/** Absolute floor for the staleness window, so a fast poll is not flappy. */
export const MIN_STALE_WINDOW_MS = 30_000;

/** The Ashby queues whose depth is a liveness signal. */
export const ASHBY_QUEUE_NAMES: readonly string[] = [
  ASHBY_SIGNAL_QUEUE,
  ASHBY_IMPORT_QUEUE,
  ASHBY_INGESTION_QUEUE,
];

// ── Process-local scheduler registry ─────────────────────────────────────────

let registered: { scheduler: AshbySchedulerHandle; intervals: Record<string, number> } | null = null;

/**
 * Register the live scheduler so the health route can read its real tick
 * bookkeeping. Called by `index.ts` when — and only when — a runtime was
 * actually constructed and started.
 */
export function registerAshbyScheduler(
  scheduler: AshbySchedulerHandle,
  intervals: Record<string, number>,
): void {
  registered = { scheduler, intervals };
}

/** Clear the registry (process shutdown, and test isolation). */
export function clearAshbySchedulerRegistration(): void {
  registered = null;
}

export interface LoopHealthView {
  name: string;
  running: boolean;
  lastTickAt: string | null;
  ticks: number;
  errors: number;
  consecutiveErrors: number;
  /** True when the loop has not ticked within its own expected window. */
  stale: boolean;
}

export interface SchedulerHealthView {
  /** Whether THIS process has a started scheduler. Never a fleet-wide claim. */
  registeredInThisProcess: boolean;
  running: boolean;
  loops: LoopHealthView[];
}

/**
 * Snapshot the in-process scheduler. `registeredInThisProcess: false` means
 * exactly that — this process has no scheduler — and NOT that the fleet has
 * none. The backlog fields below are the fleet-wide signal.
 */
export function snapshotScheduler(nowMs: number = Date.now()): SchedulerHealthView {
  if (!registered) {
    return { registeredInThisProcess: false, running: false, loops: [] };
  }
  const health = registered.scheduler.health();
  return {
    registeredInThisProcess: true,
    running: health.running,
    loops: health.loops.map((loop: SchedulerLoopHealth): LoopHealthView => {
      const interval = registered!.intervals[loop.name] ?? 0;
      const window = Math.max(MIN_STALE_WINDOW_MS, interval * STALE_TICK_MULTIPLIER);
      const last = loop.lastTickAt ? Date.parse(loop.lastTickAt) : NaN;
      // A running loop that has never ticked, or whose last tick is older than
      // its window, is stale. A stopped loop is not "stale" — it is stopped.
      const stale = health.running
        && (!Number.isFinite(last) || nowMs - last > window);
      return { ...loop, stale };
    }),
  };
}

// ── Durable backlog (multi-machine safe) ─────────────────────────────────────

export interface BacklogView {
  /** Live (pending/active/delayed) Ashby jobs across all Ashby queues. */
  queuePending: number;
  /** Ashby jobs in the dead-letter queue. */
  dlqDepth: number;
  /** Age in seconds of the oldest live Ashby job, or null when the queue is empty. */
  oldestPendingAgeSec: number | null;
  /** Operations still runnable. */
  operationsPending: number;
  /** Operations failed and awaiting an admin decision. */
  operationsFailed: number;
  /** Manual invites minted but not yet handed to a recruiter. */
  operationsAwaitingDelivery: number;
  /** Applications parked awaiting manual result publication. */
  writebackPending: number;
  /** Consecutive reconciliation runs that did not advance the cursor. */
  reconcileNoProgressRuns: number;
  /** Last fully-drained reconciliation, or null. */
  reconcileLastSuccessAt: string | null;
}

const EMPTY_BACKLOG: BacklogView = {
  queuePending: 0, dlqDepth: 0, oldestPendingAgeSec: null,
  operationsPending: 0, operationsFailed: 0, operationsAwaitingDelivery: 0,
  writebackPending: 0, reconcileNoProgressRuns: 0, reconcileLastSuccessAt: null,
};

/**
 * Minimal shape of the PostgREST count query we build. Declared explicitly so
 * the helpers below read as ordinary code instead of a wall of casts.
 */
interface CountQuery {
  eq(column: string, value: string): CountQuery;
  in(column: string, values: readonly string[]): CountQuery;
  then<T>(onOk: (r: { count: number | null; error: unknown }) => T): Promise<T>;
}

/** Count rows matching a filter without transferring any of them. */
async function countRows(
  client: SupabaseClient,
  table: string,
  filter: (q: CountQuery) => CountQuery,
): Promise<number> {
  const base = client.from(table).select('*', { count: 'exact', head: true }) as unknown as CountQuery;
  const { count, error } = await filter(base).then((r) => r);
  if (error) throw new Error('ashby_health_count_error');
  return typeof count === 'number' ? count : 0;
}

/**
 * Read the durable backlog. Correct on any machine, including one that never
 * started a scheduler.
 */
export async function readBacklog(
  client: SupabaseClient,
  nowMs: number = Date.now(),
): Promise<BacklogView> {
  const names = [...ASHBY_QUEUE_NAMES];
  const operationsInState = (state: string) =>
    countRows(client, 'ashby_operations', (q) => q.eq('state', state));

  const [
    queuePending, dlqDepth,
    operationsPending, operationsFailed, operationsAwaitingDelivery,
    writebackPending,
  ] = await Promise.all([
    countRows(client, 'job_queue', (q) => q.in('name', names)),
    countRows(client, 'job_dlq', (q) => q.in('name', names)),
    operationsInState('pending'),
    operationsInState('failed'),
    operationsInState('awaiting_manual_delivery'),
    countRows(client, 'ashby_application_links', (q) => q.eq('lifecycle', 'writeback_pending')),
  ]);

  // Oldest live job — one row, scheduled_at only.
  const { data: oldest, error: oldestErr } = await client
    .from('job_queue')
    .select('scheduled_at')
    .in('name', names)
    .in('status', ['pending', 'active', 'delayed'])
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (oldestErr) throw new Error('ashby_health_count_error');
  const oldestAt = (oldest as { scheduled_at?: string } | null)?.scheduled_at;
  const oldestPendingAgeSec = oldestAt
    ? Math.max(0, Math.round((nowMs - Date.parse(oldestAt)) / 1000))
    : null;

  const { data: checkpoint, error: cpErr } = await client
    .from('ashby_sync_checkpoints')
    .select('no_progress_runs, last_success_at')
    .eq('provider', 'ashby')
    .eq('checkpoint_key', DEFAULT_CHECKPOINT_KEY)
    .maybeSingle();
  if (cpErr) throw new Error('ashby_health_count_error');
  const cp = checkpoint as { no_progress_runs?: number; last_success_at?: string | null } | null;

  return {
    queuePending, dlqDepth, oldestPendingAgeSec,
    operationsPending, operationsFailed, operationsAwaitingDelivery, writebackPending,
    reconcileNoProgressRuns: typeof cp?.no_progress_runs === 'number' ? cp.no_progress_runs : 0,
    reconcileLastSuccessAt: cp?.last_success_at ?? null,
  };
}

// ── Degradation verdict ──────────────────────────────────────────────────────

/** Thresholds beyond which the integration is reported degraded. */
export const DEGRADE_THRESHOLDS = {
  /** Oldest live job older than this means work is not being drained. */
  oldestPendingAgeSec: 900,
  /** Any dead-lettered Ashby job needs a human. */
  dlqDepth: 1,
  /** Consecutive non-advancing reconciliation runs. */
  reconcileNoProgressRuns: 3,
} as const;

export type HealthStatus = 'healthy' | 'degraded' | 'idle';

export interface DegradeVerdict {
  status: HealthStatus;
  /** Stable sanitized reason codes. Never free text. */
  reasons: string[];
}

/**
 * Decide whether the integration is degraded from signals that are true across
 * the fleet. Deliberately does NOT treat "no scheduler in this process" as
 * degraded — another machine may own the loops — but a stale loop in a process
 * that DOES have one is a real fault.
 */
export function evaluateDegradation(input: {
  active: boolean;
  scheduler: SchedulerHealthView;
  backlog: BacklogView;
}): DegradeVerdict {
  // Nothing is enabled: not healthy, not broken — idle by configuration.
  if (!input.active) return { status: 'idle', reasons: [] };

  const reasons: string[] = [];
  if (input.backlog.dlqDepth >= DEGRADE_THRESHOLDS.dlqDepth) reasons.push('dlq_non_empty');
  if ((input.backlog.oldestPendingAgeSec ?? 0) > DEGRADE_THRESHOLDS.oldestPendingAgeSec) {
    reasons.push('queue_not_draining');
  }
  if (input.backlog.reconcileNoProgressRuns >= DEGRADE_THRESHOLDS.reconcileNoProgressRuns) {
    reasons.push('reconciliation_not_advancing');
  }
  if (input.scheduler.registeredInThisProcess && input.scheduler.loops.some((l) => l.stale)) {
    reasons.push('scheduler_loop_stale');
  }
  if (input.scheduler.registeredInThisProcess && !input.scheduler.running) {
    reasons.push('scheduler_stopped');
  }
  return { status: reasons.length > 0 ? 'degraded' : 'healthy', reasons };
}
