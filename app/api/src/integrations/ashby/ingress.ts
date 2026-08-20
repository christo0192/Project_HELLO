/**
 * ashby/ingress.ts — durable webhook ingress via the transactional outbox.
 *
 * Runs AFTER the route has verified the HMAC signature over the raw bytes and
 * parsed the JSON. Given the parsed body it:
 *   0. acknowledges Ashby's signed, idless configuration `ping` without DB work;
 *   1. extracts a sanitized signal (action + dedup identity + opaque ids);
 *   2. for the stage-change trigger, atomically records the receipt AND ensures
 *      exactly one live signal job (transactional outbox — a single RPC), so a
 *      durably-recorded trigger is always durably queued (no strand gap);
 *   3. for non-trigger actions, records the receipt only (no queue work).
 *
 * The outbox RE-DRIVES a missing enqueue: a duplicate delivery whose signal was
 * never queued (or whose job was lost) re-inserts one job, and the route acks
 * 2xx ONLY when durable processing work exists (`workPending`). This closes the
 * receipt-then-enqueue gap and guarantees at-least-once processing while
 * converging to exactly one scheduled import.
 *
 * Outcome → HTTP mapping (applied by the route):
 *   accepted / duplicate → 200 (durable; work pending)
 *   ignored_action       → 200 (durable non-trigger receipt, or storage-free signed ping)
 *   unrecognized         → 400 (signed but unparseable/idless — Ashby won't storm)
 *   durability_error     → 500 (retryable; receipt/enqueue not durable)
 *
 * SECURITY: only a sanitized `{ source }` marker is stored as receipt metadata —
 * never the body, contact data, or ids-as-content. Ping stores nothing. The raw
 * body/signature/secret never reach this layer.
 */

import {
  extractWebhookSignal,
  CANDIDATE_STAGE_CHANGE_ACTION,
  type WebhookSignal,
} from './extractors.js';
import { buildSignalEnqueueSpec } from './signal-worker.js';
import type { ReceiptStore } from './ports.js';

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
  /** Whether a queue job was inserted on this call. */
  enqueued: boolean;
}

export interface IngressDeps {
  /** Transactional-outbox receipt store (receipt + signal job in one tx). */
  receipts: ReceiptStore;
}

/** The only action that triggers downstream signal processing. */
export function isTriggerAction(action: string): boolean {
  return action === CANDIDATE_STAGE_CHANGE_ACTION;
}

/**
 * Ashby's create/edit liveness probe has no `webhookActionId` by contract:
 * `{ action: "ping", data: { webhookActionType: "ping" } }`. It must receive
 * 200 or Ashby leaves the webhook disabled. Signature verification has already
 * happened in the route; this exact shape performs no persistence or queueing.
 */
export function isAshbyPing(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const root = parsed as Record<string, unknown>;
  if (root.action !== 'ping') return false;
  // Ashby has emitted both a bare ping and a ping carrying
  // data.webhookActionType. The request has already passed HMAC verification;
  // acknowledging either signed liveness form performs no persistence or work.
  return root.action === 'ping';
}

/**
 * Durably ingest one verified, parsed webhook. Throws are converted to a
 * retryable `durability_error` so the route returns a 5xx and Ashby retries.
 */
export async function ingestWebhook(parsed: unknown, deps: IngressDeps): Promise<IngressOutcome> {
  // Provider liveness handshake: signed by the route, exact official shape,
  // deliberately storage-free because Ashby supplies no stable event id.
  if (isAshbyPing(parsed)) {
    return { kind: 'ignored_action', httpStatus: 200, code: 'ping', enqueued: false };
  }

  const extracted = extractWebhookSignal(parsed);
  if (!extracted.ok) {
    // Signed but structurally unusable: acknowledge as a non-retryable 400 so
    // Ashby does not retry-storm on a payload we can never process.
    return { kind: 'unrecognized', httpStatus: 400, code: extracted.reason, enqueued: false };
  }
  const signal: WebhookSignal = extracted.signal;

  // Non-trigger actions (applicationUpdate is redundant with stage change;
  // candidateDelete is capability-gated in the worker) are durably recorded and
  // acked, but never scheduled — reconciliation provides the safety net.
  if (!isTriggerAction(signal.action)) {
    try {
      const r = await deps.receipts.record({
        webhookActionId: signal.webhookActionId,
        action: signal.action,
        metadata: { source: 'webhook' },
      });
      return {
        kind: 'ignored_action',
        httpStatus: 200,
        code: r.status === 'inserted' ? 'recorded' : 'duplicate',
        enqueued: false,
      };
    } catch {
      return { kind: 'durability_error', httpStatus: 500, code: 'receipt_persist_failed', enqueued: false };
    }
  }

  // Stage-change trigger: atomic receipt + signal enqueue (single transaction),
  // re-driving a missing enqueue on a duplicate delivery.
  let r;
  try {
    r = await deps.receipts.record({
      webhookActionId: signal.webhookActionId,
      action: signal.action,
      metadata: { source: 'webhook' },
      enqueue: buildSignalEnqueueSpec(signal),
    });
  } catch {
    return { kind: 'durability_error', httpStatus: 500, code: 'receipt_persist_failed', enqueued: false };
  }

  // Ack 2xx ONLY when durable processing work exists after the call. If the
  // outbox could not establish durable work, force a retryable 5xx.
  if (!r.workPending) {
    return { kind: 'durability_error', httpStatus: 500, code: 'enqueue_incomplete', enqueued: false };
  }

  if (r.status === 'inserted') {
    return { kind: 'accepted', httpStatus: 200, code: 'accepted', enqueued: r.enqueued };
  }
  // Duplicate delivery: durable work already existed, or was re-driven now.
  return {
    kind: 'duplicate',
    httpStatus: 200,
    code: r.enqueued ? 'duplicate_redriven' : 'duplicate',
    enqueued: r.enqueued,
  };
}
