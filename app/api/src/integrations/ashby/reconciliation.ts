/**
 * ashby/reconciliation.ts — incremental application.list reconciliation.
 *
 * Reconciliation is the safety net for dropped/undelivered webhooks. It pages
 * through `application.list` with the opaque incremental sync token and, for
 * every application it ADMITS, records a dedup-safe stage receipt using the
 * SAME stage-centric identity the webhook uses (extractors.stageDedupId). A
 * dropped webhook leaves no receipt, so reconciliation's insert RECOVERS the
 * signal; an application already covered by a webhook receipt converges to the
 * same row (duplicate, no new work).
 *
 * ADMISSION (the storm fix). Recording/enqueuing EVERY observed application is
 * what turned the first production run into 2,000 pending `ashby.signal` jobs
 * against a tenant whose only mapping was paused: the worker's mapping/stage
 * gate ran far too late, after a tenant-wide fan-out had already been durably
 * queued. Admission now happens BEFORE any receipt write or enqueue:
 *
 *   an application.list row is admitted ONLY when it positively exposes both a
 *   job id and a current stage id, that job id matches an ENABLED mapping, and
 *   that stage id equals the mapping's configured AI screening stage.
 *
 * An unmapped job, a paused/drifted mapping, an ambiguous index entry, and
 * another stage of a mapped job are all SKIPPED with a counter and touch
 * nothing. With no enabled mapping, a run over thousands of applications
 * writes zero receipts, enqueues zero jobs, and issues zero `application.info`
 * calls.
 *
 * UNCLASSIFIABLE rows fail OPEN, not closed. A row carrying an application id
 * but no readable job or stage id means the provider's list shape is not what
 * these extractors assume — and silently dropping 100% of real work on a
 * schema change is a worse failure than the storm. Such rows are admitted and
 * counted separately, but bounded: exceeding `maxUnclassified` aborts the run
 * WITHOUT advancing the cursor and flags the stream `list_schema_unclassified`,
 * so schema drift is loud and bounded instead of silent in either direction.
 *
 * A per-run ENQUEUE CIRCUIT BREAKER (`maxEnqueuePerRun`) caps how much durable
 * work one pass may create. Any future admission-logic error is then bounded at
 * N jobs and visible (the run stops on `enqueue_cap` and never advances, so
 * `no_progress_runs` climbs) instead of producing another 2,000-row incident.
 *
 * Admission is a CHEAP PRE-FILTER, not an authority: the enabled-mapping index
 * is built once per run from one bounded query (never cached across runs, so a
 * pause takes effect on the next pass), and the list row's own job/stage claims
 * are only ever used to DECLINE work. The signal worker still re-reads
 * `application.info` authoritatively and re-applies the mapping/stage gate
 * before anything is imported, so an admitted-but-stale row is still rejected
 * downstream. Admission can only ever produce LESS work, never more.
 *
 * Forced resync on enable (0033): enabling or resuming a complete mapping —
 * or repointing an enabled mapping's AI stage — flags the `application.list`
 * checkpoint `full_resync_required` in the SAME transaction as the mapping
 * write, so applications already sitting at the trigger stage are reconsidered
 * under the new mapping instead of being invisible behind an incremental
 * cursor. A `resyncEpoch` guard means a run that is already in flight cannot
 * clear that flag when it completes.
 *
 * PAGE-ANCHORED FULL-RESYNC CONTINUATION (0034). A forced full resync used to
 * have to drain in ONE run or the cursor never moved at all, because only the
 * final sync token was ever persisted. With `maxPages 50 x pageLimit 100` and
 * `maxItems 5000`, a tenant whose corpus exceeds ~5,000 applications ended
 * EVERY sweep on `page_cap`/`item_cap`, advanced nothing, and re-paged the
 * same prefix forever — reconciliation could never come up for it at all.
 *
 * A full resync now persists the opaque provider PAGE cursor after every page
 * whose every item was durably handled, and the next run RESUMES there:
 *
 *   handle every item on page N  ->  commit  ->  anchor page N+1's cursor
 *
 * That ordering is the whole correctness argument. A crash BEFORE the anchor
 * replays page N, which is dedup-safe (the receipt/outbox converges, creating
 * no duplicate work); a crash AFTER it resumes at page N+1, whose predecessor
 * is fully handled. There is no ordering in which an application is skipped.
 * A page that stopped MID-way (item cap, enqueue breaker, drift abort) is
 * never anchored, so it replays in full.
 *
 * The anchor is invalidated — cursor nulled, epoch bumped — by any
 * `mark_ashby_sync_full_resync`, including the one a mapping enable/repoint
 * performs in its own transaction. Every anchor write compare-and-sets that
 * epoch AND the live single-flight lease owner, so a run that was already
 * paging under the old epoch (or whose lease expired) fails closed instead of
 * resurrecting a stale anchor. The final drained page installs the sync token
 * and clears the continuation in ONE atomic statement.
 *
 * Bounds & safety (invariant 7):
 *  - Sync mode: incremental with the stored token, UNLESS the token is absent,
 *    the stream is flagged full_resync_required, or the token is older than the
 *    14-day provider expiry — any of which forces a safe full resync.
 *  - Bounded pages, items, and wall-clock runtime; a repeated cursor (loop) is
 *    detected and aborts.
 *  - The checkpoint (opaque sync token) is advanced ONLY after a fully drained,
 *    fully successful run. Any page fetch or receipt failure throws and the
 *    cursor is NOT advanced — the next run safely reprocesses (dedup makes it
 *    idempotent). A bounded stop still anchors the pages it fully handled.
 *
 * SECURITY: sync tokens and cursors are opaque black boxes — never logged or
 * returned. Only opaque application/stage ids flow into receipts; no contact or
 * resume data is read.
 */

import { counter } from '../../lib/metrics.js';
import { extractApplicationInfo, stageDedupId, CANDIDATE_STAGE_CHANGE_ACTION } from './extractors.js';
import { buildSignalEnqueueSpec } from './signal-worker.js';
import type {
  CheckpointStore,
  ReceiptStore,
  EnabledMappingLoader,
  EnabledMappingRow,
} from './ports.js';
import type { AshbyResult, ApplicationListParams, OpaqueRecord } from './types.js';

/** 14-day provider sync-token expiry — an older token forces a full resync. */
export const SYNC_TOKEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Default reconciliation stream key. */
export const DEFAULT_CHECKPOINT_KEY = 'application.list';

