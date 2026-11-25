/**
 * M034 S06 T5: the `maintenance` job (lib/r1/meet/maintenance.ts), driven against the in-memory 0142
 * port (T2 harness).
 *
 * Pinned (D-S06-30, D-S06-16):
 *  - each step: owed releases -> `bot_release`; overdue live bookings -> their terminal reason (and a
 *    held bot queued for release); an `in_call` booking whose session ended -> `attempt_ended`; stuck
 *    `pending` and capped bookings -> `ensure_bot`;
 *  - the bounds of every step and the 30-minute, 10-minute and late-create edges;
 *  - one failing step (or one failing row) does not stop the others, and is reported once, by name;
 *  - prunes every 24th bucket only, with a 30-day cutoff and a limit of 500;
 *  - the daily cap: a capped booking is re-driven, stays quiet while still capped, and gets its bot
 *    once the cap allows;
 *  - only ids in what it queues, never an id in a log line.
 */

import { describe, expect, it } from 'vitest';
import { ensureBot } from '../lib/r1/meet/bot-flow.js';
import { parseMaintenanceJob } from '../lib/r1/meet/jobs.js';
import {
  R1_MEET_MAINTENANCE,
  r1MeetMaintenanceDefinition,
  runR1MeetMaintenance,
} from '../lib/r1/meet/maintenance.js';
import { r1MeetEnsureBotDefinition } from '../lib/r1/meet/schedule-handler.js';
import type { Row } from './support/r1-meet-fake-db.js';
import { MEET_URL, createR1MeetHarness, fixtureId, type R1MeetHarness } from './support/r1-meet-harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const ROUND_BOUND = new Set(['pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed']);
const HOLDS_BOT = new Set(['bot_scheduled', 'bot_joining', 'human_present', 'in_call']);
const DEFAULT_REASON: Record<string, string> = {
  pending: 'eligible',
  bot_scheduled: 'eligible',
  bot_joining: 'eligible',
  human_present: 'eligible',
  in_call: 'eligible',
  blocked: 'paused',
  unmatched_application: 'application_unknown',
  unmapped_scheduler: 'scheduler_unmapped',
  failed: 'no_show',
  completed: 'attempt_settled',
};

interface SeedOptions {
  readonly reason?: string;
  readonly startInMs?: number;
  readonly durationMs?: number;
  readonly updatedAgoMs?: number;
  readonly bot?: boolean;
  readonly sessionId?: string | null;
}

/** A booking row in `status`, valid under the 0142 CHECKs (a round, a bot, a slot as needed). */
function seed(h: R1MeetHarness, status: string, o: SeedOptions = {}): Row {
  const start = h.now() + (o.startInMs ?? DAY);
  const round = ROUND_BOUND.has(status) ? h.db.addRound() : null;
  return h.db.seedBooking({
    status,
    reason: o.reason ?? DEFAULT_REASON[status],
    round_id: round === null ? null : round.id,
    recall_bot_id: HOLDS_BOT.has(status) || o.bot === true ? fixtureId() : null,
    start_at: iso(start),
    end_at: iso(start + (o.durationMs ?? 45 * MINUTE)),
    session_id: o.sessionId ?? null,
    updated_at: iso(h.now() - (o.updatedAgoMs ?? 0)),
  });
}

/** A slot that ended `endedAgoMs` ago. */
const ended = (endedAgoMs: number): SeedOptions => ({ startInMs: -(endedAgoMs + 45 * MINUTE), durationMs: 45 * MINUTE });

const statusOf = (h: R1MeetHarness, row: Row): [unknown, unknown] => {
  const fresh = h.db.booking(row.id as string)!;
  return [fresh.status, fresh.reason];
};

const queued = (h: R1MeetHarness, kind: string): Array<Record<string, unknown>> =>
  h.db.jobs(kind).map((job) => job.payload as Record<string, unknown>);

function expectNoPii(h: R1MeetHarness): void {
  const text = JSON.stringify({ logs: h.logs, jobs: h.db.tables.job_queue.map((job) => job.payload) });
  for (const value of [MEET_URL, 'meet.google.com', '@']) expect(text).not.toContain(value);
  for (const booking of h.db.tables.r1_meet_bookings) expect(JSON.stringify(h.logs)).not.toContain(booking.id as string);
}

