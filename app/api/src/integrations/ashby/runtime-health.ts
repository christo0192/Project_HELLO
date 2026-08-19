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
import {
  defaultSignatureFreshnessReader,
  type SignatureFreshnessReader,
} from '../../lib/clamav-signatures.js';
import {
  defaultScannerCapabilityReader,
  type ScannerCapabilityReader,
} from '../../lib/malware-scanner.js';

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

// ── Process-local reconciliation-pass registry ───────────────────────────────
//
// Review finding M-1: the admission counters emitted by `runReconciliation` go
// to `lib/metrics.ts`, whose sink is a NO-OP in this deployment (there is no
// production `setMetricSink` caller). That made the runbook's re-activation
// gate — "confirm admitted = 0 and enqueued = 0 while every mapping is paused"
// — impossible to actually execute: the numbers existed only inside the worker
// process. Publishing the last pass here gives the Mission Control health route
// a real, sanitized consumer, so the gate can be checked over HTTP.
//
// Counts and a sanitized stop/mode code ONLY. No application, job, stage,
// candidate, mapping, or tenant identifier ever enters this structure — it is
// the same discipline as the rest of the health surface.

/** Per-reason skip counts for the last reconciliation pass. */
export interface ReconcileSkipView {
  noApplicationId: number;
  noEnabledMapping: number;
  stageNotAi: number;
  ambiguousMapping: number;
}

/**
 * The last completed reconciliation pass, as exposed on the health surface.
 * `observed === admitted + sum(skipped)` on any pass that reached a normal
 * stop; on an aborted pass (`enqueue_cap` / `unclassified_cap`) the row that
 * tripped the bound is observed but neither admitted nor skipped.
 */
export interface ReconcilePassView {
  stop: string;
  mode: string;
  observed: number;
  admitted: number;
  skipped: ReconcileSkipView;
  unclassified: number;
  enabledMappings: number;
  mappingIndexTruncated: boolean;
  recovered: number;
  duplicates: number;
  enqueued: number;
  advanced: boolean;
  /**
   * Page-anchored full-resync continuation (0034). Booleans and bounded
   * counts ONLY — the opaque page cursor never reaches this surface, exactly
   * like the sync token it sits beside.
   */
  resumed: boolean;
  continuationPending: boolean;
  pageAnchors: number;
  resyncPagesDone: number;
  resyncItemsDone: number;
  /** Why the run started at page 1 instead of resuming. Sanitized code. */
  restartReason: string;
  /** Times a sweep was abandoned and restarted. Climbing ⇒ resume not holding. */
  sweepRestarts: number;
  /**
   * Signal jobs the CURRENT sweep has created across ALL of its runs. This —
   * not `enqueued`, which is per-run — is the figure that bounds blast radius,
   * because the per-run breaker is page-aligned and a pass fires every few
   * seconds while a sweep is in flight. Climbing while `resyncPagesDone` is
   * flat is the signature of an admission bug.
   */
  sweepEnqueued: number;
  /**
   * Reconciliation has HALTED itself on this stream (per-sweep enqueue or
   * restart budget exhausted) and makes no provider call until an operator
   * clears it with a forced resync. Webhook delivery is unaffected.
   */
  halted: boolean;
  /**
   * Whether a drained run actually installed a sync token. A sweep can drain
   * with none (the provider returned no token in 1,200 probed pages), which
   * means the next pass is another full sweep — invisible from `advanced`.
   */
  tokenInstalled: boolean;
  /** ISO time this pass was published. Never a provider timestamp. */
  observedAt: string;
}

let lastPass: ReconcilePassView | null = null;

/** Bound an untrusted number into a safe non-negative integer for the surface. */
function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

/** Bound a sanitized code to a short identifier; anything else becomes 'unknown'. */
function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : 'unknown';
}

/**
 * Publish the last completed reconciliation pass. Called by the reconcile loop
 * on every non-`locked` pass. Defensive by construction: every field is
 * re-derived through the bounded helpers above, so nothing unexpected can reach
 * the health surface even if the caller changes.
 */
