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
 * fix it and the DLQ row is the operator alert.
 *
 * THE WAIT IS BOUNDED, per kind of failure, from the job's own queue columns (`job_queue` keeps
 * no per-code count):
 *   - a deferral STREAK older than `R1_PROVIDER_DEFER_MAX_MS` is not extended (any code);
 *   - a job that has deferred `R1_PROVIDER_DEFER_MAX_COUNT` times in total (the count survives
 *     `fail_job`, which resets the streak start) defers no more provider failures;
 *   - a TIMEOUT stops deferring after `R1_TIMEOUT_DEFER_MAX_COUNT` deferrals, far earlier. A
 *     timeout is a full billed `high`-reasoning call of 300 s, and a transcript too long for one
 *     call times out EVERY time, so waiting cannot fix it and each cycle costs real money;
 *   - the breaker's REFUSAL (`provider_circuit_open`) is different in kind: it is not a provider
 *     failure but R1 declining to call, so it makes no call and bills nothing, and the caps do
 *     not stop it, only the streak bound does. (Each refusal is still a deferral, so it adds to
 *     `defer_count` like any other and uses up the budget the real failures are measured
 *     against.) See below for why it must be so.
 * Past a bound the failure takes the normal retry, placeholder and DLQ path.
 *
 * WHY A REFUSAL STAYS DEFERRABLE PAST THE CAP. By the time a cap is reached every deferral cycle
 * has been a failing half-open probe, so the breaker is OPEN. If the refusal were terminal, the
 * five attempts after the cap would arrive seconds apart (retry backoff 1-16 s, poll 5 s), all
 * inside the 60 s cooldown: the first probe's REAL failure would be followed by four refusals, and
 * the job would dead-letter as `provider_circuit_open`, a side effect that names no cause, with a
 * placeholder carrying the same wrong code (the RCA for owner test b58c7d9c complained about
 * exactly this). Deferring the refusal for the cooldown makes every counted attempt after the cap a
 * real probe, so the DLQ row and the placeholder carry the provider's real code (429, 5xx,
 * timeout, ...), and the job still ends within five probes, about 5 x 70 s after the cap. The
 * refusal can never loop on its own: after the cooldown the next claim IS a probe, and a probe
 * either succeeds or fails with a real, counted code.
 *
 * NO PLACEHOLDER FOR A JOB THAT DEFERS. The service records its `scoring_failed`
 * `human_review` placeholder only when the job is really ending. The handler therefore tells it
 * (`willDefer`) whether this failure will be deferred, from the SAME snapshot of the deferral
 * budget that then decides the deferral, so the two cannot disagree.
 *
 * ...UNLESS THE DEFERRAL DOES NOT LAND. The runner commits a deferral AFTER the handler returns
 * (`deferClaim`). On the final attempt a deferral whose commit throws (a database blip) or finds
 * the lease gone leaves the job `active` with attempts == max, and `reclaim_expired_jobs`
 * dead-letters it as `lease_expired_attempts_exhausted` with nothing for HR to see. The handler
 * therefore reports every FINAL-attempt deferral (`onFinalDeferral`), and the R1 runtime's queue
 * guard (`createR1FinalDeferralGuard`) records the placeholder when the commit does not land.
 */

import type { QueueHandler, QueueHandlerResult, QueueRunnerOptions } from '../queue/runner.js';
import type { ClaimOptions, DeferOutcome, QueueJob } from '../queue/types.js';
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
 * The most deferrals one job may take over its whole life for a provider FAILURE.
 * `job_queue.defer_count` is monotonic (a counted failure resets the streak start, not this
 * count), so this is what bounds the total wait across streaks. 30 deferrals are about 33 minutes
 * of pure breaker waiting at `R1_PROVIDER_DEFER_SECONDS`. After it the job fails normally and
 * dead-letters for an operator to replay (see the runbook).
 */
export const R1_PROVIDER_DEFER_MAX_COUNT = 30;
/**
 * The most deferrals a job may have taken for a TIMEOUT to still be deferred. Timeouts are the
 * one billed failure (a full 300 s reasoning call) and usually deterministic (a transcript too
 * long for one call), so they get a much smaller budget than a 429 or a 5xx, which fail
 * instantly and cost nothing. A job that exhausts it takes its remaining attempts as ordinary
 * failures: a transcript that times out every time makes 8 calls (3 deferred, then the 5 attempts
 * the job is allowed) instead of 31.
 */
export const R1_TIMEOUT_DEFER_MAX_COUNT = 3;

/** The code for "R1's own breaker declined to call". Not a provider failure, see the header. */
export const R1_BREAKER_REFUSAL_CODE = 'provider_circuit_open';
/** The deferrable codes that stand for a billed call that ran out its timeout. */
export const R1_TIMEOUT_CODES: ReadonlySet<string> = new Set(['deepseek_timeout', 'provider_timeout']);

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
  R1_BREAKER_REFUSAL_CODE,
]);

/**
 * ONE snapshot of a job's deferral budget, as a predicate over the failure's stable code. The
 * service asks it (`willDefer`, to skip the placeholder) and the handler decides the deferral
 * from the same answer, so the two cannot disagree.
 */