describe('the definition', () => {
  it('parses its payload and answers processed `maintenance` when every step ran', async () => {
    const h = createR1MeetHarness();
    const job = parseMaintenanceJob({ kind: 'maintenance', bucket: 7 })!;
    expect(r1MeetMaintenanceDefinition.parse({ kind: 'maintenance', bucket: -1 })).toBeNull();
    await expect(r1MeetMaintenanceDefinition.run(h.deps, job, h.meta())).resolves.toEqual({
      outcome: 'done',
      receipt: 'processed',
      code: 'maintenance',
    });
    expect(h.logs).toEqual([]);
  });
});

describe('owed releases', () => {
  it('queues one bot_release per terminal booking still holding its bot, at most 20', async () => {
    const h = createR1MeetHarness();
    const owed = Array.from({ length: 25 }, () => seed(h, 'failed', { bot: true }));
    seed(h, 'failed'); // released already: not owed
    const report = await runR1MeetMaintenance(h.deps, 1);
    expect(report.counts.owed).toBe(R1_MEET_MAINTENANCE.owedLimit);
    const jobs = queued(h, 'bot_release');
    expect(jobs).toHaveLength(20);
    const owedBots = new Set(owed.map((row) => row.recall_bot_id));
    for (const job of jobs) {
      expect(Object.keys(job).sort()).toEqual(['booking_id', 'kind', 'recall_bot_id']);
      expect(owedBots.has(job.recall_bot_id)).toBe(true);
    }
    // A second run in the same window queues nothing twice (the trigger's dedup key).
    await runR1MeetMaintenance(h.deps, 2);
    expect(queued(h, 'bot_release')).toHaveLength(20);
    expectNoPii(h);
  });
});

describe('overdue bookings (slot ended more than 30 minutes ago)', () => {
  it('moves each live status to its terminal reason and queues the release of a held bot', async () => {
    const h = createR1MeetHarness();
    const cases: Array<[string, string]> = [
      ['pending', 'in_past'],
      ['blocked', 'in_past'],
      ['unmatched_application', 'in_past'],
      ['unmapped_scheduler', 'in_past'],
      ['bot_scheduled', 'no_show'],
      ['bot_joining', 'no_show'],
      ['human_present', 'bot_fatal'],
      ['in_call', 'admission_refused'],
    ];
    const rows = cases.map(([status]) => seed(h, status, ended(31 * MINUTE)));
    const report = await runR1MeetMaintenance(h.deps, 1);
    expect(report.failed).toEqual([]);
    expect(report.counts.overdue).toBe(cases.length);
    rows.forEach((row, index) => expect(statusOf(h, row), cases[index]![0]).toEqual(['failed', cases[index]![1]]));
    const releases = queued(h, 'bot_release').map((job) => job.recall_bot_id).sort();
    expect(releases).toEqual(rows.filter((row) => row.recall_bot_id !== null).map((row) => row.recall_bot_id).sort());
    expect(releases).toHaveLength(4);
    expectNoPii(h);
  });

  it('leaves a slot ended under 30 minutes ago, and an in_call booking with a session, alone', async () => {
    const h = createR1MeetHarness();
    const recent = seed(h, 'bot_joining', ended(29 * MINUTE));
    const round = h.db.addRound();
    const session = h.db.addSession({ interview_round_id: round.id as string, status: 'in_progress' });
    const withSession = h.db.seedBooking({
      status: 'in_call',
      reason: 'eligible',
      round_id: round.id,
      recall_bot_id: fixtureId(),
      session_id: session.id,
      start_at: iso(h.now() - 2 * HOUR),
      end_at: iso(h.now() - HOUR),
    });
    await runR1MeetMaintenance(h.deps, 1);
    expect(statusOf(h, recent)).toEqual(['bot_joining', 'eligible']);
    expect(statusOf(h, withSession)).toEqual(['in_call', 'eligible']);
    expect(queued(h, 'bot_release')).toEqual([]);
  });

  it('takes at most 50 a run, oldest slot first', async () => {
    const h = createR1MeetHarness();
    const rows = Array.from({ length: 55 }, (_unused, index) => seed(h, 'blocked', ended(HOUR + index * MINUTE)));
    const report = await runR1MeetMaintenance(h.deps, 1);
    expect(report.counts.overdue).toBe(R1_MEET_MAINTENANCE.overdueLimit);
    const stillBlocked = rows.filter((row) => h.db.booking(row.id as string)!.status === 'blocked');
    // The five most recently ended are left for the next bucket.
    expect(stillBlocked.map((row) => row.id)).toEqual(rows.slice(0, 5).map((row) => row.id));
  });

  it('one failing move does not stop the others, and the step is reported', async () => {
    const h = createR1MeetHarness();
    const rows = [seed(h, 'blocked', ended(2 * HOUR)), seed(h, 'blocked', ended(HOUR))];
    h.db.failNext('r1_meet_transition_booking');
    const report = await runR1MeetMaintenance(h.deps, 1);
    expect(report.failed).toEqual(['overdue']);
    expect(report.counts.overdue).toBe(1);
    expect(statusOf(h, rows[0]!)).toEqual(['blocked', 'paused']);
    expect(statusOf(h, rows[1]!)).toEqual(['failed', 'in_past']);
  });
});

