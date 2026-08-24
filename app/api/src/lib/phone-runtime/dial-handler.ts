/**
 * lib/phone-runtime/dial-handler.ts — the `phone.dial` queue handler.
 *
 * ── IT DOES NOT DIAL, AND THAT IS THE DESIGN ──────────────────────────
 * This is the surprising part of the phase, so it is stated first and in full.
 *
 * `admit_phone_attempt` enqueues a `phone.dial` job INSIDE the transaction
 * that creates the attempt, moves the engagement to `dialing` and takes the
 * fleet slot. That is what makes the work durable: an admission that cannot
 * schedule work raises `phone_dial_enqueue_failed` and rolls the whole thing
 * back, so `dialing` never exists without a queue row.
 *
 * But admission is not reached on its own — it is reached THROUGH
 * `dialPhoneAttempt`, the P4a controller, which admits and then originates in
 * the same call. By the time this job can be claimed, the originate for its
 * attempt has already been placed, or the process that would have placed it is
 * gone.
 *
 * So there are exactly two states this handler can find, and the right action
 * is the same in both:
 *
 *   1. The dial was placed. The attempt is live or has already ended. Nothing
 *      is owed; the job is a spent durability record.
 *   2. The process died between the admission commit and the originate. The
 *      attempt is live and no call is in flight.
 *
 * In case 2 the temptation is to dial from here. That temptation is the one
 * thing this file exists to refuse. This handler cannot tell case 2 from case
 * 1 — a job claimed while an originate is still in flight looks identical to a
 * job claimed after the process that owned it died — so a handler that dialled
 * would place a SECOND call to a candidate whose first call is ringing. On a
 * lane whose per-IST-day index exists to stop exactly that, a maybe-duplicate
 * is not an acceptable trade for a faster retry.
 *
 * Case 2 is already recovered, by machinery that has been reviewed and that
 * charges nothing: the attempt's concurrency lease lapses,
 * `reclaim_phone_attempt_leases` marks the attempt `abandoned`, restores the
 * engagement to `prior_engagement_state` (transition #30) and completes the
 * job it can still reach — and the due pass offers the engagement again. The
 * candidate loses no budget, because a dead worker is our failure and 0042
 * says so in as many words.
 *
 * ── SO WHAT IS THE HANDLER FOR? ───────────────────────────────────────
 * Draining the queue. Without it every admission leaves a `pending` row that
 * nothing ever completes: `uq_job_queue_dedup_active` covers `pending`, and
 * `reclaim_phone_attempt_leases` only completes jobs for attempts IT reclaims,
 * so a normally-ended attempt's job would sit in the queue forever and the
 * backlog would grow one row per call placed.
 *
 * ── IT DELIBERATELY READS NOTHING ─────────────────────────────────────
 * An earlier draft read the attempt's state to label the outcome. It was
 * removed: the action is identical either way, and a read that cannot change
 * an outcome is a read that a later editor will mistake for a gate.
 */

import type { QueueJob } from '../queue/types.js';

/** The payload `admit_phone_attempt` writes. camelCase, and opaque. */
export interface PhoneDialJobPayload {
  readonly provider?: unknown;
  readonly attemptId?: unknown;
}

export const PHONE_DIAL_JOB_OUTCOMES = ['completed', 'malformed_payload'] as const;

export type PhoneDialJobOutcome = (typeof PHONE_DIAL_JOB_OUTCOMES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when the payload is the shape 0042 writes.
 *
 * A malformed payload is still COMPLETED, not failed. 0040 recorded the trap
 * this avoids: a payload the handler cannot read is not a transient fault, so
 * retrying it to `max_attempts` only converts one bad row into dead-letter
 * noise. The count is what an operator needs, and the count is what they get.
 */
export function isPhoneDialPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const p = payload as PhoneDialJobPayload;
  return p.provider === 'phone' && typeof p.attemptId === 'string' && UUID_RE.test(p.attemptId);
}

export interface PhoneDialHandlerDeps {
  /** Counts outcomes for the health surface. Never receives a payload. */
  readonly onOutcome?: (outcome: PhoneDialJobOutcome) => void;
}

/**
 * Returns a handler for `createQueueRunner`. Resolving normally makes the
 * runner call `completeClaim`, which is the whole contract: never throw, so
 * the job is never failed and never retried.
 */
export function createPhoneDialHandler(
  deps: PhoneDialHandlerDeps = {},
): (job: QueueJob<unknown>) => Promise<void> {
  return async (job: QueueJob<unknown>): Promise<void> => {
    const outcome: PhoneDialJobOutcome = isPhoneDialPayload(job.payload)
      ? 'completed'
      : 'malformed_payload';
    // The sink is caller-supplied, so it is caller-fallible. Letting it throw
    // would reject the handler, and a rejected handler is exactly what this
    // file exists to prevent: the runner would FAIL the job and retry it. A
    // broken metrics counter must not become a redialled candidate.
    try {
      deps.onOutcome?.(outcome);
    } catch {
      // Deliberately swallowed, and deliberately not logged: this seam has no
      // logger by design (`phone-runtime-structural` enforces that), and the
      // error object could carry whatever the sink was holding.
    }
    // Resolve. The runner completes the claim; nothing here can fail a job.
  };
}
