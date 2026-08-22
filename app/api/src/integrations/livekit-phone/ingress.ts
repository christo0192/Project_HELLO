/**
 * livekit-phone/ingress.ts — the single choke point through which every
 * LiveKit-sourced phone event reaches 0042, and the home of P1 residual R-4.
 *
 * ── ONE LEDGER, NO SECOND RECEIPT LAYER ───────────────────────────────
 * The Ashby ingress writes its own `ashby_event_receipts` row because 0029/0030
 * gave it one. The phone lane does NOT get a second one: 0042's
 * `phone_call_events` already IS the receipt table — it is insert-once, carries
 * `unique (source, provider_event_id)`, is protected by BEFORE UPDATE/DELETE
 * triggers, and `apply_phone_event` writes the verdict and the row in ONE
 * transaction. A receipt layer in front of it could only disagree with it.
 * Durability-before-2xx is therefore the RPC's own commit: a 200 is returned
 * only after the RPC has answered, and any failure to reach that answer is a
 * 500 so the provider redelivers.
 *
 * ── R-4: THE REFUSALS THAT WRITE NO ROW ───────────────────────────────
 * `apply_phone_event` answers five statuses BEFORE its INSERT —
 * `attempt_required`, `invalid_source`, `invalid_event_type`,
 * `provider_event_id_required`, `invalid_provider_event_id`. That is
 * deliberate (a malformed call is not an event that happened, and recording it
 * would let an engagement-scoped post drive an attempt-scoped edge — the exact
 * half-applied transition 0042's guard exists to prevent). The consequence is
 * that `phone_backlog` CANNOT see them: it counts ledger rows, and there is no
 * row. A persistently malformed poster would be invisible.
 *
 * So the count lives HERE, at the choke point every poster must pass, and the
 * route emits it on every such response. It is deliberately NOT a second write
 * to the database: R-4's whole point is that no partial engagement write may
 * happen, and a counter that wrote a row would reintroduce exactly that.
 *
 * Nothing this route can send produces `attempt_required` — a resolved
 * participant identity always yields an attempt id — but the counter is not
 * scoped to this route. It covers the shared entry point, and the
 * reconciliation module posts through it too.
 */

import type { ApplyPhoneEventResult, PhoneStores } from '../../lib/phone-screening/index.js';
import { resolvePhoneEvent, type LiveKitPhoneEnvelope } from './events.js';

/**
 * The `apply_phone_event` statuses that write NO ledger row. Every other
 * status has a durable row behind it by the time the RPC returns.
 */
export const PHONE_UNRECORDED_STATUSES = [
  'attempt_required',
  'invalid_source',
  'invalid_event_type',
  'provider_event_id_required',
  'invalid_provider_event_id',
] as const;

export type PhoneUnrecordedStatus = (typeof PHONE_UNRECORDED_STATUSES)[number];

const UNRECORDED_SET: ReadonlySet<string> = new Set(PHONE_UNRECORDED_STATUSES);

/** True iff the RPC refused before writing anything. */
export function isUnrecordedStatus(status: string): status is PhoneUnrecordedStatus {
  return UNRECORDED_SET.has(status);
}

export interface PhoneIngressHealth {
  /** Count one malformed-ingress refusal. */
  record(status: PhoneUnrecordedStatus): void;
  /** Total refusals, plus a per-status breakdown. Counts only, never content. */
  snapshot(): { total: number; byStatus: Readonly<Record<string, number>> };
}

/** Build an isolated counter. Tests get their own; production shares one. */
export function createPhoneIngressHealth(): PhoneIngressHealth {
  const byStatus = new Map<string, number>();
  let total = 0;
  return {
    record(status) {
      total += 1;
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    },
    snapshot() {
      return { total, byStatus: Object.fromEntries(byStatus) };
    },
  };
}

/**
 * The process-wide counter. Exported so a later health surface can read it
 * without reaching into the router; the route also emits the running total on
 * every refusal, so the signal exists today rather than waiting for that.
 */
export const phoneIngressHealth: PhoneIngressHealth = createPhoneIngressHealth();

export type PhoneIngressCode =
  | 'applied'
  | 'duplicate'
  | 'ignored_not_phone'
  | 'unrecognized_event'
  | `ignored_${string}`
  | PhoneUnrecordedStatus
  | 'apply_unexpected_status';

