/**
 * M035 S02 T2: public-page bookings (source `public_page`, no Ashby event, schedule or scheduler)
 * through the rest of the M034 Meet runtime, by PARITY with Ashby bookings.
 *
 * Method: every flow runs twice, in two fresh harnesses (the REAL Recall client over the S01 fake and
 * the in-memory 0142/0143 port): once for an Ashby booking (`h.createBooking`, the real create RPC)
 * and once for a public one (`h.createPublicBooking`), with the same slot, status and bot state,
 * reached through the same real RPCs and job definitions. The two runs must observe the SAME:
 *   - job results (and maintenance reports),
 *   - final booking status, reason, version, key_attempt, ticket state and bot / session presence,
 *   - Recall requests (op, method, path, headers, body), in order,
 *   - timeline (`recall:*`, `db:*`, `queue:*`), database calls with their arguments,
 *   - queued jobs (kind, payload key set, payload, dedup key, schedule),
 *   - log lines (alerts included) and hot-window hints,
 * with every id replaced by a stable token. The only differences allowed are asserted explicitly:
 * the create Idempotency-Key (`r1-meet-<event>-v…-k…` vs `r1-meet-pb-<booking>-v…-k…`), and the
 * `p_ashby_updated_at` the capped re-drive's reschedule sends (the Ashby row's own value vs null).
 *
 * Flows: maintenance (owed release, overdue per status, stuck pending, the daily cap and its
 * re-drive), `recall_event` (joining, human present and the arm, a terminal event, two humans),
 * `bridge_check`, `bot_release`, `round_cancelled`, `attempt_ended`, drain, the bridge page's half
 * (peek, claim, bind) and the two hooks (`notifyR1MeetScorecardReady`, `notifyR1MeetAttemptEnded`).
 * Every flow: no log line holds a booking, bot, round, session, candidate, application or event id,
 * the Meet URL, an `@` or the web origin.
 *
 * Fixture ids live in `7f000000-0000-4000-8000-…`; secrets are built at run time; fakes only.
 */

import { describe, expect, it } from 'vitest';
import { armBridge } from '../lib/r1/meet/arm.js';
import { notifyR1MeetAttemptEnded } from '../lib/r1/meet/attempt-ended.js';
import type { R1MeetBookingReason, R1MeetBookingStatus } from '../lib/r1/meet/bookings-read.js';
import { ensureBot } from '../lib/r1/meet/bot-flow.js';
import { bindR1MeetSession, claimR1MeetTicket, peekR1MeetTicket } from '../lib/r1/meet/bridge-store.js';
import { getR1MeetConfig, type R1MeetFeedbackConfig } from '../lib/r1/meet/config.js';
import { r1MeetDrainDefinition } from '../lib/r1/meet/drain.js';
import {
  r1MeetAttemptEndedDefinition,
  r1MeetBridgeCheckDefinition,
  r1MeetMultiHumanCheckDefinition,
  r1MeetRecallEventDefinition,
} from '../lib/r1/meet/event-handler.js';
import { notifyR1MeetScorecardReady } from '../lib/r1/meet/feedback-notify.js';
import { R1_MEET_QUEUE, r1MeetJobMeta, r1MeetJobs, type R1MeetJobMeta, type R1MeetJobResult } from '../lib/r1/meet/jobs.js';
import { r1MeetMaintenanceDefinition, runR1MeetMaintenance } from '../lib/r1/meet/maintenance.js';
import type { R1MeetJobDefinition } from '../lib/r1/meet/recall-actions.js';
import {
  r1MeetBotReleaseDefinition,
  r1MeetEnsureBotDefinition,
  r1MeetRoundCancelledDefinition,
} from '../lib/r1/meet/schedule-handler.js';
import { r1MeetTicketDigest } from '../lib/r1/meet/ticket.js';
import {
  BRIDGE_PAGE_URL,
  BRIDGE_SOURCE,
  MEET_URL,
  STAFF_USER_ID,
  WEB_ORIGIN_FIXTURE,
  createR1MeetHarness,
  fixtureId,
  type HarnessOptions,
  type R1MeetHarness,
} from './support/r1-meet-harness.js';
import { FAKE_RECALL_API_KEY } from './support/recall-fake.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const ASSESSMENT_ID = '7f000000-0000-4000-8000-00000000f201';
const DEX_USER_ID = '7f000000-0000-4000-8000-00000000f202';
const FEEDBACK_FORM_ID = '7f000000-0000-4000-8000-00000000f203';
const R1_ON = { enabled: true };
/** An enabled Meet config: the webhook secret is built at run time, never a secret-shaped literal. */
const MEET_ON = getR1MeetConfig({
  R1_MEET_ENABLED: 'true',
  RECALL_API_KEY: FAKE_RECALL_API_KEY,
  RECALL_WEBHOOK_SECRET: 'whsec' + '_' + Buffer.alloc(32, 7).toString('base64'),
  R1_MEET_ASHBY_DEX_USER_ID: DEX_USER_ID,
  R1_MEET_SERVICE_USER_ID: STAFF_USER_ID,
  WEB_ORIGIN: WEB_ORIGIN_FIXTURE,
});
const FEEDBACK_ON: R1MeetFeedbackConfig = { status: 'on', formDefinitionId: FEEDBACK_FORM_ID };

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ── Twin worlds ─────────────────────────────────────────────────────────────

