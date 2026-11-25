/**
 * Arming the bridge (M034 S06, dark): give Dex's bot a single-use ticket and show the bridge page as
 * its camera, so the page can exchange the ticket for the R1 session (S05) and Dex is heard in the
 * Meet.
 *
 * WHEN A HUMAN IS PRESENT (D-S06-25, the default mode). The caller (the `recall_event` handler) has
 * elected one winner by compare-and-set; `armBridge` then runs, in this order, each step only after
 * the one before succeeded:
 *   1. one GET of the bot: a bot Recall no longer knows, or whose call ended, gets no page;
 *   2. `mintR1MeetTicket` (32 fresh random bytes, S05) and `r1_meet_arm_ticket` with its digest and
 *      window. `digest_in_use` or `duplicate` mean "mint again", at most `R1_MEET_ARM_MINT_ATTEMPTS`
 *      times; any other refusal (5 arms spent, the booking moved on, the window closed) alerts
 *      `r1_meet_arm_refused` and stops;
 *   3. a `bridge_check` job 45 s later, keyed by the arm count the RPC answered, so the page that never
 *      claims its ticket is re-armed (D-S06-27) even if this run dies right after;
 *   4. output_media with `<web origin>/candidate/r1/meet#t=<ticket>`. No Idempotency-Key: Recall
 *      caches an error under a key for an hour, and a re-post must be answerable. A retriable failure
 *      is retried in this run with the same URL after 2, 4 and 8 s (at most 30 s in all: no new arm),
 *      never sooner than Recall asked (a 429's or 507's Retry-After or fallback, any other answer's
 *      Retry-After; a wait past the budget ends the in-run retries), then the job defers 20 s,
 *      doubling per deferral up to 120 s, or longer when Recall asked; a re-run arms a fresh ticket
 *      (the bridge check of this arm finds it superseded). Five arms thus outlast a Recall outage of
 *      about five minutes (PR #444 review S06-R4, round 2).
 * The ticket's plaintext lives only in this call frame: it is never stored, logged, enqueued or put in
 * an error (the RPC gets the digest, Recall gets the URL, and a `RecallError` never holds a URL).
 *
 * AT CREATE (D-S06-26, `R1_MEET_ARM_AT_CREATE=true`, critic B2). The create body carries the page as
 * `output_media`, and the ticket is armed right after the bot is attached. Recall answers a retried
 * create from its one-hour cache with the FIRST body, so a random ticket would be lost on a retry: the
 * 32 bytes are DERIVED instead, `HMAC(r1MeetDerivedKey('hello:r1:meet-create-ticket:v1'),
 * '<booking>.<version>.<key_attempt>')`, fed to `mintR1MeetTicket` through its random seam. The same
 * create key always derives the same ticket (so a retry arms what the page really carries), and a new
 * generation or key attempt derives a new one. The key is derived from `WORKER_CONTEXT_SECRET`, like
 * every bridge key, so nothing outside the API can compute it. No secret or no window: the bot is
 * created without output media and the human-present arm runs as the fallback.
 *
 * The client, store, queue, clock and logger are arguments: loading this module performs no I/O.
 */

import { createHmac } from 'node:crypto';
import { getR1MeetProfile } from './profiles.js';
import {
  R1MeetJobError,
  canDeferR1MeetJob,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetJobs,
  r1MeetProcessed,
  type R1MeetJobMeta,
  type R1MeetJobResult,
} from './jobs.js';
import {
  R1_MEET_ALERTS,
  R1_MEET_RECALL_UNAVAILABLE,
  r1MeetBotEnded,
  r1MeetRecallFailure,
  r1MeetRecallRejected,
  type R1MeetFlowDeps,
} from './recall-actions.js';
import type { R1MeetBooking } from './runtime-store.js';
import {
  mintR1MeetTicket,
  r1MeetBridgePageUrl,
  r1MeetDerivedKey,
  type MintedR1MeetTicket,
} from './ticket.js';
import { RECALL_DEFAULT_RETRY_AFTER_MS } from '../../../integrations/recall/client.js';
import { isRecallError, type RecallError } from '../../../integrations/recall/errors.js';
import type { RecallBot } from '../../../integrations/recall/types.js';

