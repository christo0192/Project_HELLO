/**
 * The `maintenance` job of the `r1-meet` runtime (M034 S06, dark; D-S06-30): the one place that re-drives
 * whatever the bookings say is still owed, so that a job lost to a crash, a dead letter or a Recall
 * outage costs a delay and never a bot that joins and bills, or a booking stuck for ever.
 *
 * WHO QUEUES IT. The existing `r1-sweep` loop of the R1 runtime (15-minute buckets, critic C8: no new
 * loop, no poller) queues ONE `maintenance { bucket }` job per bucket while Meet is active
 * (`runtime.ts`, `createR1MeetSweepTick`). The dedup key is the bucket, and the job is queued during
 * the bucket BEFORE, scheduled for its bucket's first instant: it is live until it runs, so every
 * machine's tick collapses into it and the fleet runs it once (PR #444 review S06-R5). A key only
 * stops a second LIVE job; a job queued and run at once would let the next machine queue it again.
 * The first bucket after Meet is turned on gets no run; maintenance starts with the next one.
 *
 * WHAT IT DOES, each step isolated (one failing step, or one failing booking, never stops the others)
 * and bounded (20 to 50 rows a step):
 *   owed releases      a terminal booking that still holds its bot (idx_r1_meet_bookings_owed_release):
 *                      queue its `bot_release`;
 *   overdue            a live booking whose slot ended more than 30 minutes ago: `-> failed` with
 *                      `in_past` (no bot yet: pending, blocked, unmatched, unmapped), `no_show` (the
 *                      bot entered the call but never met a human: bot_scheduled, bot_joining), `bot_fatal` (human_present:
 *                      the bridge never got in) or `admission_refused` (in_call with no session); a bot
 *                      it held is queued for release at once. An `in_call` booking WITH a session is
 *                      the attempt's to settle (next step);
 *   ended sessions     an `in_call` booking whose session is over (the orphan sweep lapsed it, or the
 *                      attempt-outcome hook was lost): queue `attempt_ended`, which completes the call
 *                      when the attempt counted and otherwise re-arms or fails it (event-handler.ts);
 *   stuck pending      untouched for 10 minutes and still creatable: queue `ensure_bot`;
 *   capped             `blocked/bot_cap_reached` with a future slot: queue `ensure_bot`, which re-checks
 *                      the cap itself (the count dropped, or the cap was raised) and stays quiet when
 *                      it is still reached;
 *   prune              every 24th bucket (6 hours): receipts and round-less bookings older than 30
 *                      days, 500 each (0142's own RPCs; they refuse anything under 7 days).
 *   feedback re-drive  (M034 S09) AFTER the steps above and OUTSIDE `R1_MEET_MAINTENANCE_STEPS`:
 *                      Lexy's scorecard feedback that a lost scorecard-ready trigger never queued
 *                      (`redriveR1MeetFeedback`, `feedback-notify.ts`: completed bookings whose slot
 *                      started 26 h to 20 min ago, at most 10). It writes its own log lines, never
 *                      throws, and leaves the job's result and the warning below unchanged. Inert
 *                      (no read) while the Ashby feedback form setting is blank.
 *   public maintenance (M035 S05) AFTER feedback, with separate bounds and warning words: invite
 *                      re-drive, undeliverable invites, calendar drift, retention, the pre-slot
 *                      Ashby status re-check, and throttle pruning. No calendar ports means no reads.
 *                      Calendar steps need usable Google settings; re-check needs public booking on.
 * Overdue pre-call bots use Recall's history before deciding no-show (S09-R5). An outage keeps the
 * booking live for six more hours, then fails the bot, never the candidate. At most ten verdict GETs
 * start in the first 30 seconds of the overdue step; remaining rows wait for the next bucket.
 * Every job it queues carries ids only and is deduplicated by its key, so a slow step that overlaps
 * the next bucket queues nothing twice.
 *
 * LOGS: a warning `r1_meet_maintenance_had_errors` naming the failed steps (closed words), never an id.
 * Loading this module performs no I/O: everything arrives in `R1MeetFlowDeps`.
 */