type Source = 'ashby' | 'public_page';

interface World {
  readonly source: Source;
  readonly h: R1MeetHarness;
  /** Every id this world's bookings carry, and the token it reads as when two worlds are compared. */
  readonly ids: Map<string, string>;
  /** Log lines of the set-up steps (cleared from `h.logs` by `reset`, still checked for PII). */
  readonly setupLogs: unknown[];
}

/** Distinct, predictable random bytes per mint: byte value n for the n-th mint. */
function countingRandom(): (bytes: number) => Buffer {
  let n = 0;
  return (bytes) => Buffer.alloc(bytes, ++n);
}

function world(source: Source, options: HarnessOptions): World {
  return { source, h: createR1MeetHarness({ random: countingRandom(), ...options }), ids: new Map(), setupLogs: [] };
}

function track(w: World, label: string, ids: Readonly<Record<string, string | null | undefined>>): void {
  for (const [name, id] of Object.entries(ids)) {
    if (typeof id === 'string') w.ids.set(id.toLowerCase(), `<${label}:${name}>`);
  }
}

/** Clear the traces of the set-up (its log lines are kept aside for the PII check). */
function reset(w: World): void {
  const { h } = w;
  w.setupLogs.push(...h.logs);
  h.logs.length = 0;
  h.timeline.length = 0;
  h.requests.length = 0;
  h.hot.length = 0;
  h.sleeps.length = 0;
  h.db.calls.length = 0;
}

/** Every string with each known id replaced by its token, and any other UUID by `<uuid>`. */
function normalize(w: World, value: unknown): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const [id, token] of w.ids) text = text.split(id).join(token);
    return text.replace(UUID_ANYWHERE, '<uuid>');
  }
  if (Array.isArray(value)) return value.map((item) => normalize(w, item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(w, item)]));
  }
  return value;
}

interface Booked {
  readonly id: string;
  readonly eventId: string | null;
  readonly roundId: string;
  readonly startAt: string;
  readonly botId: string | null;
  readonly sessionId: string | null;
}

/** The state of a booking that both sources must share (not its source, ids or Ashby columns). */
function stateOf(h: R1MeetHarness, id: string): Record<string, unknown> | null {
  const row = h.db.booking(id);
  if (row === undefined) return null;
  return {
    status: row.status,
    reason: row.reason,
    version: row.version,
    key_attempt: row.key_attempt,
    bot: row.recall_bot_id !== null,
    ticket_arms: row.ticket_arms,
    ticket: row.ticket_digest !== null,
    claimed: row.ticket_claimed_at !== null,
    session: row.session_id !== null,
    start_at: row.start_at,
    end_at: row.end_at,
    meet_url: row.meet_url,
    objective_profile: row.objective_profile,
  };
}

function observe(w: World, bookings: readonly Booked[], results: readonly unknown[], extra: unknown = null): unknown {
  const { h } = w;
  for (const b of bookings) expect(h.db.booking(b.id)?.source ?? w.source).toBe(w.source);
  return normalize(w, {
    results,
    bookings: bookings.map((b) => stateOf(h, b.id)),
    recall: h.requests.map((request) => {
      // The one header that differs by source; asserted on its own (`createKeys`).
      const { 'idempotency-key': _key, ...headers } = request.headers;
      return { op: request.op, method: request.method, path: request.path, headers, body: request.body };
    }),
    timeline: h.timeline,
    rpcs: h.db.calls,
    jobs: h.db.jobs().map((job) => ({
      kind: job.payload.kind,
      keys: Object.keys(job.payload).sort(),
      payload: job.payload,
      dedupKey: job.dedup_key,
      scheduledAt: job.scheduled_at,
      maxAttempts: job.max_attempts,
      status: job.status,
    })),
    alerts: h.alerts(),
    logs: h.logs,
    hot: h.hot,
    sleeps: h.sleeps,
    extra,
  });
}

/** Run `scenario` for an Ashby booking and for a public one; they must observe the same. */
async function twins(scenario: (w: World) => Promise<unknown>, options: HarnessOptions = {}): Promise<void> {
  const ashby = world('ashby', options);
  const observedAshby = await scenario(ashby);
  expectNoPii(ashby);
  const pub = world('public_page', options);
  const observedPublic = await scenario(pub);
  expectNoPii(pub);
  expect(observedPublic).toEqual(observedAshby);
}

