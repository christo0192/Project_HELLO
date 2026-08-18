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
 * Everything else — a missing/unreadable job or stage id, an unmapped job, a
 * paused/drifted mapping, an ambiguous index entry, another stage of a mapped
 * job — is SKIPPED with a counter and touches nothing. With no enabled
 * mapping, a run over thousands of applications writes zero receipts, enqueues
 * zero jobs, and issues zero `application.info` calls.
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
 * Bounds & safety (invariant 7):
 *  - Sync mode: incremental with the stored token, UNLESS the token is absent,
 *    the stream is flagged full_resync_required, or the token is older than the
 *    14-day provider expiry — any of which forces a safe full resync.
 *  - Bounded pages, items, and wall-clock runtime; a repeated cursor (loop) is
 *    detected and aborts.
 *  - The checkpoint (opaque sync token) is advanced ONLY after a fully drained,
 *    fully successful run. Any page fetch or receipt failure throws and the
 *    cursor is NOT advanced — the next run safely reprocesses (dedup makes it
 *    idempotent).
 *
 * SECURITY: sync tokens and cursors are opaque black boxes — never logged or
 * returned. Only opaque application/stage ids flow into receipts; no contact or
 * resume data is read.
 */

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
}

/**
 * Bound on the enabled-mapping index loaded per run. Far above any realistic
 * count of concurrently enabled Ashby jobs for one tenant; a tenant that
 * somehow exceeds it gets a truthful `mappingIndexTruncated` signal rather
 * than a silently partial admission set.
 */
export const DEFAULT_MAX_ENABLED_MAPPINGS = 2_000;
const HARD_MAX_ENABLED_MAPPINGS = 10_000;

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_ITEMS = 5_000;
const DEFAULT_DEADLINE_MS = 60_000;
const HARD_MAX_PAGES = 1_000;
const HARD_MAX_ITEMS = 100_000;

export type ReconcileStop = 'drained' | 'page_cap' | 'item_cap' | 'deadline' | 'locked';

/**
 * Why an observed application.list row was NOT admitted. Counters only — no
 * ids, no PII, nothing tenant-identifying.
 */
export interface ReconcileSkipCounts {
  /** No usable application id on the row. */
  noApplicationId: number;
  /** Job id and/or current stage id absent or unreadable. */
  missingFields: number;
  /** The job has no ENABLED mapping (unmapped, paused, or drifted). */
  noEnabledMapping: number;
  /** Mapped + enabled, but the row is at some other stage than the AI stage. */
  stageNotAi: number;
  /** The index held conflicting AI stages for that job id — refuse to guess. */
  ambiguousMapping: number;
}