import { extractAshbyApplicationStatus } from '../../../integrations/ashby/candidate-profile.js';
import { isRecallError } from '../../../integrations/recall/errors.js';
import type { R1MeetBookingReason, R1MeetBookingStatus } from './bookings-read.js';
import { R1_MEET_LATE_CREATE_LIMIT_MS } from './bot-flow.js';
import { failR1MeetPublicInvite, R1_MEET_CALENDAR_SYNC, R1_MEET_PUBLIC_CALENDAR_ALERTS } from './calendar-sync.js';
import { R1_MEET_PUBLIC_INTEGER_KNOBS } from './config.js';
import { r1MeetBotAlertFor, r1MeetPreCallVerdict } from './event-handler.js';
import { redriveR1MeetFeedback } from './feedback-notify.js';
import {
  R1MeetJobError,
  R1_MEET_DEFER_MAX_COUNT,
  R1_MEET_RPC_UNEXPECTED,
  parseMaintenanceJob,
  r1MeetJobs,
  r1MeetProcessed,
  type R1MeetJobMeta,
  type R1MeetJobResult,
  type R1MeetMaintenanceJob,
} from './jobs.js';
import type { R1MeetFlowDeps, R1MeetJobDefinition } from './recall-actions.js';
import type { R1MeetBooking, R1MeetSessionStatus } from './runtime-store.js';
import { cancelFlow } from './schedule-handler.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The bounds of one maintenance run. Frozen. */
export const R1_MEET_MAINTENANCE = Object.freeze({
  owedLimit: 20,
  overdueLimit: 50,
  inCallLimit: 20,
  stuckLimit: 20,
  cappedLimit: 20,
  /** A live booking this long past its slot's end is over, whatever its status says. */
  overdueGraceMs: 30 * MINUTE_MS,
  overdueVerdictLimit: 10,
  overdueVerdictBudgetMs: 30_000,
  overdueVerdictGraceMs: 6 * 60 * MINUTE_MS,
  /** A `pending` booking untouched this long lost its create job. */
  stuckPendingMs: 10 * MINUTE_MS,
  /** Prune on every Nth bucket: 24 x 15 minutes = every 6 hours. */
  pruneEveryBuckets: 24,
  retentionMs: 30 * DAY_MS,
  pruneLimit: 500,
});

/**
 * The steps, in the order they run, and the closed words of the warning (all seven joined stay under
 * the logger's 64-character limit).
 */
export const R1_MEET_MAINTENANCE_STEPS = Object.freeze([
  'owed',
  'overdue',
  'ended',
  'stuck',
  'capped',
  'prune_receipts',
  'prune_bookings',
] as const);
export type R1MeetMaintenanceStep = (typeof R1_MEET_MAINTENANCE_STEPS)[number];

/** Where an overdue booking goes (null: not this step's). Frozen. */
const OVERDUE_REASON: Readonly<Partial<Record<R1MeetBookingStatus, R1MeetBookingReason>>> = Object.freeze({
  pending: 'in_past',
  blocked: 'in_past',
  unmatched_application: 'in_past',
  unmapped_scheduler: 'in_past',
  bot_scheduled: 'no_show',
  bot_joining: 'no_show',
  human_present: 'bot_fatal',
  in_call: 'admission_refused',
});

const ENDED_SESSIONS: ReadonlySet<R1MeetSessionStatus> = new Set(['completed', 'failed', 'cancelled', 'expired']);

const toIso = (ms: number): string => new Date(ms).toISOString();

export interface R1MeetMaintenanceReport {
  /** Rows acted on per step (a queued job, a move, a pruned row). */
  readonly counts: Readonly<Record<R1MeetMaintenanceStep, number>>;
  /** Steps that failed, fully or for one row, in step order. */
  readonly failed: readonly R1MeetMaintenanceStep[];
  readonly pruned: boolean;
}

type Deps = Pick<R1MeetFlowDeps, 'store' | 'enqueue' | 'now' | 'recall' | 'log'>;

/** Both reports use the same isolation boundary and preserve step order. */
function maintenanceStep<S extends string>(counts: Record<S, number>, failed: S[]) {
  return async (name: S, work: () => Promise<{ done: number; errors: number }>): Promise<void> => {
    try {
      const outcome = await work();
      counts[name] = outcome.done;
      if (outcome.errors > 0) failed.push(name);
    } catch {
      failed.push(name);
    }
  };
}