describe('in_call bookings whose session ended', () => {
  it('queues attempt_ended for an ended session only', async () => {
    const h = createR1MeetHarness();
    const rows: Record<string, Row> = {};
    for (const status of ['completed', 'failed', 'cancelled', 'expired', 'in_progress', 'waiting']) {
      const round = h.db.addRound();
      const session = h.db.addSession({ interview_round_id: round.id as string, status });
      rows[status] = h.db.seedBooking({
        status: 'in_call',
        reason: 'eligible',
        round_id: round.id,
        recall_bot_id: fixtureId(),
        session_id: session.id,
        start_at: iso(h.now() - 10 * MINUTE),
        end_at: iso(h.now() + 35 * MINUTE),
      });
    }
    seed(h, 'in_call', { startInMs: -10 * MINUTE }); // no session yet: not this step's
    const report = await runR1MeetMaintenance(h.deps, 1);
    expect(report.counts.ended).toBe(4);
    const jobs = queued(h, 'attempt_ended');
    expect(jobs.map((job) => job.booking_id).sort()).toEqual(
      ['completed', 'failed', 'cancelled', 'expired'].map((status) => rows[status]!.id).sort(),
    );
    for (const job of jobs) expect(Object.keys(job).sort()).toEqual(['booking_id', 'kind', 'session_id']);
    // The statuses are the attempt's to settle: nothing moved here.
    for (const row of Object.values(rows)) expect(statusOf(h, row)).toEqual(['in_call', 'eligible']);
  });
});

describe('stuck pending and capped bookings', () => {
  it('re-drives a pending booking untouched for 10 minutes that can still get a bot', async () => {
    const h = createR1MeetHarness();
    const stuck = seed(h, 'pending', { updatedAgoMs: 11 * MINUTE });
    const lateButCreatable = seed(h, 'pending', { updatedAgoMs: 11 * MINUTE, startInMs: -10 * MINUTE });
    seed(h, 'pending', { updatedAgoMs: 5 * MINUTE }); // recently touched: its own job is still on it
    seed(h, 'pending', { updatedAgoMs: 11 * MINUTE, startInMs: -20 * MINUTE }); // past the late-create limit
    const report = await runR1MeetMaintenance(h.deps, 1);
    expect(report.counts.stuck).toBe(2);
    expect(queued(h, 'ensure_bot').map((job) => job.booking_id).sort()).toEqual([stuck.id, lateButCreatable.id].sort());
  });

  it('re-drives a capped booking with a future slot only', async () => {
    const h = createR1MeetHarness();
    const future = seed(h, 'blocked', { reason: 'bot_cap_reached' });
    seed(h, 'blocked', { reason: 'bot_cap_reached', startInMs: -10 * MINUTE });
    seed(h, 'blocked', { reason: 'paused' });
    const report = await runR1MeetMaintenance(h.deps, 1);
    expect(report.counts.capped).toBe(1);
    expect(queued(h, 'ensure_bot').map((job) => job.booking_id)).toEqual([future.id]);
  });

  it('the daily cap: blocked with an alert, quiet while still capped, a bot once the cap allows', async () => {
    const h = createR1MeetHarness({ config: { dailyBotCap: 1 } });
    const startAt = iso(h.now() + DAY);
    const first = await h.createBooking({ startAt });
    expect(await ensureBot(h.deps, first.bookingId, h.meta())).toMatchObject({ code: 'bot_scheduled' });
    const second = await h.createBooking({ startAt: iso(Date.parse(startAt) + HOUR) });
    expect(await ensureBot(h.deps, second.bookingId, h.meta())).toMatchObject({ code: 'bot_cap_reached' });
    expect(h.alerts()).toEqual(['r1_meet_bot_cap_reached']);
    expect(h.db.booking(second.bookingId)).toMatchObject({ status: 'blocked', reason: 'bot_cap_reached' });

    await runR1MeetMaintenance(h.deps, 1);
    const [job] = queued(h, 'ensure_bot');
    expect(job).toEqual({ kind: 'ensure_bot', booking_id: second.bookingId });
    const parsed = r1MeetEnsureBotDefinition.parse(job)!;
    h.logs.length = 0;
    const creates = h.requests.filter((request) => request.op === 'create').length;
    expect(await r1MeetEnsureBotDefinition.run(h.deps, parsed, h.meta())).toMatchObject({ receipt: 'ignored', code: 'bot_cap_reached' });
    expect(h.alerts()).toEqual([]);
    expect(h.requests.filter((request) => request.op === 'create')).toHaveLength(creates);

    h.config.dailyBotCap = 2;
    expect(await r1MeetEnsureBotDefinition.run(h.deps, parsed, h.meta())).toMatchObject({ code: 'bot_scheduled' });
    expect(h.db.booking(second.bookingId)).toMatchObject({ status: 'bot_scheduled' });
    expectNoPii(h);
  });
});