/** No log line (set-up included) holds an id, the Meet URL, an email or the web origin; no job holds the URL. */
function expectNoPii(w: World): void {
  const logs = JSON.stringify([...w.setupLogs, ...w.h.logs]);
  const jobs = JSON.stringify(w.h.db.jobs().map((job) => job.payload));
  for (const value of [MEET_URL, 'meet.google.com', '@', WEB_ORIGIN_FIXTURE, 'hello.example.test', BRIDGE_PAGE_URL]) {
    expect(logs).not.toContain(value);
    expect(jobs).not.toContain(value);
  }
  expect(w.ids.size).toBeGreaterThan(0);
  for (const id of w.ids.keys()) expect(logs).not.toContain(id);
}

// ── Small helpers ───────────────────────────────────────────────────────────

const done = (receipt: 'processed' | 'ignored', code: string) => ({ outcome: 'done', receipt, code });
const recallOps = (h: R1MeetHarness): string[] => h.requests.map((request) => request.op);
const createKeys = (h: R1MeetHarness): Array<string | undefined> =>
  h.requests.filter((request) => request.op === 'create').map((request) => request.headers['idempotency-key']);
const payloads = (h: R1MeetHarness, kind: string): Array<Record<string, unknown>> =>
  h.db.jobs(kind).map((job) => job.payload as Record<string, unknown>);

/** The create Idempotency-Key of a booking of this world's source: the one allowed difference. */
function keyOf(w: World, b: Pick<Booked, 'id' | 'eventId'>, version: number, keyAttempt: number): string {
  if (w.source === 'ashby') return `r1-meet-${b.eventId}-v${version}-k${keyAttempt}`;
  return `r1-meet-pb-${b.id}-v${version}-k${keyAttempt}`;
}

async function runJob<T>(
  h: R1MeetHarness,
  definition: R1MeetJobDefinition<T>,
  payload: unknown,
  meta: R1MeetJobMeta = h.meta(),
): Promise<R1MeetJobResult> {
  const job = definition.parse(payload);
  expect(job).not.toBeNull();
  return definition.run(h.deps, job!, meta);
}

async function move(
  h: R1MeetHarness,
  bookingId: string,
  from: R1MeetBookingStatus,
  to: R1MeetBookingStatus,
  reason: R1MeetBookingReason = 'eligible',
): Promise<void> {
  const answer = await h.db.store.transition({ bookingId, from, to, reason, nowIso: iso(h.now()) });
  expect(answer.status).toBe('ok');
}

/** A `pending/eligible` booking of the world's source, with the slot asked for. */
async function createPending(w: World, startAt: string, label: string): Promise<Booked> {
  const { h } = w;
  let id: string;
  let roundId: string;
  let eventId: string | null = null;
  if (w.source === 'ashby') {
    eventId = fixtureId();
    const created = await h.createBooking({ eventId, startAt });
    id = created.bookingId;
    roundId = created.roundId;
  } else {
    const created = h.createPublicBooking({ startAt });
    id = created.bookingId;
    roundId = created.roundId;
  }
  const row = h.db.booking(id)!;
  expect(row).toMatchObject({ source: w.source, status: 'pending', reason: 'eligible', start_at: startAt, round_id: roundId });
  if (w.source === 'public_page') {
    expect(row).toMatchObject({ ashby_interview_event_id: null, ashby_schedule_id: null, ashby_scheduled_by_user_id: null });
  }
  track(w, label, {
    booking: id,
    round: roundId,
    candidate: row.candidate_id as string,
    application: row.ashby_application_id as string,
    event: eventId,
    schedule: row.ashby_schedule_id as string | null,
  });
  return { id, eventId, roundId, startAt, botId: null, sessionId: null };
}

const outputMedia = (h: R1MeetHarness) => h.requests.filter((request) => request.op === 'output_media');
const lastTicket = (h: R1MeetHarness): string => {
  const url = (outputMedia(h).at(-1)!.body as { camera: { config: { url: string } } }).camera.config.url;
  return url.slice(`${BRIDGE_PAGE_URL}#t=`.length);
};

type State = 'pending' | 'bot_scheduled' | 'bot_joining' | 'human_present' | 'in_call' | 'in_call_session';

interface BookedOptions {
  /** Slot start from now (default one minute: the ticket window is open). */
  readonly startInMs?: number;
  readonly sessionStatus?: string;
  readonly label?: string;
}

/**
 * A booking of the world's source in the asked state, reached through the real RPCs (create,
 * `ensureBot`, the transitions, a real arm, the bridge page's real claim and bind), the Recall fake's
 * bot mirrored. The create key is checked on the way. The traces are cleared at the end.
 */