/** Narrow lister seam — satisfied by AshbyClient; injectable for tests. */
export interface ApplicationLister {
  applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams): Promise<AshbyResult<T>>;
}

export interface ReconcileCaps {
  maxPages?: number;
  maxItems?: number;
  /** Wall-clock budget (ms) for the whole run. */
  deadlineMs?: number;
  /** Page size hint passed to application.list. */
  pageLimit?: number;
  /** Bound on the per-run enabled-mapping index load. */
  maxEnabledMappings?: number;
  /** Circuit breaker: most signal jobs one pass may enqueue. */
  maxEnqueuePerRun?: number;
  /** Bound on unclassifiable rows before the run aborts as schema drift. */
  maxUnclassified?: number;
  /** Pages ONE SWEEP may consume across all of its runs (0034). */
  sweepMaxPages?: number;
  /** Age at which a persisted page anchor is discarded and the sweep restarts. */
  anchorMaxAgeMs?: number;
  /** Kill switch: skip every anchor read/write (pre-0034 behaviour). */
  anchorDisabled?: boolean;
  /** Absolute jobs ONE SWEEP may create across its runs before halting. */
  sweepMaxEnqueue?: number;
  /** Sweep restarts allowed before halting (M2). */
  sweepMaxRestarts?: number;
}

/**
 * Bound on the enabled-mapping index loaded per run. Far above any realistic
 * count of concurrently enabled Ashby jobs for one tenant; a tenant that
 * somehow exceeds it gets a truthful `mappingIndexTruncated` signal rather
 * than a silently partial admission set.
 */
export const DEFAULT_MAX_ENABLED_MAPPINGS = 2_000;
const HARD_MAX_ENABLED_MAPPINGS = 10_000;

/**
 * Circuit breaker: the most signal jobs ONE reconciliation pass may create.
 * Deliberately small — a healthy incremental pass creates a handful. Tripping
 * it means either a genuine backlog (a just-enabled mapping's first sweep, which
 * simply continues on the next pass) or an admission bug, and either way the
 * cursor does not advance and the stream becomes visibly stuck rather than
 * silently flooding the queue.
 */
export const DEFAULT_MAX_ENQUEUE_PER_RUN = 200;
const HARD_MAX_ENQUEUE_PER_RUN = 2_000;

/**
 * Bound on rows admitted as UNCLASSIFIED (application id present, job/stage id
 * unreadable) before the run aborts as probable provider-schema drift.
 */
export const DEFAULT_MAX_UNCLASSIFIED = 50;
const HARD_MAX_UNCLASSIFIED = 1_000;

/** Sanitized stream flag written when the unclassified bound is exceeded. */
export const UNCLASSIFIED_RESYNC_REASON = 'list_schema_unclassified';

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_ITEMS = 5_000;
const DEFAULT_DEADLINE_MS = 60_000;
const HARD_MAX_PAGES = 1_000;
const HARD_MAX_ITEMS = 100_000;

export type ReconcileStop =
  | 'drained'
  | 'page_cap'
  | 'item_cap'
  | 'deadline'
  | 'locked'
  /** Circuit breaker tripped: this pass created its maximum durable work. */
  | 'enqueue_cap'
  /** Too many unclassifiable rows — probable provider-schema drift. */
  | 'unclassified_cap'
  /**
   * The durable page anchor could not be written (0034): a forced resync
   * bumped the epoch mid-run, or this runner no longer holds the stream's
   * single-flight lease. Fail closed — nothing further is processed and
   * nothing is advanced.
   */
  | 'continuation_conflict'
  /**
   * The resumed anchor came straight back as the next cursor: a cursor loop
   * that spans runs, invisible to the per-run loop detector. The anchor is
   * dropped and the sweep restarts.
   */
  | 'cursor_invalid'
  /**
   * The sweep exceeded its cross-run page budget without draining. Abandon it
   * loudly rather than page a non-terminating cursor chain forever.
   */
  | 'sweep_budget'
  /**
   * Reconciliation is HALTED on this stream: a sweep exhausted its absolute
   * per-sweep enqueue budget or its restart budget. No provider call is made
   * until an operator clears it with a forced resync.
   */
  | 'halted';

/**
 * Why an observed application.list row was NOT admitted. Counters only — no
 * ids, no PII, nothing tenant-identifying.
 */
export interface ReconcileSkipCounts {
  /** No usable application id on the row — nothing could be keyed off it. */
  noApplicationId: number;
  /** The job has no ENABLED mapping (unmapped, paused, or drifted). */
  noEnabledMapping: number;
  /** Mapped + enabled, but the row is at some other stage than the AI stage. */
  stageNotAi: number;
  /** The index held conflicting AI stages for that job id — refuse to guess. */
  ambiguousMapping: number;
}

/**
 * Truthful, durable progress of a page-anchored FULL-resync continuation
 * (0034). Bounded counts and booleans only — the opaque page cursor itself
 * never appears here, so this is safe to log or surface to an operator.
 */
export interface PartialProgress {
  /** This run RESUMED from a persisted page anchor instead of page 1. */
  resumed: boolean;
  /** Page anchors durably written THIS run — each one a fully handled page. */
  checkpoints: number;
  /**
   * Pages fully handled across the WHOLE continuation, including the runs
   * that came before this one. Zero outside a continuation.
   */
  pagesDone: number;
  /** Applications fully handled across the whole continuation. */
  itemsDone: number;
  /**
   * This run ended still OWNING a durable page anchor, so the next run
   * resumes mid-sweep from it. False on a drained run (the continuation ended
   * atomically with the token install), false outside a full resync, and
   * false after a `continuation_conflict` — there the run provably lost
   * ownership of the continuation (a newer generation invalidated it, or
   * another runner holds the lease), so it may not claim one is pending on
   * its behalf. Read the checkpoint, not this flag, to see what a DIFFERENT
   * generation left behind.
   */
  continuationPending: boolean;
  /** Why this run started at page 1 rather than resuming. */
  restartReason: SweepRestartReason;
  /** Times a sweep has been abandoned and restarted, across runs. */
  sweepRestarts: number;
  /**
   * Signal jobs the CURRENT sweep has created across all of its runs. `enqueued`
   * is per-run; page-aligning the breaker and sweeping every few seconds made
   * the per-run figure a rate, so THIS is the number that bounds blast radius.
   */
  sweepEnqueued: number;
  /** Reconciliation is halted on this stream until an operator clears it. */
  halted: boolean;
  /**
   * True when the run drained AND an opaque sync token was actually installed.
   * A sweep can legitimately drain with NO token (production observed none in
   * 1,200 pages), which means the next pass is another full sweep — an
   * operator fact that `advanced: true` alone would hide.
   */
  tokenInstalled: boolean;
}