export interface PhoneIngressOutcome {
  readonly httpStatus: 200 | 400 | 500;
  readonly code: PhoneIngressCode;
  /** True iff a durable ledger row exists for this delivery. */
  readonly recorded: boolean;
  /** True iff the RPC recognised this as a redelivery of an earlier event. */
  readonly duplicate: boolean;
}

export interface PhoneIngressDeps {
  readonly stores: Pick<PhoneStores, 'applyEvent'>;
  readonly health?: PhoneIngressHealth;
  /** Injected clock — the RPC is given an explicit instant, never `now()`. */
  readonly now: Date;
}

/**
 * Turn one `apply_phone_event` answer into a sanitized ingress outcome.
 *
 * 200 vs 500 is decided by ONE question: did the database reach a verdict?
 *   - applied / ignored  → a durable row exists → 200, never redeliver.
 *   - a malformed refusal → the poster is wrong, not the transport → 200,
 *     counted, never redelivered (a redelivery would be malformed again).
 *   - anything unrecognised → we do not know what happened → 500, redeliver.
 */
export function classifyApplyResult(
  result: ApplyPhoneEventResult,
  health: PhoneIngressHealth,
): PhoneIngressOutcome {
  const duplicate = result.duplicate === true;
  const status = result.status;

  if (status === 'applied' || status === 'ignored') {
    // ONE rule, no special case: if the RPC recognised a redelivery, say
    // `duplicate` — whatever the original verdict was. The alternative
    // (reporting `duplicate` for a re-applied event but `ignored_<reason>`
    // for a re-ignored one) reads as two rules, and that asymmetry is the
    // kind that later grows a bug. The original verdict is not lost: it is on
    // the ledger row, which is the durable place for it, rather than in an
    // HTTP body sent back to a provider that does not read it.
    if (duplicate) {
      return { httpStatus: 200, code: 'duplicate', recorded: true, duplicate: true };
    }
    if (status === 'applied') {
      return { httpStatus: 200, code: 'applied', recorded: true, duplicate: false };
    }
    // `ignored_reason` is a closed 0042 vocabulary — stale_epoch,
    // unknown_attempt, terminal, unexpected_event — so the code stays a
    // stable, sanitized token in every case.
    const reason = typeof result.ignoredReason === 'string' ? result.ignoredReason : 'unspecified';
    return { httpStatus: 200, code: `ignored_${reason}`, recorded: true, duplicate: false };
  }
  if (isUnrecordedStatus(status)) {
    health.record(status);
    return { httpStatus: 200, code: status, recorded: false, duplicate: false };
  }
  // `unknown_status` from the port's narrowing, or anything a future migration
  // adds. We cannot claim durability we did not observe.
  return { httpStatus: 500, code: 'apply_unexpected_status', recorded: false, duplicate: false };
}

/**
 * Ingest one VERIFIED LiveKit envelope.
 *
 * The caller has already proven the bytes were signed; this decides what they
 * mean. A throw propagates: the route turns it into a retryable 500.
 */
export async function ingestPhoneWebhook(
  envelope: LiveKitPhoneEnvelope,
  deps: PhoneIngressDeps,
): Promise<PhoneIngressOutcome> {
  const health = deps.health ?? phoneIngressHealth;
  const resolution = resolvePhoneEvent(envelope);

  if (resolution.kind === 'not_livekit_event') {
    // Signed by our own key pair, yet not a name this SDK produces. Retrying
    // cannot fix it, so it is non-retryable and loud.
    return { httpStatus: 400, code: 'unrecognized_event', recorded: false, duplicate: false };
  }
  if (resolution.kind === 'not_phone_event') {
    // A real LiveKit event for some other room — a browser interview session,
    // an egress, a track. Accepted, ZERO database work, never recorded.
    return { httpStatus: 200, code: 'ignored_not_phone', recorded: false, duplicate: false };
  }

  const result = await deps.stores.applyEvent({
    source: 'livekit_webhook',
    eventType: resolution.eventType,
    attemptId: resolution.attemptId,
    providerEventId: resolution.providerEventId,
    epoch: resolution.epoch,
    // The ONLY metadata is the LiveKit event name. No timestamp (0042 rejects
    // any string containing seven consecutive digits), no room, no attributes,
    // no provider envelope.
    metadata: { lk_event: resolution.event },
    now: deps.now,
  });

  return classifyApplyResult(result, health);
}