/** The HMAC domain of the at-create ticket seed (a `hello:r1:meet-*` bridge domain, ticket.ts). */
export const R1_MEET_CREATE_TICKET_DOMAIN = 'hello:r1:meet-create-ticket:v1';
/** A ticket the RPC refuses as in use or already armed is minted again at most this many times. */
export const R1_MEET_ARM_MINT_ATTEMPTS = 3;
/** The bridge check of an arm runs this long after it (D-S06-27). */
export const R1_MEET_BRIDGE_CHECK_DELAY_SEC = 45;
/**
 * A retriable output_media failure is retried IN THE SAME RUN after each of these waits (same URL,
 * same ticket, no new arm), while the run has spent less than the budget on it (PR #444 review S06-R4:
 * every deferred re-run must arm a fresh ticket, and a booking has only 5 arms).
 */
export const R1_MEET_OUTPUT_MEDIA_RETRY_WAITS_MS: readonly number[] = Object.freeze([2_000, 4_000, 8_000]);
export const R1_MEET_OUTPUT_MEDIA_RETRY_BUDGET_MS = 30_000;
/** After the in-run retries, a failed output_media waits at least this long, doubling per deferral... */
export const R1_MEET_OUTPUT_MEDIA_MIN_DEFER_SEC = 20;
/** ...up to this long, so five arms outlast an outage of about five minutes. */
export const R1_MEET_OUTPUT_MEDIA_MAX_DEFER_SEC = 120;

