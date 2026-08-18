/**
 * ashby/ports.ts — injectable persistence/queue seams for the webhook +
 * reconciliation modules. Every DB or queue interaction the ingress, worker,
 * and reconciliation code performs goes through one of these narrow ports, so
 * unit tests drive fully deterministic in-memory fakes and production wires the
 * service-role Supabase RPCs (see stores.ts). No port ever accepts or returns
 * PII, raw bodies, signatures, secrets, or logs an opaque sync token.
 */

/** Opaque-ID-only signal payload placed on the leased queue. NEVER carries PII. */
export interface AshbySignalPayload {
  provider: 'ashby';
  webhookActionId: string;
  action: string;
  /** Opaque external application id (never contact/resume data). May be absent. */
  externalApplicationId?: string;
}

/**
 * A deterministic enqueue request handed to the transactional-outbox receipt
 * write. The receipt insert and this job insert commit in ONE transaction, and
 * the dedup key makes re-drive idempotent (exactly one live job per signal).
 */
export interface EnqueueSpec {
  queueName: string;
  /** Deterministic dedup key — identical across webhook retries + reconciliation. */
  dedupKey: string;
  /** Opaque-ids-only payload. */
  payload: AshbySignalPayload;
  maxAttempts?: number;
}

/** Outcome of the transactional-outbox receipt write (mirrors the 0030 RPC). */
export interface ReceiptOutcome {
  /** 'inserted' = receipt newly stored; 'duplicate' = already stored. */
  status: 'inserted' | 'duplicate';
  /** Opaque receipt row id. */
  id: string;
  /** A queue job was inserted on THIS call (false when re-drive found work). */
  enqueued: boolean;
  /** Durable processing work exists after this call (live job or terminal receipt). */
  workPending: boolean;
}

/** Durable, dedup-safe webhook receipt sink with an atomic signal outbox. */
export interface ReceiptStore {
  /**
   * Atomically insert-or-noop a sanitized receipt keyed by
   * (webhookActionId, action) AND, when `enqueue` is supplied, ensure exactly
   * one live signal job exists for the deterministic dedup key (re-driving a
   * missing enqueue on a duplicate). Metadata/payload are bounded non-PII only.
   * Throws on a durability failure so the caller returns a retryable 5xx.
   */
  record(input: {
    webhookActionId: string;
    action: string;
    metadata?: Record<string, unknown> | null;
    enqueue?: EnqueueSpec;
  }): Promise<ReceiptOutcome>;

  /** Update a receipt's processing status (post-processing bookkeeping). */
  markStatus?(input: {
    webhookActionId: string;
    action: string;
    status: 'processing' | 'processed' | 'failed' | 'ignored';
  }): Promise<void>;
}

/** A durable reconciliation cursor for one stream. */
export interface SyncCheckpoint {
  /** Opaque incremental token; null forces a full sync. Never log. */
  syncToken: string | null;
  status: 'idle' | 'running' | 'full_resync_required';
  /** ISO time the current token was issued (14-day expiry anchor), or null. */
  tokenIssuedAt: string | null;
  lastSuccessAt: string | null;
  /**
   * Monotonic counter bumped every time a forced full resync is requested
   * (0033). A run reads it before paging and hands it back to `advance`, which
   * refuses to clear `full_resync_required` when the value moved meanwhile —
   * so enabling a mapping DURING a run cannot have its forced resync silently
   * cleared by that run's own completion.
   */
  resyncEpoch?: number;
  /**
   * PAGE ANCHOR for an in-flight FULL resync (0034): the opaque provider page
   * cursor the next run resumes from, or null when no continuation is in
   * flight (start at page 1). Written only after every item on the preceding
   * page was durably handled, so resuming can never skip an application.
   * Opaque like `syncToken` — never log it, never return it to a browser.
   */
  resyncCursor?: string | null;
  /**
   * The `resyncEpoch` the anchor was written under. An anchor from an older
   * epoch was scanned against a STALE admission index — the mapping enabled
   * since then admits rows that prefix skipped — so it must not be resumed.
   */
  resyncCursorEpoch?: number | null;
  /**
   * When the anchor was last written (ISO). Provider cursor lifetime is not a
   * documented guarantee, so an anchor older than the caller's freshness bound
   * is discarded and the sweep restarts rather than replaying a dead cursor.
   */
  resyncCursorAt?: string | null;
  /** Which sweep the anchor belongs to. A full anchor is invalid incrementally. */
  sweepMode?: 'full' | 'incremental' | null;
  /** Pages fully handled so far in the current continuation, across its runs. */
  resyncPagesDone?: number;
  /** Applications fully handled so far in the current continuation. */
  resyncItemsDone?: number;
  /** How many times a sweep was abandoned and restarted from page 1. */
  sweepRestarts?: number;
}