export interface ReconcileResult {
  mode: 'full' | 'incremental';
  pages: number;
  /** Applications OBSERVED on the pages read (the item-cap counter). */
  items: number;
  /** Alias of `items`, named for the observed/admitted/skipped health triple. */
  observed: number;
  /**
   * Applications that passed admission — a job+stage match against an enabled
   * mapping, PLUS the fail-open unclassified rows (also counted separately).
   */
  admitted: number;
  /**
   * Per-reason skip counts. On any run that ran to a normal stop,
   * `observed === admitted + sum(skipped)`. On an ABORTED run
   * (`unclassified_cap` / `enqueue_cap`) the row that tripped the bound is
   * counted in `observed` — and, for the drift abort, in `unclassified` — but
   * is neither admitted nor skipped, because the run stopped before deciding
   * it. It is reconsidered by the next pass (the cursor did not advance).
   */
  skipped: ReconcileSkipCounts;
  /**
   * Admitted rows whose job/stage id could not be read (fail-open). A non-zero
   * value means the provider list shape may have drifted; exceeding
   * `maxUnclassified` aborts the run and flags the stream.
   */
  unclassified: number;
  /** Enabled mappings in this run's index (0 ⇒ nothing can be admitted). */
  mappingsLoaded: number;
  /** True when more enabled mappings exist than the per-run bound. */
  mappingIndexTruncated: boolean;
  /** Newly recovered (previously missing) stage receipts, admitted rows only. */
  recovered: number;
  /** Admitted applications whose receipt already existed. */
  duplicates: number;
  /** Signal jobs enqueued this run (recovered work re-driven into processing). */
  enqueued: number;
  stop: ReconcileStop;
  /** Whether the checkpoint token was advanced (only on a fully drained run). */
  advanced: boolean;
  /**
   * Durable page-anchored continuation progress (0034). A bounded run that
   * stopped on a page/item/deadline bound reports here exactly how much of
   * the sweep is now permanently behind it — the honest answer to "is this
   * stream progressing or stuck?", which `advanced` alone cannot give.
   */
  partialProgress: PartialProgress;
}

export interface ReconcileDeps {
  client: ApplicationLister;
  checkpoints: CheckpointStore;
  receipts: ReceiptStore;
  /**
   * REQUIRED admission source. Deliberately not optional: an absent loader
   * used to mean "admit everything", which is exactly the storm. Callers must
   * supply it, and a loader that returns no rows admits nothing.
   */
  mappings: EnabledMappingLoader;
  checkpointKey?: string;
  caps?: ReconcileCaps;
  /** Monotonic clock in ms; inject for deterministic tests. */
  nowMs?: () => number;
  /** Opaque single-flight lease owner. Never a secret. Default 'reconciler'. */
  owner?: string;
}

function emptySkips(): ReconcileSkipCounts {
  return { noApplicationId: 0, noEnabledMapping: 0, stageNotAi: 0, ambiguousMapping: 0 };
}

function noProgress(): PartialProgress {
  return {
    resumed: false, checkpoints: 0, pagesDone: 0, itemsDone: 0,
    continuationPending: false, restartReason: 'none', sweepRestarts: 0,
    sweepEnqueued: 0, halted: false, tokenInstalled: false,
  };
}

/**
 * Whether a page-fetch failure means the CURSOR was rejected rather than the
 * request being transiently unlucky (M1).
 *
 * Only a NON-retriable provider failure implicates the cursor: a logical
 * envelope failure, a permanent 4xx, a rejected request, or an unparseable
 * response. Rate limits, 5xx, timeouts, and socket errors say nothing about
 * the cursor and must never cost a good anchor.
 *
 * Structural rather than `instanceof`, so the injectable lister seam stays
 * testable, and deliberately conservative: anything unrecognised is treated as
 * transient, because throwing away a valid anchor restarts a ~119k-page sweep.
 */
export function isCursorRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { retriable?: unknown; category?: unknown };
  if (e.retriable !== false) return false;
  return e.category === 'logical_failure'
    || e.category === 'http_client_error'
    || e.category === 'invalid_request'
    || e.category === 'malformed_response';
}

/** Coerce a stored continuation counter into a safe non-negative integer. */
function safeProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function bounded(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return def;
  return Math.min(Math.max(v, min), max);
}

/**
 * Decide whether an incremental run is possible, or a full resync is forced.
 * Exposed for unit testing the expiry / forced-resync logic in isolation.
 */
export function resolveSyncMode(
  checkpoint: { syncToken: string | null; status: string; tokenIssuedAt: string | null } | null,
  nowMs: number,
): { mode: 'full' | 'incremental'; syncToken?: string } {
  if (!checkpoint || !checkpoint.syncToken) return { mode: 'full' };
  if (checkpoint.status === 'full_resync_required') return { mode: 'full' };
  const issued = checkpoint.tokenIssuedAt ? Date.parse(checkpoint.tokenIssuedAt) : NaN;
  if (!Number.isFinite(issued) || nowMs - issued > SYNC_TOKEN_MAX_AGE_MS) return { mode: 'full' };
  return { mode: 'incremental', syncToken: checkpoint.syncToken };
}

/**
 * How long a persisted page anchor may be trusted. A production probe resumed
 * a `nextCursor` from a DIFFERENT process 120 seconds later and got a normal
 * page back, so cursors do outlive a run — but the provider documents no
 * lifetime, so an anchor older than this is discarded and the sweep restarts
 * from page 1 rather than being replayed into an unknown failure. Generous by
 * design: with the sweep cadence below, a live sweep re-anchors every few
 * seconds, so this only ever fires on a sweep that was genuinely abandoned.
 */
export const ANCHOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Bound on how many pages ONE SWEEP may consume across all of its runs. The
 * per-run `maxPages` bounds a run; this bounds the sweep, so a provider whose
 * cursor chain never terminates (production paged 1,200 pages / 118,909 items
 * without draining) is abandoned loudly instead of paging forever. Exceeding
 * it forces a fresh full resync with a sanitized reason.
 */
