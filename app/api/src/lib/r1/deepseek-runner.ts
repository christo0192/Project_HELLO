/**
 * The R1 scorer's OWN DeepSeek runner and circuit breaker (plan 6.3).
 *
 * The default exports of `deepseek.ts` (`runDeepseek*`, re-exported by `claude.ts`) share ONE
 * circuit breaker with resume parsing and phone scoring in the process that also serves the
 * phone worker (hazard documented at app.ts). R1 therefore never calls them: it builds its
 * own runner around its own `CircuitBreaker`, so R1 provider failures can open R1's breaker
 * and nothing else's. `r1-scorer-isolation.test.ts` drives R1 failures past the threshold
 * and asserts the default breaker stays CLOSED, and greps the R1 sources for the defaults.
 *
 * The scoring model and reasoning effort are the same as the phone scorer's
 * (`DEEPSEEK_SCORING_MODEL`, V4-Pro; `DEEPSEEK_REASONING_EFFORT`), so R1 adds no environment
 * variable. The per-call timeout is an R1 constant, at most the shared 300 s ceiling.
 */

import { env, DEEPSEEK_TIMEOUT_CEILING_MS } from '../env.js';
import {
  createDeepseekRunner,
  type DeepseekRunner,
  type DeepseekRunnerDeps,
} from '../deepseek.js';
import { CircuitBreaker } from '../provider-resilience.js';

/**
 * Per-call timeout. Three runs go in parallel, each with at most one repair, and the shared
 * JSON helper may re-ask once on unparsable output, so a job is bounded by 4 calls of this
 * length: 4 x 180 s = 720 s, inside the 900 s maximum queue lease the runtime heartbeats.
 */
export const R1_SCORER_TIMEOUT_MS = 180_000;

/** Two fully failed jobs (3 runs each) open the R1 breaker; it half-opens after a minute. */
export const R1_BREAKER_FAILURE_THRESHOLD = 6;
export const R1_BREAKER_COOLDOWN_MS = 60_000;

if (R1_SCORER_TIMEOUT_MS > DEEPSEEK_TIMEOUT_CEILING_MS) {
  throw new Error('R1_SCORER_TIMEOUT_MS exceeds the shared DeepSeek ceiling');
}

/** Build an R1-only runner. `deps.breaker` defaults to a FRESH R1 breaker, never the shared one. */
export function createR1DeepseekRunner(deps: Partial<DeepseekRunnerDeps> = {}): DeepseekRunner {
  const breaker = deps.breaker ?? new CircuitBreaker({
    failureThreshold: R1_BREAKER_FAILURE_THRESHOLD,
    cooldownMs: R1_BREAKER_COOLDOWN_MS,
  });
  return createDeepseekRunner({ ...deps, breaker });
}

let sharedR1Runner: DeepseekRunner | null = null;

/** The process-wide R1 runner, created lazily so importing this module has no effect. */
export function getR1DeepseekRunner(): DeepseekRunner {
  if (sharedR1Runner === null) sharedR1Runner = createR1DeepseekRunner();
  return sharedR1Runner;
}

/** Test seam: drop the cached runner so the next call builds a fresh breaker. */
export function resetR1DeepseekRunnerForTests(): void {
  sharedR1Runner = null;
}

/** The scoring model R1 requests, recorded in provenance as the design-intent model. */
export function r1ScoringModel(): string {
  return env.deepseekScoringModel;
}

/** The `infer` boundary the scorer expects: one JSON answer per prompt, through the R1 breaker. */
export function createR1Infer(
  runner: DeepseekRunner = getR1DeepseekRunner(),
): (prompt: string) => Promise<unknown> {
  return async (prompt: string): Promise<unknown> => {
    const { data } = await runner.runDeepseekJSONWithProvenance<unknown>(prompt, {
      model: r1ScoringModel(),
      timeoutMs: R1_SCORER_TIMEOUT_MS,
    });
    return data;
  };
}
