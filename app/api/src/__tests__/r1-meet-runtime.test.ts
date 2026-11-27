/**
 * M034 S06 T5: the `r1-meet` lane inside the R1 runtime (lib/r1/meet/runtime.ts, hosted by
 * lib/r1/runtime.ts), driven through `createR1Runtime` over a `MemoryAdapter` queue, the in-memory 0142
 * port and the REAL Recall client over the S01 fake.
 *
 * Pinned (D-S06-2, D-S06-3, D-S06-29..32):
 *  - flag off (or invalid, or R1 off): no lane, the queues and loops exactly as before, `claim` never
 *    asked for `r1-meet`, an enqueued Meet job stays pending, zero fetch, zero Meet query;
 *  - flag on: `r1-meet` joins the queues (the four loops unchanged) and a booking runs end to end:
 *    Ashby schedule -> bot -> joining -> human present (arm + output_media) -> the page claims and binds
 *    -> the attempt ends -> leave -> completed; receipts processed; nothing dead-lettered;
 *  - Meet turned off after construction: the lane stops claiming at once;
 *  - the sweep tick: one maintenance job per bucket for the whole fleet (queued a bucket ahead, at its
 *    first instant, so a second machine's tick collapses into it: S06-R5); the drain backstop while
 *    off with a key;
 *  - the hot window keeps the storage loop at its base cadence and throttles storage claims, and
 *    expires; without a lane the storage tick is the storage runner's own;
 *  - stop() waits for the jobs in flight;
 *  - no Meet URL, address, ticket, digest or id in any log line, and nothing but ids in what it queues;
 *  - M034 S09: the lane's flow ports carry `feedback` (the seam is honoured; production builds the
 *    form setting, the store, the Dex user, the bridge page and a LAZY Ashby port: no usable
 *    `ASHBY_API_KEY` = null and no client built, a null is not remembered, a built port is kept), and
 *    the maintenance job re-drives a lost feedback trigger only while the form setting is set;
 *  - M035 S11: the lane's flow ports carry `ashbyTag` (the seam is honoured; production builds the
 *    booked-tag store, Ashby's own switches read per call and a LAZY tag port: no usable
 *    `ASHBY_API_KEY` = null and no client built, a null is not remembered, a built port is kept), and
 *    an `ashby_booked_tag` job through the production lane reaches its wired definition.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecallClient, type RecallTransport } from '../integrations/recall/client.js';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { notifyR1MeetAttemptEnded } from '../lib/r1/meet/attempt-ended.js';
import type { R1MeetAshbyTagDeps } from '../lib/r1/meet/ashby-booked-tag.js';
import { createR1MeetAshbyTagPort } from '../lib/r1/meet/ashby-booked-tag-ashby.js';
import { getR1MeetConfig, getR1MeetDrainConfig, type R1MeetConfig, type R1MeetDrainConfig } from '../lib/r1/meet/config.js';
import { R1_MEET_DEFINITIONS } from '../lib/r1/meet/dispatcher.js';
import { createR1MeetAshbyFeedbackPort } from '../lib/r1/meet/feedback-ashby.js';
import type { R1MeetFeedbackDeps } from '../lib/r1/meet/feedback.js';
import { R1_MEET_QUEUE, r1MeetJobs, r1MeetProcessed } from '../lib/r1/meet/jobs.js';
import type { R1MeetFlowDeps, R1MeetJobDefinition } from '../lib/r1/meet/recall-actions.js';
import {
  R1_MEET_LANE,
  createR1MeetAshbyTagPorts,
  createR1MeetFeedbackPorts,
  createR1MeetLane,
  createR1MeetSweepTick,
  withR1MeetStorageTick,
  type R1MeetLane,
} from '../lib/r1/meet/runtime.js';
import { r1MeetTicketDigest } from '../lib/r1/meet/ticket.js';
import { R1_RUNTIME_BOUNDS, createR1Runtime, type R1RuntimeHandle } from '../lib/r1/runtime.js';
import type { R1RecordingConfig } from '../lib/r1/recording/config.js';
import { FAKE_RECALL_API_KEY, createFakeRecall, type FakeRecall } from './support/recall-fake.js';
import { createR1MeetFakeDb, type R1MeetFakeDb } from './support/r1-meet-fake-db.js';
import {
  BRIDGE_PAGE_URL,
  BRIDGE_SOURCE,
  HARNESS_NOW,
  MEET_URL,
  SCHEDULER_ID,
  STAFF_USER_ID,
  WEB_ORIGIN_FIXTURE,
  fixtureId,
  recallOp,
  type RecallOp,
} from './support/r1-meet-harness.js';

// M034 S09: a pass-through spy on the Ashby feedback port factory, so a test can prove no client is
// built without a usable key. It calls the real factory.
vi.mock('../lib/r1/meet/feedback-ashby.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/r1/meet/feedback-ashby.js')>();
  return { ...actual, createR1MeetAshbyFeedbackPort: vi.fn(actual.createR1MeetAshbyFeedbackPort) };
});
// M035 S11: the same pass-through spy on the "Dex R1: Booked" tag port factory.
vi.mock('../lib/r1/meet/ashby-booked-tag-ashby.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/r1/meet/ashby-booked-tag-ashby.js')>();
  return { ...actual, createR1MeetAshbyTagPort: vi.fn(actual.createR1MeetAshbyTagPort) };
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const iso = (ms: number): string => new Date(ms).toISOString();

const R1_ON = { enabled: true, status: 'enabled' as const };
const R1_OFF = { enabled: false, status: 'disabled' as const };
const REC_OFF = (): R1RecordingConfig => ({ enabled: false, status: 'disabled' });
const MEET_OFF: R1MeetConfig = { enabled: false, status: 'disabled' };
const MEET_INVALID: R1MeetConfig = { enabled: false, status: 'invalid', reason: 'R1_MEET_ENABLED must be either "true" or "false"' };
const DEX_ID = '7f000000-0000-4000-8000-0000000000d1';
/** An enabled Meet config: the webhook secret is built at run time, never a secret-shaped literal. */
const MEET_ON = getR1MeetConfig({
  R1_MEET_ENABLED: 'true',
  RECALL_API_KEY: FAKE_RECALL_API_KEY,
  RECALL_WEBHOOK_SECRET: 'whsec' + '_' + Buffer.alloc(32, 7).toString('base64'),
  R1_MEET_ASHBY_DEX_USER_ID: DEX_ID,
  R1_MEET_SERVICE_USER_ID: STAFF_USER_ID,
  WEB_ORIGIN: WEB_ORIGIN_FIXTURE,
});
const KEY: R1MeetDrainConfig = getR1MeetDrainConfig({ RECALL_API_KEY: FAKE_RECALL_API_KEY });
const NO_KEY: R1MeetDrainConfig = getR1MeetDrainConfig({});

