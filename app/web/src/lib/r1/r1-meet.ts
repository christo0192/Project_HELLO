/**
 * The Meet bridge's ticket exchange: how its refusals read and how often it may ask again
 * (M034 S07; `.gsd/milestones/M034/contracts/meet-contracts.md` sections 4 and 9, decisions
 * D-S07-10 and D-S07-11).
 *
 * The bridge page runs inside the Recall bot's headless Chrome, so nobody is there to press
 * "try again", and every exchange can boot an interview worker (critic C5). So:
 *
 *   - Only two things are asked again: a 202 `preparing` (the worker is booting) and a network
 *     failure (fetch rejected, or 502/504 from the proxy). Every other answer is terminal and
 *     quiet: the page shows one tile and makes no further call.
 *   - At most `R1_MEET_EXCHANGE_MAX_CALLS` calls, with the waits of `R1_MEET_EXCHANGE_WAITS_MS`
 *     between them (never less than 3 s). The server's `retry_after_sec` can lengthen a wait,
 *     never shorten it, and never past `R1_MEET_RETRY_AFTER_CAP_MS`.
 *   - The call COUNT is the primary bound (the e2e harness freezes the clock); the deadline of
 *     `R1_MEET_EXCHANGE_DEADLINE_MS` after the first call is the secondary one, read from the
 *     injected monotonic clock.
 *   - After a 202 every later call presents the newest `resume_token` (the ticket alone is
 *     single-use and would be refused as already claimed). A network failure keeps the one held.
 *   - The runner stops, without another call, the moment the page says it is gone.
 *
 * This module is pure: it sends nothing itself (the page injects `r1Api.meetExchange`), and it
 * imports no SDK.
 */

import { ApiError } from '../api-client';
import type { R1MeetExchangeResult, R1MeetRoomGrant } from './r1-api';

/** Why the bridge gave up, as the tile's `data-reason` names it. */
export type R1MeetFailure =
  | 'invalid'
  | 'claimed'
  | 'not_yet'
  | 'expired'
  | 'round_closed'
  | 'unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'malformed';

/** The exchange's own refusal codes (contract section 4), and the failure each one is. */
export const R1_MEET_EXCHANGE_ERRORS: Readonly<Record<string, R1MeetFailure>> = Object.freeze({
  invalid_request: 'invalid',
  ticket_unknown: 'invalid',
  ticket_already_claimed: 'claimed',
  ticket_not_yet_valid: 'not_yet',
  ticket_expired: 'expired',
  round_not_live: 'round_closed',
});

/** `R1_MEET_ENABLED` is off on the server (503): the tile idles, it is not a failure. */
export const R1_MEET_DISABLED_CODE = 'meet_disabled';

/** Every exchange code the page tells apart by name. */
export const R1_MEET_EXCHANGE_ERROR_CODES: readonly string[] = Object.freeze([
  ...Object.keys(R1_MEET_EXCHANGE_ERRORS),
  R1_MEET_DISABLED_CODE,
]);

export type R1MeetExchangeVerdict =
  | { kind: 'disabled' }
  | { kind: 'retry' }
  | { kind: 'failed'; reason: R1MeetFailure };

/** Statuses that mean the request never reached the API: worth one more bounded try. */
const RETRIED_STATUSES: readonly number[] = [0, 502, 504];
const INVALID_STATUSES: readonly number[] = [400, 401, 403, 404];

/** What one failed exchange call means for the bridge. */
export function classifyMeetExchangeError(error: unknown): R1MeetExchangeVerdict {
  if (!(error instanceof ApiError)) return { kind: 'failed', reason: 'unavailable' };
  const code = error.message;
  if (code === R1_MEET_DISABLED_CODE) return { kind: 'disabled' };
  if (Object.prototype.hasOwnProperty.call(R1_MEET_EXCHANGE_ERRORS, code)) {
    return { kind: 'failed', reason: R1_MEET_EXCHANGE_ERRORS[code] as R1MeetFailure };
  }
  if (code === 'r1_malformed_response') return { kind: 'failed', reason: 'malformed' };
  if (RETRIED_STATUSES.includes(error.status)) return { kind: 'retry' };
  if (error.status === 429) return { kind: 'failed', reason: 'rate_limited' };
  if (error.status === 410) return { kind: 'failed', reason: 'expired' };
  if (error.status === 425) return { kind: 'failed', reason: 'not_yet' };
  if (INVALID_STATUSES.includes(error.status)) return { kind: 'failed', reason: 'invalid' };
  // Maintenance (503 `http_503`), a 500, an unknown 409: nothing the bridge can clear.
  return { kind: 'failed', reason: 'unavailable' };
}