export interface ReconcileResult {
  mode: 'full' | 'incremental';
  pages: number;
  /** Applications OBSERVED on the pages read (the item-cap counter). */
  items: number;
  /** Alias of `items`, named for the observed/admitted/skipped health triple. */
  observed: number;
  /** Applications that passed admission (job + stage match an enabled mapping). */
  admitted: number;
  /** Per-reason skip counts. observed === admitted + sum(skipped). */
  skipped: ReconcileSkipCounts;
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
  return {
    noApplicationId: 0, missingFields: 0, noEnabledMapping: 0,
    stageNotAi: 0, ambiguousMapping: 0,
  };
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
  | { admit: true; applicationId: string; jobId: string; stageId: string }
  | { admit: false; reason: keyof ReconcileSkipCounts };

/**
 * Decide whether one observed row may create durable work. Pure and total:
 * every path returns either an admission with all three concrete ids, or a
 * single sanitized skip reason. Exported for direct unit coverage.
 */
export function admitApplication(
  view: { applicationId?: string; jobId?: string; currentStageId?: string },
  index: ReadonlyMap<string, string | null>,
): AdmissionVerdict {
  if (!view.applicationId) return { admit: false, reason: 'noApplicationId' };
  // A row must POSITIVELY expose both ids. Absent/unreadable ⇒ skip, never
  // "look it up anyway" — that lookup is the storm we are preventing.
  if (!view.jobId || !view.currentStageId) return { admit: false, reason: 'missingFields' };
  if (!index.has(view.jobId)) return { admit: false, reason: 'noEnabledMapping' };
  const aiStageId = index.get(view.jobId);
  if (aiStageId === null || aiStageId === undefined) {
    return { admit: false, reason: 'ambiguousMapping' };
  }
  if (view.currentStageId !== aiStageId) return { admit: false, reason: 'stageNotAi' };
  return {
    admit: true,
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
      leaseSeconds: Math.max(1, Math.ceil(deadlineMs / 1000) + 60),
    });
    if (begun.status === 'locked') {
      return {
        mode: 'incremental', pages: 0, items: 0, observed: 0, admitted: 0,
        skipped: emptySkips(), mappingsLoaded: 0, mappingIndexTruncated: false,
        recovered: 0, duplicates: 0, enqueued: 0, stop: 'locked', advanced: false,
      };
    }
    leaseHeld = true;
  }

  let advanced = false;
  try {
    return await drain();
  } finally {
    if (leaseHeld && deps.checkpoints.endRun) {
      // Best-effort release: a failure here must not mask the run's own error,
      // and the lease expires on its own deadline regardless.
      try {
        await deps.checkpoints.endRun({ checkpointKey, owner, advanced });
      } catch { /* lease self-expires; never mask the primary outcome */ }
    }
  }

  async function drain(): Promise<ReconcileResult> {
  const checkpoint = await deps.checkpoints.get(checkpointKey);
  const decided = resolveSyncMode(checkpoint, startedAt);
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

  let cursor: string | undefined;
  let syncToken: string | undefined = decided.mode === 'incremental' ? decided.syncToken : undefined;
  const seenCursors = new Set<string>();
  let pages = 0;
  let items = 0;
  let admitted = 0;
  let recovered = 0;
  let duplicates = 0;
  let enqueued = 0;
  const skipped = emptySkips();
  let stop: ReconcileStop = 'drained';

  for (;;) {
    if (pages >= maxPages) { stop = 'page_cap'; break; }
    if (nowMs() - startedAt > deadlineMs) { stop = 'deadline'; break; }

    // A page fetch or receipt failure throws — the cursor is NOT advanced.
    const page = await deps.client.applicationList<OpaqueRecord[]>({
      cursor,
      syncToken,
      limit: pageLimit,
    });
    pages += 1;

    const pageItems = Array.isArray(page.results) ? page.results : [];
    let itemCapHit = false;
    for (const raw of pageItems) {
      if (items >= maxItems) { itemCapHit = true; break; }
      items += 1;
      // ADMISSION FIRST — before ANY receipt write or enqueue. A skipped row
      // costs one map lookup and leaves no durable trace whatsoever.
      const verdict = admitApplication(extractApplicationInfo(raw), index);
      if (!verdict.admit) { skipped[verdict.reason] += 1; continue; }
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
      if (outcome.enqueued) enqueued += 1;
    }

    // The final page's opaque token supersedes the working token.
    if (page.syncToken !== undefined) syncToken = page.syncToken;

    if (itemCapHit) { stop = 'item_cap'; break; }
    if (!page.moreDataAvailable || !page.nextCursor) { stop = 'drained'; break; }
    if (seenCursors.has(page.nextCursor)) {
      // Provider cursor loop — abort without advancing.
      throw new Error('ashby_reconcile_cursor_loop');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  // Advance the checkpoint ONLY on a fully drained, successful run. A run that
  // stopped on a page/item cap or the deadline is partial and must NOT advance
  // the cursor past unprocessed work (dedup makes the next full run idempotent).
  if (stop === 'drained') {
    await deps.checkpoints.advance({
      checkpointKey,
      syncToken: syncToken ?? null,
      pages,
      items,
      full: decided.mode === 'full',
      resyncEpoch,
    });
    advanced = true;
  }

  return {
    mode: decided.mode, pages, items, observed: items, admitted, skipped,
    mappingsLoaded, mappingIndexTruncated, recovered, duplicates, enqueued,
    stop, advanced,
  };
  }
}
