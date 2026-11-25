/**
 * The `r1-meet` dispatcher (M034 S06, dark; D-S06-4..6, D-S06-33): the ONE queue handler of the Meet
 * runtime. Every job of the `r1-meet` queue carries a `kind`; this module looks the kind up in a frozen
 * registry of definitions (`{ kind, parse, run }`, one per kind, exported by the kind files) and runs it.
 *
 * THE S09 SEAM. The registry is built from a list (`R1_MEET_DEFINITIONS`); a kind may appear once only,
 * and a duplicate throws at construction, so a second definition can never silently shadow the first.
 * S09 registers its `scorecard_feedback` definition (`feedback.ts`) LAST in that list, and nothing else.
 *
 * CLOSED FAILURES (D-S06-5). A payload whose kind this build does not know throws `r1_meet_unknown_kind`
 * (a kind a rolling deploy has not shipped yet survives a few retries), and one its parser refuses
 * throws `r1_meet_malformed_payload`; both also alert. Any throw is a lease failure: bounded retries,
 * then the dead-letter queue under that closed code. A throw that is not an `R1MeetJobError` (a bug) is
 * rethrown as `r1_meet_unexpected_error`, so no driver or vendor text ever reaches `job_queue`.
 *
 * RECEIPTS (D-S06-6). A job that carries `receipt_id` (the webhook receivers' jobs) ends with one
 * compare-and-set of that receipt: `processed` or `ignored` when it is done, `failed` on the FINAL
 * attempt of a throwing job. Best effort: a failed update logs `r1_meet_receipt_finish_failed` and never
 * fails the job (a re-driven job is idempotent). A deferral leaves the receipt alone.
 *
 * MEET TURNED OFF MID-FLIGHT. The lane stops claiming as soon as Meet is inactive, but a job claimed a
 * moment before runs here: it is deferred (`r1_meet_inactive`, the attempt refunded) before anything is
 * read, so nothing is created, armed or released while Meet is off. The drain owns that state.
 *
 * LOGS. One info line per job, `{ error_category: 'r1_meet_job', error_type: '<kind>:<code>' }`, where
 * the kind is a registered one (else `unknown`) and the code a closed word. Never an id, a URL or a name.
 */

import type { QueueHandlerResult } from '../../queue/runner.js';
import type { QueueJob } from '../../queue/types.js';
import { r1MeetDrainDefinition } from './drain.js';
import { R1_MEET_EVENT_DEFINITIONS } from './event-handler.js';
import { r1MeetScorecardFeedbackDefinition } from './feedback.js';
import {
  R1MeetJobError,
  R1_MEET_MALFORMED_PAYLOAD,
  R1_MEET_UNKNOWN_KIND,
  r1MeetJobMeta,
  r1MeetPayloadKind,
  r1MeetReceiptId,
  type R1MeetJobResult,
} from './jobs.js';
import { r1MeetMaintenanceDefinition } from './maintenance.js';
import { R1_MEET_ALERTS, type R1MeetFlowDeps, type R1MeetJobDefinition } from './recall-actions.js';
import type { R1MeetReceiptFinal } from './runtime-store.js';
import { R1_MEET_SCHEDULE_DEFINITIONS } from './schedule-handler.js';

/** Every kind this build handles, one definition each; S09's `scorecard_feedback` is last. Frozen. */
export const R1_MEET_DEFINITIONS: readonly R1MeetJobDefinition[] = Object.freeze([
  ...R1_MEET_SCHEDULE_DEFINITIONS,
  ...R1_MEET_EVENT_DEFINITIONS,
  r1MeetMaintenanceDefinition as R1MeetJobDefinition,
  r1MeetDrainDefinition as R1MeetJobDefinition,
  r1MeetScorecardFeedbackDefinition as R1MeetJobDefinition,
]);

/** The deferral of a job claimed just before Meet turned off. */
export const R1_MEET_INACTIVE = 'r1_meet_inactive';
export const R1_MEET_INACTIVE_DEFER_SEC = 60;
/** What a throw that is not an `R1MeetJobError` becomes. */
export const R1_MEET_UNEXPECTED_ERROR = 'r1_meet_unexpected_error';
/** The category of the one line per job. */
export const R1_MEET_JOB_LOG = 'r1_meet_job';