async function booked(w: World, state: State, o: BookedOptions = {}): Promise<Booked> {
  const { h } = w;
  const label = o.label ?? 'b';
  const pending = await createPending(w, iso(h.now() + (o.startInMs ?? MIN)), label);
  if (state === 'pending') {
    reset(w);
    return pending;
  }
  expect(await ensureBot(h.deps, pending.id, h.meta())).toEqual(done('processed', 'bot_scheduled'));
  expect(createKeys(h)).toEqual([keyOf(w, pending, 0, 0)]);
  const botId = h.db.booking(pending.id)!.recall_bot_id as string;
  track(w, label, { bot: botId });
  let sessionId: string | null = null;
  if (state === 'bot_joining') {
    h.recall.markDispatched(botId);
    await move(h, pending.id, 'bot_scheduled', 'bot_joining');
  }
  if (state === 'human_present' || state === 'in_call' || state === 'in_call_session') {
    h.recall.markDispatched(botId);
    h.recall.setStatus(botId, 'in_call_recording');
    await move(h, pending.id, 'bot_scheduled', 'human_present');
  }
  if (state === 'in_call' || state === 'in_call_session') {
    const booking = (await h.db.store.getBooking(pending.id))!;
    expect(await armBridge(h.deps, booking, h.meta())).toMatchObject({ code: 'armed' });
    const digest = r1MeetTicketDigest(lastTicket(h), BRIDGE_SOURCE)!;
    const claimed = await claimR1MeetTicket(h.db.client, digest, iso(h.now()));
    expect(claimed).toMatchObject({ kind: 'ok', binding: { bookingId: pending.id, roundId: pending.roundId, sessionId: null } });
    if (state === 'in_call_session') {
      const session = h.db.addSession({ interview_round_id: pending.roundId, status: o.sessionStatus ?? 'in_progress' });
      sessionId = session.id as string;
      track(w, label, { session: sessionId });
      expect(await bindR1MeetSession(h.db.client, pending.id, sessionId, iso(h.now()))).toEqual({ kind: 'ok', previousSessionId: null });
    }
  }
  reset(w);
  return { ...pending, botId, sessionId };
}

interface Delivery {
  readonly subCode?: string | null;
  readonly participantId?: number;
  readonly isBot?: boolean | null;
}

/**
 * One Recall webhook as S03 writes it: the durable `recall_event` job row (the participant counter
 * reads those rows), the Recall fake's bot mirrored for a `bot.*` status, then the job run.
 */
async function deliver(w: World, b: Booked, type: string, d: Delivery = {}): Promise<R1MeetJobResult> {
  const { h } = w;
  const botId = b.botId!;
  const receiptId = fixtureId();
  const payload = {
    kind: 'recall_event',
    event_type: type,
    recall_bot_id: botId,
    booking_id: b.id,
    occurred_at: iso(h.now()),
    sub_code: d.subCode ?? null,
    participant: type.startsWith('participant_events.')
      ? { id: d.participantId ?? 101, is_host: null, is_bot: d.isBot ?? null }
      : null,
    receipt_id: receiptId,
    source: 'recall',
  };
  h.db.enqueue({ payload, dedupKey: `r1-meet:receipt:${receiptId}`, maxAttempts: 5 });
  const bot = h.recall.bots.get(botId);
  if (bot !== undefined && type.startsWith('bot.')) {
    bot.dispatched = true;
    h.recall.setStatus(botId, type.slice('bot.'.length), d.subCode ?? null);
  }
  return runJob(h, r1MeetRecallEventDefinition, payload);
}

// ── The comparison itself ───────────────────────────────────────────────────

describe('the parity comparison', () => {
  it('is not vacuous: ids become tokens, and a different outcome or call is seen', async () => {
    const ashby = world('ashby', {});
    const pub = world('public_page', {});
    const a = await booked(ashby, 'pending');
    const p = await booked(pub, 'pending');
    const resultA = await ensureBot(ashby.h.deps, a.id, ashby.h.meta());
    track(ashby, 'b', { bot: ashby.h.db.booking(a.id)!.recall_bot_id as string });
    const seenA = observe(ashby, [a], [resultA]);
    const text = JSON.stringify(seenA);
    expect(text).toContain('<b:booking>');
    expect(text).toContain('<b:bot>');
    expect(text).not.toContain(a.id);
    // The public twin did nothing: its observation must differ.
    expect(observe(pub, [p], [resultA])).not.toEqual(seenA);
    // Same run, but a different Recall answer path (a canned 500): seen as a difference too.
    pub.h.intercept('create', { status: 500, body: {} });
    const resultP = await ensureBot(pub.h.deps, p.id, pub.h.meta());
    expect(observe(pub, [p], [resultP])).not.toEqual(seenA);
  });
});

// ── 1. maintenance ──────────────────────────────────────────────────────────