/** Run `work` for each item; a failing item is recorded and the rest still run. Answers items done. */
async function eachIsolated<T>(items: readonly T[], work: (item: T) => Promise<boolean>): Promise<{ done: number; errors: number }> {
  let done = 0;
  let errors = 0;
  for (const item of items) {
    try {
      if (await work(item)) done += 1;
    } catch {
      errors += 1;
    }
  }
  return { done, errors };
}

/** A terminal move for an overdue booking; a bot it held is queued for release at once. */
async function failOverdue(deps: Deps, booking: R1MeetBooking, verdicts: { count: number; startedAt: number }): Promise<boolean> {
  // In a call with a session: the attempt decides (the ended-sessions step, or its own outcome hook).
  if (booking.status === 'in_call' && booking.sessionId !== null) return false;
  let reason = OVERDUE_REASON[booking.status];
  if (reason === undefined) return false;
  let alertSubCode: string | null = null;
  if ((booking.status === 'bot_scheduled' || booking.status === 'bot_joining') && booking.recallBotId !== null) {
    const limits = R1_MEET_MAINTENANCE;
    if (verdicts.count >= limits.overdueVerdictLimit || deps.now() - verdicts.startedAt >= limits.overdueVerdictBudgetMs) return false;
    verdicts.count += 1;
    try {
      const bot = await deps.recall.getBot(booking.recallBotId);
      const verdict = r1MeetPreCallVerdict(bot.statusChanges);
      reason = verdict.botFailed ? 'bot_fatal' : 'no_show';
      alertSubCode = verdict.alertSubCode;
    } catch (error) {
      if (!(isRecallError(error) && error.category === 'not_found')) {
        if (deps.now() < Date.parse(booking.endAt) + limits.overdueGraceMs + limits.overdueVerdictGraceMs) {
          throw new R1MeetJobError('r1_meet_overdue_recall_unavailable');
        }
        reason = 'bot_fatal';
      }
    }
  }
  const answer = await deps.store.transition({
    bookingId: booking.id,
    from: booking.status,
    to: 'failed',
    reason,
    nowIso: toIso(deps.now()),
  });
  if (answer.status === 'status_conflict' || answer.status === 'not_found') return false;
  if (answer.status !== 'ok') throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  const alert = reason === 'bot_fatal' ? r1MeetBotAlertFor(alertSubCode) : null;
  if (alert !== null) deps.log.error({ error_category: alert, error_type: alertSubCode! });
  if (answer.recallBotId !== null) await deps.enqueue(r1MeetJobs.botRelease(answer.recallBotId, booking.id));
  return true;
}

/** One maintenance run for `bucket` (see the header). Never throws: a failing step is reported. */
export async function runR1MeetMaintenance(deps: Deps, bucket: number): Promise<R1MeetMaintenanceReport> {
  const counts = Object.fromEntries(R1_MEET_MAINTENANCE_STEPS.map((step) => [step, 0])) as Record<R1MeetMaintenanceStep, number>;
  const failed: R1MeetMaintenanceStep[] = [];
  const limits = R1_MEET_MAINTENANCE;

  const step = maintenanceStep(counts, failed);

  await step('owed', async () =>
    eachIsolated(await deps.store.listOwedReleases(limits.owedLimit), async (booking) => {
      if (booking.recallBotId === null) return false;
      await deps.enqueue(r1MeetJobs.botRelease(booking.recallBotId, booking.id));
      return true;
    }),
  );

  await step('overdue', async () => {
    const verdicts = { count: 0, startedAt: deps.now() };
    return eachIsolated(
      await deps.store.listOverdue(toIso(deps.now() - limits.overdueGraceMs), limits.overdueLimit),
      (booking) => failOverdue(deps, booking, verdicts),
    );
  });

  await step('ended', async () =>
    eachIsolated(await deps.store.listInCall(limits.inCallLimit), async (booking) => {
      if (booking.sessionId === null) return false;
      const status = await deps.store.sessionStatus(booking.sessionId);
      if (status === null || !ENDED_SESSIONS.has(status)) return false;
      await deps.enqueue(r1MeetJobs.attemptEnded(booking.id, booking.sessionId));
      return true;
    }),
  );

  await step('stuck', async () => {
    const nowMs = deps.now();
    const stuck = await deps.store.listStuckPending({
      untouchedSince: toIso(nowMs - limits.stuckPendingMs),
      // ensureBot still creates up to 15 minutes into the slot (late create); past that it fails it.
      startAfter: toIso(nowMs - R1_MEET_LATE_CREATE_LIMIT_MS),
      limit: limits.stuckLimit,
    });
    return eachIsolated(stuck, async (booking) => {
      await deps.enqueue(r1MeetJobs.ensureBot(booking.id));
      return true;
    });
  });

  await step('capped', async () =>
    eachIsolated(
      await deps.store.listCapBlocked({ startAfter: toIso(deps.now()), limit: limits.cappedLimit }),
      async (booking) => {
        await deps.enqueue(r1MeetJobs.ensureBot(booking.id));
        return true;
      },
    ),
  );

  const pruned = Number.isSafeInteger(bucket) && bucket % limits.pruneEveryBuckets === 0;
  if (pruned) {
    const prune = (name: 'prune_receipts' | 'prune_bookings') =>
      step(name, async () => {
        const nowMs = deps.now();
        const input = { olderThan: toIso(nowMs - limits.retentionMs), limit: limits.pruneLimit, nowIso: toIso(nowMs) };
        const answer = name === 'prune_receipts'
          ? await deps.store.pruneReceipts(input)
          : await deps.store.pruneBookings(input);
        if (answer.status !== 'ok') throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
        return { done: answer.deleted, errors: 0 };
      });
    await prune('prune_receipts');
    await prune('prune_bookings');
  }

  return Object.freeze({ counts: Object.freeze(counts), failed: Object.freeze(failed), pruned });
}

