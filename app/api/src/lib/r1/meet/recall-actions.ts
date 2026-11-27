/**
 * The Recall side of the `r1-meet` runtime (M034 S06, dark): the ports every Meet flow shares, the one
 * primitive that removes a bot, and the one rule that turns a Recall failure into a job outcome.
 *
 * PORTS. A flow never builds its own client, store, queue, clock or logger: it receives them
 * (`R1MeetFlowDeps`), so loading this module reads no environment and performs no I/O, and every test
 * drives the real code against the S01 Recall fake and the in-memory 0142 port. `R1MeetRecall` is the
 * five calls of the S01 client the runtime makes: create, read, unschedule, leave, and the bridge
 * page as the bot's camera. Nothing here can PATCH a bot (S01 R30/R31): a moved slot deletes the bot
 * and creates the next one.
 *
 * RELEASING A BOT (D-S06-11): `releaseRecallBot` reads the bot ONCE (a single GET, never a poll) and
 * then does the one thing its state allows:
 *   gone        Recall no longer knows it (404 at any step);
 *   ended       its history holds `call_ended`, `done` or `fatal`, or leave_call says
 *               `cannot_command_completed_bot`: there is nothing to stop and nothing billing;
 *   deleted     it was still `ready` (or had no status): unscheduled with DELETE;
 *   left        it had been sent to its call: leave_call. A DELETE that Recall refuses with 405
 *               (`bot_already_dispatched`: Recall dispatches a scheduled bot about 10 minutes before
 *               its join time) also ends in leave_call;
 *   dispatched  mode `undispatched_only` and the bot is already on its way: nothing was sent (a move
 *               of the slot holds; the booking's next Recall event settles it);
 *   retry       leave_call says `cannot_command_unstarted_bot`: it is between dispatch and the call,
 *               so the caller waits `R1_MEET_RELEASE_RETRY_SECONDS` and asks again.
 * Any other Recall failure is thrown as the client's `RecallError` for `r1MeetRecallFailure`.
 *
 * RETRY POLICY (D-S06-12), `r1MeetRecallFailure`: a retriable failure (network, timeout, 409 still
 * processing, 429, 507, 5xx) defers the job for the client's bounded hint, clamped to 5..300 s; a
 * 401/402/403 is an operator problem (key, credit, WAF), so it alerts `r1_meet_recall_rejected` and
 * defers 300 s; anything else throws `r1_meet_recall_<category>` (attempts, then the dead-letter
 * queue). A deferral is allowed only within `canDeferR1MeetJob` (30 deferrals, a 60-minute streak);
 * past that the same failure throws, so a long outage still ends in the DLQ, and the maintenance pass
 * re-drives whatever the bookings say is still owed.
 *
 * LOGS. Every line is `{ error_category, error_type?, http_status? }` with closed words only
 * (`R1_MEET_ALERTS`, operation and category names): never an id, a name, an email, a Meet URL, a page
 * URL, a ticket or a digest. Alerts are `error` lines.
 */

import type { RecallClient, RecallClientLogger } from '../../../integrations/recall/client.js';
import { isRecallError, type RecallErrorCategory } from '../../../integrations/recall/errors.js';
import type { RecallBot } from '../../../integrations/recall/types.js';
import { createLogger } from '../../logger.js';
import type { R1MeetAshbyTagDeps } from './ashby-booked-tag.js';
import type { R1MeetMultiHumanPolicy } from './config.js';
import type { R1MeetFeedbackDeps } from './feedback.js';
import {
  R1MeetJobError,
  canDeferR1MeetJob,
  r1MeetDefer,
  type R1MeetJobMeta,
  type R1MeetJobResult,
  type R1MeetJobSpec,
} from './jobs.js';
import type { R1MeetStore } from './runtime-store.js';

// ── Ports ───────────────────────────────────────────────────────────────────

/** The five Recall calls the runtime makes. The S01 client satisfies it as it is. */
export type R1MeetRecall = Pick<RecallClient, 'createBot' | 'getBot' | 'deleteScheduledBot' | 'leaveCall' | 'startOutputMedia'>;

/** One log line: closed words and a status number, nothing else. */
export interface R1MeetLogMeta {
  readonly error_category: string;
  readonly error_type?: string;
  readonly http_status?: number;
}

/** The structured logger as the flows use it (`createLogger(...)` adapted by the runtime). */
export interface R1MeetLog {
  info(meta: R1MeetLogMeta): void;
  warn(meta: R1MeetLogMeta): void;
  error(meta: R1MeetLogMeta): void;
}