/** Everything the process writes as a log line (the structured logger: stdout, warn, error). */
let written: string[] = [];

beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
    written.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    written.push(String(line));
  });
  // The bridge key (mint and digest): built at run time.
  vi.stubEnv('WORKER_CONTEXT_SECRET', BRIDGE_SOURCE.WORKER_CONTEXT_SECRET!);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface World {
  readonly clock: { ms: number };
  readonly db: R1MeetFakeDb;
  readonly queue: Queue;
  readonly fake: FakeRecall;
  readonly requests: Array<{ op: RecallOp; method: string; path: string; body: unknown }>;
  readonly runtime: R1RuntimeHandle | null;
  meet: R1MeetConfig;
}

function world(options: { meet?: R1MeetConfig; drain?: R1MeetDrainConfig; r1?: typeof R1_ON | typeof R1_OFF } = {}): World {
  const clock = { ms: Date.parse(HARNESS_NOW) };
  const nowIso = (): string => iso(clock.ms);
  const queue = new Queue(new MemoryAdapter({ clock: nowIso }), { clock: nowIso });
  const db = createR1MeetFakeDb({ now: () => clock.ms });
  db.users.add(STAFF_USER_ID);
  const fake = createFakeRecall({ now: () => new Date(clock.ms) });
  const requests: World['requests'] = [];
  const transport: RecallTransport = async (req) => {
    requests.push({ op: recallOp(req), method: req.method, path: new URL(req.url).pathname, body: req.body === undefined ? null : JSON.parse(req.body) });
    return fake.transport(req);
  };
  const recall = createRecallClient({ apiKey: FAKE_RECALL_API_KEY, transport });
  const state = { meet: options.meet ?? MEET_ON } as World;
  const runtime = createR1Runtime({
    config: options.r1 ?? R1_ON,
    client: db.client as never,
    queue,
    now: () => new Date(clock.ms),
    recordingConfig: REC_OFF,
    meetConfig: () => state.meet,
    meetDrainConfig: () => options.drain ?? NO_KEY,
    meetRecall: recall,
  });
  return Object.assign(state, { clock, db, queue, fake, requests, runtime });
}

async function settle(lane: R1MeetLane): Promise<void> {
  await vi.waitFor(() => {
    if (lane.runner.inFlight() !== 0) throw new Error('busy');
  }, { timeout: 5000, interval: 2 });
}

/** Tick the lane until a tick claims nothing, letting every job settle. */
async function drive(lane: R1MeetLane): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    const tick = await lane.tick();
    await settle(lane);
    if (!tick.worked) return;
  }
  throw new Error('drive: the lane never went idle');
}

const meetTableCalls = (db: R1MeetFakeDb) => db.calls.filter((call) => call.name.startsWith('r1_meet') || call.name === 'job_queue');