describe('maintenance over a public booking, as over an Ashby one', () => {
  it('an owed release (a terminal booking still holding its bot): bot_release queued, ids only', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'bot_scheduled');
      await move(h, b.id, 'bot_scheduled', 'failed', 'no_show');
      reset(w);
      const result = await runJob(h, r1MeetMaintenanceDefinition, { kind: 'maintenance', bucket: 1 });
      expect(result).toEqual(done('processed', 'maintenance'));
      expect(payloads(h, 'bot_release')).toEqual([{ kind: 'bot_release', recall_bot_id: b.botId, booking_id: b.id }]);
      expect(h.requests).toEqual([]);
      expect(h.logs).toEqual([]);
      return observe(w, [b], [result]);
    });
  });

  it.each([
    ['pending', 'in_past', false],
    ['bot_scheduled', 'no_show', true],
    ['bot_joining', 'no_show', true],
    ['human_present', 'bot_fatal', true],
    ['in_call', 'admission_refused', true],
  ] as const)('an overdue %s booking (slot ended 31 min ago) -> failed/%s', async (state, reason, holdsBot) => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, state);
      // One minute to the start, the 45-minute slot, then past the 30-minute grace.
      h.advance(MIN + 45 * MIN + 31 * MIN);
      const report = await runR1MeetMaintenance(h.deps, 1);
      expect(report.failed).toEqual([]);
      expect(report.counts.overdue).toBe(1);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason, recall_bot_id: b.botId });
      expect(payloads(h, 'bot_release')).toEqual(
        holdsBot ? [{ kind: 'bot_release', recall_bot_id: b.botId, booking_id: b.id }] : [],
      );
      // Maintenance never calls Recall itself: the queued release does.
      expect(h.requests).toEqual([]);
      return observe(w, [b], [report]);
    });
  });

  it('a stuck pending booking: ensure_bot queued, and that job creates under the source key', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'pending', { startInMs: DAY });
      h.advance(11 * MIN);
      const report = await runR1MeetMaintenance(h.deps, 1);
      expect(report.counts.stuck).toBe(1);
      const [job] = payloads(h, 'ensure_bot');
      expect(job).toEqual({ kind: 'ensure_bot', booking_id: b.id });
      const result = await runJob(h, r1MeetEnsureBotDefinition, job);
      expect(result).toEqual(done('processed', 'bot_scheduled'));
      expect(createKeys(h)).toEqual([keyOf(w, b, 0, 0)]);
      track(w, 'b', { bot: h.db.booking(b.id)!.recall_bot_id as string });
      expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_scheduled', version: 0, key_attempt: 0 });
      expect(recallOps(h)).toEqual(['create']);
      return observe(w, [b], [report, result]);
    });
  });

  it('the daily cap: a public bot counts like an Ashby one; capped -> ensure_bot; quiet while capped; then reschedule and the source key', async () => {
    await twins(
      async (w) => {
        const { h } = w;
        // Another booking of the same source and IST day already used the one bot of the cap.
        const capper = await booked(w, 'bot_scheduled', { startInMs: DAY, label: 'capper' });
        const createdIso = iso(h.now());
        const b = await createPending(w, iso(Date.parse(capper.startAt) + HOUR), 'b');
        const capped = await ensureBot(h.deps, b.id, h.meta());
        expect(capped).toEqual(done('processed', 'bot_cap_reached'));
        expect(h.alerts()).toEqual(['r1_meet_bot_cap_reached']);
        expect(createKeys(h)).toEqual([]);
        // The cap retired the key first (S06-R2): key_attempt 1, same generation.
        expect(h.db.booking(b.id)).toMatchObject({ status: 'blocked', reason: 'bot_cap_reached', version: 0, key_attempt: 1, recall_bot_id: null });
        reset(w);

        const report = await runR1MeetMaintenance(h.deps, 1);
        expect(report.counts.capped).toBe(1);
        const [job] = payloads(h, 'ensure_bot');
        expect(job).toEqual({ kind: 'ensure_bot', booking_id: b.id });
        const still = await runJob(h, r1MeetEnsureBotDefinition, job);
        expect(still).toEqual(done('ignored', 'bot_cap_reached'));
        expect(h.requests).toEqual([]);
        expect(h.alerts()).toEqual([]);

        h.config.dailyBotCap = 2;
        const result = await runJob(h, r1MeetEnsureBotDefinition, job);
        expect(result).toEqual(done('processed', 'bot_scheduled'));
        const reschedules = h.db.calls.filter((call) => call.kind === 'rpc' && call.name === 'r1_meet_reschedule_booking');
        expect(reschedules).toHaveLength(1);
        const args = reschedules[0]!.args!;
        expect(args).toStrictEqual({
          p_booking_id: b.id,
          p_expected_version: 0,
          p_start_at: b.startAt,
          p_end_at: iso(Date.parse(b.startAt) + 45 * MIN),
          p_meet_url: MEET_URL,
          // The second allowed difference: a public row has no Ashby update time to keep ordered.
          p_ashby_updated_at: w.source === 'ashby' ? createdIso : null,
          p_expiry_grace_sec: 7200,
          p_now: iso(h.now()),
        });
        args.p_ashby_updated_at = '<ashby_updated_at>';
        // Same slot: the generation is kept, so is the rotated key attempt.
        expect(createKeys(h)).toEqual([keyOf(w, b, 0, 1)]);
        track(w, 'b', { bot: h.db.booking(b.id)!.recall_bot_id as string });
        expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_scheduled', reason: 'eligible', version: 0, key_attempt: 1 });
        return observe(w, [capper, b], [capped, report, still, result]);
      },
      { config: { dailyBotCap: 1 } },
    );
  });
});

// ── 2. recall_event, bridge_check, multi_human_check ────────────────────────

