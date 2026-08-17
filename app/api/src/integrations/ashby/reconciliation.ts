/**
 * ashby/reconciliation.ts — incremental application.list reconciliation.
 *
 * Reconciliation is the safety net for dropped/undelivered webhooks. It pages
 * through `application.list` with the opaque incremental sync token, and for
 * every application it observes it records a dedup-safe stage receipt using the
 * SAME stage-centric identity the webhook uses (extractors.stageDedupId). A
 * dropped webhook leaves no receipt, so reconciliation's insert RECOVERS the
 * signal; an application already covered by a webhook receipt converges to the
 * same row (duplicate, no new work).
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
import type { CheckpointStore, ReceiptStore } from './ports.js';
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
}

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_ITEMS = 5_000;
const DEFAULT_DEADLINE_MS = 60_000;
const HARD_MAX_PAGES = 1_000;
const HARD_MAX_ITEMS = 100_000;

export type ReconcileStop = 'drained' | 'page_cap' | 'item_cap' | 'deadline' | 'locked';

export interface ReconcileResult {
  mode: 'full' | 'incremental';
  pages: number;
  items: number;
  /** Newly recovered (previously missing) stage receipts. */
  recovered: number;
  /** Applications whose receipt already existed. */
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
  checkpointKey?: string;
  caps?: ReconcileCaps;
  /** Monotonic clock in ms; inject for deterministic tests. */
  nowMs?: () => number;
  /** Opaque single-flight lease owner. Never a secret. Default 'reconciler'. */
  owner?: string;
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
        mode: 'incremental', pages: 0, items: 0, recovered: 0, duplicates: 0,
        enqueued: 0, stop: 'locked', advanced: false,
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

  let cursor: string | undefined;
  let syncToken: string | undefined = decided.mode === 'incremental' ? decided.syncToken : undefined;
  const seenCursors = new Set<string>();
  let pages = 0;
  let items = 0;
  let recovered = 0;
  let duplicates = 0;
  let enqueued = 0;
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
      const view = extractApplicationInfo(raw);
      if (!view.applicationId) continue; // unusable item — skip safely
      const dedupId = stageDedupId(view.applicationId, view.currentStageId);
      // Recover the signal INTO PROCESSING via the transactional outbox: record
      // the receipt AND ensure a live signal job exists (re-drive). A dropped
      // webhook is thus imported; an already-covered application converges (the
      // outbox creates no duplicate job) so a later webhook still results in
      // exactly one scheduled import. The worker re-reads authoritative state
      // and gates on mapping/stage, so enqueuing every observed application is
      // safe (non-AI-stage / paused / unknown → no-op).
      const outcome = await deps.receipts.record({
        webhookActionId: dedupId,
        action: CANDIDATE_STAGE_CHANGE_ACTION,
        metadata: { source: 'reconcile' },
        enqueue: buildSignalEnqueueSpec({
          webhookActionId: dedupId,
          action: CANDIDATE_STAGE_CHANGE_ACTION,
          externalApplicationId: view.applicationId,
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
    });
    advanced = true;
  }

  return { mode: decided.mode, pages, items, recovered, duplicates, enqueued, stop, advanced };
  }
}
