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
  }): Promise<void>;
  /** Force a safe full resync (null the token, flag the stream). */
  requireFullResync(checkpointKey: string, reason: string): Promise<void>;

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