describe('the call side over a public booking, as over an Ashby one', () => {
  it('joining, then a participant join: human_present, the arm and its ticket; a duplicate signal is ignored', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'bot_scheduled');
      const results = [
        await deliver(w, b, 'bot.joining_call'),
        await deliver(w, b, 'participant_events.join', { participantId: 101 }),
        await deliver(w, b, 'bot.in_call_recording'),
      ];
      // The compare-and-set winner arms, and answers the arm's own result.
      expect(results).toEqual([
        done('processed', 'bot_joining'),
        done('processed', 'armed'),
        done('ignored', 'already_present'),
      ]);
      const row = h.db.booking(b.id)!;
      expect(row).toMatchObject({ status: 'human_present', reason: 'eligible', ticket_arms: 1, ticket_claimed_at: null });
      expect(row.ticket_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(recallOps(h)).toEqual(['get', 'output_media']);
      expect(payloads(h, 'bridge_check')).toEqual([{ kind: 'bridge_check', booking_id: b.id, version: 0, arm: 1 }]);
      // The page's half reads the ticket's booking without any Ashby id.
      const digest = r1MeetTicketDigest(lastTicket(h), BRIDGE_SOURCE)!;
      const peeked = await peekR1MeetTicket(h.db.client, digest);
      expect(peeked).toMatchObject({ kind: 'found', booking: { id: b.id, status: 'human_present', roundId: b.roundId, sessionId: null } });
      expect(h.alerts()).toEqual([]);
      return observe(w, [b], [...results, peeked]);
    });
  });

  it('a terminal event of a joining bot that was in the call: Recall read first (M035 S09), failed/no_show, released', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'bot_joining');
      h.recall.setStatus(b.botId!, 'in_call_not_recording');
      const result = await deliver(w, b, 'bot.call_ended', { subCode: 'call_ended_by_host' });
      expect(result).toEqual(done('processed', 'failed_no_show'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
      // The one GET before the move already says the call ended: no second Recall call.
      expect(h.timeline.filter((step) => step !== 'queue:recall_event')).toEqual([
        'recall:get',
        'db:transition:failed',
        'db:set_bot:release',
      ]);
      expect(h.alerts()).toEqual([]);
      return observe(w, [b], [result]);
    });
  });

  it('a terminal event of a joining bot that never got into the call: failed/bot_fatal (M035 S09), released', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'bot_joining');
      const result = await deliver(w, b, 'bot.call_ended', { subCode: 'call_ended_by_host' });
      expect(result).toEqual(done('processed', 'failed_bot_fatal'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: null });
      expect(h.timeline.filter((step) => step !== 'queue:recall_event')).toEqual([
        'recall:get',
        'db:transition:failed',
        'db:set_bot:release',
      ]);
      return observe(w, [b], [result]);
    });
  });

  it('bridge_check of an unclaimed arm after 200 s: a re-arm (a second ticket and page)', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'bot_scheduled');
      await deliver(w, b, 'bot.in_call_recording');
      const [check] = payloads(h, 'bridge_check');
      expect(check).toEqual({ kind: 'bridge_check', booking_id: b.id, version: 0, arm: 1 });
      const armedAt = h.now();
      reset(w);
      h.advance(201 * SEC);
      const meta = r1MeetJobMeta({ attempts: 1, maxAttempts: 10, deferCount: 0, createdAt: iso(armedAt) });
      const result = await runJob(h, r1MeetBridgeCheckDefinition, check, meta);
      expect(result).toEqual(done('processed', 'armed'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 2 });
      expect(recallOps(h)).toEqual(['get', 'output_media']);
      return observe(w, [b], [result]);
    });
  });

  it('two humans: a multi_human_check 120 s later; policy end leaves first, then failed/multiple_humans', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'bot_scheduled');
      await deliver(w, b, 'bot.joining_call');
      await deliver(w, b, 'participant_events.join', { participantId: 101 });
      const second = await deliver(w, b, 'participant_events.join', { participantId: 102 });
      expect(second).toEqual(done('ignored', 'already_present'));
      const [check] = payloads(h, 'multi_human_check');
      expect(check).toEqual({ kind: 'multi_human_check', booking_id: b.id, version: 0 });
      reset(w);
      h.advance(121 * SEC);
      const result = await runJob(h, r1MeetMultiHumanCheckDefinition, check);
      expect(result).toEqual(done('processed', 'multiple_humans'));
      expect(h.alerts()).toEqual(['r1_meet_multiple_humans']);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'multiple_humans', recall_bot_id: null });
      expect(h.timeline).toEqual(['recall:get', 'recall:leave', 'db:transition:failed', 'db:set_bot:release']);
      return observe(w, [b], [second, result]);
    });
  });
});

// ── 3. bot_release ──────────────────────────────────────────────────────────

