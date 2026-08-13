/**
 * ashby/ingress.ts — durable webhook ingress orchestration.
 *
 * Runs AFTER the route has verified the HMAC signature over the raw bytes and
 * parsed the JSON. Given the parsed body it:
 *   1. extracts a sanitized signal (action + dedup identity + opaque ids);
 *   2. durably records a dedup-safe receipt (insert-or-noop) BEFORE acking;
 *   3. schedules signal work AT MOST ONCE — only for the single stage-change
 *      trigger action, only on a newly-inserted receipt, and only when an
 *      enqueuer is wired.
 *
 * Outcome → HTTP mapping (applied by the route):
 *   accepted        → 200 (durable; signal maybe enqueued)
 *   duplicate       → 200 (already durable; no new queue work)
 *   ignored_action  → 200 (durable receipt; not a processing trigger)
 *   unrecognized    → 400 (signed but unparseable/idless — Ashby will not storm)
 *   durability_error→ 500 (retryable; receipt or enqueue failed)
 *
 * SECURITY: only a sanitized `{ source }` marker is stored as receipt metadata —
 * never the body, contact data, or ids-as-content. The raw body/signature/secret
 * never reach this layer.
 */

import {
  extractWebhookSignal,
  CANDIDATE_STAGE_CHANGE_ACTION,
  type WebhookSignal,
} from './extractors.js';
import type { ReceiptStore, SignalEnqueuer } from './ports.js';

export type IngressOutcomeKind =
  | 'accepted'
  | 'duplicate'
  | 'ignored_action'
  | 'unrecognized'
  | 'durability_error';

export interface IngressOutcome {
  kind: IngressOutcomeKind;
  httpStatus: 200 | 400 | 500;
  /** Stable sanitized code for logging/response (never PII). */
  code: string;
  /** Whether a signal was enqueued (true only for a fresh stage-change trigger). */
  enqueued: boolean;
}

export interface IngressDeps {
  receipts: ReceiptStore;
  /** Optional queue seam; when absent no signal work is scheduled. */
  enqueuer?: SignalEnqueuer;
}

/** The only action that triggers downstream signal processing. */
export function isTriggerAction(action: string): boolean {
  return action === CANDIDATE_STAGE_CHANGE_ACTION;
}

const OK = (kind: IngressOutcomeKind, code: string, enqueued: boolean): IngressOutcome => ({
  kind,
  httpStatus: 200,
  code,
  enqueued,
});

/**
 * Durably ingest one verified, parsed webhook. Throws are converted to a
 * retryable `durability_error` so the route returns a 5xx and Ashby retries.
 */
export async function ingestWebhook(parsed: unknown, deps: IngressDeps): Promise<IngressOutcome> {
  const extracted = extractWebhookSignal(parsed);
  if (!extracted.ok) {
    // Signed but structurally unusable: acknowledge as a non-retryable 400 so
    // Ashby does not retry-storm on a payload we can never process.
    return { kind: 'unrecognized', httpStatus: 400, code: extracted.reason, enqueued: false };
  }
  const signal: WebhookSignal = extracted.signal;

  let receipt;
  try {
    receipt = await deps.receipts.record({
      webhookActionId: signal.webhookActionId,
      action: signal.action,
      metadata: { source: 'webhook' },
    });
  } catch {
    return { kind: 'durability_error', httpStatus: 500, code: 'receipt_persist_failed', enqueued: false };
  }

  // Non-trigger actions (applicationUpdate is redundant with stage change;
  // candidateDelete is capability-gated) are durably recorded and acked, but
  // never scheduled — reconciliation provides the safety net.
  if (!isTriggerAction(signal.action)) {
    return OK('ignored_action', receipt.status === 'inserted' ? 'recorded' : 'duplicate', false);
  }

  // A duplicate delivery is already durable — ack without duplicate queue work.
  if (receipt.status === 'duplicate') {
    return OK('duplicate', 'duplicate', false);
  }

  // Fresh stage-change trigger: schedule signal work at most once.
  if (deps.enqueuer) {
    try {
      await deps.enqueuer.enqueue({
        provider: 'ashby',
        webhookActionId: signal.webhookActionId,
        action: signal.action,
        externalApplicationId: signal.externalApplicationId,
      });
    } catch {
      return { kind: 'durability_error', httpStatus: 500, code: 'enqueue_failed', enqueued: false };
    }
    return OK('accepted', 'accepted', true);
  }

  // Durable receipt with no wired queue (disabled/foundation): still ack 2xx.
  return OK('accepted', 'accepted_no_queue', false);
}