export const DEFAULT_SWEEP_MAX_PAGES = 5_000;
const HARD_SWEEP_MAX_PAGES = 100_000;

/** Sanitized stream flag written when a sweep exceeds its page budget. */
export const SWEEP_BUDGET_RESYNC_REASON = 'sweep_page_budget';

/**
 * ABSOLUTE ceiling on the durable work ONE SWEEP may create, across all of its
 * runs — the compensating control for page-aligning the enqueue breaker.
 *
 * Page alignment makes the per-run breaker a RATE limit rather than a wedge
 * (it bounds a pass, and a pass now fires every few seconds while a sweep is
 * in flight). Without a sweep-level ceiling, a runaway admission bug would
 * create `maxEnqueuePerRun` jobs indefinitely instead of wedging after one
 * run. Exceeding this HALTS the stream until an operator clears it.
 *
 * Deliberately conservative: the production incident this subsystem exists to
 * prevent created 2,000 jobs, so the default budget would have caught it. With
 * PR64 admission in place a legitimate sweep enqueues a tiny fraction of the
 * corpus, so this should never be reached in normal operation — and when it is
 * reached, stopping is the right answer. A genuinely large first enable can
 * raise it via `ASHBY_RECONCILE_SWEEP_MAX_ENQUEUE`.
 */
export const DEFAULT_SWEEP_MAX_ENQUEUE = 2_000;
const HARD_SWEEP_MAX_ENQUEUE = 100_000;

/**
 * How many times one stream may restart a sweep from page 1 before halting. A
 * resume that never holds would otherwise re-page the entire corpus forever,
 * burning provider quota with nothing to show for it (M2).
 */
export const DEFAULT_SWEEP_MAX_RESTARTS = 5;
const HARD_SWEEP_MAX_RESTARTS = 1_000;

/** Sanitized halt codes. Never an id, token, or message. */
export const HALT_ENQUEUE_BUDGET = 'sweep_enqueue_budget';
export const HALT_RESTART_BUDGET = 'sweep_restart_budget';

/** Sanitized flag written when the provider REJECTED a resumed cursor (M1). */
export const CURSOR_REJECTED_RESYNC_REASON = 'resume_cursor_rejected';

/** Sanitized flag written when a resumed anchor proves to be a cursor loop. */
export const CURSOR_INVALID_RESYNC_REASON = 'resume_cursor_invalid';

/** Why a run started at page 1 instead of resuming a persisted anchor. */
export type SweepRestartReason =
  /** Nothing to resume — this is a fresh sweep. */
  | 'none'
  /** A forced resync bumped the epoch: the scanned prefix used a stale index. */
  | 'epoch_moved'
  /** The anchor belongs to the other sweep mode. */
  | 'mode_changed'
  /** The anchor is older than `ANCHOR_MAX_AGE_MS`. */
  | 'anchor_stale'
  /** Anchoring is switched off by configuration (kill switch). */
  | 'anchor_disabled';

/** The full resume decision for one run: mode, token, and where to start. */
export interface RunPlan {
  mode: 'full' | 'incremental';
  syncToken?: string;
  /** Opaque page cursor to resume from, or undefined to start at page 1. */
  resumeCursor?: string;
  restartReason: SweepRestartReason;
}

/**
 * Decide the sync mode AND whether a persisted page anchor may be resumed.
 *
 * An anchor is resumable only when EVERY binding holds: it exists, it was
 * written under the current `resyncEpoch` (a mapping enabled since then admits
 * rows the scanned prefix skipped), it belongs to the SAME sweep mode (a full
 * cursor is meaningless to an incremental request), and it is fresh. Any
 * failure starts at page 1 with a sanitized reason — never a silent restart,
 * because a restart every run is precisely the stall this design removes.
 */
export function resolveRunPlan(
  checkpoint:
    | (Parameters<typeof resolveSyncMode>[0] & {
        resyncEpoch?: number;
        resyncCursor?: string | null;
        resyncCursorEpoch?: number | null;
        resyncCursorAt?: string | null;
        sweepMode?: 'full' | 'incremental' | null;
      })
    | null,
  nowMs: number,
  opts: { anchorEnabled: boolean; anchorMaxAgeMs?: number } = { anchorEnabled: true },
): RunPlan {
  const decided = resolveSyncMode(checkpoint, nowMs);
  const base: RunPlan = { ...decided, restartReason: 'none' };
  if (!opts.anchorEnabled) return { ...base, restartReason: 'anchor_disabled' };

  const cursor = typeof checkpoint?.resyncCursor === 'string' && checkpoint.resyncCursor
    ? checkpoint.resyncCursor
    : null;
  if (!cursor) return base;

  const epoch = typeof checkpoint?.resyncEpoch === 'number' ? checkpoint.resyncEpoch : null;
  const anchorEpoch = typeof checkpoint?.resyncCursorEpoch === 'number'
    ? checkpoint.resyncCursorEpoch
    : null;
  if (epoch !== null && anchorEpoch !== epoch) return { ...base, restartReason: 'epoch_moved' };

  if (checkpoint?.sweepMode && checkpoint.sweepMode !== decided.mode) {
    return { ...base, restartReason: 'mode_changed' };
  }

  const maxAge = opts.anchorMaxAgeMs ?? ANCHOR_MAX_AGE_MS;
  const writtenAt = checkpoint?.resyncCursorAt ? Date.parse(checkpoint.resyncCursorAt) : NaN;
  if (!Number.isFinite(writtenAt) || nowMs - writtenAt > maxAge) {
    return { ...base, restartReason: 'anchor_stale' };
  }

  return { ...base, resumeCursor: cursor };
}

/**
 * Build the per-run admission index: opaque job id → its enabled mapping's AI
 * screening stage id, or `null` when the loader returned CONFLICTING stages
 * for one job id. A conflict is never resolved by guessing — the job is marked
 * ambiguous and every one of its applications is skipped.
 *
 * Rows missing either id are dropped: an enabled mapping cannot admit anything
 * without a concrete stage to match.
 */
