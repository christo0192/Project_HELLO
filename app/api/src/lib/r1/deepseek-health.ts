/**
 * R1 admission health probe for DeepSeek (plan section 4 step 7).
 *
 * Before the exchange creates a LiveKit room it asks: is the language model R1
 * depends on reachable and funded right now? If not, the candidate is told
 * "temporarily unavailable" at zero LiveKit cost and keeps a valid attempt.
 *
 * The probe is two requests sent together under ONE 3 s deadline:
 *   - `GET /user/balance`, which must report `is_available: true`;
 *   - a one-token completion on the model R1 uses (`deepseek-flash`, the alias
 *     the worker pins in r1_llm.py), thinking disabled.
 *
 * Isolation: this module has its OWN fetch and cache. It never touches the
 * shared DeepSeek runner or its circuit breaker, so an outage seen here cannot
 * open the breaker that serves resume parsing and scorecard scoring, and
 * their failures cannot make R1 look unhealthy.
 *
 * Results are cached for 60 s (a failure for 10 s, so a recovered provider is
 * noticed quickly) and concurrent probes share one in-flight request. The API
 * key and any response content are never logged.
 */

import { env } from '../env.js';
import { createLogger } from '../logger.js';

const log = createLogger('r1-deepseek-health');

/** Pinned like the worker's base-URL guard: R1 only ever talks to this host. */
export const R1_DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
export const R1_DEEPSEEK_PROBE_MODEL = 'deepseek-flash';
export const R1_HEALTH_DEADLINE_MS = 3_000;
export const R1_HEALTH_TTL_MS = 60_000;
export const R1_HEALTH_FAILURE_TTL_MS = 10_000;

const MAX_BODY_CHARS = 64 * 1024;

export interface DeepSeekHealthDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Defaults to `DEEPSEEK_API_KEY`, read on every uncached probe. */
  apiKey?: () => string | undefined;
}

export interface DeepSeekHealthProbe {
  /** True when the provider answered both requests within the deadline. */
  check(): Promise<boolean>;
  /** Forget the cached verdict (tests, and a manual operator retry). */
  reset(): void;
}

async function readBounded(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}

export function createDeepSeekHealthProbe(deps: DeepSeekHealthDeps = {}): DeepSeekHealthProbe {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  // The key comes from the shared env module (lib/env.ts), like the R1 scorer's runner:
  // R1 reads no environment variable directly (r1-scorer-isolation fence).
  const readKey = deps.apiKey ?? (() => env.deepseekApiKey || undefined);

  let verdict: { healthy: boolean; until: number } | null = null;
  let inflight: Promise<boolean> | null = null;

  async function probe(): Promise<boolean> {
    const apiKey = readKey();
    if (!apiKey) {
      log.error('unknown_event', { error_category: 'r1_health_key_missing' });
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), R1_HEALTH_DEADLINE_MS);
    const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
    try {
      const [balance, completion] = await Promise.all([
        doFetch(`${R1_DEEPSEEK_ORIGIN}/user/balance`, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: controller.signal,
        }),
        doFetch(`${R1_DEEPSEEK_ORIGIN}/v1/chat/completions`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          redirect: 'error',
          signal: controller.signal,
          body: JSON.stringify({
            model: R1_DEEPSEEK_PROBE_MODEL,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
            thinking: { type: 'disabled' },
          }),
        }),
      ]);
      if (!balance.ok || !completion.ok) return false;
      const parsed = JSON.parse(await readBounded(balance)) as { is_available?: unknown };
      await readBounded(completion);
      return parsed.is_available === true;
    } catch {
      // Timeout, network error, redirect, or a body that is not the expected JSON.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(): Promise<boolean> {
      const at = now();
      if (verdict && at < verdict.until) return verdict.healthy;
      if (inflight) return inflight;
      inflight = probe()
        .then((healthy) => {
          verdict = {
            healthy,
            until: now() + (healthy ? R1_HEALTH_TTL_MS : R1_HEALTH_FAILURE_TTL_MS),
          };
          if (!healthy) log.warn('unknown_event', { error_category: 'r1_health_unavailable' });
          return healthy;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    reset(): void {
      verdict = null;
    },
  };
}

/** The process-wide probe the exchange route uses. */
export const r1DeepSeekHealth: DeepSeekHealthProbe = createDeepSeekHealthProbe();
