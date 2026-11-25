/**
 * M034 S06 T5: the drain (lib/r1/meet/drain.ts) and its three doors: the operator's `drain` job, the
 * flag-off backstop of the `r1-sweep` tick (lib/r1/meet/runtime.ts), and the doors that must NEVER
 * open. Driven through the REAL Recall client over the S01 fake and the in-memory 0142 port.
 *
 * Pinned (D-S06-31, D-S06-32, plan 2.5):
 *  - every drainable status: the bot released at Recall first (one GET, then DELETE or leave_call),
 *    then `-> drained/flag_off`, then the release recorded; no bot, no outbound call;
 *  - a live interview is skipped unless forced; an `in_call` booking whose session ended is completed
 *    only when its attempt counted (or the round's counted attempts are all used), else it is
 *    drained/flag_off so HR books again (PR #444 review round 2, S06-R1);
 *  - Recall down: nothing is marked, one alert, the next pass finishes; owed releases are included;
 *  - the backstop: only bookings untouched for 5 minutes, bounded, once per bucket unless rows remain;
 *  - `invalid` never drains, R1 off with the Meet flag on never drains, no key = zero queries and zero
 *    fetch; the standalone storage runtime (R1 off) drains when the Meet flag is off;
 *  - the operator job loops (deferring) until done, and gives up loudly after its bound.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { armBridge } from '../lib/r1/meet/arm.js';
import { ensureBot } from '../lib/r1/meet/bot-flow.js';
import { getR1MeetConfig, getR1MeetDrainConfig, type R1MeetConfig, type R1MeetDrainConfig } from '../lib/r1/meet/config.js';
import { R1_MEET_DRAIN, drainR1Meet, r1MeetDrainDefinition, type R1MeetDrainOptions } from '../lib/r1/meet/drain.js';
import { r1MeetJobMeta } from '../lib/r1/meet/jobs.js';
import { createR1MeetSweepTick, type R1MeetLane } from '../lib/r1/meet/runtime.js';
import { MemoryR1ObjectStore } from '../lib/r1/recording/memory-store.js';
import { createR1StorageRuntime } from '../lib/r1/runtime.js';
import { FAKE_RECALL_API_KEY } from './support/recall-fake.js';
import { enabledRecordingConfig } from './support/r1-recording-harness.js';
import {
  BRIDGE_PAGE_URL,
  BRIDGE_SOURCE,
  MEET_URL,
  createR1MeetHarness,
  type R1MeetHarness,
} from './support/r1-meet-harness.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const iso = (ms: number): string => new Date(ms).toISOString();

const DISABLED: R1MeetConfig = { enabled: false, status: 'disabled' };
const INVALID: R1MeetConfig = { enabled: false, status: 'invalid', reason: 'R1_MEET_ENABLED must be either "true" or "false"' };
const KEY: R1MeetDrainConfig = getR1MeetDrainConfig({ RECALL_API_KEY: FAKE_RECALL_API_KEY });
const NO_KEY: R1MeetDrainConfig = getR1MeetDrainConfig({});

const OPERATOR: R1MeetDrainOptions = { limit: 25, untouchedForMs: null, force: false, budgetMs: 40 * SECOND };

afterEach(() => {
  vi.restoreAllMocks();
});

type Start = 'pending' | 'bot_scheduled' | 'bot_joining' | 'human_present' | 'in_call' | 'in_call_session' | 'failed_owed';

interface Booked {
  readonly id: string;
  readonly botId: string | null;
  readonly sessionId: string | null;
}

/**
 * A booking in `start`, reached through the real RPCs and flows (create, ensureBot, the moves, a real
 * arm and claim, a bound session), its Recall bot mirrored at the fake. The slot starts a minute from
 * now, so the ticket window is open. Traces are cleared at the end.
 */