/** Separate from the classic words: all joined fit the logger's 64-character bound. */
export const R1_MEET_PUBLIC_MAINTENANCE_STEPS = Object.freeze([
  'invite', 'undeliverable', 'drift', 'retention', 'recheck', 'throttle_prune',
] as const);
export type R1MeetPublicMaintenanceStep = (typeof R1_MEET_PUBLIC_MAINTENANCE_STEPS)[number];
export const R1_MEET_PUBLIC_MAINTENANCE = Object.freeze({
  listLimit: 20,
  inviteGraceMs: 2 * MINUTE_MS,
  inviteDeadlineMs: R1_MEET_CALENDAR_SYNC.inviteDeadlineMs,
  driftSettleMs: 10 * MINUTE_MS,
  recheckFromMs: 105 * MINUTE_MS,
  recheckToMs: 120 * MINUTE_MS,
  recheckBudgetMs: 20_000,
  throttleOlderThanSec: 172800,
  throttleLimit: 5000,
  throttleMaxCalls: 4,
  pruneEveryBuckets: 24,
});
export interface R1MeetPublicMaintenanceReport {
  readonly counts: Readonly<Record<R1MeetPublicMaintenanceStep, number>>;
  readonly failed: readonly R1MeetPublicMaintenanceStep[];
  readonly skipped: boolean;
}

const NO_DEFER_META = Object.freeze({ deferCount: R1_MEET_DEFER_MAX_COUNT, deferredAt: null });