/** Enqueue one `r1-meet` job (`r1MeetJobs.*`); a live job with the same dedup key wins. */
export type R1MeetEnqueue = (spec: R1MeetJobSpec, options?: { readonly scheduledAt?: string }) => Promise<void>;

/** The part of the enabled Meet configuration the flows read. An enabled `R1MeetConfig` satisfies it. */
export interface R1MeetFlowConfig {
  readonly dailyBotCap: number;
  readonly botNameOverride: string | null;
  readonly armAtCreate: boolean;
  readonly bridgePageUrl: string;
  readonly recallRealtimeWebhookUrl: string;
  readonly recall: { readonly googleLoginGroupId: string | null };
  /** `R1_MEET_SERVICE_USER_ID`: the staff user that creates Meet rounds, or null (D-S06-8). */
  readonly serviceUserId: string | null;
  /** `R1_MEET_MULTI_HUMAN_POLICY`: a second human ends the call (`end`) or is only logged (D-S06-28). */
  readonly multiHumanPolicy: R1MeetMultiHumanPolicy;
}

export interface R1MeetFlowDeps {
  readonly store: R1MeetStore;
  readonly recall: R1MeetRecall;
  readonly config: R1MeetFlowConfig;
  readonly enqueue: R1MeetEnqueue;
  /** Epoch ms. Read afresh for every write, so a compare-and-set sees the time it runs at. */
  readonly now: () => number;
  readonly log: R1MeetLog;
  /**
   * Maps the Ashby scheduler to our staff user that creates the round (D-S06-8). No such mapping
   * exists yet, so production passes nothing and `config.serviceUserId` answers; null makes the
   * create RPC record `unmapped_scheduler`. The RPC refuses a user it does not know.
   */
  readonly resolveCreatedBy?: (ashbyUserId: string) => Promise<string | null>;
  /** Test seam for the bridge key (the worker secret); production passes nothing. */
  readonly ticketSource?: NodeJS.ProcessEnv;
  /** Test seam for the random ticket bytes; production passes nothing (crypto.randomBytes). */
  readonly random?: (bytes: number) => Buffer;
  /** Test seam for the in-run retry waits of output_media; production passes nothing (a timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The hot-window hint of the runtime lane (D-S06-3): a call is live, so keep the storage loop at
   * its base cadence until `untilMs` (epoch ms), because the next webhook of that call must not wait
   * for an idle backoff. Only the later of two hints counts. Optional: no lane, no hint.
   */
  readonly hotUntil?: (untilMs: number) => void;
  /**
   * The ports of Dex's scorecard feedback to Ashby (M034 S09, `feedback.ts`): the form setting, the
   * feedback store, the Ashby port, the Dex user and the bridge page. Optional so the S06 flows and
   * harnesses compile unchanged; absent, a `scorecard_feedback` job throws `r1_meet_feedback_unwired`.
   */
  readonly feedback?: R1MeetFeedbackDeps;
  /**
   * The ports of the "Dex R1: Booked" tag lane (M035 S11, `ashby-booked-tag.ts`): the booked-tag
   * store, Ashby's own write switches and the Ashby tag port. Optional so the S06 flows and harnesses
   * compile unchanged; absent, an `ashby_booked_tag` job throws `r1_meet_ashby_tag_unwired`.
   */
  readonly ashbyTag?: R1MeetAshbyTagDeps;
}

/**
 * One job kind as the dispatcher registers it (D-S06-4): a strict parser (null = malformed) and a
 * handler. Each kind file exports its definitions; S09 adds one more and nothing else. `parse` and
 * `run` are methods, so definitions of different job types share one registry type.
 */
