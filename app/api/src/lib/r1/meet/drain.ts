/**
 * The drain of the `r1-meet` runtime (M034 S06, dark; D-S06-31, D-S06-32): remove every Recall bot
 * that could still join a Meet and close its booking, so that turning R1 over Meet off never leaves a
 * bot joining an interview, or billing, behind it. One function, `drainR1Meet`, three doors:
 *
 *   (a) OPERATOR, flag still ON: an operator inserts one `r1-meet` job `{"kind":"drain"}` (runbook
 *       SQL). Its definition below runs passes until nothing is left, deferring between them, and
 *       ignores how recently a booking changed. `"force": true` also cuts a live interview.
 *   (b) BACKSTOP, `R1_MEET_ENABLED` deliberately OFF (config status exactly `disabled`) while the
 *       process still holds a well-formed Recall key: the existing `r1-sweep` tick runs one bounded
 *       pass per 15-minute bucket (10 bookings, 40 s), again sooner while rows remain
 *       (`runtime.ts`, `createR1MeetSweepTick`). It touches only bookings untouched for 5 minutes,
 *       so a rolling restart that turns the flag ON cannot drain a booking the new machines just
 *       created.
 *   (c) NEVER for status `invalid` (a typo or a lost secret must not cancel every booked interview)
 *       and never because R1 alone is off (`R1_ENABLED` is a short incident switch; a drained
 *       booking is terminal and HR must book again).
 *
 * PER BOOKING (plan 2.5: Recall first, the database second, so a pass killed in between replays):
 *   a live bound session (created, waiting, in progress) is skipped until it ends, unless forced;
 *   the bot, if any, is released at Recall (one GET, then DELETE or leave_call: `releaseRecallBot`);
 *   then `-> drained/flag_off`, or `in_call -> completed/attempt_settled` only when its session
 *   already ended AND the interview's result stands: the bound attempt counted, or the round's
 *   counted attempts are all used (PR #444 review round 2, S06-R1). An attempt that ended without
 *   counting (provider_error, shutdown_forced, ...) or is not settled yet is `drained/flag_off`, so HR
 *   sees a booking to book again, never a `completed` interview that never counted. Then
 *   `set_bot('release')`. A Recall failure leaves the booking as it was (the next pass retries) and
 *   raises one `r1_meet_drain_failed` alert per pass.
 * OWED RELEASES (terminal bookings still holding a bot) are released and recorded too.
 *
 * WHAT IT NEVER DOES: create, arm or enqueue anything. With no bot to remove it makes no outbound call
 * at all, only the two narrow reads and the status moves.
 *
 * LOGS: closed words only (`R1_MEET_ALERTS`), never an id, a URL or a name. Loading this module
 * performs no I/O: the store, the Recall client, the clock and the logger are arguments.
 */

import { isRecallError } from '../../../integrations/recall/errors.js';
import {
  R1MeetJobError,
  R1_MEET_RPC_UNEXPECTED,
  parseDrainJob,
  r1MeetDefer,
  r1MeetProcessed,
  type R1MeetDrainJob,
  type R1MeetJobMeta,
  type R1MeetJobResult,
} from './jobs.js';
import {
  R1_MEET_ALERTS,
  releaseRecallBot,
  type R1MeetFlowDeps,
  type R1MeetJobDefinition,
  type R1MeetLog,
  type R1MeetReleasePort,
} from './recall-actions.js';
import type { R1MeetBooking, R1MeetSessionStatus, R1MeetStore } from './runtime-store.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** The bounds of the three doors. Frozen. */
export const R1_MEET_DRAIN = Object.freeze({
  /** (a) the operator job: rows per pass and the wall-clock budget of one pass. */
  operatorLimit: 25,
  operatorBudgetMs: 40 * SECOND_MS,
  /** (a) rows remain: the next pass soon. */
  moreDeferSec: 5,
  /** (a) only live interviews, conflicts or Recall failures remain: look again in a minute. */
  waitDeferSec: 60,
  /** (a) a drain job gives up (alert) after this many passes: two hours of one-minute waits. */
  maxPasses: 120,
  /** (b) the backstop: rows per pass, budget, and how long a booking must be untouched. */
  backstopLimit: 10,
  backstopBudgetMs: 40 * SECOND_MS,
  backstopUntouchedMs: 5 * MINUTE_MS,
});