async function booked(h: R1MeetHarness, start: Start, options: { readonly sessionStatus?: string } = {}): Promise<Booked> {
  const created = await h.createBooking({ startAt: iso(h.now() + MINUTE) });
  const id = created.bookingId;
  let sessionId: string | null = null;
  if (start !== 'pending') {
    expect(await ensureBot(h.deps, id, h.meta())).toMatchObject({ code: 'bot_scheduled' });
  }
  const botId = (h.db.booking(id)!.recall_bot_id as string | null) ?? null;
  const move = async (from: string, to: string, reason = 'eligible'): Promise<void> => {
    const answer = await h.db.store.transition({ bookingId: id, from: from as never, to: to as never, reason: reason as never, nowIso: iso(h.now()) });
    expect(answer.status).toBe('ok');
  };
  if (start === 'bot_joining') {
    h.recall.markDispatched(botId!);
    h.recall.setStatus(botId!, 'joining_call');
    await move('bot_scheduled', 'bot_joining');
  }
  if (start === 'human_present' || start === 'in_call' || start === 'in_call_session') {
    h.recall.markDispatched(botId!);
    h.recall.setStatus(botId!, 'in_call_recording');
    await move('bot_scheduled', 'human_present');
  }
  if (start === 'in_call' || start === 'in_call_session') {
    expect(await armBridge(h.deps, (await h.db.store.getBooking(id))!, h.meta())).toMatchObject({ code: 'armed' });
    const page = h.requests.filter((request) => request.op === 'output_media').at(-1)!;
    const url = (page.body as { camera: { config: { url: string } } }).camera.config.url;
    const claimed = await h.db.claimTicket(url.slice(`${BRIDGE_PAGE_URL}#t=`.length), iso(h.now()), BRIDGE_SOURCE);
    expect(claimed.data).toMatchObject({ status: 'ok' });
    if (start === 'in_call_session') {
      const round = h.db.booking(id)!.round_id as string;
      const session = h.db.addSession({ interview_round_id: round, status: options.sessionStatus ?? 'in_progress' });
      expect((await h.db.bind(id, session.id as string, iso(h.now()))).data).toMatchObject({ status: 'ok' });
      sessionId = session.id as string;
    }
  }
  if (start === 'failed_owed') await move('bot_scheduled', 'failed', 'no_show');
  h.timeline.length = 0;
  h.requests.length = 0;
  h.logs.length = 0;
  h.db.calls.length = 0;
  return { id, botId, sessionId };
}

const row = (h: R1MeetHarness, b: Booked) => h.db.booking(b.id)!;
const ops = (h: R1MeetHarness) => h.requests.map((request) => request.op);
const roundOf = (h: R1MeetHarness, b: Booked) => h.db.tables.interview_rounds.find((round) => round.id === row(h, b).round_id)!;
/** What `r1_settle_attempt` leaves for the booking's bound session. */
const settle = (h: R1MeetHarness, b: Booked, outcome: string | null, counted: boolean) =>
  h.db.addAttempt({ session_id: b.sessionId!, round_id: row(h, b).round_id as string, outcome, counted });

/** Jobs hold ids and nothing else; log lines hold not even an id. */
function expectNoPii(h: R1MeetHarness): void {
  const logs = JSON.stringify(h.logs);
  const text = JSON.stringify({ logs: h.logs, jobs: h.db.tables.job_queue.map((job) => job.payload) });
  for (const value of [MEET_URL, 'meet.google.com', '@', BRIDGE_PAGE_URL]) expect(text).not.toContain(value);
  for (const booking of h.db.tables.r1_meet_bookings) {
    expect(logs).not.toContain(booking.id as string);
    if (booking.recall_bot_id !== null) expect(logs).not.toContain(booking.recall_bot_id as string);
  }
}