/** The most exchange calls one page may make, the first included. */
export const R1_MEET_EXCHANGE_MAX_CALLS = 10;

/** The wait before calls 2 to 10 (168 s in all). */
export const R1_MEET_EXCHANGE_WAITS_MS: readonly number[] = Object.freeze([
  3_000, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 30_000, 30_000,
]);

/** No call starts once the next wait would end more than this long after the first call. */
export const R1_MEET_EXCHANGE_DEADLINE_MS = 180_000;

/** The server's `retry_after_sec` may lengthen a wait up to this, never beyond. */
export const R1_MEET_RETRY_AFTER_CAP_MS = 30_000;

export interface R1MeetExchangeDeps {
  ticket: string;
  /** One exchange call (`r1Api.meetExchange` on the page). */
  exchange: (ticket: string, resumeToken: string | null) => Promise<R1MeetExchangeResult>;
  sleep: (ms: number) => Promise<void>;
  /** A monotonic clock in milliseconds (`performance.now` on the page). */
  now: () => number;
  /** True once the page is gone: the runner then stops without another call. */
  isCancelled: () => boolean;
  /** Called after each 202, so the tile can say the interview is being prepared. */
  onPreparing?: () => void;
}

export type R1MeetExchangeOutcome =
  | { kind: 'ready'; grant: R1MeetRoomGrant }
  | { kind: 'disabled' }
  | { kind: 'failed'; reason: R1MeetFailure }
  | { kind: 'cancelled' };

const CANCELLED: R1MeetExchangeOutcome = Object.freeze({ kind: 'cancelled' });
const TIMED_OUT: R1MeetExchangeOutcome = Object.freeze({ kind: 'failed', reason: 'timeout' });

/** Trade the ticket for a room token within the bounded schedule above. */
export async function runMeetExchange(deps: R1MeetExchangeDeps): Promise<R1MeetExchangeOutcome> {
  const { ticket, exchange, sleep, now, isCancelled, onPreparing } = deps;
  let resumeToken: string | null = null;
  let startedAt: number | null = null;
  for (let call = 1; call <= R1_MEET_EXCHANGE_MAX_CALLS; call += 1) {
    if (isCancelled()) return CANCELLED;
    if (startedAt === null) startedAt = now();
    let result: R1MeetExchangeResult | null = null;
    try {
      result = await exchange(ticket, resumeToken);
    } catch (error) {
      if (isCancelled()) return CANCELLED;
      const verdict = classifyMeetExchangeError(error);
      if (verdict.kind !== 'retry') return verdict;
    }
    if (isCancelled()) return CANCELLED;
    let floorMs = 0;
    if (result !== null) {
      if (result.status === 'ready') return { kind: 'ready', grant: result };
      resumeToken = result.resume_token;
      if (result.retry_after_sec !== null) {
        floorMs = Math.min(result.retry_after_sec * 1_000, R1_MEET_RETRY_AFTER_CAP_MS);
      }
      onPreparing?.();
    }
    if (call >= R1_MEET_EXCHANGE_MAX_CALLS) break;
    const waitMs = Math.max(R1_MEET_EXCHANGE_WAITS_MS[call - 1] as number, floorMs);
    if (now() - startedAt + waitMs > R1_MEET_EXCHANGE_DEADLINE_MS) break;
    await sleep(waitMs);
  }
  return isCancelled() ? CANCELLED : TIMED_OUT;
}
