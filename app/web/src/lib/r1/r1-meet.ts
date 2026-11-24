/**
 * The Meet bridge's ticket exchange: how its refusals read and how often it may ask again
 * (M034 S07; `.gsd/milestones/M034/contracts/meet-contracts.md` sections 4 and 9, decisions
 * D-S07-10 and D-S07-11).
 *
 * The bridge page runs inside the Recall bot's headless Chrome, so nobody is there to press
 * "try again", and every exchange can boot an interview worker (critic C5). So:
 *
 *   - Asked again: a 202 `preparing` (the worker is booting), a network failure (fetch rejected,
 *     or 502/504 from the proxy), and a short-lived refusal the server answers BEFORE it claims
 *     the ticket (contract section 9, S04 order steps 1 to 7, so a retry spends no ticket, no
 *     start and boots no worker): a 429, a 503 that says when to ask again (`retry_after_sec`,
 *     the DeepSeek probe), and maintenance (`http_503`, also what a proxy 503 reads as). Once a
 *     202 has handed out a `resume_token`, every 503 but `meet_disabled` is asked again too: the
 *     continuation claims and admits nothing (S07 review finding S07-R1). Every other answer is
 *     terminal and quiet: the page shows one tile and makes no further call. A 503 with no hint
 *     on a FRESH ticket stays terminal, because it may come after the claim (`r1_room_unavailable`,
 *     an invalid role's `r1_unavailable`), where the ticket alone would be refused as claimed.
 *   - At most `R1_MEET_EXCHANGE_MAX_CALLS` calls, with the waits of `R1_MEET_EXCHANGE_WAITS_MS`
 *     between them (never less than 3 s). The server's `retry_after_sec` (a 202's, or a
 *     retried refusal's) can lengthen a wait, never shorten it, and never past
 *     `R1_MEET_RETRY_AFTER_CAP_MS`.
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
import { R1ApiError, type R1MeetExchangeResult, type R1MeetRoomGrant } from './r1-api';

/** Why the bridge gave up, as the tile's `data-reason` names it. */
export type R1MeetFailure =
  | 'invalid'
  | 'claimed'
  | 'not_yet'
  | 'expired'
  | 'round_closed'
  | 'unavailable'
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

/** The refusal's own `retry_after_sec`, when the server sent one (see `R1ApiError`). */
function refusalHintSeconds(error: unknown): number | null {
  return error instanceof R1ApiError ? error.retryAfterSec : null;
}

/**
 * A short-lived refusal worth asking again inside the same bound (S07-R1). A 429 and maintenance
 * (`http_503`) are answered before the ticket is claimed; a 503 carrying `retry_after_sec` is the
 * server saying when to ask again (the DeepSeek probe, also before the claim). With a resume
 * token held, every 503 qualifies: the continuation claims and admits nothing.
 */
function isTransientRefusal(error: ApiError, resumeHeld: boolean): boolean {
  if (error.status === 429) return true;
  if (error.status !== 503) return false;
  return resumeHeld || error.message === 'http_503' || refusalHintSeconds(error) !== null;
}

/**
 * What one failed exchange call means for the bridge. `resumeHeld` says whether the call presented
 * a `resume_token` (a continuation after a 202), which makes every 503 safe to ask again.
 */
export function classifyMeetExchangeError(
  error: unknown,
  resumeHeld = false,
): R1MeetExchangeVerdict {
  if (!(error instanceof ApiError)) return { kind: 'failed', reason: 'unavailable' };
  const code = error.message;
  if (code === R1_MEET_DISABLED_CODE) return { kind: 'disabled' };
  if (Object.prototype.hasOwnProperty.call(R1_MEET_EXCHANGE_ERRORS, code)) {
    return { kind: 'failed', reason: R1_MEET_EXCHANGE_ERRORS[code] as R1MeetFailure };
  }
  if (code === 'r1_malformed_response') return { kind: 'failed', reason: 'malformed' };
  if (RETRIED_STATUSES.includes(error.status)) return { kind: 'retry' };
  if (isTransientRefusal(error, resumeHeld)) return { kind: 'retry' };
  if (error.status === 410) return { kind: 'failed', reason: 'expired' };
  if (error.status === 425) return { kind: 'failed', reason: 'not_yet' };
  if (INVALID_STATUSES.includes(error.status)) return { kind: 'failed', reason: 'invalid' };
  // A 500, an unknown 409 (r1_busy after the claim), a hintless 503 on a fresh ticket: nothing
  // the bridge can clear by asking again with the ticket alone.
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
    /** The server's hint for the next wait, in seconds, from a 202 or a retried refusal. */
    let hintSec: number | null = null;
    try {
      result = await exchange(ticket, resumeToken);
    } catch (error) {
      if (isCancelled()) return CANCELLED;
      const verdict = classifyMeetExchangeError(error, resumeToken !== null);
      if (verdict.kind !== 'retry') return verdict;
      hintSec = refusalHintSeconds(error);
    }
    if (isCancelled()) return CANCELLED;
    if (result !== null) {
      if (result.status === 'ready') return { kind: 'ready', grant: result };
      resumeToken = result.resume_token;
      hintSec = result.retry_after_sec;
      onPreparing?.();
    }
    const floorMs = hintSec === null ? 0 : Math.min(hintSec * 1_000, R1_MEET_RETRY_AFTER_CAP_MS);
    if (call >= R1_MEET_EXCHANGE_MAX_CALLS) break;
    const waitMs = Math.max(R1_MEET_EXCHANGE_WAITS_MS[call - 1] as number, floorMs);
    if (now() - startedAt + waitMs > R1_MEET_EXCHANGE_DEADLINE_MS) break;
    await sleep(waitMs);
  }
  return isCancelled() ? CANCELLED : TIMED_OUT;
}