describe('drainR1Meet: every drainable status', () => {
  it('releases at Recall first, then drained/flag_off, then the release recorded; no bot means no call', async () => {
    const h = createR1MeetHarness();
    const bookings = {
      pending: await booked(h, 'pending'),
      bot_scheduled: await booked(h, 'bot_scheduled'),
      bot_joining: await booked(h, 'bot_joining'),
      human_present: await booked(h, 'human_present'),
      in_call: await booked(h, 'in_call'),
    };
    const report = await drainR1Meet(h.deps, OPERATOR);
    expect(report).toEqual({ drained: 5, completed: 0, released: 0, skipped: 0, failed: 0, more: false });
    for (const [status, b] of Object.entries(bookings)) {
      expect(row(h, b), status).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
    }
    // The undispatched bot is deleted, the dispatched ones leave; the pending booking costs no call.
    const byBot = (botId: string | null) => h.requests.filter((request) => botId !== null && request.path.includes(botId)).map((request) => request.op);
    expect(byBot(bookings.bot_scheduled.botId)).toEqual(['get', 'delete']);
    for (const status of ['bot_joining', 'human_present', 'in_call'] as const) {
      expect(byBot(bookings[status].botId), status).toEqual(['get', 'leave']);
    }
    expect(ops(h)).not.toContain('create');
    expect(ops(h)).not.toContain('output_media');
    // Per booking: Recall, then the move, then the release.
    const steps = h.timeline.filter((step) => step.startsWith('recall:') || step.startsWith('db:transition') || step.startsWith('db:set_bot'));
    expect(steps.slice(-3)).toEqual(['recall:leave', 'db:transition:drained', 'db:set_bot:release']);
    expect(h.alerts()).toEqual([]);
    expectNoPii(h);
  });

  it('skips a live interview unless forced, and completes one whose session ended with a counted attempt', async () => {
    const h = createR1MeetHarness();
    const live = await booked(h, 'in_call_session', { sessionStatus: 'in_progress' });
    const over = await booked(h, 'in_call_session', { sessionStatus: 'completed' });
    settle(h, over, 'complete', true);
    const first = await drainR1Meet(h.deps, OPERATOR);
    expect(first).toMatchObject({ drained: 0, completed: 1, skipped: 1, failed: 0 });
    expect(row(h, live)).toMatchObject({ status: 'in_call', recall_bot_id: live.botId });
    expect(row(h, over)).toMatchObject({ status: 'completed', reason: 'attempt_settled', recall_bot_id: null });
    expect(h.requests.filter((request) => request.path.includes(live.botId!))).toEqual([]);

    const forced = await drainR1Meet(h.deps, { ...OPERATOR, force: true });
    expect(forced).toMatchObject({ drained: 1, skipped: 0 });
    expect(row(h, live)).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
  });

  it('an ended session whose attempt did NOT count (or is not settled) is drained/flag_off, never completed (PR #444 round 2, S06-R1)', async () => {
    const h = createR1MeetHarness();
    // The worker ended the attempt with an outcome that does not count, the bot is still in the call
    // (a re-armed ticket waiting for its claim): HR must see a booking to book again.
    const uncounted = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
    settle(h, uncounted, 'provider_error', false);
    const shutdown = await booked(h, 'in_call_session', { sessionStatus: 'completed' });
    settle(h, shutdown, 'shutdown_forced', false);
    // The session ended but its outcome never arrived (no worker joined): not a completed interview.
    const unsettled = await booked(h, 'in_call_session', { sessionStatus: 'expired' });
    settle(h, unsettled, null, false);
    const noAttempt = await booked(h, 'in_call_session', { sessionStatus: 'failed' });

    const report = await drainR1Meet(h.deps, OPERATOR);
    expect(report).toEqual({ drained: 4, completed: 0, released: 0, skipped: 0, failed: 0, more: false });
    for (const b of [uncounted, shutdown, unsettled, noAttempt]) {
      expect(row(h, b)).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
    }
    // The bots still leave first, then the move, then the release.
    expect(ops(h)).toEqual(['get', 'leave', 'get', 'leave', 'get', 'leave', 'get', 'leave']);
    expect(h.db.tables.r1_meet_bookings.some((booking) => booking.status === 'completed')).toBe(false);
    expectNoPii(h);
  });

  it('an ended session whose round has all its counted attempts (an earlier attempt counted) is completed', async () => {
    const h = createR1MeetHarness();
    const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
    settle(h, b, 'provider_error', false);
    roundOf(h, b).attempts_counted = roundOf(h, b).attempts_allowed;
    expect(await drainR1Meet(h.deps, OPERATOR)).toMatchObject({ drained: 0, completed: 1 });
    expect(row(h, b)).toMatchObject({ status: 'completed', reason: 'attempt_settled', recall_bot_id: null });
  });

  it('a settlement read that fails leaves the booking as it was (one alert); the next pass settles it', async () => {
    const h = createR1MeetHarness();
    const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
    settle(h, b, 'provider_error', false);
    h.db.failNext('interview_round_attempts');
    expect(await drainR1Meet(h.deps, OPERATOR)).toMatchObject({ drained: 0, completed: 0, failed: 1 });
    expect(row(h, b)).toMatchObject({ status: 'in_call', recall_bot_id: b.botId });
    // Nothing was sent to Recall: the reads come before the leave.
    expect(h.requests).toEqual([]);
    expect(h.alerts()).toEqual(['r1_meet_drain_failed']);
    expect(await drainR1Meet(h.deps, OPERATOR)).toMatchObject({ drained: 1, failed: 0 });
    expect(row(h, b)).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
  });

  it('Recall down: nothing is marked, one alert; the next pass finishes', async () => {
    const h = createR1MeetHarness();
    const b = await booked(h, 'bot_joining');
    h.intercept('get', { status: 503 });
    const first = await drainR1Meet(h.deps, OPERATOR);
    expect(first).toMatchObject({ drained: 0, failed: 1 });
    expect(row(h, b)).toMatchObject({ status: 'bot_joining', recall_bot_id: b.botId });
    expect(h.logs.filter((line) => line.level === 'error').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_drain_failed', error_type: 'bot.get:http_server_error' },
    ]);
    const second = await drainR1Meet(h.deps, OPERATOR);
    expect(second).toMatchObject({ drained: 1, failed: 0 });
    expect(row(h, b)).toMatchObject({ status: 'drained', recall_bot_id: null });
  });

  it('a bot between dispatch and its call (cannot_command_unstarted_bot) is left for the next pass', async () => {
    const h = createR1MeetHarness();
    const b = await booked(h, 'bot_joining');
    h.intercept('leave', { status: 400, body: { code: 'cannot_command_unstarted_bot' } });
    expect(await drainR1Meet(h.deps, OPERATOR)).toMatchObject({ drained: 0, failed: 1 });
    expect(row(h, b).status).toBe('bot_joining');
    expect(await drainR1Meet(h.deps, OPERATOR)).toMatchObject({ drained: 1, failed: 0 });
  });

  it('includes owed releases: a terminal booking still holding its bot', async () => {
    const h = createR1MeetHarness();
    const b = await booked(h, 'failed_owed');
    const report = await drainR1Meet(h.deps, OPERATOR);
    expect(report).toMatchObject({ released: 1, drained: 0 });
    expect(row(h, b)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
    expect(ops(h)).toEqual(['get', 'delete']);
  });

  it('the backstop touches only bookings untouched for 5 minutes', async () => {
    const h = createR1MeetHarness();
    const b = await booked(h, 'bot_scheduled');
    const backstop: R1MeetDrainOptions = {
      limit: R1_MEET_DRAIN.backstopLimit,
      untouchedForMs: R1_MEET_DRAIN.backstopUntouchedMs,
      force: false,
      budgetMs: R1_MEET_DRAIN.backstopBudgetMs,
    };
    h.advance(4 * MINUTE);
    expect(await drainR1Meet(h.deps, backstop)).toMatchObject({ drained: 0 });
    expect(h.requests).toEqual([]);
    expect(row(h, b).status).toBe('bot_scheduled');
    h.advance(MINUTE + SECOND);
    expect(await drainR1Meet(h.deps, backstop)).toMatchObject({ drained: 1 });
  });

  it('is bounded: a full list or a spent budget reports more', async () => {
    const h = createR1MeetHarness();
    for (let index = 0; index < 3; index += 1) await booked(h, 'pending');
    expect(await drainR1Meet(h.deps, { ...OPERATOR, limit: 2 })).toMatchObject({ drained: 2, more: true });
    expect(await drainR1Meet(h.deps, { ...OPERATOR, limit: 2 })).toMatchObject({ drained: 1, more: false });

    await booked(h, 'pending');
    expect(await drainR1Meet(h.deps, { ...OPERATOR, budgetMs: 0 })).toMatchObject({ drained: 0, more: true });
  });
});

