/**
 * Durable handler for the `r1.assessment` queue (plan 6.7).
 *
 * The 0116 trigger `enqueue_r1_assessment` enqueues `{session_id}` with dedup key
 * `r1.assessment:<session_id>` and `max_attempts = 5` when an R1 session completes. This
 * handler scores it through `services/r1-assessment.ts`.
 *
 * It is registered ONLY in the R1 queue runtime (`runtime.ts`), never in the phone runtime
 * (handlers `{phone.dial, phone.assessment}`) or the recording runtime.
 *
 * RETRY AND DLQ. A throwing handler fails the job under its lease (bounded retry with
 * backoff); the stable code becomes `job_queue.error_message` and, after the last attempt,
 * the DLQ row that `v_funnel_failures` surfaces as `r1:<code>` (migration 0122). On the FINAL
 * attempt the service first records a `human_review` placeholder so the candidate is never
 * left without a visible outcome, then rethrows.
 *
 * PROVIDER OUTAGES DEFER. A DeepSeek timeout, a connection failure, a 429, a 5xx or R1's own
 * open circuit breaker says the PROVIDER is unavailable, not that this job is bad. Failing
 * five times inside the breaker's cooldown would dead-letter a recoverable blip within
 * seconds and cost a manual replay, so the handler returns a deferral instead: the runner
 * returns the job to `delayed` behind the breaker cooldown and REFUNDS the attempt. The set of
 * codes that may defer is EXPLICIT (`R1_DEFERRABLE_CODES`); everything else, an exhausted
 * balance (402) and a rejected key (401/403) included, fails normally because waiting cannot
 * fix it and the DLQ row is the operator alert. The wait is bounded twice: a deferral streak
 * older than `R1_PROVIDER_DEFER_MAX_MS` is not extended, and a job that has deferred
 * `R1_PROVIDER_DEFER_MAX_COUNT` times in total (the count survives `fail_job`, which resets
 * the streak start) is not deferred again. Past either bound the failure takes the normal
 * retry, placeholder and DLQ path.
 *
 * NO PLACEHOLDER FOR A JOB THAT DEFERS. The service records its `scoring_failed`
 * `human_review` placeholder only when the job is really ending. The handler therefore tells it
 * (`willDefer`) whether this failure will be deferred, from the SAME snapshot of the deferral
 * budget that then decides the deferral, so the two cannot disagree.
 */

import type { QueueHandler, QueueHandlerResult } from '../queue/runner.js';
import type { QueueJob } from '../queue/types.js';
import { R1_BREAKER_COOLDOWN_MS } from './deepseek-runner.js';
import {
  R1_CODE_RATE_LIMITED,
  R1_CODE_SERVER_ERROR,
  R1_CONSENT_WITHDRAWN_CODE,
  runR1Assessment,
  type R1AssessmentOptions,
  type R1AssessmentResult,
  type R1DbClient,
} from '../../services/r1-assessment.js';

export const R1_ASSESSMENT_QUEUE = 'r1.assessment';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sanitized deferral reason recorded on the job (`job_queue.defer_reason`). */
export const R1_PROVIDER_DEFER_REASON = 'r1_provider_unavailable';
/** Wait at least the breaker cooldown (plus a margin) so the retry meets a half-open breaker. */
export const R1_PROVIDER_DEFER_SECONDS = Math.ceil(R1_BREAKER_COOLDOWN_MS / 1000) + 5;
/** The longest uninterrupted deferral streak; past it the failure counts like any other. */
export const R1_PROVIDER_DEFER_MAX_MS = 60 * 60 * 1000;
/**
 * The most deferrals one job may take over its whole life. `job_queue.defer_count` is
 * monotonic (a counted failure resets the streak start, not this count), so this is what bounds
 * the total wait across streaks. 30 deferrals are about 33 minutes of pure breaker waiting at
 * `R1_PROVIDER_DEFER_SECONDS`; with 300 s timeouts each cycle is longer and the bound is still
 * a few hours, not the ~5 h the streak bound alone allowed. After it the job fails normally and
 * dead-letters for an operator to replay (see the runbook).
 */
export const R1_PROVIDER_DEFER_MAX_COUNT = 30;

/**
 * The `r1ErrorCode` values that mean "the provider is unavailable right now, waiting can help":
 * a DeepSeek timeout, a connection failure, a rate limit (429) or a server error (5xx), or an
 * open circuit breaker. EXPLICIT on purpose, never a prefix match. NOT here, because waiting
 * cannot fix them: `deepseek_insufficient_balance` (402), `deepseek_auth` (401/403), any other
 * `deepseek_http_<status>`, a bare `deepseek_protocol`, and a malformed or invalid answer.
 */
export const R1_DEFERRABLE_CODES: ReadonlySet<string> = new Set([
  'deepseek_timeout',
  'deepseek_connection',
  R1_CODE_RATE_LIMITED,
  R1_CODE_SERVER_ERROR,
  'provider_timeout',
  'provider_connection',
  'provider_circuit_open',
]);

function mayDefer(job: QueueJob<unknown>, nowMs: number): boolean {
  if (typeof job.deferCount === 'number' && job.deferCount >= R1_PROVIDER_DEFER_MAX_COUNT) {
    return false;
  }
  if (!job.deferredAt) return true;
  const since = Date.parse(job.deferredAt);
  return !Number.isFinite(since) || nowMs - since < R1_PROVIDER_DEFER_MAX_MS;
}

function payloadSessionId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>).session_id;
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

export interface R1AssessmentHandlerOptions {
  readonly client?: R1DbClient;
  /** Test seam; defaults to the real service. */
  readonly run?: (sessionId: string, options: R1AssessmentOptions) => Promise<R1AssessmentResult>;
  readonly infer?: R1AssessmentOptions['infer'];
  readonly onResult?: (result: R1AssessmentResult) => void;
  /** Test seam: the clock the deferral budget is measured against (epoch ms). */
  readonly now?: () => number;
}

export function createR1AssessmentHandler(
  options: R1AssessmentHandlerOptions = {},
): QueueHandler {
  const run = options.run ?? runR1Assessment;
  const clock = options.now ?? ((): number => Date.now());
  return async (job: QueueJob<unknown>): Promise<QueueHandlerResult> => {
    const sessionId = payloadSessionId(job.payload);
    if (!sessionId) throw new Error('malformed_r1_assessment_payload');
    // `attempts` counts the claim that is running now; the last allowed claim is final.
    const finalAttempt = job.attempts >= job.maxAttempts;
    // ONE snapshot of the deferral budget, taken before the work: the service asks `willDefer`
    // (to skip the placeholder) and this handler decides the deferral from the same answer.
    const deferralBudgetLeft = mayDefer(job, clock());
    const willDefer = (code: string): boolean =>
      deferralBudgetLeft && R1_DEFERRABLE_CODES.has(code);
    try {
      const result = await run(sessionId, {
        client: options.client,
        infer: options.infer,
        finalAttempt,
        willDefer,
      });
      options.onResult?.(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      // A withdrawal that landed between the settlement and this job stops all processing of the
      // interview: complete the job without scoring. Retrying it would only dead-letter a
      // correct decision as a Mission Control alert.
      if (code === R1_CONSENT_WITHDRAWN_CODE) return;
      if (willDefer(code)) {
        return {
          outcome: 'defer',
          reasonCode: R1_PROVIDER_DEFER_REASON,
          delaySeconds: R1_PROVIDER_DEFER_SECONDS,
        };
      }
      throw error;
    }
  };
}