describe('bot_release of a public booking’s bot, as of an Ashby one', () => {
  it('a terminal holder: released at Recall, then recorded', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'bot_scheduled');
      await move(h, b.id, 'bot_scheduled', 'failed', 'no_show');
      reset(w);
      const result = await runJob(h, r1MeetBotReleaseDefinition, r1MeetJobs.botRelease(b.botId!, b.id).payload);
      expect(result).toEqual(done('processed', 'released_deleted'));
      expect(h.timeline).toEqual(['recall:get', 'recall:delete', 'db:set_bot:release']);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
      return observe(w, [b], [result]);
    });
  });

  it('a live holder: ignored in_use, no Recall call', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'bot_scheduled');
      const result = await runJob(h, r1MeetBotReleaseDefinition, r1MeetJobs.botRelease(b.botId!, b.id).payload);
      expect(result).toEqual(done('ignored', 'in_use'));
      expect(h.requests).toEqual([]);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_scheduled', recall_bot_id: b.botId });
      return observe(w, [b], [result]);
    });
  });
});

// ── 4. round_cancelled ──────────────────────────────────────────────────────

describe('round_cancelled of a public booking’s round, as of an Ashby one', () => {
  it.each([
    ['pending', [] as string[]],
    ['bot_scheduled', ['recall:get', 'recall:delete']],
    ['human_present', ['recall:get', 'recall:leave']],
  ] as const)('a %s booking: Recall first, then cancelled/round_cancelled, then the release record', async (state, recall) => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, state);
      h.db.cancelRound(b.roundId);
      const [job] = payloads(h, 'round_cancelled');
      expect(job).toEqual({ kind: 'round_cancelled', booking_id: b.id, round_id: b.roundId });
      const result = await runJob(h, r1MeetRoundCancelledDefinition, job);
      expect(result).toEqual(done('processed', 'cancelled'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'cancelled', reason: 'round_cancelled', recall_bot_id: null });
      expect(h.timeline).toEqual([
        'queue:round_cancelled',
        ...recall,
        'db:cancel_booking',
        ...(state === 'pending' ? [] : ['db:set_bot:release']),
      ]);
      return observe(w, [b], [result]);
    });
  });
});

// ── 5. attempt_ended ────────────────────────────────────────────────────────

describe('attempt_ended of a public booking’s call, as of an Ashby one', () => {
  it('a counted attempt: leave -> completed/attempt_settled -> release', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'in_call_session', { sessionStatus: 'completed' });
      h.db.addAttempt({ session_id: b.sessionId!, round_id: b.roundId, outcome: 'complete', counted: true });
      const result = await runJob(h, r1MeetAttemptEndedDefinition, r1MeetJobs.attemptEnded(b.id, b.sessionId!).payload);
      expect(result).toEqual(done('processed', 'completed'));
      expect(h.timeline).toEqual(['recall:get', 'recall:leave', 'db:transition:completed', 'db:set_bot:release']);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'completed', reason: 'attempt_settled', recall_bot_id: null, session_id: b.sessionId });
      return observe(w, [b], [result]);
    });
  });

  it('an attempt that did not count, nobody left in the call: failed/no_show, never completed', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'in_call_session', { sessionStatus: 'failed' });
      h.db.addAttempt({ session_id: b.sessionId!, round_id: b.roundId, outcome: 'provider_error', counted: false });
      const result = await runJob(h, r1MeetAttemptEndedDefinition, r1MeetJobs.attemptEnded(b.id, b.sessionId!).payload);
      expect(result).toEqual(done('processed', 'failed_no_show'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
      return observe(w, [b], [result]);
    });
  });
});

// ── 6. drain ────────────────────────────────────────────────────────────────

describe('the drain of a public booking, as of an Ashby one', () => {
  it.each([
    ['pending', [] as string[]],
    ['bot_scheduled', ['get', 'delete']],
    ['human_present', ['get', 'leave']],
  ] as const)('a live %s booking -> drained/flag_off, its bot removed at Recall first', async (state, recall) => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, state);
      const result = await runJob(h, r1MeetDrainDefinition, { kind: 'drain' });
      expect(result).toEqual(done('processed', 'drained'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'drained', reason: 'flag_off', recall_bot_id: null });
      expect(recallOps(h)).toEqual(recall);
      expect(h.alerts()).toEqual([]);
      return observe(w, [b], [result]);
    });
  });

  it('an in_call booking whose session ended and whose attempt counted -> completed/attempt_settled', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'in_call_session', { sessionStatus: 'completed' });
      h.db.addAttempt({ session_id: b.sessionId!, round_id: b.roundId, outcome: 'complete', counted: true });
      const result = await runJob(h, r1MeetDrainDefinition, { kind: 'drain' });
      expect(result).toEqual(done('processed', 'drained'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'completed', reason: 'attempt_settled', recall_bot_id: null });
      return observe(w, [b], [result]);
    });
  });
});

// ── 7. the two hooks ────────────────────────────────────────────────────────