describe('door (a): the operator job', () => {
  it('loops until nothing is left, deferring between passes', async () => {
    const h = createR1MeetHarness();
    for (let index = 0; index < R1_MEET_DRAIN.operatorLimit + 2; index += 1) await booked(h, 'pending');
    const job = r1MeetDrainDefinition.parse({ kind: 'drain' })!;
    expect(job).toEqual({ kind: 'drain', force: false });
    expect(await r1MeetDrainDefinition.run(h.deps, job, h.meta())).toEqual({
      outcome: 'defer',
      code: 'drain_continue',
      delaySeconds: R1_MEET_DRAIN.moreDeferSec,
    });
    expect(await r1MeetDrainDefinition.run(h.deps, job, h.meta({ deferCount: 1 }))).toEqual({
      outcome: 'done',
      receipt: 'processed',
      code: 'drained',
    });
    expect(h.db.tables.r1_meet_bookings.every((booking) => booking.status === 'drained')).toBe(true);
  });

  it('waits a minute for a live interview, cuts it when forced, and gives up loudly after its bound', async () => {
    const h = createR1MeetHarness();
    const live = await booked(h, 'in_call_session');
    const plain = r1MeetDrainDefinition.parse({ kind: 'drain' })!;
    expect(await r1MeetDrainDefinition.run(h.deps, plain, h.meta())).toEqual({
      outcome: 'defer',
      code: 'drain_continue',
      delaySeconds: R1_MEET_DRAIN.waitDeferSec,
    });
    expect(await r1MeetDrainDefinition.run(h.deps, plain, h.meta({ deferCount: R1_MEET_DRAIN.maxPasses }))).toMatchObject({
      receipt: 'processed',
      code: 'drain_incomplete',
    });
    expect(h.alerts()).toEqual(['r1_meet_drain_failed']);
    expect(row(h, live).status).toBe('in_call');

    const forced = r1MeetDrainDefinition.parse({ kind: 'drain', force: true })!;
    expect(await r1MeetDrainDefinition.run(h.deps, forced, h.meta())).toMatchObject({ code: 'drained' });
    expect(row(h, live)).toMatchObject({ status: 'drained', recall_bot_id: null });
    expect(r1MeetDrainDefinition.parse({ kind: 'drain', force: 'yes' })).toBeNull();
  });
});