/** Durable checkpoint store for incremental reconciliation. */
export interface CheckpointStore {
  /** Read the checkpoint for a stream, or null when none exists yet. */
  get(checkpointKey: string): Promise<SyncCheckpoint | null>;
  /** Persist a new cursor AFTER a fully successful run. */
  advance(input: {
    checkpointKey: string;
    syncToken: string | null;
    pages: number;
    items: number;
    full: boolean;
    /**
     * The `resyncEpoch` observed when this run started. When supplied and the
     * stored epoch has moved on, the cursor still advances but the forced
     * `full_resync_required` flag is PRESERVED (see 0033).
     */
    resyncEpoch?: number | null;
    /**
     * The lease owner asserted by the store's compare-and-set (0034). A run
     * whose lease expired must not install a token over the sweep another
     * runner is now performing — doing so would strand that runner's
     * continuation behind a fresh incremental token and silently skip its
     * unread pages. Omitted ⇒ no lease assertion (pre-0034 behaviour).
     */
    owner?: string;
  }): Promise<void>;
  /**
   * Force a safe full resync (null the token, flag the stream). Also bumps
   * `resyncEpoch` and INVALIDATES any in-flight page-anchored continuation,
   * so the new generation sweeps from page 1 (0034).
   */
  requireFullResync(checkpointKey: string, reason: string): Promise<void>;

  /**
   * Persist the durable PAGE ANCHOR of an in-flight full resync (0034), so
   * the next run resumes there instead of page 1 — the only thing that lets a
   * corpus larger than one run's page/item bound ever finish sweeping.
   *
   * The caller invokes this ONLY after every item on the page preceding
   * `cursor` has been durably handled. The store compare-and-sets BOTH the
   * observed `resyncEpoch` and the live single-flight lease owner and writes
   * nothing on a mismatch, returning a sanitized status — so a stale run can
   * neither resurrect an anchor a forced resync just invalidated nor move an
   * anchor a different runner now owns. Any non-`ok` status makes the caller
   * fail closed (stop the run, advance nothing).
   *
   * Optional so the pure-domain tests can drive `runReconciliation` with a
   * minimal fake; production ALWAYS supplies it. When absent, a full resync
   * behaves exactly as it did pre-0034 (no continuation, one-run-or-nothing).
   */
  saveResyncCursor?(input: {
    checkpointKey: string;
    /** Opaque provider page cursor. Never logged. */
    cursor: string;
    /** Lease owner asserted by the compare-and-set. Never a secret. */
    owner: string;
    /** Pages fully handled across the whole continuation so far. */
    pagesDone: number;
    /** Applications fully handled across the whole continuation so far. */
    itemsDone: number;
    /** The epoch observed before paging; a mismatch refuses the write. */
    resyncEpoch: number | null;
    /** Which sweep this anchor belongs to, so a resume can mode-check it. */
    mode: 'full' | 'incremental';
    /**
     * The opaque sync token observed so far in THIS sweep, if any. Banked
     * first-write-wins: installing the EARLIEST token anchors "changes since"
     * at the sweep's start, which can only re-deliver (idempotent), where the
     * latest would permanently hide changes that landed on scanned pages.
     */
    sweepToken?: string | null;
    /**
     * True for the first anchor of a NEW sweep: resets the sweep's counters and
     * banked token, and counts a restart if an anchor was still standing.
     */
    first?: boolean;
  }): Promise<{ status: 'ok' | string }>;

  /**
   * Acquire the SINGLE-FLIGHT lease for a stream (0032). Returns `locked` when
   * another runner holds a live lease, so two schedulers — or a slow run
   * overlapping the next tick — can never both page the provider and both
   * advance the cursor.
   *
   * Optional so the pure-domain tests can drive `runReconciliation` with a
   * minimal fake; production ALWAYS supplies it. When absent, reconciliation
   * runs unguarded exactly as it did before, which is only safe because
   * nothing scheduled it.
   */
  beginRun?(input: { checkpointKey: string; owner: string; leaseSeconds: number }): Promise<{
    status: 'ok' | 'locked' | string;
    checkpoint?: SyncCheckpoint | null;
    noProgressRuns?: number;
  }>;

  /**
   * Release the single-flight lease. `advanced=false` increments the durable
   * consecutive-no-progress counter so a stream that can never drain (e.g. a
   * full resync permanently larger than `item_cap`) becomes observable instead
   * of silently replaying the same prefix forever.
   */
  endRun?(input: { checkpointKey: string; owner: string; advanced: boolean }): Promise<{
    status: string;
    noProgressRuns: number;
  }>;
}

// ── Reconciliation admission: enabled-mapping index ─────────────────────────

/**
 * One ENABLED mapping's admission facts. Opaque provider ids only — never a
 * role, owner, label, or any tenant-identifying text.
 */
export interface EnabledMappingRow {
  externalJobId: string;
  aiScreeningStageId: string;
}

/**
 * Loads the CURRENT set of enabled mappings in ONE bounded query, so
 * reconciliation can admit applications without issuing a per-application
 * mapping lookup (which is what turned a single reconciliation pass into a
 * tenant-wide `application.info` + queue storm).
 *
 * The index is rebuilt from this port on EVERY run and never cached across
 * runs: a pause, a drift auto-pause, or a stage-id edit must take effect on
 * the very next pass.
 */
export interface EnabledMappingLoader {
  /**
   * Return at most `limit` enabled mappings that carry an AI screening stage
   * id. `truncated` is true when more enabled mappings exist than the bound —
   * a fail-closed condition the caller reports rather than silently ignores.
   */
  listEnabled(limit: number): Promise<{ rows: EnabledMappingRow[]; truncated: boolean }>;
}