export function publishReconcilePass(
  pass: {
    stop: string;
    mode: string;
    observed: number;
    admitted: number;
    skipped: ReconcileSkipView;
    unclassified: number;
    enabledMappings: number;
    mappingIndexTruncated: boolean;
    recovered: number;
    duplicates: number;
    enqueued: number;
    advanced: boolean;
    partialProgress?: {
      resumed: boolean;
      checkpoints: number;
      pagesDone: number;
      itemsDone: number;
      continuationPending: boolean;
      restartReason?: string;
      sweepRestarts?: number;
      sweepEnqueued?: number;
      halted?: boolean;
      tokenInstalled?: boolean;
    };
  },
  nowIso: string = new Date().toISOString(),
): void {
  lastPass = {
    stop: safeCode(pass.stop),
    mode: safeCode(pass.mode),
    observed: safeCount(pass.observed),
    admitted: safeCount(pass.admitted),
    skipped: {
      noApplicationId: safeCount(pass.skipped?.noApplicationId),
      noEnabledMapping: safeCount(pass.skipped?.noEnabledMapping),
      stageNotAi: safeCount(pass.skipped?.stageNotAi),
      ambiguousMapping: safeCount(pass.skipped?.ambiguousMapping),
    },
    unclassified: safeCount(pass.unclassified),
    enabledMappings: safeCount(pass.enabledMappings),
    mappingIndexTruncated: pass.mappingIndexTruncated === true,
    recovered: safeCount(pass.recovered),
    duplicates: safeCount(pass.duplicates),
    enqueued: safeCount(pass.enqueued),
    advanced: pass.advanced === true,
    resumed: pass.partialProgress?.resumed === true,
    continuationPending: pass.partialProgress?.continuationPending === true,
    pageAnchors: safeCount(pass.partialProgress?.checkpoints),
    resyncPagesDone: safeCount(pass.partialProgress?.pagesDone),
    resyncItemsDone: safeCount(pass.partialProgress?.itemsDone),
    restartReason: safeCode(pass.partialProgress?.restartReason ?? 'none'),
    sweepRestarts: safeCount(pass.partialProgress?.sweepRestarts),
    sweepEnqueued: safeCount(pass.partialProgress?.sweepEnqueued),
    halted: pass.partialProgress?.halted === true,
    tokenInstalled: pass.partialProgress?.tokenInstalled === true,
    observedAt: nowIso,
  };
}

/**
 * The last pass observed BY THIS PROCESS, or null when this process has not run
 * one. Like `snapshotScheduler`, null is a statement about this process only —
 * never a fleet-wide claim, and never a claim that no reconciliation happened.
 */
export function snapshotReconcilePass(): ReconcilePassView | null {
  return lastPass;
}

/** Clear the registry (process shutdown, and test isolation). */
export function clearReconcilePassRegistration(): void {
  lastPass = null;
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
  /**
   * Invite deliveries currently held back by an unmet prerequisite (mapping
   * paused, or a resume-backed link whose ingestion is not `ready`). This is
   * CORRECT behaviour — waiting, not broken — but it was previously
   * indistinguishable from `operationsPending`, so an operator had no way to
   * tell "the pipeline is idle" from "every invite is blocked".
   */
  operationsBlockedPrerequisite: number;
  /**
   * The SUBSET of `operationsBlockedPrerequisite` that cannot clear without a
   * human: a resume-backed link whose ingestion ended `failed_review`. The 0029
   * trigger lets that state go only to `queued` or `cancelled` and nothing in
   * the runtime does either, so the invite waits forever.
   *
   * This exists because the ordering repair traded a wrong-but-loud signal for
   * a right-but-quiet one: before it, such a link surfaced (incorrectly) as
   * `operationsFailed` within ~25 seconds. Being recoverable instead of
   * budget-burnt is the improvement; being SILENT would not be. Not subtracted
   * from the total above — a consumer wanting "transiently waiting" takes the
   * difference.
   */
  operationsBlockedFailedIngestion: number;
  /**
   * Invite deliveries already driven to `failed` on a prerequisite-deferral
   * code. Non-zero means `reopen_ashby_invite_delivery` is needed; after the
   * 0035 fix nothing new can enter this count.
   */
  operationsFailedPrerequisite: number;
  /**
   * Resume ingestions stranded in `queued` past the stuck window on a
   * resume-backed, non-terminal link — i.e. work that was enqueued and never
   * started. This signal did not exist before: a stranded ingestion was
   * invisible to /health by construction and discoverable only by direct
   * database inspection.
   */
  ingestionStuckQueued: number;
  /** Resume ingestions stranded in `fetching` past the stuck window. */
  ingestionStuckFetching: number;
  /**
   * Ashby jobs currently DEFERRED on scanner readiness (0037): claimed, found
   * the malware scanner unable to screen, and returned to the queue with their
   * attempt refunded. This is correct behaviour and costs no failure budget —
   * but without a count it is indistinguishable from an idle queue, which is
   * exactly the reading an operator would take during a signature outage.
   */
  scannerDeferredJobs: number;
  /**
   * Age in seconds of the LONGEST-waiting scanner deferral, measured from the
   * start of its uninterrupted wait (not its most recent poll), or null when
   * nothing is waiting. Minutes are a cold boot; an hour is an updater that
   * never came back.
   */
  scannerDeferredOldestAgeSec: number | null;
  /** Consecutive reconciliation runs that did not advance the cursor. */
  reconcileNoProgressRuns: number;
  /** Last fully-drained reconciliation, or null. */
  reconcileLastSuccessAt: string | null;
}