describe('door (b): the flag-off backstop of the r1-sweep tick', () => {
  function sweep(h: R1MeetHarness, meet: () => R1MeetConfig, drain: () => R1MeetDrainConfig = () => KEY, lane: R1MeetLane | null = null) {
    return createR1MeetSweepTick({ lane, meetConfig: meet, drainConfig: drain, client: h.db.client, now: h.now, recall: h.client, log: h.deps.log });
  }

  it('drains with the flag deliberately off and a key, once per bucket, never touching a fresh booking', async () => {
    const h = createR1MeetHarness();
    const old = await booked(h, 'bot_scheduled');
    h.advance(6 * MINUTE);
    const fresh = await booked(h, 'pending');
    const tick = sweep(h, () => DISABLED);
    expect(await tick()).toBe(true);
    expect(row(h, old)).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
    expect(row(h, fresh).status).toBe('pending');
    // Same bucket, nothing more to take: no read at all.
    const reads = h.db.calls.length;
    h.advance(6 * MINUTE);
    expect(await tick()).toBe(false);
    expect(h.db.calls).toHaveLength(reads);
    // The next bucket takes the booking that has now been untouched long enough.
    h.advance(15 * MINUTE);
    expect(await tick()).toBe(true);
    expect(row(h, fresh).status).toBe('drained');
  });

  it('the backstop drains an in-call booking whose attempt ended uncounted as drained/flag_off (PR #444 round 2, S06-R1)', async () => {
    const h = createR1MeetHarness();
    const uncounted = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
    settle(h, uncounted, 'provider_error', false);
    const counted = await booked(h, 'in_call_session', { sessionStatus: 'completed' });
    settle(h, counted, 'complete', true);
    h.advance(6 * MINUTE);
    expect(await sweep(h, () => DISABLED)()).toBe(true);
    expect(row(h, uncounted)).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
    expect(row(h, counted)).toMatchObject({ status: 'completed', reason: 'attempt_settled', recall_bot_id: null });
  });

  it('runs again within the bucket while rows remain beyond its bound of 10', async () => {
    const h = createR1MeetHarness();
    for (let index = 0; index < 12; index += 1) await booked(h, 'pending');
    h.advance(6 * MINUTE);
    const tick = sweep(h, () => DISABLED);
    expect(await tick()).toBe(true);
    expect(h.db.tables.r1_meet_bookings.filter((booking) => booking.status === 'drained')).toHaveLength(10);
    expect(await tick()).toBe(true);
    expect(h.db.tables.r1_meet_bookings.filter((booking) => booking.status === 'drained')).toHaveLength(12);
    expect(await tick()).toBe(false);
  });

  it('a key and no booking holding a bot: no outbound call at all', async () => {
    const h = createR1MeetHarness();
    const b = await booked(h, 'pending');
    h.advance(6 * MINUTE);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await sweep(h, () => DISABLED)()).toBe(true);
    expect(row(h, b).status).toBe('drained');
    expect(h.requests).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never drains for `invalid`, for R1 off with the Meet flag on, or without a key: zero queries, zero fetch', async () => {
    const h = createR1MeetHarness();
    const b = await booked(h, 'bot_scheduled');
    h.advance(6 * MINUTE);
    const enabled = getR1MeetConfig({
      R1_MEET_ENABLED: 'true',
      RECALL_API_KEY: FAKE_RECALL_API_KEY,
      RECALL_WEBHOOK_SECRET: 'whsec' + '_' + Buffer.alloc(32, 7).toString('base64'),
      R1_MEET_ASHBY_DEX_USER_ID: '7f000000-0000-4000-8000-0000000000d1',
      WEB_ORIGIN: 'https://hello.example.test',
    });
    expect(enabled.status).toBe('enabled');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const drainConfig = vi.fn(() => KEY);
    for (const tick of [
      sweep(h, () => INVALID, drainConfig),
      // R1 off: no lane, whatever the Meet flag says; Meet on is not a drain.
      sweep(h, () => enabled, drainConfig),
      sweep(h, () => DISABLED, () => NO_KEY),
    ]) {
      expect(await tick()).toBe(false);
    }
    expect(drainConfig).not.toHaveBeenCalled();
    expect(h.db.calls).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(row(h, b).status).toBe('bot_scheduled');
  });

  it('with an active lane it queues one maintenance job per bucket instead (the next one, at its start), and never drains', async () => {
    const h = createR1MeetHarness();
    await booked(h, 'bot_scheduled');
    h.advance(6 * MINUTE);
    const enqueue = vi.fn(async () => {});
    const lane = { active: () => true, enqueue } as unknown as R1MeetLane;
    const tick = sweep(h, () => DISABLED, () => KEY, lane);
    expect(await tick()).toBe(true);
    expect(await tick()).toBe(false);
    h.advance(15 * MINUTE);
    expect(await tick()).toBe(true);
    const calls = enqueue.mock.calls as unknown as Array<[{ payload: { bucket: number } }, { scheduledAt: string }]>;
    const buckets = calls.map((call) => call[0].payload.bucket);
    // Each tick queues the NEXT bucket's job for that bucket's first instant (S06-R5).
    const next = [Math.floor((h.now() - 15 * MINUTE) / (15 * MINUTE)) + 1, Math.floor(h.now() / (15 * MINUTE)) + 1];
    expect(buckets).toEqual(next);
    expect(calls.map((call) => call[1].scheduledAt)).toEqual(next.map((bucket) => new Date(bucket * 15 * MINUTE).toISOString()));
    expect(h.db.calls).toEqual([]);
  });

  it('never throws: an unreadable list is one alert, the next bucket tries again', async () => {
    const h = createR1MeetHarness();
    await booked(h, 'pending');
    h.advance(6 * MINUTE);
    h.db.failNext('r1_meet_bookings');
    const tick = sweep(h, () => DISABLED);
    await expect(tick()).resolves.toBe(false);
    expect(h.alerts()).toEqual(['r1_meet_drain_failed']);
    h.advance(15 * MINUTE);
    await expect(tick()).resolves.toBe(true);
    const throwing = createR1MeetSweepTick({
      lane: null,
      meetConfig: () => {
        throw new Error('unreadable');
      },
      drainConfig: () => KEY,
      client: h.db.client,
      now: h.now,
      log: h.deps.log,
    });
    await expect(throwing()).resolves.toBe(false);
  });
});

