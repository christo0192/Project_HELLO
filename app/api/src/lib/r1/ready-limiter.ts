/**
 * The per-attempt limiter for `POST /api/r1/ready` (the candidate's "I'm ready" button).
 *
 * The button is a convenience: the interviewer takes the first press and ignores the rest, so a
 * real candidate needs one or two requests a minute (the second is a retry). The limit exists so a
 * held attempt token and nonce cannot be used to hammer LiveKit's server API through this route
 * (every accepted request is one `listParticipants` and one `sendData` call).
 *
 * It is keyed on the ATTEMPT (the session id of an attempt token and nonce that have already been
 * verified), never on anything the caller merely asserts, so junk requests cannot spend a real
 * candidate's allowance. It is a sliding window, in memory, per process: a restart or a second
 * instance only means a fresh allowance, which is harmless for a relay the worker de-duplicates.
 * Memory is bounded: expired attempts are dropped, and the oldest are evicted past `MAX_KEYS`.
 */

/** Requests one attempt may make inside the window. */
export const R1_READY_LIMIT = 6;
export const R1_READY_WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

export type ReadyLimitVerdict = { ok: true } | { ok: false; retryAfterSec: number };

export interface ReadyLimiter {
  /** Count one request for `key` at `nowMs`; refuses once the window already holds the limit. */
  hit(key: string, nowMs: number): ReadyLimitVerdict;
}

export function createReadyLimiter(
  limit: number = R1_READY_LIMIT,
  windowMs: number = R1_READY_WINDOW_MS,
): ReadyLimiter {
  // Insertion order is recency order: a key is re-inserted on every accepted hit.
  const hits = new Map<string, number[]>();

  function evict(nowMs: number): void {
    const cutoff = nowMs - windowMs;
    for (const [key, stamps] of hits) {
      if (stamps.length === 0 || stamps[stamps.length - 1]! <= cutoff) hits.delete(key);
    }
    while (hits.size > MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }

  return {
    hit(key, nowMs) {
      const cutoff = nowMs - windowMs;
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);
      if (recent.length >= limit) {
        hits.set(key, recent);
        const oldest = recent[0]!;
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)) };
      }
      recent.push(nowMs);
      hits.delete(key);
      hits.set(key, recent);
      if (hits.size > MAX_KEYS) evict(nowMs);
      return { ok: true };
    },
  };
}