function deferralPolicy(job: QueueJob<unknown>, nowMs: number): (code: string) => boolean {
  const count = typeof job.deferCount === 'number' ? job.deferCount : null;
  const since = job.deferredAt ? Date.parse(job.deferredAt) : Number.NaN;
  const streakOpen = !job.deferredAt
    || !Number.isFinite(since)
    || nowMs - since < R1_PROVIDER_DEFER_MAX_MS;
  return (code: string): boolean => {
    if (!R1_DEFERRABLE_CODES.has(code) || !streakOpen) return false;
    // The breaker declining to call is free: no call, no bill. The streak bound above is its only
    // bound, and the real probe that follows each refusal is what ends the job.
    if (code === R1_BREAKER_REFUSAL_CODE) return true;
    // A count that was never reported (an older row shape) defers, within its streak.
    if (count === null) return true;
    if (count >= R1_PROVIDER_DEFER_MAX_COUNT) return false;
    return !(R1_TIMEOUT_CODES.has(code) && count >= R1_TIMEOUT_DEFER_MAX_COUNT);
  };
}

function payloadSessionId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>).session_id;
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

/** A failure the handler returned as a deferral on the FINAL attempt, until the runner commits it. */
export interface R1FinalDeferral {
  readonly sessionId: string;
  /** The stable `r1ErrorCode` of the failure. */
  readonly code: string;
}

export interface R1AssessmentHandlerOptions {
  readonly client?: R1DbClient;
  /** Test seam; defaults to the real service. */
  readonly run?: (sessionId: string, options: R1AssessmentOptions) => Promise<R1AssessmentResult>;
  readonly infer?: R1AssessmentOptions['infer'];
  readonly onResult?: (result: R1AssessmentResult) => void;
  /** Test seam: the clock the deferral budget is measured against (epoch ms). */
  readonly now?: () => number;
  /**
   * Called just before the handler returns a deferral on the FINAL attempt (no placeholder was
   * written for it). The runtime hands it to `createR1FinalDeferralGuard`.
   */
  readonly onFinalDeferral?: (jobId: string, deferral: R1FinalDeferral) => void;
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
    const willDefer = deferralPolicy(job, clock());
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
        if (finalAttempt) options.onFinalDeferral?.(job.id, { sessionId, code });
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

/** The queue the runner is built on (the five methods it calls). */
export type R1RunnerQueue = QueueRunnerOptions['queue'];

export interface R1FinalDeferralGuard {
  /** The handler's `onFinalDeferral`. */
  note(jobId: string, deferral: R1FinalDeferral): void;
  /** The queue to hand the runner: `queue` itself, plus the fallback below on `deferClaim`. */
  guard(queue: R1RunnerQueue): R1RunnerQueue;
}

/**
 * The fallback for a FINAL-attempt deferral that does not land.
 *
 * On the final attempt the service writes no placeholder for a failure the handler defers (the
 * job is alive and will be scored). The runner commits that deferral after the handler returns;
 * if the commit THROWS (a database error) or answers anything but `deferred` (`not_owned`: the
 * lease is gone), the job stays `active` with attempts == max, its lease expires, and
 * `reclaim_expired_jobs` dead-letters it as `lease_expired_attempts_exhausted`. HR would be left
 * with no outcome at all, which the placeholder exists to prevent. So `record` writes it then.
 *
 * `record` is best effort and must not throw (a database that rejected the deferral may reject
 * this too; the lease expiry is then the same as before this guard). The shared runner and queue
 * are untouched: only the five methods R1 passes the runner are wrapped, and only `deferClaim`
 * does anything. One ambiguity is accepted: a `deferClaim` that threw AFTER its write landed (a
 * lost response) leaves the job deferred AND a placeholder behind. That placeholder is harmless
 * and temporary: the job is scored later, and a scored run supersedes a placeholder as the next
 * assessment revision.
 */
export function createR1FinalDeferralGuard(
  record: (deferral: R1FinalDeferral) => Promise<void>,
): R1FinalDeferralGuard {
  const pending = new Map<string, R1FinalDeferral>();
  const recordSafely = async (deferral: R1FinalDeferral): Promise<void> => {
    try {
      await record(deferral);
    } catch {
      /* best effort: see above */
    }
  };
  return {
    note(jobId: string, deferral: R1FinalDeferral): void {
      pending.set(jobId, deferral);
    },
    guard(queue: R1RunnerQueue): R1RunnerQueue {
      return {
        claim: <T = unknown>(name: string, claimOptions?: ClaimOptions) => queue.claim<T>(name, claimOptions),
        completeClaim: (jobId, leaseToken) => queue.completeClaim(jobId, leaseToken),
        failClaim: (jobId, leaseToken, error) => queue.failClaim(jobId, leaseToken, error),
        heartbeat: (jobId, leaseToken, heartbeatOptions) => queue.heartbeat(jobId, leaseToken, heartbeatOptions),
        deferClaim: async (jobId, leaseToken, reasonCode, delaySeconds): Promise<DeferOutcome> => {
          const deferral = pending.get(jobId);
          pending.delete(jobId);
          let outcome: DeferOutcome;
          try {
            outcome = await queue.deferClaim(jobId, leaseToken, reasonCode, delaySeconds);
          } catch (error) {
            if (deferral) await recordSafely(deferral);
            throw error;
          }
          if (deferral && outcome !== 'deferred') await recordSafely(deferral);
          return outcome;
        },
      };
    },
  };
}