describe('door (b) with R1 off: the standalone storage runtime', () => {
  function standalone(h: R1MeetHarness, meet: R1MeetConfig) {
    const clock = (): string => iso(h.now());
    const queue = new Queue(new MemoryAdapter({ clock }), { clock });
    const runtime = createR1StorageRuntime({
      client: h.db.client as never,
      queue,
      now: () => new Date(h.now()),
      recordingConfig: () => enabledRecordingConfig(),
      recordingStore: () => new MemoryR1ObjectStore({ now: h.now }),
      meetConfig: () => meet,
      meetDrainConfig: () => KEY,
      meetRecall: h.client,
    })!;
    expect(runtime).not.toBeNull();
    return runtime;
  }

  it('drains a bot left behind when the Meet flag is off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const h = createR1MeetHarness();
    const b = await booked(h, 'bot_joining');
    h.advance(6 * MINUTE);
    const runtime = standalone(h, DISABLED);
    expect(runtime.queues).toEqual(['r1.recording.finalize', 'r1.recording.erase', 'r1.sweep']);
    await runtime.tickAll();
    await runtime.stop();
    expect(row(h, b)).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
    expect(ops(h)).toEqual(['get', 'leave']);
  });

  it('never drains with the Meet flag on (R1 off alone is not a drain)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const h = createR1MeetHarness();
    const b = await booked(h, 'bot_joining');
    h.advance(6 * MINUTE);
    const enabled = { ...DISABLED, enabled: true, status: 'enabled' } as unknown as R1MeetConfig;
    const runtime = standalone(h, enabled);
    await runtime.tickAll();
    await runtime.stop();
    expect(row(h, b).status).toBe('bot_joining');
    expect(h.requests).toEqual([]);
    expect(h.db.calls.filter((call) => call.name === 'r1_meet_bookings')).toEqual([]);
  });
});

describe('the job facts the operator drain reads', () => {
  it('counts its passes from the job row', () => {
    expect(r1MeetJobMeta({ attempts: 1, maxAttempts: 10, deferCount: 3, createdAt: iso(0) }).deferCount).toBe(3);
  });
});