const LIVE_SESSIONS: ReadonlySet<R1MeetSessionStatus> = new Set(['created', 'waiting', 'in_progress']);

const toIso = (ms: number): string => new Date(ms).toISOString();

/** What a drain needs: no queue, no config, no profile. The flow deps satisfy it. */
export interface R1MeetDrainPorts {
  readonly store: Pick<
    R1MeetStore,
    'listDrainable' | 'listOwedReleases' | 'sessionStatus' | 'attemptSettlement' | 'roundStart' | 'transition' | 'setBot'
  >;
  readonly recall: R1MeetReleasePort;
  readonly now: () => number;
  readonly log: R1MeetLog;
}

export interface R1MeetDrainOptions {
  readonly limit: number;
  /** Only bookings untouched this long (the backstop); null = however recent (the operator). */
  readonly untouchedForMs: number | null;
  /** Also drain a booking whose bound session is still live. */
  readonly force: boolean;
  /** The wall-clock budget of this pass. */
  readonly budgetMs: number;
}

export interface R1MeetDrainReport {
  /** `-> drained/flag_off`. */
  readonly drained: number;
  /** `in_call -> completed/attempt_settled` (its session had ended and its attempt counted). */
  readonly completed: number;
  /** Owed releases removed at Recall and recorded. */
  readonly released: number;
  /** Bookings left for a later pass: a live session, or a move another writer won. */
  readonly skipped: number;
  /** Bookings or owed releases a Recall (or database) failure left as they were. */
  readonly failed: number;
  /** A list came back full, or the budget ran out: more rows than this pass could take. */
  readonly more: boolean;
}

type Settled = 'drained' | 'completed' | 'skipped' | 'failed';

/** Record a bot released (a terminal booking only). Not `ok`: it stays an owed release for later. */
async function markReleased(ports: R1MeetDrainPorts, booking: R1MeetBooking): Promise<void> {
  const answer = await ports.store.setBot({
    bookingId: booking.id,
    action: 'release',
    expectedVersion: booking.version,
    expectedKeyAttempt: booking.keyAttempt,
    nowIso: toIso(ports.now()),
  });
  if (answer.status === 'invalid_action' || answer.status === 'invalid_request') {
    throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  }
}

/** Remove the bot at Recall; false = it cannot be removed right now (between dispatch and the call). */
async function removeBot(ports: R1MeetDrainPorts, botId: string): Promise<boolean> {
  return (await releaseRecallBot(ports.recall, botId, 'any')) !== 'retry';
}

/**
 * The interview of this call has a result that stands (`attempt_ended`'s COMPLETE rule): its bound
 * attempt counted, or the round's counted attempts are all used. Anything else (not counted, not
 * settled yet, no attempt row) is not a completed interview.
 */
async function resultStands(ports: R1MeetDrainPorts, booking: R1MeetBooking, sessionId: string): Promise<boolean> {
  const settlement = await ports.store.attemptSettlement(sessionId);
  if (settlement !== null && settlement.counted) return true;
  return booking.roundId !== null && (await ports.store.roundStart(booking.roundId, ports.now())) === 'complete';
}