export interface R1MeetJobDefinition<TJob = unknown> {
  readonly kind: string;
  parse(payload: unknown): TJob | null;
  run(deps: R1MeetFlowDeps, job: TJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult>;
}

// ── Alerts (plan section 2.6): closed categories, logged at error level ─────

export const R1_MEET_ALERTS = Object.freeze({
  botCapReached: 'r1_meet_bot_cap_reached',
  botCreateFailed: 'r1_meet_bot_create_failed',
  generationExhausted: 'r1_meet_generation_exhausted',
  recallRejected: 'r1_meet_recall_rejected',
  strayBot: 'r1_meet_stray_bot',
  botInUse: 'r1_meet_bot_in_use',
  releaseOwed: 'r1_meet_release_owed',
  armRefused: 'r1_meet_arm_refused',
  outputMediaRefused: 'r1_meet_output_media_refused',
  bridgeGaveUp: 'r1_meet_bridge_gave_up',
  multipleHumans: 'r1_meet_multiple_humans',
  profileUnknown: 'r1_meet_profile_unknown',
  drainFailed: 'r1_meet_drain_failed',
  malformedPayload: 'r1_meet_malformed_payload',
  unknownKind: 'r1_meet_unknown_kind',
  jobFailed: 'r1_meet_job_failed',
  /** M035 S09: the bot sits in a waiting room (the meeting is not OPEN, or nobody admitted Dex). */
  botWaitingRoom: 'r1_meet_bot_waiting_room',
  /** M035 S09: the bot was held, denied or blocked at the door (`error_type` = the Recall sub-code). */
  botAdmissionBlocked: 'r1_meet_bot_admission_blocked',
  /** M035 S09: the signed-in bot could not sign in to Google (`error_type` = the Recall sub-code). */
  botSignInFailed: 'r1_meet_bot_sign_in_failed',
  /** M035 S11: the Dex R1 Booked tag could not be set up or written (`error_type` closed). */
  ashbyTagFailed: 'r1_meet_ashby_tag_failed',
} as const);

/**
 * The structured logger (`lib/logger.ts`, component `r1-meet`, event `unknown_event`) as an
 * `R1MeetLog`. The logger keeps only allowlisted keys and scans every value, a second line of defence
 * behind the closed words the flows write. Building it performs no I/O.
 */
export function createR1MeetLog(): R1MeetLog {
  const logger = createLogger('r1-meet');
  return Object.freeze({
    info: (meta: R1MeetLogMeta) => logger.info('unknown_event', meta),
    warn: (meta: R1MeetLogMeta) => logger.warn('unknown_event', meta),
    error: (meta: R1MeetLogMeta) => logger.error('unknown_event', meta),
  });
}

/** The Recall client's own metadata logger as `r1_meet_recall_ok` / `r1_meet_recall_failed` lines (D-S06-33). */
export function r1MeetRecallClientLogger(log: R1MeetLog): RecallClientLogger {
  return {
    event(record) {
      const meta: R1MeetLogMeta = {
        error_category: record.outcome === 'success' ? 'r1_meet_recall_ok' : 'r1_meet_recall_failed',
        error_type: record.category === undefined ? record.operation : `${record.operation}:${record.category}`,
        ...(record.httpStatus === undefined ? {} : { http_status: record.httpStatus }),
      };
      if (record.outcome === 'success') log.info(meta);
      else log.warn(meta);
    },
  };
}

// ── What a bot's history says ───────────────────────────────────────────────

const ENDED_CODES: ReadonlySet<string> = new Set(['call_ended', 'done', 'fatal']);

/** The call is over: there is nothing left to stop or bill. */
export function r1MeetBotEnded(bot: RecallBot): boolean {
  return bot.statusChanges.some((change) => ENDED_CODES.has(change.code));
}

/** Recall has not sent it anywhere yet: only `ready` (or nothing) in its history. */
export function r1MeetBotUndispatched(bot: RecallBot): boolean {
  return bot.statusChanges.every((change) => change.code === 'ready');
}

function isCategory(error: unknown, category: RecallErrorCategory): boolean {
  return isRecallError(error) && error.category === category;
}

// ── Releasing a bot ─────────────────────────────────────────────────────────

export type R1MeetReleaseMode = 'any' | 'undispatched_only';
export type R1MeetReleaseOutcome = 'gone' | 'ended' | 'deleted' | 'left' | 'dispatched' | 'retry';
/** The three calls a release may make (the drain holds only these: it can never create or arm). */
export type R1MeetReleasePort = Pick<R1MeetRecall, 'getBot' | 'deleteScheduledBot' | 'leaveCall'>;

/** How long to wait after `cannot_command_unstarted_bot` (a bot between dispatch and its call). */
export const R1_MEET_RELEASE_RETRY_SECONDS = 30;

/** The vendor codes leave_call can answer with (Recall's errors reference). */
const CANNOT_COMMAND_COMPLETED = 'cannot_command_completed_bot';
const CANNOT_COMMAND_UNSTARTED = 'cannot_command_unstarted_bot';

async function leave(recall: R1MeetReleasePort, botId: string): Promise<R1MeetReleaseOutcome> {
  try {
    await recall.leaveCall(botId);
    return 'left';
  } catch (error) {
    if (!isRecallError(error)) throw error;
    if (error.category === 'not_found') return 'gone';
    if (error.code === CANNOT_COMMAND_COMPLETED) return 'ended';
    if (error.code === CANNOT_COMMAND_UNSTARTED) return 'retry';
    throw error;
  }
}

/**
 * Remove one bot from Recall, confirming its state with exactly one GET first (see the header). The
 * caller marks the database only after this answers, so a crash in between replays a release that
 * Recall then reports as `gone` or `ended`: idempotent.
 */
export async function releaseRecallBot(
  recall: R1MeetReleasePort,
  botId: string,
  mode: R1MeetReleaseMode,
): Promise<R1MeetReleaseOutcome> {
  let bot: RecallBot;
  try {
    bot = await recall.getBot(botId);
  } catch (error) {
    if (isCategory(error, 'not_found')) return 'gone';
    throw error;
  }
  if (r1MeetBotEnded(bot)) return 'ended';
  if (r1MeetBotUndispatched(bot)) {
    try {
      await recall.deleteScheduledBot(botId);
      return 'deleted';
    } catch (error) {
      if (isCategory(error, 'not_found')) return 'gone';
      // 405: Recall dispatched it in the meantime (the last 10 minutes before join_at). It has not
      // joined, so leaving costs nothing; holding it would let it join the old slot.
      if (!isCategory(error, 'not_allowed')) throw error;
    }
    return leave(recall, botId);
  }
  if (mode === 'undispatched_only') return 'dispatched';
  return leave(recall, botId);
}

// ── A Recall failure as a job outcome ───────────────────────────────────────

/** The defer reason of a transient Recall failure (`job_queue.defer_reason`). */
export const R1_MEET_RECALL_UNAVAILABLE = 'r1_meet_recall_unavailable';
export const R1_MEET_RECALL_MIN_DEFER_SEC = 5;
export const R1_MEET_RECALL_MAX_DEFER_SEC = 300;
/** A rejected key, an empty credit balance or a WAF block waits this long (an operator must act). */
export const R1_MEET_RECALL_REJECTED_DEFER_SEC = 300;

const REJECTED_CATEGORIES: ReadonlySet<RecallErrorCategory> = new Set(['unauthorized', 'payment_required', 'forbidden']);

/** 401, 402 or 403: the key, the workspace credit or Recall's WAF. Waiting fixes none of them alone. */
export function r1MeetRecallRejected(error: unknown): boolean {
  return isRecallError(error) && REJECTED_CATEGORIES.has(error.category);
}

export interface R1MeetRecallFailureContext {
  readonly meta: Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>;
  readonly nowMs: number;
  readonly log: R1MeetLog;
  /** A floor above 5 s for this call site (output_media waits at least 20 s). */
  readonly minDelaySeconds?: number;
}

/**
 * The job outcome of a Recall failure (D-S06-12): a deferral, or a throw of one closed code. Anything
 * that is not a `RecallError` (a database failure, a bug) is rethrown unchanged.
 */
export function r1MeetRecallFailure(error: unknown, context: R1MeetRecallFailureContext): R1MeetJobResult {
  if (!isRecallError(error)) throw error;
  const code = `r1_meet_recall_${error.category}`;
  if (error.retriable) {
    if (!canDeferR1MeetJob(context.meta, context.nowMs)) throw new R1MeetJobError(code);
    const floor = Math.max(R1_MEET_RECALL_MIN_DEFER_SEC, context.minDelaySeconds ?? 0);
    const hinted = Math.ceil((error.retryAfterMs ?? 0) / 1000);
    return r1MeetDefer(R1_MEET_RECALL_UNAVAILABLE, Math.min(R1_MEET_RECALL_MAX_DEFER_SEC, Math.max(floor, hinted)));
  }
  if (REJECTED_CATEGORIES.has(error.category)) {
    context.log.error({
      error_category: R1_MEET_ALERTS.recallRejected,
      error_type: `${error.operation}:${error.category}`,
      ...(error.httpStatus === null ? {} : { http_status: error.httpStatus }),
    });
    if (!canDeferR1MeetJob(context.meta, context.nowMs)) throw new R1MeetJobError(code);
    return r1MeetDefer(R1_MEET_ALERTS.recallRejected, R1_MEET_RECALL_REJECTED_DEFER_SEC);
  }
  throw new R1MeetJobError(code);
}