/** Public catch-up: calendar cleanup survives a public-flag rollback; re-check never does. */
export async function runR1MeetPublicMaintenance(deps: R1MeetFlowDeps, bucket: number): Promise<R1MeetPublicMaintenanceReport> {
  const counts = Object.fromEntries(R1_MEET_PUBLIC_MAINTENANCE_STEPS.map((name) => [name, 0])) as Record<R1MeetPublicMaintenanceStep, number>;
  const failed: R1MeetPublicMaintenanceStep[] = [];
  const report = (skipped: boolean): R1MeetPublicMaintenanceReport =>
    Object.freeze({ counts: Object.freeze(counts), failed: Object.freeze(failed), skipped });
  const calendar = deps.calendar;
  if (calendar === undefined) return report(true);
  const googleAvailable = calendar.google() !== null;
  const config = calendar.publicConfig();
  const recheck = config.status === 'on' && config.preSlotRecheck;
  if (!googleAvailable && !recheck) return report(true);
  const limits = R1_MEET_PUBLIC_MAINTENANCE;
  const limit = limits.listLimit;
  const step = maintenanceStep(counts, failed);

  if (googleAvailable) {
    await step('invite', async () => {
      const nowMs = deps.now();
      return eachIsolated(await calendar.store.listInviteOwed({
        createdBefore: toIso(nowMs - limits.inviteGraceMs),
        startAfter: toIso(nowMs + limits.inviteDeadlineMs), limit,
      }), async (booking) => {
        await deps.enqueue(r1MeetJobs.calendarSync('invite', booking.id));
        return true;
      });
    });
    await step('undeliverable', async () => eachIsolated(
      await calendar.store.listInviteDeadline({ startBefore: toIso(deps.now() + limits.inviteDeadlineMs), limit }),
      (booking) => failR1MeetPublicInvite(deps, booking, 'invite_deadline'),
    ));
    await step('drift', async () => {
      const nowMs = deps.now();
      const outcome = await eachIsolated(await calendar.store.listCalendarDrift({
        startAfter: toIso(nowMs), updatedBefore: toIso(nowMs - limits.driftSettleMs), limit,
      }), async (booking) => {
        await deps.enqueue(r1MeetJobs.calendarSync('cancel', booking.id));
        return true;
      });
      if (outcome.done > 0) deps.log.error({ error_category: R1_MEET_PUBLIC_CALENDAR_ALERTS.calendarDrift, error_type: `queued_${outcome.done}` });
      return outcome;
    });
    await step('retention', async () => {
      const days = config.status === 'on' ? config.calendarRetentionDays : R1_MEET_PUBLIC_INTEGER_KNOBS.R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS.default;
      return eachIsolated(await calendar.store.listRetention({ endBefore: toIso(deps.now() - days * DAY_MS), limit }), async (booking) => {
        await deps.enqueue(r1MeetJobs.calendarSync('purge', booking.id));
        return true;
      });
    });
  }

  if (recheck) await step('recheck', async () => {
    const startedAt = deps.now();
    const rows = await calendar.store.listRecheck({
      startFrom: toIso(startedAt + limits.recheckFromMs), startTo: toIso(startedAt + limits.recheckToMs), limit,
    });
    return eachIsolated(rows, async (booking) => {
      if (deps.now() - startedAt >= limits.recheckBudgetMs) return false;
      const ashby = calendar.ashby();
      if (ashby === null) throw new R1MeetJobError('r1_meet_public_recheck_unavailable');
      const status = extractAshbyApplicationStatus((await ashby.applicationInfo(booking.applicationId)).results);
      if (status === null || status.trim() === '') throw new R1MeetJobError('r1_meet_public_recheck_unreadable');
      if (status === 'Active') return false;
      const result = await cancelFlow(deps, booking.id, 'cancelled', NO_DEFER_META);
      if (result.outcome !== 'done' || result.receipt !== 'processed') return false;
      deps.log.info({ error_category: 'r1_meet_public_recheck', error_type: 'cancelled' });
      return true;
    });
  });

  if (googleAvailable && Number.isSafeInteger(bucket) && bucket % limits.pruneEveryBuckets === 0) {
    await step('throttle_prune', async () => {
      let done = 0;
      for (let call = 0; call < limits.throttleMaxCalls; call += 1) {
        const deleted = await calendar.store.throttlePrune({
          olderThanSec: limits.throttleOlderThanSec, limit: limits.throttleLimit, nowIso: toIso(deps.now()),
        });
        done += deleted;
        if (deleted < limits.throttleLimit) break;
      }
      return { done, errors: 0 };
    });
  }
  return report(false);
}

/** `maintenance` (the `r1-sweep` tick, once per 15-minute bucket while Meet is active). */
export const r1MeetMaintenanceDefinition: R1MeetJobDefinition<R1MeetMaintenanceJob> = Object.freeze({
  kind: 'maintenance',
  parse: parseMaintenanceJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetMaintenanceJob, _meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const report = await runR1MeetMaintenance(deps, job.bucket);
    // M034 S09: outside the pinned steps (its own lines; never throws; no read while feedback is off).
    await redriveR1MeetFeedback(deps);
    const publicReport = await runR1MeetPublicMaintenance(deps, job.bucket);
    // Closed step names only. The next bucket's run retries whatever is still owed.
    if (report.failed.length > 0) {
    deps.log.warn({ error_category: 'r1_meet_maintenance_had_errors', error_type: report.failed.join(':') });
    }
    if (publicReport.failed.length > 0) {
      deps.log.warn({ error_category: 'r1_meet_public_maintenance_had_errors', error_type: publicReport.failed.join(':') });
    }
    return r1MeetProcessed(report.failed.length > 0 || publicReport.failed.length > 0 ? 'maintenance_had_errors' : 'maintenance');
  },
});