describe('isolation and the prune cadence', () => {
  it('a failing step does not stop the next ones, and the warning names it', async () => {
    const h = createR1MeetHarness();
    const stuck = seed(h, 'pending', { updatedAgoMs: 11 * MINUTE });
    // The next bookings read (the owed list) fails.
    h.db.failNext('r1_meet_bookings');
    const job = parseMaintenanceJob({ kind: 'maintenance', bucket: 1 })!;
    await expect(r1MeetMaintenanceDefinition.run(h.deps, job, h.meta())).resolves.toMatchObject({
      receipt: 'processed',
      code: 'maintenance_had_errors',
    });
    expect(queued(h, 'ensure_bot').map((row) => row.booking_id)).toEqual([stuck.id]);
    expect(h.logs).toEqual([
      { level: 'warn', meta: { error_category: 'r1_meet_maintenance_had_errors', error_type: 'owed' } },
    ]);
  });

  it('prunes every 24th bucket only, 30 days back, 500 at most, each prune on its own', async () => {
    const h = createR1MeetHarness();
    const pruneCalls = () => h.db.calls.filter((call) => call.kind === 'rpc' && call.name.startsWith('r1_meet_prune_'));

    const off = await runR1MeetMaintenance(h.deps, 25);
    expect(off.pruned).toBe(false);
    expect(pruneCalls()).toEqual([]);

    h.db.failNext('r1_meet_prune_receipts');
    const on = await runR1MeetMaintenance(h.deps, 48);
    expect(on.pruned).toBe(true);
    expect(on.failed).toEqual(['prune_receipts']);
    const calls = pruneCalls();
    expect(calls.map((call) => call.name)).toEqual(['r1_meet_prune_receipts', 'r1_meet_prune_bookings']);
    for (const call of calls) {
      expect(call.args).toEqual({ p_older_than: iso(h.now() - 30 * DAY), p_limit: 500, p_now: iso(h.now()) });
    }
  });

  it('prunes what is older than 30 days', async () => {
    const h = createR1MeetHarness();
    const old = h.db.seedBooking({
      status: 'cancelled',
      reason: 'cancelled',
      start_at: iso(h.now() - 31 * DAY),
      end_at: iso(h.now() - 31 * DAY + 45 * MINUTE),
    });
    const young = h.db.seedBooking({
      status: 'cancelled',
      reason: 'cancelled',
      start_at: iso(h.now() - 29 * DAY),
      end_at: iso(h.now() - 29 * DAY + 45 * MINUTE),
    });
    const report = await runR1MeetMaintenance(h.deps, 0);
    expect(report.counts.prune_bookings).toBe(1);
    expect(h.db.booking(old.id as string)).toBeUndefined();
    expect(h.db.booking(young.id as string)).toBeDefined();
  });
});