/** The `kind` rule of `r1_meet_record_receipt` (0142). */
const KIND = /^[a-z][a-z0-9_]{0,39}$/;

export interface R1MeetDispatcherDeps {
  /** The registry. Default: `R1_MEET_DEFINITIONS`. */
  readonly definitions?: readonly R1MeetJobDefinition[];
  /** The ports a job runs with; asked once per job (after the active check). */
  readonly flowDeps: () => R1MeetFlowDeps;
  /** Is Meet still active? Asked first, per job. A throw counts as no. */
  readonly active: () => boolean;
}

export interface R1MeetDispatcher {
  /** The registered kinds, in registration order. Frozen. */
  readonly kinds: readonly string[];
  /** The queue handler (`createQueueRunner`): void = complete, a directive = defer, a throw = fail. */
  handle(job: QueueJob<unknown>): Promise<QueueHandlerResult>;
}

export function createR1MeetDispatcher(deps: R1MeetDispatcherDeps): R1MeetDispatcher {
  const registry = new Map<string, R1MeetJobDefinition>();
  for (const definition of deps.definitions ?? R1_MEET_DEFINITIONS) {
    if (typeof definition.kind !== 'string' || !KIND.test(definition.kind)) throw new Error('r1_meet_invalid_kind');
    // The one-definition rule: a second definition of a kind is a build error, never a shadow.
    if (registry.has(definition.kind)) throw new Error('r1_meet_duplicate_kind');
    registry.set(definition.kind, definition);
  }
  const kinds = Object.freeze([...registry.keys()]);

  const isActive = (): boolean => {
    try {
      return deps.active() === true;
    } catch {
      return false;
    }
  };

  async function finishReceipt(flow: R1MeetFlowDeps, receiptId: string | null, outcome: R1MeetReceiptFinal): Promise<void> {
    if (receiptId === null) return;
    try {
      await flow.store.finishReceipt(receiptId, outcome, new Date(flow.now()).toISOString());
    } catch {
      flow.log.warn({ error_category: 'r1_meet_receipt_finish_failed' });
    }
  }

  async function handle(job: QueueJob<unknown>): Promise<QueueHandlerResult> {
    const named = r1MeetPayloadKind(job.payload);
    const definition = named === null ? undefined : registry.get(named);
    // Only a registered kind reaches a log line: an unknown one could be any text.
    const kind = definition?.kind ?? 'unknown';

    if (!isActive()) {
      deps.flowDeps().log.info({ error_category: R1_MEET_JOB_LOG, error_type: `${kind}:${R1_MEET_INACTIVE}` });
      return { outcome: 'defer', reasonCode: R1_MEET_INACTIVE, delaySeconds: R1_MEET_INACTIVE_DEFER_SEC };
    }

    const flow = deps.flowDeps();
    const meta = r1MeetJobMeta(job);
    const receiptId = r1MeetReceiptId(job.payload);
    let result: R1MeetJobResult;
    try {
      if (definition === undefined) {
        flow.log.error({ error_category: R1_MEET_ALERTS.unknownKind });
        throw new R1MeetJobError(R1_MEET_UNKNOWN_KIND);
      }
      const parsed = definition.parse(job.payload);
      if (parsed === null) {
        flow.log.error({ error_category: R1_MEET_ALERTS.malformedPayload, error_type: kind });
        throw new R1MeetJobError(R1_MEET_MALFORMED_PAYLOAD);
      }
      result = await definition.run(flow, parsed, meta);
    } catch (error) {
      const failure = error instanceof R1MeetJobError ? error : new R1MeetJobError(R1_MEET_UNEXPECTED_ERROR);
      flow.log.info({ error_category: R1_MEET_JOB_LOG, error_type: `${kind}:${failure.code}` });
      if (meta.finalAttempt) {
        flow.log.error({ error_category: R1_MEET_ALERTS.jobFailed, error_type: `${kind}:${failure.code}` });
        await finishReceipt(flow, receiptId, 'failed');
      }
      throw failure;
    }

    flow.log.info({ error_category: R1_MEET_JOB_LOG, error_type: `${kind}:${result.code}` });
    if (result.outcome === 'defer') {
      return { outcome: 'defer', reasonCode: result.code, delaySeconds: result.delaySeconds };
    }
    await finishReceipt(flow, receiptId, result.receipt);
    return undefined;
  }

  return Object.freeze({ kinds, handle });
}