export function buildEnabledStageIndex(rows: readonly EnabledMappingRow[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const row of rows) {
    const jobId = typeof row?.externalJobId === 'string' ? row.externalJobId : '';
    const stageId = typeof row?.aiScreeningStageId === 'string' ? row.aiScreeningStageId : '';
    if (!jobId || !stageId) continue;
    if (!index.has(jobId)) { index.set(jobId, stageId); continue; }
    const existing = index.get(jobId);
    if (existing !== stageId) index.set(jobId, null); // conflicting → ambiguous
  }
  return index;
}

/** The admission verdict for one observed application.list row. */
export type AdmissionVerdict =
  /** Positively matched an enabled mapping's job + AI stage. */
  | { admit: true; classified: true; applicationId: string; jobId: string; stageId: string }
  /** Application id readable, job/stage not — admitted fail-open, and counted. */
  | { admit: true; classified: false; applicationId: string; stageId?: string }
  | { admit: false; reason: keyof ReconcileSkipCounts };

/**
 * Decide whether one observed row may create durable work. Pure and total:
 * every path returns an admission or a single sanitized skip reason.
 *
 * The list row's own claims are used as a RESTRICTIVE HINT: they can decline
 * work, never authorise it — the worker's authoritative `application.info`
 * re-read remains the only thing that authorises an import. The one exception
 * is the unclassified path, which admits precisely because the hint could not
 * be read and failing closed there would silently drop real work.
 */
export function admitApplication(
  view: { applicationId?: string; jobId?: string; currentStageId?: string },
  index: ReadonlyMap<string, string | null>,
): AdmissionVerdict {
  if (!view.applicationId) return { admit: false, reason: 'noApplicationId' };

  // Unreadable job/stage ⇒ the provider list shape is not what we assume.
  // Fail OPEN (the worker will decide authoritatively) but count it, so the
  // caller can abort on a bounded amount of drift.
  if (!view.jobId || !view.currentStageId) {
    return { admit: true, classified: false, applicationId: view.applicationId, stageId: view.currentStageId };
  }

  if (!index.has(view.jobId)) return { admit: false, reason: 'noEnabledMapping' };
  const aiStageId = index.get(view.jobId);
  if (aiStageId === null || aiStageId === undefined) {
    return { admit: false, reason: 'ambiguousMapping' };
  }
  if (view.currentStageId !== aiStageId) return { admit: false, reason: 'stageNotAi' };
  return {
    admit: true,
    classified: true,
    applicationId: view.applicationId,
    jobId: view.jobId,
    stageId: view.currentStageId,
  };
}

/**
 * Run one bounded reconciliation pass. Recovers dropped webhook signals by
 * recording dedup-safe stage receipts, and advances the checkpoint ONLY after
 * a fully drained, fully successful run.
 */