const EMPTY_BACKLOG: BacklogView = {
  queuePending: 0, dlqDepth: 0, oldestPendingAgeSec: null,
  operationsPending: 0, operationsFailed: 0, operationsAwaitingDelivery: 0,
  operationsBlockedPrerequisite: 0, operationsBlockedFailedIngestion: 0,
  operationsFailedPrerequisite: 0,
  ingestionStuckQueued: 0, ingestionStuckFetching: 0,
  scannerDeferredJobs: 0, scannerDeferredOldestAgeSec: null,
  writebackPending: 0, reconcileNoProgressRuns: 0, reconcileLastSuccessAt: null,
};

/**
 * Minimal shape of the PostgREST count query we build. Declared explicitly so
 * the helpers below read as ordinary code instead of a wall of casts.
 */
interface CountQuery {
  eq(column: string, value: string): CountQuery;
  in(column: string, values: readonly string[]): CountQuery;
  like(column: string, pattern: string): CountQuery;
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
    queuePending, dlqDepth, scannerDeferredJobs,
    operationsPending, operationsFailed, operationsAwaitingDelivery,
    writebackPending,
  ] = await Promise.all([
    countRows(client, 'job_queue', (q) => q.in('name', names)),
    countRows(client, 'job_dlq', (q) => q.in('name', names)),
    // Deferred-on-scanner jobs. `defer_reason` is a sanitized code written
    // only by `defer_job`, and every non-deferral outcome clears it, so a
    // delayed row carrying a `scanner*` reason is waiting on the scanner and
    // nothing else.
    countRows(client, 'job_queue', (q) =>
      q.in('name', names).eq('status', 'delayed').like('defer_reason', 'scanner%')),
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

  // Longest-waiting scanner deferral — one row, `deferred_at` only, and no
  // identifier of any kind leaves the database.
  const { data: oldestDeferred, error: deferErr } = await client
    .from('job_queue')
    .select('deferred_at')
    .in('name', names)
    .eq('status', 'delayed')
    .like('defer_reason', 'scanner%')
    .order('deferred_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (deferErr) throw new Error('ashby_health_count_error');
  const deferredAt = (oldestDeferred as { deferred_at?: string | null } | null)?.deferred_at;
  const scannerDeferredOldestAgeSec = deferredAt
    ? Math.max(0, Math.round((nowMs - Date.parse(deferredAt)) / 1000))
    : null;

  const { data: checkpoint, error: cpErr } = await client
    .from('ashby_sync_checkpoints')
    .select('no_progress_runs, last_success_at')
    .eq('provider', 'ashby')
    .eq('checkpoint_key', DEFAULT_CHECKPOINT_KEY)
    .maybeSingle();
  if (cpErr) throw new Error('ashby_health_count_error');
  const cp = checkpoint as { no_progress_runs?: number; last_success_at?: string | null } | null;

  // Prerequisite/stuck counters come from ONE service-role RPC: the predicates
  // need joins across operations, links, mappings and ingestions, which a
  // PostgREST count cannot express. Counters only — the RPC returns no
  // application, job, candidate or tenant identifier.
  const { data: prereq, error: prereqErr } = await client.rpc('ashby_prerequisite_backlog', {
    p_stuck_after_seconds: DEGRADE_THRESHOLDS.ingestionStuckAgeSec,
  });
  if (prereqErr) throw new Error('ashby_health_count_error');
  const pq = (prereq ?? {}) as Record<string, unknown>;
  const counter = (key: string): number => {
    const v = pq[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  return {
    queuePending, dlqDepth, oldestPendingAgeSec,
    operationsPending, operationsFailed, operationsAwaitingDelivery, writebackPending,
    operationsBlockedPrerequisite: counter('pending_blocked'),
    operationsBlockedFailedIngestion: counter('pending_blocked_failed_ingestion'),
    operationsFailedPrerequisite: counter('failed_prerequisite'),
    ingestionStuckQueued: counter('ingestion_stuck_queued'),
    ingestionStuckFetching: counter('ingestion_stuck_fetching'),
    scannerDeferredJobs, scannerDeferredOldestAgeSec,
    reconcileNoProgressRuns: typeof cp?.no_progress_runs === 'number' ? cp.no_progress_runs : 0,
    reconcileLastSuccessAt: cp?.last_success_at ?? null,
  };
}

// ── Malware scanner readiness ────────────────────────────────────────────────

/**
 * Sanitized view of the resume malware scanner.
 *
 * Stage 5 of the activation runbook turns on resume ingestion, and that stage
 * is only safe if the scanner is genuinely able to screen — which, for ClamAV,
 * means a signature database that exists and is current. `clamscan` exits 0 on
 * a clean file regardless of database age, so "the binary is installed" was
 * never evidence of readiness; this reports the thing that actually is.
 *
 * DISCLOSURE BOUNDARY: an enum, two booleans, two bounded integers and a stable
 * reason code. No path, no ClamAV or signature version, no mirror, no hostname,
 * no filename, nothing candidate-derived.
 */
export interface ScannerHealthView {
  /** Which scanner the configuration selects. */
  mode: 'clamav' | 'test' | 'fail-closed';
  /** True only when this scanner can currently accept a file on production evidence. */
  ready: boolean;
  /** Age of the signature database in seconds; null when it could not be read. */
  signatureAgeSec: number | null;
  /** Age ceiling this verdict was measured against, in seconds. */
  maxAgeSec: number | null;
  /** Stable reason code when not ready; null when ready. */
  reason: string | null;
}

/** Resolve the configured scanner mode without constructing a scanner. */
export function scannerMode(source: NodeJS.ProcessEnv): ScannerHealthView['mode'] {
  const setting = source.RESUME_SCANNER ?? '';
  if (setting === 'clamav') return 'clamav';
  // Mirrors `resolveScanner`: outside production an unset/`test` setting means
  // the built-in test scanner; everything else is the fail-closed stub.
  const isProduction = (source.NODE_ENV ?? 'development') === 'production';
  if (!isProduction && (setting === 'test' || setting === '')) return 'test';
  return 'fail-closed';
}

/**
 * Read scanner readiness. Never throws.
 *
 * Only ClamAV can ever be `ready: true`. The built-in test scanner accepts
 * everything that is not EICAR and is explicitly not production anti-malware
 * evidence, so reporting it as ready would be exactly the untruth this surface
 * exists to prevent.
 */
export async function readScannerHealth(
  source: NodeJS.ProcessEnv = process.env,
  freshness: SignatureFreshnessReader = defaultSignatureFreshnessReader(),
  capability: ScannerCapabilityReader = defaultScannerCapabilityReader,
): Promise<ScannerHealthView> {
  const mode = scannerMode(source);
  if (mode !== 'clamav') {
    return {
      mode,
      ready: false,
      signatureAgeSec: null,
      maxAgeSec: null,
      reason: mode === 'test' ? 'test_scanner' : 'scanner_not_configured',
    };
  }
  try {
    const state = await freshness();
    if (!state.fresh) {
      return {
        mode,
        ready: false,
        signatureAgeSec: state.ageSec,
        maxAgeSec: state.maxAgeSec,
        reason: state.reason,
      };
    }
    const proof = await capability();
    return {
      mode,
      ready: proof.ready,
      signatureAgeSec: state.ageSec,
      maxAgeSec: state.maxAgeSec,
      reason: proof.ready ? null : proof.reason ?? 'capability_unverified',
    };
  } catch {
    return {
      mode,
      ready: false,
      signatureAgeSec: null,
      maxAgeSec: null,
      reason: 'signatures_unreadable',
    };
  }
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
  /**
   * A resume ingestion sitting in `queued` or `fetching` longer than this is
   * stranded, not slow. Download + scan + parse of a real resume is a
   * seconds-to-low-minutes operation.
   */
  ingestionStuckAgeSec: 900,
  /** Any stranded ingestion needs a human — one is already a fault. */
  ingestionStuck: 1,
  /** Any invite killed by the prerequisite-ordering defect needs a reopen. */
  operationsFailedPrerequisite: 1,
  /**
   * A scanner deferral lasting longer than this is no longer a cold boot.
   * freshclam establishes a database in tens of seconds; fifteen minutes of
   * waiting means the updater is not winning and a human should look.
   */
  scannerDeferredAgeSec: 900,
  /**
   * Any invite blocked behind a failed_review ingestion needs a human — the
   * ingestion cannot requeue itself, so this never clears on its own.
   */
  operationsBlockedFailedIngestion: 1,
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
  /** Optional: omitted only by callers that do not own the resume path. */
  scanner?: ScannerHealthView;
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
  // A stranded ingestion is the failure shape the live canary produced, and it
  // had no health signal at all: the durable row sat in `queued` forever while
  // /health reported a perfectly ordinary backlog.
  if (input.backlog.ingestionStuckQueued + input.backlog.ingestionStuckFetching
      >= DEGRADE_THRESHOLDS.ingestionStuck) {
    reasons.push('ingestion_stuck');
  }
  // An invite blocked behind a failed_review ingestion is NOT transient: the
  // ingestion can only leave failed_review via an explicit requeue or a cancel,
  // neither of which the runtime performs. Degrading here is what keeps the
  // ordering repair from converting a loud wrong signal into a silent right
  // one — the invite is correctly not failed, but it is also going nowhere.
  if (input.backlog.operationsBlockedFailedIngestion
      >= DEGRADE_THRESHOLDS.operationsBlockedFailedIngestion) {
    reasons.push('invite_blocked_failed_ingestion');
  }
  // Invites killed by the ordering defect. Nothing new can enter this count
  // after 0035, so a non-zero value is a recovery backlog, not a live fault.
  if (input.backlog.operationsFailedPrerequisite
      >= DEGRADE_THRESHOLDS.operationsFailedPrerequisite) {
    reasons.push('invite_prerequisite_failed');
  }
  // A scanner deferral is CORRECT — no attempt burned, nothing failed — but a
  // long one is still work that is not happening, and it is fleet-wide
  // durable evidence where `input.scanner` only describes THIS machine. A
  // process with a healthy scanner must still report jobs stuck waiting on
  // another one, or the deferral becomes the silent failure the whole repair
  // exists to avoid.
  if ((input.backlog.scannerDeferredOldestAgeSec ?? 0) > DEGRADE_THRESHOLDS.scannerDeferredAgeSec) {
    reasons.push('scanner_deferral_stalled');
  }
  if (input.scheduler.registeredInThisProcess && input.scheduler.loops.some((l) => l.stale)) {
    reasons.push('scheduler_loop_stale');
  }
  if (input.scheduler.registeredInThisProcess && !input.scheduler.running) {
    reasons.push('scheduler_stopped');
  }
  // A live runtime whose scanner cannot screen means resume ingestion is
  // fail-closed. That is the correct behaviour, but it is NOT healthy, and an
  // operator who cannot see it here would read stalled ingestions as a bug.
  if (input.scanner && !input.scanner.ready) {
    reasons.push(`scanner_${input.scanner.reason ?? 'not_ready'}`);
  }
  return { status: reasons.length > 0 ? 'degraded' : 'healthy', reasons };
}