describe('the two hooks find a public booking by its session, as an Ashby one', () => {
  it('notifyR1MeetAttemptEnded queues the same attempt_ended job, which completes the call', async () => {
    expect(MEET_ON.enabled).toBe(true);
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'in_call_session', { sessionStatus: 'completed' });
      h.db.addAttempt({ session_id: b.sessionId!, round_id: b.roundId, outcome: 'complete', counted: true });
      const enqueued: Array<{ name: string; payload: unknown; options: unknown }> = [];
      await notifyR1MeetAttemptEnded(b.sessionId!.toUpperCase(), {
        client: h.db.client,
        enqueue: async (name, payload, options) => {
          enqueued.push({ name, payload, options });
        },
        r1Config: () => R1_ON,
        meetConfig: () => MEET_ON,
        now: () => h.now(),
        log: h.deps.log,
      });
      const spec = r1MeetJobs.attemptEnded(b.id, b.sessionId!);
      expect(enqueued).toEqual([
        {
          name: R1_MEET_QUEUE,
          payload: { kind: 'attempt_ended', booking_id: b.id, session_id: b.sessionId },
          options: { dedupKey: spec.dedupKey, maxAttempts: spec.maxAttempts, scheduledAt: iso(h.now() + 5 * SEC) },
        },
      ]);
      expect(h.logs).toEqual([]);
      const result = await runJob(h, r1MeetAttemptEndedDefinition, enqueued[0]!.payload);
      expect(result).toEqual(done('processed', 'completed'));
      return observe(w, [b], [result], enqueued);
    });
  });

  it('notifyR1MeetScorecardReady records the same receipt and queues the same scorecard_feedback job', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'in_call_session', { sessionStatus: 'completed' });
      h.db.addAttempt({ session_id: b.sessionId!, round_id: b.roundId, outcome: 'complete', counted: true });
      expect(await runJob(h, r1MeetAttemptEndedDefinition, r1MeetJobs.attemptEnded(b.id, b.sessionId!).payload)).toEqual(
        done('processed', 'completed'),
      );
      reset(w);
      await notifyR1MeetScorecardReady(
        { sessionId: b.sessionId, assessmentId: ASSESSMENT_ID, attach: 'ok' },
        {
          client: h.db.client,
          r1Config: () => R1_ON,
          meetConfig: () => MEET_ON,
          feedbackConfig: () => FEEDBACK_ON,
          now: () => h.now(),
          log: h.deps.log,
        },
      );
      expect(h.db.calls.map((call) => `${call.kind}:${call.name}`)).toEqual(['from:r1_meet_bookings', 'rpc:r1_meet_record_receipt']);
      const receipt = h.db.tables.r1_meet_receipts.find(
        (row) => row.dedupe_key === `ashby-schedule:feedback:${b.id}:${ASSESSMENT_ID}`,
      );
      expect(receipt).toMatchObject({ source: 'ashby', event_type: 'scorecard_feedback', booking_id: b.id, outcome: 'enqueued' });
      expect(payloads(h, 'scorecard_feedback')).toStrictEqual([
        { kind: 'scorecard_feedback', booking_id: b.id, assessment_id: ASSESSMENT_ID, receipt_id: receipt!.id, source: 'ashby' },
      ]);
      expect(h.logs).toEqual([]);
      return observe(w, [b], [], { receipts: h.db.tables.r1_meet_receipts });
    });
  });
});

// ── The bridge page's half ──────────────────────────────────────────────────

describe('the bridge page reads a public booking as an Ashby one (peek, claim, bind)', () => {
  it('the real bridge-store readers over the 0142 RPCs answer the same binding', async () => {
    await twins(async (w) => {
      const { h } = w;
      const b = await booked(w, 'human_present');
      const booking = (await h.db.store.getBooking(b.id))!;
      expect(booking.source).toBe(w.source);
      const armed = await armBridge(h.deps, booking, h.meta());
      expect(armed).toEqual(done('processed', 'armed'));
      const digest = r1MeetTicketDigest(lastTicket(h), BRIDGE_SOURCE)!;
      const peeked = await peekR1MeetTicket(h.db.client, digest);
      expect(peeked).toMatchObject({ kind: 'found', booking: { id: b.id, status: 'human_present', ticketClaimedAtMs: null } });
      const claimed = await claimR1MeetTicket(h.db.client, digest, iso(h.now()));
      expect(claimed).toEqual({
        kind: 'ok',
        binding: {
          bookingId: b.id,
          roundId: b.roundId,
          candidateId: h.db.booking(b.id)!.candidate_id,
          objectiveProfile: 'r1_dex_sales',
          sessionId: null,
          startAt: b.startAt,
          endAt: iso(Date.parse(b.startAt) + 45 * MIN),
        },
      });
      const session = h.db.addSession({ interview_round_id: b.roundId, status: 'in_progress' });
      track(w, 'b', { session: session.id as string });
      const bound = await bindR1MeetSession(h.db.client, b.id, session.id as string, iso(h.now()));
      expect(bound).toEqual({ kind: 'ok', previousSessionId: null });
      expect(h.db.booking(b.id)).toMatchObject({ status: 'in_call', session_id: session.id });
      expect(await h.db.store.getBookingBySession(session.id as string)).toMatchObject({ id: b.id, source: w.source });
      return observe(w, [b], [armed, peeked, claimed, bound]);
    });
  });
});
