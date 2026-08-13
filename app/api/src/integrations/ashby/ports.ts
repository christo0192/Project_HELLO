/**
 * ashby/ports.ts — injectable persistence/queue seams for the webhook +
 * reconciliation modules. Every DB or queue interaction the ingress, worker,
 * and reconciliation code performs goes through one of these narrow ports, so
 * unit tests drive fully deterministic in-memory fakes and production wires the
 * service-role Supabase RPCs (see stores.ts). No port ever accepts or returns
 * PII, raw bodies, signatures, secrets, or logs an opaque sync token.
 */

/** Outcome of a dedup-safe receipt insert (mirrors record_ashby_event_receipt). */
export interface ReceiptOutcome {
  /** 'inserted' = newly durable (schedule signal work once); 'duplicate' = already stored. */
  status: 'inserted' | 'duplicate';
  /** Opaque receipt row id. */
  id: string;
}

/** Durable, dedup-safe webhook receipt sink. */
export interface ReceiptStore {
  /**
   * Insert-or-noop a sanitized receipt keyed by (webhookActionId, action).
   * Metadata is bounded non-PII only. Throws on a durability failure so the
   * caller can return a retryable 5xx.
   */
  record(input: {
    webhookActionId: string;
    action: string;
    metadata?: Record<string, unknown> | null;
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
}

/** Opaque-ID-only signal payload placed on the leased queue. NEVER carries PII. */
export interface AshbySignalPayload {
  provider: 'ashby';
  webhookActionId: string;
  action: string;
  /** Opaque external application id (never contact/resume data). May be absent. */
  externalApplicationId?: string;
}

/**
 * Enqueues a signal for the reconciliation worker. Implementations MUST dedup
 * on (webhookActionId, action) so duplicate deliveries never create duplicate
 * queue work, and MUST carry only the opaque ids above.
 */
export interface SignalEnqueuer {
  enqueue(payload: AshbySignalPayload): Promise<void>;
}