/** The deferral floor of a failed output_media on the job's `deferCount`-th deferral: 20, 40, 80, 120 s. */
export function r1MeetOutputMediaDeferSeconds(deferCount: number): number {
  const doublings = Number.isSafeInteger(deferCount) && deferCount > 0 ? Math.min(deferCount, 8) : 0;
  return Math.min(R1_MEET_OUTPUT_MEDIA_MAX_DEFER_SEC, R1_MEET_OUTPUT_MEDIA_MIN_DEFER_SEC * 2 ** doublings);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const CANNOT_COMMAND_COMPLETED = 'cannot_command_completed_bot';
const CANNOT_COMMAND_UNSTARTED = 'cannot_command_unstarted_bot';

const toIso = (ms: number): string => new Date(ms).toISOString();

type ArmingDeps = Pick<R1MeetFlowDeps, 'store' | 'log'>;

/** The slot and generation a ticket is derived for. */
export type R1MeetCreateTicketBooking = Pick<R1MeetBooking, 'id' | 'version' | 'keyAttempt' | 'startAt' | 'endAt'>;

/**
 * The at-create ticket of one bot generation and key attempt (see the header), or null when this
 * process has no bridge key or the slot has no claim window.
 */
export function deriveR1MeetCreateTicket(
  deps: Pick<R1MeetFlowDeps, 'ticketSource'>,
  booking: R1MeetCreateTicketBooking,
  botJoinLeadSec: number,
  nowMs: number,
): MintedR1MeetTicket | null {
  const key = r1MeetDerivedKey(R1_MEET_CREATE_TICKET_DOMAIN, deps.ticketSource);
  if (key === null) return null;
  const seed = createHmac('sha256', key)
    .update(`${booking.id}.${booking.version}.${booking.keyAttempt}`, 'utf8')
    .digest();
  return mintR1MeetTicket(
    { startAt: booking.startAt, endAt: booking.endAt, botJoinLeadSec, nowMs },
    // The seed is exactly the 32 bytes asked for; anything else makes the mint refuse (null).
    { source: deps.ticketSource, random: (bytes) => (bytes === seed.length ? seed : Buffer.alloc(0)) },
  );
}

/**
 * Store the digest of an at-create ticket right after its bot was attached. `ok` and `duplicate`
 * (the same ticket and window again: a concurrent or retried create of the same generation) are
 * success. A refusal or a database failure alerts and answers false: the bot keeps its page, and the
 * human-present arm runs as the fallback.
 */
export async function armR1MeetCreateTicket(
  deps: ArmingDeps,
  bookingId: string,
  minted: MintedR1MeetTicket,
  nowIso: string,
): Promise<boolean> {
  try {
    const answer = await deps.store.armTicket({
      bookingId,
      ticketDigest: minted.digest,
      notBefore: minted.not_before,
      expiresAt: minted.expires_at,
      nowIso,
    });
    if (answer.status === 'ok' || answer.status === 'duplicate') return true;
    deps.log.error({ error_category: R1_MEET_ALERTS.armRefused, error_type: `create_${answer.status}` });
  } catch {
    deps.log.error({ error_category: R1_MEET_ALERTS.armRefused, error_type: 'create_db_error' });
  }
  return false;
}

/** The page URL of a freshly armed ticket, and the arm count the RPC answered. */
interface Armed {
  readonly pageUrl: string;
  readonly ticketArms: number;
}

/**
 * Arm a fresh ticket for the booking's current bot and post the page as its camera (see the header).
 * Answers a job outcome: `armed` when output_media was accepted, an `ignored` code when there was
 * nothing to arm, or a deferral while Recall is unavailable.
 */
export async function armBridge(
  deps: R1MeetFlowDeps,
  booking: R1MeetBooking,
  meta: Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>,
): Promise<R1MeetJobResult> {
  const botId = booking.recallBotId;
  if (botId === null) return r1MeetIgnored('no_bot');
  const profile = getR1MeetProfile(booking.objectiveProfile);
  if (profile === null) {
    // A booking this build cannot read: a newer build wrote it. Retried, then dead-lettered.
    deps.log.error({ error_category: R1_MEET_ALERTS.profileUnknown });
    throw new R1MeetJobError(R1_MEET_ALERTS.profileUnknown);
  }

  // 1. One GET: never arm a page for a bot that is gone or whose call is over.
  let bot: RecallBot;
  try {
    bot = await deps.recall.getBot(botId);
  } catch (error) {
    if (isRecallError(error) && error.category === 'not_found') return r1MeetIgnored('bot_gone');
    return r1MeetRecallFailure(error, { meta, nowMs: deps.now(), log: deps.log });
  }
  if (r1MeetBotEnded(bot)) return r1MeetIgnored('bot_ended');

  // 2. A fresh ticket, armed; minted again only when the RPC says this digest cannot be used.
  let armed: Armed | null = null;
  for (let attempt = 0; attempt < R1_MEET_ARM_MINT_ATTEMPTS && armed === null; attempt += 1) {
    const nowMs = deps.now();
    const minted = mintR1MeetTicket(
      { startAt: booking.startAt, endAt: booking.endAt, botJoinLeadSec: profile.botJoinLeadSec, nowMs },
      { source: deps.ticketSource, random: deps.random },
    );
    if (minted === null) {
      // No bridge key in this process, or the claim window has closed.
      deps.log.error({ error_category: R1_MEET_ALERTS.armRefused, error_type: 'no_ticket' });
      return r1MeetIgnored('arm_no_ticket');
    }
    const pageUrl = r1MeetBridgePageUrl(deps.config.bridgePageUrl, minted.ticket);
    if (pageUrl === null) {
      deps.log.error({ error_category: R1_MEET_ALERTS.armRefused, error_type: 'page_url' });
      return r1MeetIgnored('arm_page_url');
    }
    const answer = await deps.store.armTicket({
      bookingId: booking.id,
      ticketDigest: minted.digest,
      notBefore: minted.not_before,
      expiresAt: minted.expires_at,
      nowIso: toIso(nowMs),
    });
    if (answer.status === 'ok') {
      armed = { pageUrl, ticketArms: answer.ticketArms };
    } else if (answer.status !== 'digest_in_use' && answer.status !== 'duplicate') {
      deps.log.error({ error_category: R1_MEET_ALERTS.armRefused, error_type: answer.status });
      return r1MeetIgnored(`arm_${answer.status}`);
    }
  }
  if (armed === null) {
    deps.log.error({ error_category: R1_MEET_ALERTS.armRefused, error_type: 'remint_exhausted' });
    return r1MeetIgnored('arm_remint_exhausted');
  }

  // 3. The recovery check of THIS arm, before Recall is asked: a crash below still gets a re-arm.
  const nowMs = deps.now();
  await deps.enqueue(r1MeetJobs.bridgeCheck(booking.id, booking.version, armed.ticketArms), {
    scheduledAt: toIso(nowMs + R1_MEET_BRIDGE_CHECK_DELAY_SEC * 1000),
  });

  // 4. The page as the bot's camera.
  return postBridgePage(deps, botId, armed.pageUrl, meta);
}

/** Throttling answers: their retry hint (Retry-After, else the client's fallback) is always honoured. */
const THROTTLED: ReadonlySet<string> = new Set(['rate_limited', 'capacity_exhausted']);

/**
 * How long Recall asked us to stay away (PR #444 review round 2, S06-R4): a throttling answer's hint
 * (its Retry-After, else the client's 30 s fallback), or any other answer's Retry-After when Recall
 * sent one. The client's own fallback for a gateway error, a timeout or a network failure is not
 * Recall asking (Recall: retry 502/503/504), so those keep the 2/4/8 s schedule. 0 = no ask.
 */
function recallAskedWaitMs(error: RecallError): number {
  const hint = error.retryAfterMs ?? 0;
  if (THROTTLED.has(error.category)) return hint;
  const fallback = (RECALL_DEFAULT_RETRY_AFTER_MS as Readonly<Record<string, number>>)[error.category];
  return hint === fallback ? 0 : hint;
}

/**
 * output_media with bounded same-URL retries in this run on a retriable failure (see the header).
 * The next post never comes sooner than Recall asked (`recallAskedWaitMs`): when that wait does not
 * fit the 30 s budget, the in-run retries stop and the deferral honours the hint instead.
 */
async function postBridgePage(
  deps: R1MeetFlowDeps,
  botId: string,
  pageUrl: string,
  meta: Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>,
): Promise<R1MeetJobResult> {
  const sleep = deps.sleep ?? realSleep;
  const startedMs = deps.now();
  let lastError: unknown = null;
  for (let attempt = 0; ; attempt += 1) {
    let asked = 0;
    try {
      await deps.recall.startOutputMedia(botId, { cameraWebpageUrl: pageUrl });
      return r1MeetProcessed('armed');
    } catch (error) {
      if (!isRecallError(error)) throw error;
      lastError = error;
      if (!error.retriable) break;
      asked = recallAskedWaitMs(error);
    }
    const planned = R1_MEET_OUTPUT_MEDIA_RETRY_WAITS_MS[attempt];
    if (planned === undefined) break;
    const waitMs = Math.max(planned, asked);
    if (deps.now() - startedMs + waitMs > R1_MEET_OUTPUT_MEDIA_RETRY_BUDGET_MS) break;
    await sleep(waitMs);
  }
  const error = lastError;
  if (!isRecallError(error)) throw error;
  if (error.category === 'not_found') return r1MeetIgnored('bot_gone');
  if (error.code === CANNOT_COMMAND_COMPLETED) return r1MeetIgnored('bot_ended');
  const context = {
    meta,
    nowMs: deps.now(),
    log: deps.log,
    minDelaySeconds: r1MeetOutputMediaDeferSeconds(meta.deferCount),
  };
  if (error.retriable || r1MeetRecallRejected(error)) return r1MeetRecallFailure(error, context);
  if (error.code === CANNOT_COMMAND_UNSTARTED) {
    // The bot is between dispatch and the call: it cannot show a page yet, so wait like a 5xx.
    if (!canDeferR1MeetJob(meta, context.nowMs)) throw new R1MeetJobError(`r1_meet_recall_${error.category}`);
    return r1MeetDefer(R1_MEET_RECALL_UNAVAILABLE, R1_MEET_OUTPUT_MEDIA_MIN_DEFER_SEC);
  }
  deps.log.error({
    error_category: R1_MEET_ALERTS.outputMediaRefused,
    error_type: error.category,
    ...(error.httpStatus === null ? {} : { http_status: error.httpStatus }),
  });
  return r1MeetIgnored('output_media_refused');
}