describe('flag off: nothing of the lane exists', () => {
  it.each([
    ['disabled', MEET_OFF],
    ['invalid', MEET_INVALID],
  ])('Meet %s: the queues, loops and claims are exactly as before; a Meet job stays pending; zero fetch', async (_name, meet) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world({ meet });
    const runtime = w.runtime!;
    expect(runtime.meetLane).toBeNull();
    expect([...runtime.queues]).toEqual(['r1.assessment', 'r1.recording.finalize', 'r1.recording.erase', 'r1.sweep']);
    expect(runtime.loopIntervalsMs).toEqual({
      'r1-assessment': R1_RUNTIME_BOUNDS.queuePollMs,
      'r1-status': R1_RUNTIME_BOUNDS.statusPollMs,
      'r1-storage': R1_RUNTIME_BOUNDS.storagePollMs,
      'r1-sweep': R1_RUNTIME_BOUNDS.sweepPollMs,
    });
    const job = await w.queue.enqueue(R1_MEET_QUEUE, { kind: 'maintenance', bucket: 1 }, { maxAttempts: 3 });
    const claim = vi.spyOn(w.queue, 'claim');
    await runtime.tickAll();
    w.clock.ms += 20 * MINUTE;
    await runtime.tickAll();
    await runtime.stop();
    expect(claim.mock.calls.map((call) => call[0])).not.toContain(R1_MEET_QUEUE);
    expect((await w.queue.getById(job.id))!.status).toBe('pending');
    expect(runtime.snapshot().meetJobEvents).toEqual({});
    expect(meetTableCalls(w.db)).toEqual([]);
    expect(w.requests).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('R1 off: there is no runtime, and a lane is never built whatever the Meet flag says', () => {
    expect(world({ r1: R1_OFF }).runtime).toBeNull();
    const db = createR1MeetFakeDb();
    const queue = new Queue(new MemoryAdapter());
    expect(createR1MeetLane({ r1Config: () => R1_OFF, meetConfig: () => MEET_ON, client: db.client, queue, owner: 'o', now: Date.now })).toBeNull();
    expect(createR1MeetLane({ r1Config: () => R1_ON, meetConfig: () => MEET_INVALID, client: db.client, queue, owner: 'o', now: Date.now })).toBeNull();
    expect(db.calls).toEqual([]);
  });

  it('without a lane the storage loop tick is the storage runner tick itself', () => {
    const storageTick = async (): Promise<boolean> => false;
    expect(withR1MeetStorageTick(null, storageTick, Date.now)).toBe(storageTick);
  });
});

describe('flag on: the lane', () => {
  it('adds exactly r1-meet to the queues, keeps the four loops, and reads nothing at construction', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world();
    const runtime = w.runtime!;
    expect(MEET_ON.status).toBe('enabled');
    expect(runtime.meetLane).not.toBeNull();
    expect([...runtime.queues]).toEqual(['r1.assessment', 'r1.recording.finalize', 'r1.recording.erase', 'r1.sweep', 'r1-meet']);
    expect(Object.keys(runtime.loopIntervalsMs)).toEqual(['r1-assessment', 'r1-status', 'r1-storage', 'r1-sweep']);
    expect(runtime.scheduler.running()).toBe(false);
    expect(w.db.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(R1_MEET_LANE).toMatchObject({ concurrency: 2, leaseSeconds: 60, storageThrottleMs: 30_000 });
  });

  it('runs a booking end to end: schedule -> bot -> joining -> human -> claim + bind -> attempt ended -> completed', async () => {
    const w = world();
    const runtime = w.runtime!;
    const lane = runtime.meetLane!;
    const enqueueSpy = vi.spyOn(w.queue, 'enqueue');
    const testKinds = new Set(['ashby_schedule', 'recall_event']);
    const now = (): number => w.clock.ms;

    // ── S03 delivers an Ashby schedule (the receiver's job and receipt) ───────────────────────────
    const scheduleId = fixtureId();
    const eventId = fixtureId();
    const applicationId = fixtureId();
    w.db.linkApplication(applicationId, fixtureId());
    const updatedAt = iso(now() - MINUTE);
    const startAt = iso(now() + MINUTE);
    const receipts: string[] = [];
    const deliver = async (payload: Record<string, unknown>, source: 'ashby' | 'recall', key: string): Promise<void> => {
      const receiptId = fixtureId();
      receipts.push(receiptId);
      w.db.tables.r1_meet_receipts.push({
        id: receiptId,
        source,
        dedupe_key: key,
        event_type: source === 'ashby' ? 'interviewScheduleCreate' : String(payload.event_type),
        booking_id: null,
        outcome: 'enqueued',
        received_at: iso(now()),
        processed_at: null,
      });
      await w.queue.enqueue(R1_MEET_QUEUE, { ...payload, receipt_id: receiptId, source }, { dedupKey: `r1-meet:receipt:${receiptId}`, maxAttempts: 5 });
    };
    await deliver(
      {
        kind: 'ashby_schedule',
        scope: 'event',
        ashby_interview_event_id: eventId,
        ashby_schedule_id: scheduleId,
        ashby_application_id: applicationId,
        ashby_interview_stage_id: null,
        ashby_interview_id: null,
        ashby_scheduled_by_user_id: SCHEDULER_ID,
        ashby_updated_at: updatedAt,
        decision: 'eligible',
        start_at: startAt,
        end_at: iso(Date.parse(startAt) + 45 * MINUTE),
        meet_url: MEET_URL,
        received_at: iso(now()),
        ashby_schedule_event_ids: [eventId],
        ashby_dex_event_ids: [eventId],
      },
      'ashby',
      `ashby-schedule:${scheduleId}:${Date.parse(updatedAt)}`,
    );
    await runtime.tickAll();
    await settle(lane);
    await drive(lane);
    const booking = () => w.db.tables.r1_meet_bookings.find((row) => row.ashby_interview_event_id === eventId)!;
    expect(booking()).toMatchObject({ status: 'bot_scheduled', reason: 'eligible' });
    const botId = booking().recall_bot_id as string;
    expect(w.requests.map((request) => request.op)).toEqual(['create']);

    // ── Recall: the bot joins ────────────────────────────────────────────────────────────────────
    const recallEvent = (eventType: string): Record<string, unknown> => ({
      kind: 'recall_event',
      event_type: eventType,
      recall_bot_id: botId,
      booking_id: booking().id,
      occurred_at: iso(now()),
      sub_code: null,
      participant: null,
    });
    w.fake.markDispatched(botId);
    w.fake.setStatus(botId, 'joining_call');
    await deliver(recallEvent('bot.joining_call'), 'recall', `recall:${fixtureId()}`);
    await drive(lane);
    expect(booking().status).toBe('bot_joining');
    expect(lane.hotUntilMs()).toBeGreaterThanOrEqual(Date.parse(startAt) + 15 * MINUTE);

    // ── A human is in the call: arm and show the bridge page ────────────────────────────────────
    w.fake.setStatus(botId, 'in_call_recording');
    await deliver(recallEvent('bot.in_call_recording'), 'recall', `recall:${fixtureId()}`);
    await drive(lane);
    expect(booking().status).toBe('human_present');
    const page = w.requests.filter((request) => request.op === 'output_media');
    expect(page).toHaveLength(1);
    const url = (page[0]!.body as { camera: { config: { url: string } } }).camera.config.url;
    expect(url.startsWith(`${BRIDGE_PAGE_URL}#t=`)).toBe(true);
    const ticket = url.slice(`${BRIDGE_PAGE_URL}#t=`.length);

    // ── The bridge page claims the ticket and binds its session ─────────────────────────────────
    expect((await w.db.claimTicket(ticket, iso(now()), BRIDGE_SOURCE)).data).toMatchObject({ status: 'ok' });
    const session = w.db.addSession({ interview_round_id: booking().round_id as string, status: 'in_progress' });
    expect((await w.db.bind(booking().id as string, session.id as string, iso(now()))).data).toMatchObject({ status: 'ok' });
    expect(booking()).toMatchObject({ status: 'in_call', session_id: session.id });

    // ── The attempt ends: the outcome hook queues the leave 5 s later ───────────────────────────
    session.status = 'completed';
    // What `r1_settle_attempt` leaves before the route calls the hook: a counted, complete attempt.
    w.db.addAttempt({ session_id: session.id as string, round_id: booking().round_id as string, outcome: 'complete', counted: true });
    await notifyR1MeetAttemptEnded(session.id, {
      client: w.db.client,
      enqueue: (name, payload, options) => w.queue.enqueue(name, payload, options),
      r1Config: () => R1_ON,
      meetConfig: () => w.meet,
      now,
    });
    await drive(lane);
    expect(booking().status).toBe('in_call');
    w.clock.ms += 6 * SECOND;
    await drive(lane);
    expect(booking()).toMatchObject({ status: 'completed', reason: 'attempt_settled', recall_bot_id: null });

    // The bridge check of the arm finds a finished booking: nothing more at Recall.
    w.clock.ms += MINUTE;
    await drive(lane);
    await runtime.stop();

    expect(w.requests.map((request) => request.op)).toEqual(['create', 'get', 'output_media', 'get', 'leave']);
    expect(w.requests.map((request) => request.method)).not.toContain('PATCH');
    for (const receiptId of receipts) {
      expect(w.db.tables.r1_meet_receipts.find((row) => row.id === receiptId)!.outcome).toBe('processed');
    }
    expect(await w.queue.getDlqJobs()).toEqual([]);
    const events = runtime.snapshot().meetJobEvents;
    expect(events.completed).toBeGreaterThanOrEqual(5);
    expect(events.failed ?? 0).toBe(0);

    // ── No PII anywhere it writes ──────────────────────────────────────────────────────────────────
    const digest = r1MeetTicketDigest(ticket, BRIDGE_SOURCE)!;
    const laneJobs = enqueueSpy.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((payload) => !testKinds.has(String(payload.kind)));
    expect(laneJobs.map((payload) => payload.kind).sort()).toEqual(['attempt_ended', 'bridge_check', 'maintenance']);
    for (const payload of laneJobs) {
      for (const value of Object.values(payload)) expect(['string', 'number']).toContain(typeof value);
    }
    const queued = JSON.stringify(laneJobs);
    const logs = written.join('\n');
    expect(logs).toContain('"error_category":"r1_meet_job"');
    for (const secret of ['meet.google.com', MEET_URL, '@', ticket, digest, BRIDGE_PAGE_URL, WEB_ORIGIN_FIXTURE]) {
      expect(queued).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    for (const id of [botId, booking().id as string, session.id as string, eventId, scheduleId, applicationId, SCHEDULER_ID]) {
      expect(logs).not.toContain(id);
    }
  });

  it('stops claiming the moment Meet turns off, and the job stays pending', async () => {
    const w = world();
    const lane = w.runtime!.meetLane!;
    const job = await w.queue.enqueue(R1_MEET_QUEUE, { kind: 'maintenance', bucket: 3 }, { maxAttempts: 3 });
    w.meet = MEET_OFF;
    const claim = vi.spyOn(w.queue, 'claim');
    expect(lane.active()).toBe(false);
    expect(await lane.tick()).toEqual({ worked: false, hot: false });
    expect(claim).not.toHaveBeenCalled();
    expect((await w.queue.getById(job.id))!.status).toBe('pending');
    expect(lane.events()).toMatchObject({ not_admitted: 1 });
  });

  it('the sweep tick queues each bucket\'s maintenance one bucket ahead; the fleet runs it ONCE, at that bucket (S06-R5)', async () => {
    const w = world();
    const runtime = w.runtime!;
    const lane = runtime.meetLane!;
    const enqueueSpy = vi.spyOn(w.queue, 'enqueue');
    const maintenance = () => enqueueSpy.mock.calls.filter((call) => (call[1] as { kind?: string }).kind === 'maintenance');
    const bucketMs = 15 * MINUTE;
    const bucket = Math.floor(w.clock.ms / bucketMs);
    // A second API machine: its own sweep tick (its own memory) over the same queue.
    const otherMachine = createR1MeetSweepTick({
      lane,
      meetConfig: () => w.meet,
      drainConfig: () => NO_KEY,
      client: w.db.client,
      now: () => w.clock.ms,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await runtime.tickAll();
    await settle(lane);
    await runtime.tickAll();
    expect(maintenance()).toHaveLength(1);
    expect(maintenance()[0]![1]).toEqual({ kind: 'maintenance', bucket: bucket + 1 });
    expect(maintenance()[0]![2]).toMatchObject({
      dedupKey: `r1-meet:maintenance:${bucket + 1}`,
      maxAttempts: 3,
      scheduledAt: iso((bucket + 1) * bucketMs),
    });
    // The other machine, later in the same bucket: its insert collapses into the same live job.
    w.clock.ms += 5 * MINUTE;
    expect(await otherMachine()).toBe(true);
    expect(maintenance()).toHaveLength(2);
    const [first, second] = await Promise.all(enqueueSpy.mock.results
      .filter((_result, index) => (enqueueSpy.mock.calls[index]![1] as { kind?: string }).kind === 'maintenance')
      .map((result) => result.value as Promise<{ id: string }>));
    expect(second!.id).toBe(first!.id);
    // Not run before its bucket starts.
    await drive(lane);
    expect(runtime.snapshot().meetJobEvents.completed ?? 0).toBe(0);
    expect((await w.queue.getById(first!.id))!.status).toBe('pending');

    // Its bucket starts: it runs exactly once, and both machines' ticks now queue the NEXT one, once.
    w.clock.ms = (bucket + 1) * bucketMs + SECOND;
    await drive(lane);
    expect((await w.queue.getById(first!.id))!.status).toBe('completed');
    await runtime.tickAll();
    await settle(lane);
    await otherMachine();
    await drive(lane);
    expect(maintenance().slice(2).map((call) => (call[1] as { bucket: number }).bucket)).toEqual([bucket + 2, bucket + 2]);
    await runtime.stop();
    expect(runtime.snapshot().meetJobEvents.completed).toBe(1);
    expect(written.join('\n')).toContain('"error_type":"maintenance:maintenance"');
  });

  it('stop() waits for the jobs in flight', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const slow: R1MeetJobDefinition<{ kind: 'slow' }> = {
      kind: 'slow',
      parse: (payload) => ((payload as { kind?: unknown } | null)?.kind === 'slow' ? { kind: 'slow' } : null),
      run: async () => {
        await gate;
        finished = true;
        return r1MeetProcessed('slow_done');
      },
    };
    const lane = createR1MeetLane({
      r1Config: () => R1_ON,
      meetConfig: () => MEET_ON,
      client: w.db.client,
      queue: w.queue,
      owner: 'test',
      now: () => w.clock.ms,
      definitions: [...R1_MEET_DEFINITIONS, slow as R1MeetJobDefinition],
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })!;
    await w.queue.enqueue(R1_MEET_QUEUE, { kind: 'slow' });
    expect((await lane.tick()).worked).toBe(true);
    expect(lane.runner.inFlight()).toBe(1);
    let stopped = false;
    const stopping = lane.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    expect(lane.runner.inFlight()).toBe(0);
    expect(lane.events()).toMatchObject({ claimed: 1, completed: 1 });
  });
});

describe('the hot window (D-S06-3)', () => {
  function fakeLane(state: { hot: boolean; worked: boolean }): R1MeetLane {
    return { tick: async () => ({ worked: state.worked, hot: state.hot }) } as unknown as R1MeetLane;
  }

  it('keeps the loop fast while hot and ticks the storage runner at most every 30 s unless it had work', async () => {
    let nowMs = 0;
    const state = { hot: true, worked: false };
    let storageWork = false;
    const storageTick = vi.fn(async () => storageWork);
    const tick = withR1MeetStorageTick(fakeLane(state), storageTick, () => nowMs);

    expect(await tick()).toBe(true); // hot: the scheduler keeps its base cadence
    expect(storageTick).toHaveBeenCalledTimes(1);
    for (const step of [5, 10, 15, 20, 25]) {
      nowMs = step * SECOND;
      expect(await tick()).toBe(true);
    }
    expect(storageTick).toHaveBeenCalledTimes(1); // one claim pass in 30 s, not six
    storageWork = true;
    nowMs = 30 * SECOND;
    expect(await tick()).toBe(true);
    expect(storageTick).toHaveBeenCalledTimes(2);

    // Storage just had work: it is ticked again at once, hot or not, until it has none.
    nowMs = 35 * SECOND;
    await tick();
    expect(storageTick).toHaveBeenCalledTimes(3);
    storageWork = false;
    nowMs = 40 * SECOND;
    await tick();
    expect(storageTick).toHaveBeenCalledTimes(4);
    nowMs = 45 * SECOND;
    await tick();
    expect(storageTick).toHaveBeenCalledTimes(4);
  });

  it('when not hot, both halves run every tick and only real work keeps the cadence', async () => {
    const state = { hot: false, worked: false };
    const storageTick = vi.fn(async () => false);
    const tick = withR1MeetStorageTick(fakeLane(state), storageTick, () => 0);
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    expect(storageTick).toHaveBeenCalledTimes(2);
    state.worked = true;
    expect(await tick()).toBe(true);
  });

  it('a live call sets it, it is bounded, and it expires', async () => {
    const w = world();
    const lane = w.runtime!.meetLane!;
    expect(lane.hotUntilMs()).toBe(0);
    expect((await lane.tick()).hot).toBe(false);
    // A booking whose bot is joining: hot until 15 minutes after its start.
    const round = w.db.addRound();
    const startMs = w.clock.ms + MINUTE;
    const row = w.db.seedBooking({
      status: 'bot_scheduled',
      reason: 'eligible',
      round_id: round.id,
      recall_bot_id: fixtureId(),
      start_at: iso(startMs),
      end_at: iso(startMs + 45 * MINUTE),
    });
    await w.queue.enqueue(R1_MEET_QUEUE, {
      kind: 'recall_event',
      event_type: 'bot.joining_call',
      recall_bot_id: row.recall_bot_id,
      booking_id: row.id,
      occurred_at: iso(w.clock.ms),
      sub_code: null,
      participant: null,
    });
    await drive(lane);
    expect(w.db.booking(row.id as string)!.status).toBe('bot_joining');
    expect(lane.hotUntilMs()).toBe(startMs + 15 * MINUTE);
    expect((await lane.tick()).hot).toBe(true);
    w.clock.ms = startMs + 15 * MINUTE;
    expect((await lane.tick()).hot).toBe(false);
    await w.runtime!.stop();
  });
});

describe('the drain backstop inside the full runtime (R1 on, Meet flag off, a key)', () => {
  it('drains a bot-holding booking once untouched for 5 minutes; invalid never does', async () => {
    for (const [meet, drained] of [[MEET_OFF, true], [MEET_INVALID, false]] as const) {
      const w = world({ meet, drain: KEY });
      const round = w.db.addRound();
      const row = w.db.seedBooking({
        status: 'bot_scheduled',
        reason: 'eligible',
        round_id: round.id,
        recall_bot_id: fixtureId(),
        updated_at: iso(w.clock.ms - 6 * MINUTE),
      });
      await w.runtime!.tickAll();
      await w.runtime!.stop();
      const fresh = w.db.booking(row.id as string)!;
      if (drained) {
        expect(fresh).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
        // The bot was unknown to Recall: one GET, nothing else.
        expect(w.requests.map((request) => request.op)).toEqual(['get']);
      } else {
        expect(fresh.status).toBe('bot_scheduled');
        expect(w.requests).toEqual([]);
        expect(meetTableCalls(w.db)).toEqual([]);
      }
    }
  });
});

/** An Ashby key long enough to count, built at run time (never a key-shaped literal). */
const usableKey = (): string => 'k'.repeat(24);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The flow ports a job of the lane receives (one probe job, run through the real dispatcher). The
 * optional seams are passed to the lane only when given (M034 S09 `feedback`, M035 S11 `ashbyTag`).
 */
async function flowDepsOf(w: World, feedback?: R1MeetFeedbackDeps, ashbyTag?: R1MeetAshbyTagDeps): Promise<R1MeetFlowDeps> {
  const seen: R1MeetFlowDeps[] = [];
  const probe: R1MeetJobDefinition<{ kind: 'probe' }> = {
    kind: 'probe',
    parse: (payload) => ((payload as { kind?: unknown } | null)?.kind === 'probe' ? { kind: 'probe' } : null),
    run: async (deps) => {
      seen.push(deps);
      return r1MeetProcessed('probe');
    },
  };
  const lane = createR1MeetLane({
    r1Config: () => R1_ON,
    meetConfig: () => MEET_ON,
    client: w.db.client,
    queue: w.queue,
    owner: 'probe',
    now: () => w.clock.ms,
    definitions: [probe as R1MeetJobDefinition],
    log: quiet,
    ...(feedback === undefined ? {} : { feedback }),
    ...(ashbyTag === undefined ? {} : { ashbyTag }),
  })!;
  await w.queue.enqueue(R1_MEET_QUEUE, { kind: 'probe' });
  await lane.tick();
  await settle(lane);
  await lane.stop();
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe('M034 S09: the feedback ports of the lane', () => {
  const FORM_ID = '7f000000-0000-4000-8000-00000000f0b1';
  const factory = vi.mocked(createR1MeetAshbyFeedbackPort);

  beforeEach(() => {
    factory.mockClear();
  });

  it('the seam is honoured: a job sees exactly the feedback ports it was given', async () => {
    const w = world();
    const given = Object.freeze({
      config: () => ({ status: 'off' as const }),
      store: {} as R1MeetFeedbackDeps['store'],
      ashbyActive: () => false,
      ashby: () => null,
      dexUserId: DEX_ID,
      bridgePageUrl: BRIDGE_PAGE_URL,
    });
    expect((await flowDepsOf(w, given)).feedback).toBe(given);
    expect(factory).not.toHaveBeenCalled();
  });

  it('production ports: the setting read per call, the Dex user, the bridge page; no ASHBY_API_KEY = null and NO client built', async () => {
    vi.stubEnv('ASHBY_API_KEY', '');
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world();
    const feedback = (await flowDepsOf(w)).feedback!;
    expect(feedback).toBeDefined();
    expect(feedback.dexUserId).toBe(DEX_ID);
    expect(feedback.bridgePageUrl).toBe(BRIDGE_PAGE_URL);
    expect(MEET_ON.enabled && MEET_ON.bridgePageUrl).toBe(BRIDGE_PAGE_URL);
    expect(typeof feedback.store.recordFeedback).toBe('function');

    expect(feedback.config()).toEqual({ status: 'off' });
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', FORM_ID);
    expect(feedback.config()).toEqual({ status: 'on', formDefinitionId: FORM_ID });

    expect(feedback.ashby()).toBeNull();
    vi.stubEnv('ASHBY_API_KEY', 'replace_me');
    expect(feedback.ashby()).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.db.calls).toEqual([]);
  });

  it("production ports: Ashby's own switches, read per call (master switch with its secret AND the runtime flag)", async () => {
    // A webhook secret long enough to count, built at run time (never a secret-shaped literal).
    const secret = 's'.repeat(24);
    vi.stubEnv('ASHBY_INTEGRATION_ENABLED', 'true');
    vi.stubEnv('ASHBY_WEBHOOK_SECRET', secret);
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', 'true');
    vi.stubEnv('ASHBY_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world();
    const feedback = (await flowDepsOf(w)).feedback!;
    // On: both switches, whatever the key (the key is the job's next question).
    expect(feedback.ashbyActive()).toBe(true);
    // The documented "stop all Ashby writes" rollback, each step on its own (ashby-runtime-activation.md §6).
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', 'false');
    expect(feedback.ashbyActive()).toBe(false);
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', 'true');
    vi.stubEnv('ASHBY_INTEGRATION_ENABLED', 'false');
    expect(feedback.ashbyActive()).toBe(false);
    vi.stubEnv('ASHBY_INTEGRATION_ENABLED', 'true');
    vi.stubEnv('ASHBY_WEBHOOK_SECRET', 'replace_me');
    expect(feedback.ashbyActive()).toBe(false);
    vi.stubEnv('ASHBY_WEBHOOK_SECRET', secret);
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', '');
    expect(feedback.ashbyActive()).toBe(false);
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', 'true');
    expect(feedback.ashbyActive()).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.db.calls).toEqual([]);
  });

  it('a null is not remembered (a key set later counts), and a built port is kept', async () => {
    vi.stubEnv('ASHBY_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world();
    const feedback = (await flowDepsOf(w)).feedback!;
    expect(feedback.ashby()).toBeNull();
    vi.stubEnv('ASHBY_API_KEY', usableKey());
    const port = feedback.ashby();
    expect(port).not.toBeNull();
    expect(feedback.ashby()).toBe(port);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]![0]).toMatchObject({ apiKey: usableKey() });
    // Building the port calls nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a key the client refuses is as unusable as none, and the next call tries again', () => {
    vi.stubEnv('ASHBY_API_KEY', usableKey());
    const db = createR1MeetFakeDb();
    if (!MEET_ON.enabled) throw new Error('MEET_ON must be enabled');
    const feedback = createR1MeetFeedbackPorts(db.client, MEET_ON, quiet);
    factory.mockImplementationOnce(() => {
      throw new Error('refused');
    });
    expect(feedback.ashby()).toBeNull();
    expect(feedback.ashby()).not.toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(db.calls).toEqual([]);
  });

  /** A completed Meet booking whose round has a current assessment and no feedback receipt. */
  function lostTrigger(w: World): { bookingId: string; assessmentId: string } {
    const assessmentId = fixtureId();
    const round = w.db.addRound({ status: 'completed', assessment_id: assessmentId });
    const session = w.db.addSession({ interview_round_id: round.id as string, status: 'completed' });
    const startMs = w.clock.ms - 2 * 60 * MINUTE;
    const booking = w.db.seedBooking({
      status: 'completed',
      reason: 'attempt_settled',
      round_id: round.id,
      session_id: session.id,
      start_at: iso(startMs),
      end_at: iso(startMs + 45 * MINUTE),
    });
    return { bookingId: booking.id as string, assessmentId };
  }

  /**
   * Run this bucket's maintenance job through the runtime's own lane. The sweep tick queues each
   * bucket's job one bucket ahead, so the test queues the current bucket's (as the earlier bucket's
   * tick would have) and lets ONE lane tick claim and run it.
   */
  async function runMaintenance(w: World): Promise<void> {
    const lane = w.runtime!.meetLane!;
    const bucket = Math.floor(w.clock.ms / (15 * MINUTE));
    await w.queue.enqueue(R1_MEET_QUEUE, { kind: 'maintenance', bucket }, { maxAttempts: 3 });
    await lane.tick();
    await settle(lane);
    await w.runtime!.stop();
  }

  it('maintenance in the runtime: the form setting blank = the re-drive reads nothing', async () => {
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', '');
    const w = world();
    lostTrigger(w);
    await runMaintenance(w);
    expect(w.runtime!.snapshot().meetJobEvents.completed).toBe(1);
    const names = w.db.calls.map((call) => call.name);
    expect(names).not.toContain('r1_meet_receipts');
    expect(names).not.toContain('interview_rounds');
    expect(names).not.toContain('r1_meet_record_receipt');
    expect(w.db.jobs('scorecard_feedback')).toEqual([]);
  });

  it('maintenance in the runtime: the form setting set = a lost trigger is re-driven with ids only', async () => {
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', FORM_ID);
    vi.stubEnv('ASHBY_API_KEY', '');
    const w = world();
    const lost = lostTrigger(w);
    await runMaintenance(w);
    expect(w.runtime!.snapshot().meetJobEvents.completed).toBe(1);
    const jobs = w.db.jobs('scorecard_feedback');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ kind: 'scorecard_feedback', booking_id: lost.bookingId, assessment_id: lost.assessmentId });
    expect(Object.keys(jobs[0]!.payload).sort()).toEqual(['assessment_id', 'booking_id', 'kind', 'receipt_id', 'source']);
    const logs = written.join('\n');
    expect(logs).toContain('"error_category":"r1_meet_feedback_redriven"');
    expect(logs).toContain('"error_type":"maintenance:maintenance"');
    for (const id of [lost.bookingId, lost.assessmentId]) expect(logs).not.toContain(id);
    // No Ashby port was needed to queue it.
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('M035 S11: the tag ports of the lane', () => {
  const tagFactory = vi.mocked(createR1MeetAshbyTagPort);

  beforeEach(() => {
    tagFactory.mockClear();
  });

  it('the seam is honoured: a job sees exactly the tag ports it was given', async () => {
    const w = world();
    const given: R1MeetAshbyTagDeps = Object.freeze({
      store: {} as R1MeetAshbyTagDeps['store'],
      ashbyActive: () => false,
      ashby: () => null,
    });
    expect((await flowDepsOf(w, undefined, given)).ashbyTag).toBe(given);
    expect(tagFactory).not.toHaveBeenCalled();
  });

  it('production ports: the booked-tag store; no ASHBY_API_KEY = null and NO client built; building them reads nothing', async () => {
    vi.stubEnv('ASHBY_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world();
    const deps = await flowDepsOf(w);
    const ashbyTag = deps.ashbyTag!;
    expect(ashbyTag).toBeDefined();
    expect(Object.isFrozen(ashbyTag)).toBe(true);
    expect(Object.keys(ashbyTag).sort()).toEqual(['ashby', 'ashbyActive', 'store']);
    for (const read of ['booking', 'applicationLink', 'candidateApplications', 'newestPublicBooking'] as const) {
      expect(typeof ashbyTag.store[read]).toBe('function');
    }
    // The scorecard's group is still built next to it, unchanged.
    expect(deps.feedback).toBeDefined();

    expect(ashbyTag.ashby()).toBeNull();
    vi.stubEnv('ASHBY_API_KEY', 'replace_me');
    expect(ashbyTag.ashby()).toBeNull();
    expect(tagFactory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.db.calls).toEqual([]);
  });

  it("production ports: Ashby's own switches, read per call, the same two as Dex's scorecard", async () => {
    // A webhook secret long enough to count, built at run time (never a secret-shaped literal).
    const secret = 's'.repeat(24);
    vi.stubEnv('ASHBY_INTEGRATION_ENABLED', 'true');
    vi.stubEnv('ASHBY_WEBHOOK_SECRET', secret);
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', 'true');
    vi.stubEnv('ASHBY_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world();
    const deps = await flowDepsOf(w);
    const ashbyTag = deps.ashbyTag!;
    const feedback = deps.feedback!;
    /** Both groups answer the same at every step (one shared reading of the switches). */
    const both = (): [boolean, boolean] => [ashbyTag.ashbyActive(), feedback.ashbyActive()];
    // On: both switches, whatever the key (the key is the job's next question).
    expect(both()).toEqual([true, true]);
    // The documented "stop all Ashby writes" rollback, each step on its own (ashby-runtime-activation.md §6).
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', 'false');
    expect(both()).toEqual([false, false]);
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', 'true');
    vi.stubEnv('ASHBY_INTEGRATION_ENABLED', 'false');
    expect(both()).toEqual([false, false]);
    vi.stubEnv('ASHBY_INTEGRATION_ENABLED', 'true');
    vi.stubEnv('ASHBY_WEBHOOK_SECRET', 'replace_me');
    expect(both()).toEqual([false, false]);
    vi.stubEnv('ASHBY_WEBHOOK_SECRET', secret);
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', '');
    expect(both()).toEqual([false, false]);
    vi.stubEnv('ASHBY_RUNTIME_ENABLED', 'true');
    expect(both()).toEqual([true, true]);
    expect(tagFactory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.db.calls).toEqual([]);
  });

  it('a null is not remembered (a key set later counts), and a built port is kept', async () => {
    vi.stubEnv('ASHBY_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world();
    const ashbyTag = (await flowDepsOf(w)).ashbyTag!;
    expect(ashbyTag.ashby()).toBeNull();
    vi.stubEnv('ASHBY_API_KEY', usableKey());
    const port = ashbyTag.ashby();
    expect(port).not.toBeNull();
    expect(Object.isFrozen(port)).toBe(true);
    expect(typeof port!.client.candidateInfo).toBe('function');
    expect(typeof port!.resolver.resolve).toBe('function');
    expect(ashbyTag.ashby()).toBe(port);
    // Kept even when the key goes away afterwards (the built client holds it).
    vi.stubEnv('ASHBY_API_KEY', '');
    expect(ashbyTag.ashby()).toBe(port);
    expect(tagFactory).toHaveBeenCalledTimes(1);
    expect(tagFactory.mock.calls[0]![0]).toMatchObject({ apiKey: usableKey() });
    // Production passes no transport, sleep or clock: the real network, at the first call only.
    expect(Object.keys(tagFactory.mock.calls[0]![0]).sort()).toEqual(['apiKey', 'log']);
    // Building the port calls nothing and reads nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.db.calls).toEqual([]);
  });

  it('a key the client refuses is as unusable as none, and the next call tries again', () => {
    vi.stubEnv('ASHBY_API_KEY', usableKey());
    const db = createR1MeetFakeDb();
    const ashbyTag = createR1MeetAshbyTagPorts(db.client, quiet);
    tagFactory.mockImplementationOnce(() => {
      throw new Error('refused');
    });
    expect(ashbyTag.ashby()).toBeNull();
    expect(ashbyTag.ashby()).not.toBeNull();
    expect(tagFactory).toHaveBeenCalledTimes(2);
    expect(db.calls).toEqual([]);
  });

  it('the production lane runs an ashby_booked_tag job on its wired definition: a missing booking ends ignored, one booking read, no Ashby call', async () => {
    vi.stubEnv('ASHBY_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = world();
    const lane = w.runtime!.meetLane!;
    const bookingId = fixtureId();
    const spec = r1MeetJobs.ashbyBookedTag('add', bookingId);
    const job = await w.queue.enqueue(R1_MEET_QUEUE, spec.payload, { dedupKey: spec.dedupKey, maxAttempts: spec.maxAttempts });
    await lane.tick();
    await settle(lane);
    await w.runtime!.stop();

    expect((await w.queue.getById(job.id))!.status).toBe('completed');
    expect(w.runtime!.snapshot().meetJobEvents.completed).toBe(1);
    const logs = written.join('\n');
    expect(logs).toContain('"error_type":"ashby_booked_tag:booking_missing"');
    expect(logs).not.toContain('r1_meet_ashby_tag_unwired');
    expect(logs.toLowerCase()).not.toContain(bookingId.toLowerCase());
    // One narrow read of the booking, nothing else: no link read, no Ashby port, no request.
    expect(w.db.calls).toEqual([{ kind: 'from', name: 'r1_meet_bookings' }]);
    expect(tagFactory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.requests).toEqual([]);
  });
});