async function drainBooking(ports: R1MeetDrainPorts, booking: R1MeetBooking, force: boolean): Promise<Settled> {
  let completed = false;
  if (booking.sessionId !== null) {
    const session = await ports.store.sessionStatus(booking.sessionId);
    // A live interview finishes (KNOWLEDGE: R1 live sessions finish), unless the operator forces it.
    if (session !== null && LIVE_SESSIONS.has(session) && !force) return 'skipped';
    const sessionEnded = booking.status === 'in_call' && session !== null && !LIVE_SESSIONS.has(session);
    // Reads only, before Recall: the move below is still the last step.
    completed = sessionEnded && (await resultStands(ports, booking, booking.sessionId));
  }
  if (booking.recallBotId !== null && !(await removeBot(ports, booking.recallBotId))) return 'failed';
  const answer = await ports.store.transition({
    bookingId: booking.id,
    from: booking.status,
    to: completed ? 'completed' : 'drained',
    reason: completed ? 'attempt_settled' : 'flag_off',
    nowIso: toIso(ports.now()),
  });
  // Someone else moved it (an event, a cancel): the next pass reads it again.
  if (answer.status === 'status_conflict' || answer.status === 'not_found') return 'skipped';
  if (answer.status !== 'ok') throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  if (answer.recallBotId !== null) await markReleased(ports, booking);
  return completed ? 'completed' : 'drained';
}

/** One bounded drain pass (see the header). Throws only when a list cannot be read. */
export async function drainR1Meet(ports: R1MeetDrainPorts, options: R1MeetDrainOptions): Promise<R1MeetDrainReport> {
  const startMs = ports.now();
  const deadline = startMs + options.budgetMs;
  const bookings = await ports.store.listDrainable({
    untouchedSince: options.untouchedForMs === null ? null : toIso(startMs - options.untouchedForMs),
    limit: options.limit,
  });
  const owed = await ports.store.listOwedReleases(options.limit);

  const tally = { drained: 0, completed: 0, released: 0, skipped: 0, failed: 0 };
  let more = bookings.length >= options.limit || owed.length >= options.limit;
  let failure: string | null = null;
  const noteFailure = (error: unknown): void => {
    tally.failed += 1;
    failure ??= isRecallError(error) ? `${error.operation}:${error.category}` : 'database';
  };

  for (const booking of bookings) {
    if (ports.now() >= deadline) {
      more = true;
      break;
    }
    try {
      const settled = await drainBooking(ports, booking, options.force);
      if (settled === 'failed') failure ??= 'leave:unstarted';
      tally[settled] += 1;
    } catch (error) {
      noteFailure(error);
    }
  }

  for (const booking of owed) {
    if (booking.recallBotId === null) continue;
    if (ports.now() >= deadline) {
      more = true;
      break;
    }
    try {
      if (!(await removeBot(ports, booking.recallBotId))) {
        tally.failed += 1;
        failure ??= 'leave:unstarted';
        continue;
      }
      await markReleased(ports, booking);
      tally.released += 1;
    } catch (error) {
      noteFailure(error);
    }
  }

  if (failure !== null) ports.log.error({ error_category: R1_MEET_ALERTS.drainFailed, error_type: failure });
  return Object.freeze({ ...tally, more });
}

/** Nothing left that this drain could still settle. */
export function r1MeetDrainFinished(report: R1MeetDrainReport): boolean {
  return !report.more && report.skipped === 0 && report.failed === 0;
}

/**
 * `drain` (door (a): the operator's SQL while the flag is still on). Runs a pass, then defers until
 * nothing is left: soon while rows remain, a minute while only live interviews or failures do.
 */
export const r1MeetDrainDefinition: R1MeetJobDefinition<R1MeetDrainJob> = Object.freeze({
  kind: 'drain',
  parse: parseDrainJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetDrainJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const report = await drainR1Meet(deps, {
      limit: R1_MEET_DRAIN.operatorLimit,
      untouchedForMs: null,
      force: job.force,
      budgetMs: R1_MEET_DRAIN.operatorBudgetMs,
    });
    if (r1MeetDrainFinished(report)) return r1MeetProcessed('drained');
    if (meta.deferCount >= R1_MEET_DRAIN.maxPasses) {
      deps.log.error({ error_category: R1_MEET_ALERTS.drainFailed, error_type: 'passes_exhausted' });
      return r1MeetProcessed('drain_incomplete');
    }
    return r1MeetDefer('drain_continue', report.more ? R1_MEET_DRAIN.moreDeferSec : R1_MEET_DRAIN.waitDeferSec);
  },
});