export async function runReconciliation(deps: ReconcileDeps): Promise<ReconcileResult> {
  const checkpointKey = deps.checkpointKey ?? DEFAULT_CHECKPOINT_KEY;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const maxPages = bounded(deps.caps?.maxPages, DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES);
  const maxItems = bounded(deps.caps?.maxItems, DEFAULT_MAX_ITEMS, 1, HARD_MAX_ITEMS);
  const deadlineMs = bounded(deps.caps?.deadlineMs, DEFAULT_DEADLINE_MS, 1_000, 30 * 60_000);
  const pageLimit = bounded(deps.caps?.pageLimit, 100, 1, 500);
  const maxEnabledMappings = bounded(
    deps.caps?.maxEnabledMappings, DEFAULT_MAX_ENABLED_MAPPINGS, 1, HARD_MAX_ENABLED_MAPPINGS,
  );
  const maxEnqueuePerRun = bounded(
    deps.caps?.maxEnqueuePerRun, DEFAULT_MAX_ENQUEUE_PER_RUN, 1, HARD_MAX_ENQUEUE_PER_RUN,
  );
  const maxUnclassified = bounded(
    deps.caps?.maxUnclassified, DEFAULT_MAX_UNCLASSIFIED, 1, HARD_MAX_UNCLASSIFIED,
  );
  const sweepMaxPages = bounded(
    deps.caps?.sweepMaxPages, DEFAULT_SWEEP_MAX_PAGES, 1, HARD_SWEEP_MAX_PAGES,
  );
  const anchorEnabled = deps.caps?.anchorDisabled !== true;
  const sweepMaxEnqueue = bounded(
    deps.caps?.sweepMaxEnqueue, DEFAULT_SWEEP_MAX_ENQUEUE, 1, HARD_SWEEP_MAX_ENQUEUE,
  );
  const sweepMaxRestarts = bounded(
    deps.caps?.sweepMaxRestarts, DEFAULT_SWEEP_MAX_RESTARTS, 1, HARD_SWEEP_MAX_RESTARTS,
  );

  const startedAt = nowMs();

  // ── Single-flight (0032) ────────────────────────────────────────────────
  // Acquire the stream lease before ANY provider call. Two schedulers (or a
  // slow run overlapping the next tick) must never both page and both advance.
  // The lease is released in `finally` so a throw cannot strand the stream.
  const owner = deps.owner ?? 'reconciler';
  let leaseHeld = false;
  if (deps.checkpoints.beginRun) {
    const begun = await deps.checkpoints.beginRun({
      checkpointKey,
      owner,
      // Margin over the run's own deadline. 120 s (not 60) so a run that
      // overruns slightly still holds a LIVE lease when it anchors or
      // advances — both of which now refuse on an expired lease, and a refused
      // advance discards a completed sweep's token.
      leaseSeconds: Math.max(1, Math.ceil(deadlineMs / 1000) + 120),
    });
    if (begun.status === 'locked') {
      return {
        mode: 'incremental', pages: 0, items: 0, observed: 0, admitted: 0,
        skipped: emptySkips(), unclassified: 0, mappingsLoaded: 0,
        mappingIndexTruncated: false, recovered: 0, duplicates: 0, enqueued: 0,
        stop: 'locked', advanced: false, partialProgress: noProgress(),
      };
    }
    leaseHeld = true;
  }

  let advanced = false;
  // Durable progress of ANY kind — a token install OR at least one page
  // anchor. `endRun` resets the no-progress counter on this, not on
  // `advanced`, so a multi-run sweep that is genuinely eating through the
  // corpus one bounded run at a time does not look like a stuck stream.
  let progressed = false;
  try {
    return await drain();
  } finally {
    if (leaseHeld && deps.checkpoints.endRun) {
      // Best-effort release: a failure here must not mask the run's own error,
      // and the lease expires on its own deadline regardless.
      try {
        await deps.checkpoints.endRun({ checkpointKey, owner, advanced: advanced || progressed });
      } catch { /* lease self-expires; never mask the primary outcome */ }
    }
  }

  async function drain(): Promise<ReconcileResult> {
  const checkpoint = await deps.checkpoints.get(checkpointKey);
  const decided = resolveRunPlan(checkpoint, startedAt, {
    anchorEnabled,
    anchorMaxAgeMs: deps.caps?.anchorMaxAgeMs,
  });
  // Captured BEFORE any paging: `advance` hands it back so a forced resync
  // requested mid-run (a mapping enabled while we page) is not cleared by this
  // run's completion. `undefined` when the store predates 0033.
  const resyncEpoch = typeof checkpoint?.resyncEpoch === 'number' ? checkpoint.resyncEpoch : null;

  // ONE bounded load per run — never cached across runs, so a pause, a drift
  // auto-pause, or a stage-id edit is honoured on the very next pass.
  const loaded = await deps.mappings.listEnabled(maxEnabledMappings);
  const index = buildEnabledStageIndex(loaded.rows ?? []);
  const mappingsLoaded = index.size;
  const mappingIndexTruncated = loaded.truncated === true;

  // ── Page-anchored continuation (0034) ──────────────────────────────────
  // A continuation is only meaningful for a FULL resync (an incremental run
  // is already anchored by its sync token) and only when the store can
  // durably persist an anchor. Absent either, this is exactly the pre-0034
  // one-run-or-nothing behaviour.
  // Both sweep modes anchor: the production corpus does not drain in one run
  // in EITHER mode, and an incremental sweep large enough to hit the page
  // bound would stall exactly as the full one did.
  const canAnchor = anchorEnabled && typeof deps.checkpoints.saveResyncCursor === 'function';
  const resumeFrom = canAnchor ? (decided.resumeCursor ?? null) : null;
  const restartReason: SweepRestartReason = canAnchor ? decided.restartReason : 'anchor_disabled';
  const basePagesDone = resumeFrom ? safeProgress(checkpoint?.resyncPagesDone) : 0;
  const baseItemsDone = resumeFrom ? safeProgress(checkpoint?.resyncItemsDone) : 0;
  const sweepRestarts = safeProgress(checkpoint?.sweepRestarts);
  const baseSweepEnqueued = safeProgress(checkpoint?.sweepEnqueued);
  /** Jobs this SWEEP has created, this run included. */
  let sweepEnqueued = baseSweepEnqueued;
  let halted = false;

  /** Stop the run, durably halting the stream until an operator clears it. */
  async function haltStream(reason: string): Promise<void> {
    halted = true;
    if (!deps.checkpoints.haltSweep) return;   // fake store: the run still stops
    try {
      await deps.checkpoints.haltSweep({ checkpointKey, owner, reason });
    } catch { /* the run stops regardless; never mask the primary outcome */ }
  }

  // ── HALTED (H-8) ───────────────────────────────────────────────────────
  // Checked before ANY provider call: while halted, reconciliation on this
  // stream does nothing at all. This is what stops a page-aligned breaker from
  // becoming an unbounded rate — it restores the wedge at sweep granularity.
  if (checkpoint?.sweepHaltedAt) {
    counter('ashby_reconcile_halted', 1);
    return {
      mode: decided.mode, pages: 0, items: 0, observed: 0, admitted: 0,
      skipped: emptySkips(), unclassified: 0, mappingsLoaded,
      mappingIndexTruncated, recovered: 0, duplicates: 0, enqueued: 0,
      stop: 'halted', advanced: false,
      partialProgress: {
        ...noProgress(),
        sweepRestarts,
        sweepEnqueued: baseSweepEnqueued,
        halted: true,
      },
    };
  }

  // ── Restart budget (M2) ────────────────────────────────────────────────
  // A resume that never holds re-pages the whole corpus every run forever.
  // `sweep_restarts` was previously reported and gated nothing.
  if (canAnchor && decided.restartReason !== 'none' && sweepRestarts >= sweepMaxRestarts) {
    await haltStream(HALT_RESTART_BUDGET);
    counter('ashby_reconcile_halted', 1, { reason: HALT_RESTART_BUDGET });
    return {
      mode: decided.mode, pages: 0, items: 0, observed: 0, admitted: 0,
      skipped: emptySkips(), unclassified: 0, mappingsLoaded,
      mappingIndexTruncated, recovered: 0, duplicates: 0, enqueued: 0,
      stop: 'halted', advanced: false,
      partialProgress: {
        ...noProgress(),
        restartReason: decided.restartReason,
        sweepRestarts,
        sweepEnqueued: baseSweepEnqueued,
        halted: true,
      },
    };
  }
  /**
   * The EARLIEST opaque token seen in this sweep. Banked on the anchor so it
   * survives across runs, and installed — not the last one — on completion.
   */
  let sweepToken: string | null = null;
  /** Pages fully handled BY THIS RUN (every item on them durably recorded). */
  let handledPages = 0;
  /** Applications fully handled by this run, on those complete pages. */
  let handledItems = 0;
  /** Page anchors durably written by this run. */
  let anchors = 0;

  let cursor: string | undefined = resumeFrom ?? undefined;
  let syncToken: string | undefined = decided.mode === 'incremental' ? decided.syncToken : undefined;
  const seenCursors = new Set<string>();
  // Seed the loop detector with the cursor we resumed from, so a provider
  // that hands back the same cursor is caught on the very first page instead
  // of re-anchoring it forever.
  if (resumeFrom) seenCursors.add(resumeFrom);
  let pages = 0;
  let items = 0;
  let admitted = 0;
  let unclassified = 0;
  let recovered = 0;
  let duplicates = 0;
  let enqueued = 0;
  const skipped = emptySkips();
  let stop: ReconcileStop = 'drained';
  let unclassifiedAbort = false;
  let enqueueCapHit = false;
  let anchorConflict = false;
  let sweepAbandoned = false;

  for (;;) {
    if (pages >= maxPages) { stop = 'page_cap'; break; }
    if (nowMs() - startedAt > deadlineMs) { stop = 'deadline'; break; }
    // Under a continuation the item bound is evaluated PER PAGE, not per
    // item. A page is the unit that can be anchored, so a bound that stops
    // mid-page would discard that page's work every run and — if it always
    // struck on the first page — the sweep could never anchor anything at
    // all. Checking here keeps the run bounded (it overshoots by at most one
    // page, itself bounded by `pageLimit`) while guaranteeing liveness.
    if (canAnchor && items >= maxItems) { stop = 'item_cap'; break; }
    // Page-aligned too (D-4): checking the breaker mid-page leaves a
    // half-decided page that can never be anchored. Evaluated here it is a
    // rate limit rather than a wall, overshooting by at most one page — a
    // deliberate, bounded weakening of the storm guard (200 becomes <=300 at
    // the default page size) in exchange for atomic, anchorable pages.
    if (canAnchor && enqueued >= maxEnqueuePerRun) { stop = 'enqueue_cap'; break; }
    // Cross-run budget: `maxPages` bounds a RUN, this bounds the SWEEP, so a
    // cursor chain that never terminates is abandoned instead of paged forever.
    if (canAnchor && basePagesDone + handledPages >= sweepMaxPages) {
      stop = 'sweep_budget';
      sweepAbandoned = true;
      break;
    }
    // H-8: the ABSOLUTE ceiling on durable work for this sweep. The per-run
    // breaker only bounds a pass, and a pass fires every few seconds while a
    // sweep is in flight — so without this the guard is a rate, not a limit.
    // Exhausting it HALTS the stream rather than merely ending the run.
    if (canAnchor && sweepEnqueued >= sweepMaxEnqueue) {
      stop = 'halted';
      await haltStream(HALT_ENQUEUE_BUDGET);
      break;
    }

    // A page fetch or receipt failure throws — the cursor is NOT advanced.
    let page;
    try {
      page = await deps.client.applicationList<OpaqueRecord[]>({
        cursor,
        syncToken,
        limit: pageLimit,
      });
    } catch (err) {
      // M1: the provider REJECTED the cursor we resumed from. Left standing,
      // every subsequent run would resume the same dead cursor and throw
      // again until the freshness bound eventually expired it — hours of the
      // dropped-webhook safety net being down. Invalidate it now so the very
      // next run sweeps from page 1. Only ever on the FIRST page of a resumed
      // run, and only for a non-retriable failure: a transient error must not
      // cost a valid anchor.
      if (resumeFrom !== null && pages === 0 && isCursorRejection(err)) {
        counter('ashby_reconcile_cursor_rejected', 1);
        try {
          await deps.checkpoints.requireFullResync(checkpointKey, CURSOR_REJECTED_RESYNC_REASON);
        } catch { /* the throw already prevents advancing; never mask it */ }
      }
      throw err;
    }
    pages += 1;

    const pageItems = Array.isArray(page.results) ? page.results : [];
    let itemCapHit = false;
    /** Applications on THIS page that reached a durable decision. */
    let pageHandled = 0;
    for (const raw of pageItems) {
      if (!canAnchor && items >= maxItems) { itemCapHit = true; break; }
      items += 1;
      // ADMISSION FIRST — before ANY receipt write or enqueue. A skipped row
      // costs one map lookup and leaves no durable trace whatsoever.
      const verdict = admitApplication(extractApplicationInfo(raw), index);
      if (!verdict.admit) { skipped[verdict.reason] += 1; pageHandled += 1; continue; }

      if (!verdict.classified) {
        unclassified += 1;
        if (unclassified > maxUnclassified) {
          // Probable provider-schema drift. Abort LOUD and bounded: do not
          // advance, and flag the stream so the next pass is a full sweep and
          // an operator can see why.
          unclassifiedAbort = true;
          stop = 'unclassified_cap';
          break;
        }
      }

      // Circuit breaker. Without anchoring it stays a strict per-item ceiling
      // (pre-0034 behaviour); with anchoring it is evaluated at the page
      // boundary above so the page stays atomic.
      if (!canAnchor && enqueued >= maxEnqueuePerRun) {
        stop = 'enqueue_cap'; enqueueCapHit = true; break;
      }

      admitted += 1;
      const dedupId = stageDedupId(verdict.applicationId, verdict.stageId);
      // Recover the signal INTO PROCESSING via the transactional outbox: record
      // the receipt AND ensure a live signal job exists (re-drive). A dropped
      // webhook is thus imported; an already-covered application converges (the
      // outbox creates no duplicate job) so a later webhook still results in
      // exactly one scheduled import. The worker re-reads `application.info`
      // authoritatively and re-applies the mapping/stage gate, so admission
      // here is a pre-filter that can only ever reduce work, never widen it.
      const outcome = await deps.receipts.record({
        webhookActionId: dedupId,
        action: CANDIDATE_STAGE_CHANGE_ACTION,
        metadata: { source: 'reconcile' },
        enqueue: buildSignalEnqueueSpec({
          webhookActionId: dedupId,
          action: CANDIDATE_STAGE_CHANGE_ACTION,
          externalApplicationId: verdict.applicationId,
        }),
      });
      if (outcome.status === 'inserted') recovered += 1; else duplicates += 1;
      if (outcome.enqueued) { enqueued += 1; sweepEnqueued += 1; }
      // Durably handled: the receipt (and any re-driven job) is committed.
      // Only now may this row count towards anchoring the page.
      pageHandled += 1;
    }

    // Bank the FIRST token this sweep sees, never the last (H-6). Under
    // final-page-only issuance — which production evidence suggests — the two
    // coincide; if the provider ever issues per page, the earliest token
    // anchors "changes since" at the sweep's start, so a change that landed on
    // an already-scanned page is re-delivered rather than permanently hidden.
    if (typeof page.syncToken === 'string' && page.syncToken && sweepToken === null) {
      sweepToken = page.syncToken;
    }
    if (page.syncToken !== undefined) syncToken = page.syncToken;

    // A page counts as fully handled only when the item loop ran to
    // completion. Any mid-page stop leaves it UNANCHORED, so the next run
    // replays it whole — dedup-safe, and the only ordering in which no
    // application can be skipped.
    const pageComplete = !unclassifiedAbort && !enqueueCapHit && !itemCapHit;
    if (pageComplete) {
      handledPages += 1;
      handledItems += pageHandled;
    }

    if (unclassifiedAbort || enqueueCapHit) break;
    if (itemCapHit) { stop = 'item_cap'; break; }
    if (!page.moreDataAvailable || !page.nextCursor) { stop = 'drained'; break; }
    // A cursor loop that spans RUNS is invisible to `seenCursors`, which is
    // per-run: a resumed anchor that hands itself straight back would be
    // re-anchored forever, and `no_progress_runs` would never climb because
    // each run "made progress". Detect it and drop the anchor.
    if (resumeFrom !== null && page.nextCursor === resumeFrom && pages === 1) {
      stop = 'cursor_invalid';
      sweepAbandoned = true;
      break;
    }
    if (seenCursors.has(page.nextCursor)) {
      // Provider cursor loop within this run — abort without advancing.
      throw new Error('ashby_reconcile_cursor_loop');
    }

    // ── The page anchor (0034) ───────────────────────────────────────────
    // Everything on this page is durably handled and there is more to come:
    // persist where to resume. The store compare-and-sets the epoch and the
    // lease owner, so a forced resync raised mid-run — or a lost lease —
    // refuses the write and this run stops here having advanced nothing.
    if (canAnchor && deps.checkpoints.saveResyncCursor) {
      const saved = await deps.checkpoints.saveResyncCursor({
        checkpointKey,
        cursor: page.nextCursor,
        owner,
        pagesDone: basePagesDone + handledPages,
        itemsDone: baseItemsDone + handledItems,
        resyncEpoch,
        mode: decided.mode,
        sweepToken,
        // H-8: the sweep's durable-work total travels with the anchor, so the
        // budget survives across runs instead of resetting every pass.
        enqueued: sweepEnqueued,
        // The first anchor of a run that did NOT resume starts a new sweep:
        // it resets the sweep counters and banked token, and counts a restart
        // if an abandoned anchor was still standing.
        first: resumeFrom === null && anchors === 0,
      });
      if (saved.status !== 'ok') {
        anchorConflict = true;
        stop = 'continuation_conflict';
        break;
      }
      anchors += 1;
      progressed = true;
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  // Schema drift is a stream-level condition, not a per-item one: flag it so
  // the next pass is a full sweep and the reason is visible to an operator.
  // Best-effort — a failure here must not mask the abort itself.
  if (unclassifiedAbort) {
    try {
      await deps.checkpoints.requireFullResync(checkpointKey, UNCLASSIFIED_RESYNC_REASON);
    } catch { /* the abort already prevents advancing; never mask it */ }
  }

  // An abandoned sweep must not leave its anchor standing: the next run would
  // resume the very cursor chain that could not terminate. Forcing a resync
  // nulls the anchor, bumps the epoch, and records a sanitized reason.
  if (sweepAbandoned) {
    try {
      await deps.checkpoints.requireFullResync(
        checkpointKey,
        stop === 'sweep_budget' ? SWEEP_BUDGET_RESYNC_REASON : CURSOR_INVALID_RESYNC_REASON,
      );
    } catch { /* the abort already prevents advancing; never mask it */ }
  }

  // Advance the checkpoint ONLY on a fully drained, successful run. A run that
  // stopped on a page/item cap or the deadline is partial and must NOT advance
  // the cursor past unprocessed work (dedup makes the next full run idempotent).
  if (stop === 'drained') {
    await deps.checkpoints.advance({
      checkpointKey,
      // Earliest-wins within this run too; the store coalesces with any token
      // banked by an earlier run of the same sweep.
      syncToken: sweepToken ?? syncToken ?? null,
      pages,
      items,
      full: decided.mode === 'full',
      resyncEpoch,
      owner,
    });
    advanced = true;
    progressed = true;
  }

  // Admission counters (review L1). Nothing here would have alarmed on "one
  // run enqueued 2,000 jobs"; these are that signal. Counters and a sanitized
  // stop code only — never an application, job, stage, or tenant id.
  counter('ashby_reconcile_observed', items, { stop });
  counter('ashby_reconcile_admitted', admitted, { stop });
  counter('ashby_reconcile_enqueued', enqueued);
  counter('ashby_reconcile_unclassified', unclassified);
  counter('ashby_reconcile_skipped_mapping', skipped.noEnabledMapping);
  counter('ashby_reconcile_skipped_stage', skipped.stageNotAi);
  counter('ashby_reconcile_skipped_ambiguous', skipped.ambiguousMapping);
  counter('ashby_reconcile_skipped_no_application', skipped.noApplicationId);
  if (mappingIndexTruncated) counter('ashby_reconcile_mapping_index_truncated', 1);
  if (canAnchor) {
    counter('ashby_reconcile_page_anchors', anchors, { stop });
    if (anchorConflict) counter('ashby_reconcile_continuation_conflict', 1);
    if (sweepAbandoned) counter('ashby_reconcile_sweep_abandoned', 1, { stop });
    counter('ashby_reconcile_sweep_enqueued', sweepEnqueued, { stop });
    if (halted) counter('ashby_reconcile_halted', 1, { reason: HALT_ENQUEUE_BUDGET });
    if (restartReason !== 'none') {
      counter('ashby_reconcile_sweep_restart', 1, { reason: restartReason });
    }
  }

  const tokenInstalled = advanced && (sweepToken ?? syncToken ?? null) !== null;
  const partialProgress: PartialProgress = {
    resumed: resumeFrom !== null,
    checkpoints: anchors,
    // On a drained run the continuation is over, so the honest totals are the
    // whole sweep's; on any other stop they are what is durably behind us.
    // Outside a continuation there is nothing durable to report, so these stay
    // zero rather than describing work this run alone happened to do.
    pagesDone: canAnchor ? basePagesDone + handledPages : 0,
    itemsDone: canAnchor ? baseItemsDone + handledItems : 0,
    // An anchor outlives this run unless the run drained (which clears it
    // atomically with the token install). A run that never anchored and never
    // resumed leaves nothing behind.
    // The drift abort calls requireFullResync, which NULLS the anchor and
    // starts a new generation — so this run leaves no continuation behind
    // either, exactly like the conflict case.
    continuationPending:
      stop !== 'drained' && (anchors > 0 || resumeFrom !== null)
      && !anchorConflict && !unclassifiedAbort && !sweepAbandoned,
    restartReason,
    sweepRestarts,
    sweepEnqueued,
    halted,
    tokenInstalled,
  };

  return {
    mode: decided.mode, pages, items, observed: items, admitted, skipped,
    unclassified, mappingsLoaded, mappingIndexTruncated, recovered, duplicates,
    enqueued, stop, advanced, partialProgress,
  };
  }
}
