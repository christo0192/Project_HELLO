/**
 * M034 S06 T4: the call side of the `r1-meet` runtime (lib/r1/meet/event-handler.ts), through the REAL
 * Recall client over the S01 fake and the in-memory 0142 port.
 *
 * Pinned (D-S06-22..29, plan 2.5):
 *  - every Recall event from every booking status (the D-S06-24 mapping), out of order and twice;
 *  - the booking match (named booking first, then the holder) and the stray rule: pending waits then
 *    rotates and releases, any other status (or no booking) alerts and releases at once, a terminal
 *    event of a stray is ignored, a bot that is not ours is never touched;
 *  - human present: one compare-and-set winner, so both signals at once give exactly one arm and one
 *    output_media; a crashed winner is recovered by its re-run, a fresh duplicate never arms, a
 *    recent arm is never replaced; the at-create switch (armed: watched, not re-armed; unarmed: the
 *    normal arm; in a call: nothing);
 *  - the sub-code table (unknown codes are a no-show, never an error) and the one 60 s wait on our
 *    own leave; release after every terminal move;
 *  - multiple humans: distinct ids with more joins than leaves (a rejoin is one human, null ids and
 *    bots ignored, other bots' rows ignored), a check 120 s later, `end` leaves BEFORE it marks,
 *    `observe` only logs;
 *  - attempt_ended: a COUNTED attempt leaves -> completed -> release; one that did not count re-arms
 *    while the round has a start, the window is open, an arm is left and a human is in the call, and
 *    otherwise fails the call (no_show / bot_fatal), never `completed`; an unsettled one waits for the
 *    outcome; another session or a terminal booking is ignored; a Recall outage defers within the bound;
 *  - decideBridgeCheck, every row and boundary, and the handler's recheck / rearm / give-up;
 *  - the kill points of the arm and the outcome, and the hot-window hints;
 *  - no name, email, Meet URL, ticket or digest in any log line or job payload.
 *
 * M035 S09 T3 (D-S09-2..4), the guest-bot hardening:
 *  - the three frozen sub-code lists (admission, sign-in, fatal = M034's six first), each entry a
 *    logger safe identifier that survives the real logger as `error_type`;
 *  - `r1MeetBotAlertFor` and `r1MeetPreCallVerdict` (a `fatal` status, a fatal sub-code, or never in
 *    the call = the bot failed; the oldest listed sub-code is the alert's);
 *  - every listed sub-code on `bot.fatal` and `bot.call_ended` from `bot_scheduled` / `bot_joining`
 *    is `failed/bot_fatal` with exactly one alert, never `no_show`; an event that alone says no-show
 *    reads the bot ONCE before the move (Recall first), so an out-of-order `bot.done` of a refused
 *    bot is a bot failure too, a 503 defers before the move and a 404 keeps the event's reason;
 *  - a `bot.in_waiting_room` of a live booking's bot alerts once per run that ends (PR #449 review
 *    S09-R1: a re-run alerts too, a run that throws or defers before its end never does, so the
 *    alert is never lost), never for a terminal booking, and the status mapping is unchanged.
 *
 * M035 S09 T4 (D-S09-6, UNVERIFIED until the live spike S0c), the bot's own participant:
 *  - `r1MeetBotInCallAtMs` (the oldest `in_call_*` time) and `r1MeetBotParticipantId` (the EARLIEST
 *    marked join with an id, and only within 15 s of that time, inclusive) as tables;
 *  - `countHumans` excludes null ids and that one id only: every other id counts, marked or not;
 *  - through the real client: the bot's own join never arms or counts (H1); a candidate's join is the
 *    human signal with no recount; a later name-alike is a person (one recount; `end` ends the call,
 *    `observe` only warns); a marked join NEVER moves or arms the booking (PR #449 review S09-R4: a
 *    lone name-alike counts and `bot.in_call_recording` arms (H3); the bot's own join that misses
 *    the bound, or has no readable time, arms nothing); a participant Recall itself calls a bot
 *    reaches the handler with no id and is ignored outright (S09-R3); a marked join with no id is
 *    ignored; a Recall failure of the bound defers a marked join, `attempt_ended` and the check
 *    before any write, and only drops the bound at the human-present recount.
 */

import { describe, expect, it } from 'vitest';
import { createLogger } from '../lib/logger.js';
import { armBridge } from '../lib/r1/meet/arm.js';
import { ensureBot } from '../lib/r1/meet/bot-flow.js';
import {
  R1_MEET_ADMISSION_SUB_CODES,
  R1_MEET_BOT_JOIN_SLACK_MS,
  R1_MEET_EVENT_DEFINITIONS,
  R1_MEET_FATAL_SUB_CODES,
  R1_MEET_SIGN_IN_SUB_CODES,
  countHumans,
  decideBridgeCheck,
  r1MeetAttemptEndedDefinition,
  r1MeetBotAlertFor,
  r1MeetBotInCallAtMs,
  r1MeetBotParticipantId,
  r1MeetBridgeCheckDefinition,
  r1MeetMultiHumanCheckDefinition,
  r1MeetPreCallVerdict,
  r1MeetRecallEventDefinition,
  type R1MeetBridgeCheckFacts,
} from '../lib/r1/meet/event-handler.js';
import { r1MeetJobMeta, type R1MeetJobMeta, type R1MeetJobResult } from '../lib/r1/meet/jobs.js';
import type { R1MeetFlowDeps, R1MeetJobDefinition } from '../lib/r1/meet/recall-actions.js';
import { buildR1MeetRecallEventJob } from '../lib/r1/meet/recall-event.js';
import { r1MeetBotReleaseDefinition } from '../lib/r1/meet/schedule-handler.js';
import { R1_MEET_TICKET_PATTERN, r1MeetTicketDigest } from '../lib/r1/meet/ticket.js';
import {
  BRIDGE_PAGE_URL,
  BRIDGE_SOURCE,
  MEET_URL,
  createR1MeetHarness,
  fixtureId,
  type HarnessOptions,
  type R1MeetHarness,
} from './support/r1-meet-harness.js';
import type { Row } from './support/r1-meet-fake-db.js';

const SEC = 1000;
const MIN = 60 * SEC;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Distinct, predictable random bytes per mint: byte value n for the n-th mint. */
function countingRandom(): (bytes: number) => Buffer {
  let n = 0;
  return (bytes) => Buffer.alloc(bytes, ++n);
}

function world(options: HarnessOptions = {}): R1MeetHarness {
  return createR1MeetHarness({ random: countingRandom(), ...options });
}

function reset(h: R1MeetHarness): void {
  h.timeline.length = 0;
  h.requests.length = 0;
  h.logs.length = 0;
  h.hot.length = 0;
}

const done = (receipt: 'processed' | 'ignored', code: string) => ({ outcome: 'done', receipt, code });
const deferred = (code: string, delaySeconds: number) => ({ outcome: 'defer', code, delaySeconds });
const outputMedia = (h: R1MeetHarness) => h.requests.filter((request) => request.op === 'output_media');
const recallOps = (h: R1MeetHarness) => h.requests.map((request) => request.op);
/** The error lines (alerts) with their whole meta, so a test pins `error_type` too. */
const errorLines = (h: R1MeetHarness) => h.logs.filter((line) => line.level === 'error');
/** The timeline without the test's own enqueue of the event row (what S03 does). */
const steps = (h: R1MeetHarness) => h.timeline.filter((step) => step !== 'queue:recall_event');
const pageUrlOf = (request: { body: unknown }) => (request.body as { camera: { config: { url: string } } }).camera.config.url;
const ticketOf = (url: string): string => url.slice(`${BRIDGE_PAGE_URL}#t=`.length);
const lastTicket = (h: R1MeetHarness): string => ticketOf(pageUrlOf(outputMedia(h).at(-1)!));
const digestOf = (ticket: string): string => r1MeetTicketDigest(ticket, BRIDGE_SOURCE)!;

async function runJob<T>(
  h: R1MeetHarness,
  definition: R1MeetJobDefinition<T>,
  payload: Record<string, unknown>,
  meta: R1MeetJobMeta = h.meta(),
  deps: R1MeetFlowDeps = h.deps,
): Promise<R1MeetJobResult> {
  const job = definition.parse(payload);
  expect(job, JSON.stringify(payload)).not.toBeNull();
  return definition.run(deps, job!, meta);
}

/** A job meta with its own creation time (the bridge check reads it as the arm time). */
function metaAt(
  createdAtMs: number,
  over: { attempts?: number; deferCount?: number; deferredAt?: string } = {},
): R1MeetJobMeta {
  return r1MeetJobMeta({
    attempts: over.attempts ?? 1,
    maxAttempts: 10,
    deferCount: over.deferCount ?? 0,
    deferredAt: over.deferredAt,
    createdAt: iso(createdAtMs),
  });
}

// ── Bookings in a given state ───────────────────────────────────────────────

type Start =
  | 'bot_scheduled'
  | 'bot_joining'
  | 'human_present'
  | 'in_call'
  | 'in_call_session'
  | 'failed_owed'
  | 'failed_released';

interface Booked {
  readonly id: string;
  readonly botId: string;
  readonly roundId: string;
  readonly startAt: string;
  readonly sessionId: string | null;
}

/**
 * A booking with a bot in the asked state, reached through the real RPCs (create, ensureBot, the
 * transitions, a real arm and a real claim, a bound session), the Recall fake's bot mirrored. The slot
 * starts a minute from now, so the ticket window is open. Traces are cleared at the end.
 */
async function booked(
  h: R1MeetHarness,
  start: Start = 'bot_scheduled',
  options: { readonly sessionStatus?: string } = {},
): Promise<Booked> {
  const created = await h.createBooking({ startAt: iso(h.now() + MIN) });
  expect(await ensureBot(h.deps, created.bookingId, h.meta())).toMatchObject({ code: 'bot_scheduled' });
  const row = h.db.booking(created.bookingId)!;
  const id = row.id as string;
  const botId = row.recall_bot_id as string;
  let sessionId: string | null = null;
  const move = async (from: string, to: string, reason = 'eligible'): Promise<void> => {
    const answer = await h.db.store.transition({
      bookingId: id,
      from: from as never,
      to: to as never,
      reason: reason as never,
      nowIso: iso(h.now()),
    });
    expect(answer.status).toBe('ok');
  };
  if (start === 'bot_joining') {
    h.recall.markDispatched(botId);
    await move('bot_scheduled', 'bot_joining');
  }
  if (start === 'human_present' || start === 'in_call' || start === 'in_call_session') {
    h.recall.markDispatched(botId);
    h.recall.setStatus(botId, 'in_call_recording');
    await move('bot_scheduled', 'human_present');
  }
  if (start === 'in_call' || start === 'in_call_session') {
    const booking = (await h.db.store.getBooking(id))!;
    expect(await armBridge(h.deps, booking, h.meta())).toMatchObject({ code: 'armed' });
    const claimed = await h.db.claimTicket(lastTicket(h), iso(h.now()), BRIDGE_SOURCE);
    expect(claimed.data).toMatchObject({ status: 'ok' });
    if (start === 'in_call_session') {
      const session = h.db.addSession({ interview_round_id: row.round_id, status: options.sessionStatus ?? 'in_progress' });
      expect((await h.db.bind(id, session.id as string, iso(h.now()))).data).toMatchObject({ status: 'ok' });
      sessionId = session.id as string;
    }
  }
  if (start === 'failed_owed' || start === 'failed_released') await move('bot_scheduled', 'failed', 'no_show');
  if (start === 'failed_released') {
    const answer = await h.db.store.setBot({
      bookingId: id,
      action: 'release',
      expectedVersion: row.version,
      expectedKeyAttempt: row.key_attempt,
      nowIso: iso(h.now()),
    });
    expect(answer.status).toBe('ok');
  }
  reset(h);
  return { id, botId, roundId: row.round_id as string, startAt: row.start_at as string, sessionId };
}

interface Delivery {
  readonly subCode?: string | null;
  readonly participantId?: number | null;
  readonly isBot?: boolean | null;
  /** The event's `occurred_at`: omitted = now; `null` = Recall's time could not be read. */
  readonly occurredAt?: string | null;
  /** `null` = the bot's metadata named no booking; omitted = the booking's id. */
  readonly bookingId?: string | null;
  readonly botId?: string;
  /** Mirror a `bot.*` status at the Recall fake (default true): Recall's state matches its events. */
  readonly mirror?: boolean;
}

/**
 * What S03 does with one Recall webhook: the durable `recall_event` job row (payload exactly as the
 * receiver writes it). Answers the payload, for `run`.
 */
function event(h: R1MeetHarness, b: Pick<Booked, 'id' | 'botId'> | null, type: string, d: Delivery = {}): Record<string, unknown> {
  const receiptId = fixtureId();
  const payload = {
    kind: 'recall_event',
    event_type: type,
    recall_bot_id: d.botId ?? b!.botId,
    booking_id: d.bookingId === undefined ? b!.id : d.bookingId,
    occurred_at: d.occurredAt === undefined ? iso(h.now()) : d.occurredAt,
    sub_code: d.subCode ?? null,
    participant: type.startsWith('participant_events.')
      ? { id: d.participantId === undefined ? 101 : d.participantId, is_host: null, is_bot: d.isBot ?? null }
      : null,
    receipt_id: receiptId,
    source: 'recall',
  };
  h.db.enqueue({ payload, dedupKey: `r1-meet:receipt:${receiptId}`, maxAttempts: 5 });
  const bot = h.recall.bots.get(payload.recall_bot_id);
  if (d.mirror !== false && bot !== undefined && type.startsWith('bot.')) {
    bot.dispatched = true;
    h.recall.setStatus(bot.id, type.slice('bot.'.length), d.subCode ?? null);
  }
  return payload;
}

const run = (h: R1MeetHarness, payload: Record<string, unknown>, meta?: R1MeetJobMeta): Promise<R1MeetJobResult> =>
  runJob(h, r1MeetRecallEventDefinition, payload, meta ?? h.meta());

const deliver = (h: R1MeetHarness, b: Pick<Booked, 'id' | 'botId'> | null, type: string, d: Delivery = {}, meta?: R1MeetJobMeta) =>
  run(h, event(h, b, type, d), meta);

function expectNoPii(h: R1MeetHarness, ...secrets: string[]): void {
  const text = JSON.stringify({ logs: h.logs, jobs: h.db.tables.job_queue.map((job) => job.payload) });
  for (const value of [...secrets, MEET_URL, 'meet.google.com', '@', 'hello.example.test', BRIDGE_PAGE_URL]) {
    expect(text).not.toContain(value);
  }
}

// ── Definitions ─────────────────────────────────────────────────────────────

describe('the definitions', () => {
  it('exports the four kinds of this file with strict parsers', () => {
    expect(R1_MEET_EVENT_DEFINITIONS.map((definition) => definition.kind)).toEqual([
      'recall_event',
      'attempt_ended',
      'bridge_check',
      'multi_human_check',
    ]);
    expect(Object.isFrozen(R1_MEET_EVENT_DEFINITIONS)).toBe(true);
    for (const definition of R1_MEET_EVENT_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(definition.parse(null)).toBeNull();
      expect(definition.parse({ kind: definition.kind })).toBeNull();
    }
    const booking = fixtureId();
    expect(r1MeetBridgeCheckDefinition.parse({ kind: 'bridge_check', booking_id: booking, version: 0, arm: 0 })).toBeNull();
    expect(r1MeetMultiHumanCheckDefinition.parse({ kind: 'multi_human_check', booking_id: booking, version: 0 })).not.toBeNull();
  });
});

// ── countHumans ─────────────────────────────────────────────────────────────

describe('countHumans (D-S06-28, M035 S09 D-S09-6)', () => {
  const join = (id: number | null, isBot: boolean | null = null) => ({ type: 'join' as const, participantId: id, isBot });
  const leave = (id: number | null, isBot: boolean | null = null) => ({ type: 'leave' as const, participantId: id, isBot });

  it('counts distinct ids with more joins than leaves', () => {
    expect(countHumans([])).toBe(0);
    expect(countHumans([join(1)])).toBe(1);
    expect(countHumans([join(1), join(2)])).toBe(2);
    expect(countHumans([join(1), join(1)])).toBe(1);
    expect(countHumans([leave(1), join(1)])).toBe(0);
    expect(countHumans([leave(2), join(1)])).toBe(1);
  });

  it('a rejoin (leave, then a NEW id) is one human', () => {
    expect(countHumans([join(2), leave(1), join(1)])).toBe(1);
    expect(countHumans([join(2), leave(1), join(1)], 7)).toBe(1);
  });

  it('ignores null ids, with or without a bot id', () => {
    expect(countHumans([join(null), join(null), join(1)])).toBe(1);
    expect(countHumans([join(null, true), leave(null), join(1)], 7)).toBe(1);
    expect(countHumans([join(null)], null)).toBe(0);
  });

  it('excludes the bot\'s own participant id and ONLY that one: every other id counts, marked or not', () => {
    // A mark is evidence for r1MeetBotParticipantId, not a verdict here: only the named id is the bot.
    expect(countHumans([join(7, true), join(1)], 7)).toBe(1);
    expect(countHumans([join(7, true), join(1)])).toBe(2);
    expect(countHumans([join(7, true), join(1)], null)).toBe(2);
    // A second marked id (a candidate named like the bot) is a person.
    expect(countHumans([join(7, true), join(8, true), join(1)], 7)).toBe(2);
    // The bot's own leave and rejoin rows never count either, marked or not.
    expect(countHumans([join(7, true), leave(7), join(7), join(1)], 7)).toBe(1);
    // The bot alone; an id that is not in the rows changes nothing.
    expect(countHumans([join(7, true)], 7)).toBe(0);
    expect(countHumans([join(1), join(2)], 99)).toBe(2);
    expect(countHumans([join(1, false), join(2, false)], 1)).toBe(1);
  });
});

// ── The bot's own participant: the pure rule (M035 S09 D-S09-6) ────────────

describe('r1MeetBotInCallAtMs (M035 S09 D-S09-6)', () => {
  const T0 = Date.parse('2030-01-01T10:00:00.000Z');
  const at = (code: string, when: number | string) => ({ code, createdAt: typeof when === 'string' ? when : iso(when) });

  const cases: ReadonlyArray<readonly [label: string, changes: ReadonlyArray<{ code: string; createdAt: string }>, expected: number | null]> = [
    ['no history', [], null],
    ['ready, joining_call, in_waiting_room only: not in the call', [at('ready', T0), at('joining_call', T0 + SEC), at('in_waiting_room', T0 + 2 * SEC)], null],
    ['refused at the door: not in the call', [at('joining_call', T0), at('fatal', T0 + SEC), at('done', T0 + 2 * SEC)], null],
    ['in_call_not_recording', [at('ready', T0), at('joining_call', T0 + SEC), at('in_call_not_recording', T0 + 5 * SEC)], T0 + 5 * SEC],
    ['in_call_recording alone', [at('ready', T0), at('in_call_recording', T0 + 9 * SEC)], T0 + 9 * SEC],
    ['the oldest of either in-call code', [at('in_call_not_recording', T0 + 5 * SEC), at('in_call_recording', T0 + MIN)], T0 + 5 * SEC],
    ['the oldest by time, whatever the array order', [at('in_call_recording', T0 + MIN), at('in_call_not_recording', T0 + 5 * SEC)], T0 + 5 * SEC],
    ['a later end changes nothing', [at('in_call_not_recording', T0), at('call_ended', T0 + 10 * MIN), at('done', T0 + 11 * MIN)], T0],
    ['an unreadable time is skipped', [at('in_call_not_recording', 'not a time'), at('in_call_recording', T0 + 30 * SEC)], T0 + 30 * SEC],
    ['only unreadable in-call times: null', [at('in_call_not_recording', ''), at('in_call_recording', 'nope')], null],
  ];

  it.each(cases)('%s', (_label, changes, expected) => {
    expect(r1MeetBotInCallAtMs(changes)).toBe(expected);
  });
});

describe('r1MeetBotParticipantId (M035 S09 D-S09-6)', () => {
  const T0 = Date.parse('2030-01-01T10:00:00.000Z');
  type Row = { type: 'join' | 'leave'; participantId: number | null; isBot: boolean | null; occurredAt: string | null };
  const time = (when: number | string | null): string | null => (when === null || typeof when === 'string' ? when : iso(when));
  /** A join the receiver marked `is_bot`. */
  const marked = (id: number | null, when: number | string | null): Row => ({ type: 'join', participantId: id, isBot: true, occurredAt: time(when) });
  const person = (id: number | null, when: number | string | null, isBot: boolean | null = null): Row => ({
    type: 'join',
    participantId: id,
    isBot,
    occurredAt: time(when),
  });
  const markedLeave = (id: number, when: number): Row => ({ type: 'leave', participantId: id, isBot: true, occurredAt: time(when) });

  it('the slack is 15 s', () => {
    expect(R1_MEET_BOT_JOIN_SLACK_MS).toBe(15_000);
  });

  const cases: ReadonlyArray<readonly [label: string, rows: readonly Row[], botInCallAtMs: number | null, expected: number | null]> = [
    ['no rows', [], T0, null],
    ['no rows, no bound', [], null, null],
    ['no marked join (unmarked, or Recall said false)', [person(1, T0), person(2, T0, false)], T0, null],
    ['no marked join, no bound', [person(1, T0)], null, null],
    ['the one marked join, at the in-call time', [marked(7, T0)], T0, 7],
    ['the earliest marked join wins (rows newest first, as the store answers)', [marked(9, T0 + 5 * SEC), marked(8, T0 + 3 * SEC), person(1, T0 + SEC)], T0, 8],
    ['equal times: the smallest id', [marked(9, T0), marked(4, T0), marked(6, T0)], T0, 4],
    ['the bound is inclusive at +15 000 ms', [marked(7, T0 + 15_000)], T0, 7],
    ['one ms past the bound: a person, not the bot', [marked(7, T0 + 15_001)], T0, null],
    ['stamped before the in-call time: the bot', [marked(7, T0 - 30 * SEC)], T0, 7],
    ['no bound (not in the call yet, or unknown): the earliest marked join, however late', [marked(9, T0 + 10 * MIN), marked(8, T0 + 5 * MIN)], null, 8],
    ['a null time sorts last', [marked(3, null), marked(9, T0 + 2 * SEC)], T0, 9],
    ['a null time sorts last with no bound too', [marked(3, null), marked(9, T0 + 2 * SEC)], null, 9],
    ['only null times, with a bound: never the bot', [marked(3, null), marked(2, null)], T0, null],
    ['only null times, no bound: the smallest id', [marked(5, null), marked(3, null)], null, 3],
    ['an unreadable time sorts last, like null', [marked(3, 'not a time'), marked(9, T0 + 2 * SEC)], T0, 9],
    ['an unreadable time alone, with a bound: never the bot', [marked(3, 'not a time')], T0, null],
    ['a marked join with a null id is never chosen', [marked(null, T0 - SEC), marked(7, T0 + SEC)], T0, 7],
    ['only marked joins with null ids: null', [marked(null, T0)], null, null],
    ['a marked leave is never chosen', [markedLeave(5, T0 - SEC), marked(7, T0 + SEC)], T0, 7],
    ['only a marked leave: null', [markedLeave(5, T0)], null, null],
    ['the earliest marked join missed the bound: null, never the next one', [marked(8, T0 + MIN), marked(7, T0 + 20 * SEC)], T0, null],
    ['the earliest missed the bound, a later one has no time: still null', [marked(7, T0 + 20 * SEC), marked(8, null)], T0, null],
    ['a later name-alike never displaces the bot', [marked(8, T0 + 2 * MIN), person(1, T0 + MIN), marked(7, T0)], T0, 7],
  ];

  it.each(cases)('%s', (_label, rows, botInCallAtMs, expected) => {
    expect(r1MeetBotParticipantId(rows, botInCallAtMs)).toBe(expected);
  });
});

// ── The sub-code lists and the refused-bot verdict (M035 S09 D-S09-2..4) ───

/**
 * Copied from `lib/logger.ts:111` (`SAFE_IDENT_RE`): an `error_type` that fails it is silently DROPPED
 * by the logger, so a sub-code that failed it would alert without saying which refusal it was.
 */
const SAFE_IDENT_RE = /^[a-zA-Z0-9_:.\-]{1,64}$/;

const M034_FATAL = [
  'call_ended_by_platform_waiting_room_timeout',
  'timeout_exceeded_waiting_room',
  'bot_kicked_from_call',
  'bot_kicked_from_waiting_room',
  'meeting_not_started',
  'timeout_exceeded_recording_permission_denied',
];
const ADMISSION = [
  'call_ended_by_platform_waiting_room_timeout',
  'timeout_exceeded_waiting_room',
  'bot_kicked_from_waiting_room',
  'meeting_not_started',
  'google_meet_bot_blocked',
  'google_meet_knocking_disabled',
  'google_meet_sign_in_missing_login_credentials',
  'google_meet_organisation_restricted',
];
const SIGN_IN = [
  'google_meet_sso_sign_in_failed',
  'google_meet_sign_in_failed',
  'sso_not_configured',
  'google_meet_login_not_available',
  'google_meet_sign_in_captcha_failed',
  'google_meet_sign_in_missing_recovery_credentials',
  'google_meet_sso_sign_in_missing_login_credentials',
  'google_meet_sso_sign_in_missing_totp_secret',
  'sso_login_account_disabled',
  'sso_login_invalid_recipient',
];
const ADMISSION_WORD = 'r1_meet_bot_admission_blocked';
const SIGN_IN_WORD = 'r1_meet_bot_sign_in_failed';

describe('the sub-code lists (M035 S09 D-S09-2)', () => {
  it('exact contents and order, frozen: fatal = the M034 six, the new admission codes, the sign-in codes', () => {
    expect(R1_MEET_ADMISSION_SUB_CODES).toEqual(ADMISSION);
    expect(R1_MEET_SIGN_IN_SUB_CODES).toEqual(SIGN_IN);
    expect(R1_MEET_FATAL_SUB_CODES).toEqual([
      ...M034_FATAL,
      'google_meet_bot_blocked',
      'google_meet_knocking_disabled',
      'google_meet_sign_in_missing_login_credentials',
      'google_meet_organisation_restricted',
      ...SIGN_IN,
    ]);
    expect(R1_MEET_FATAL_SUB_CODES).toHaveLength(20);
    // M034's six keep their place at the front.
    expect(R1_MEET_FATAL_SUB_CODES.slice(0, 6)).toEqual(M034_FATAL);
    for (const list of [R1_MEET_ADMISSION_SUB_CODES, R1_MEET_SIGN_IN_SUB_CODES, R1_MEET_FATAL_SUB_CODES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('no duplicates; the alert lists are disjoint and both inside the fatal list', () => {
    const fatal = new Set<string>(R1_MEET_FATAL_SUB_CODES);
    for (const list of [R1_MEET_ADMISSION_SUB_CODES, R1_MEET_SIGN_IN_SUB_CODES, R1_MEET_FATAL_SUB_CODES]) {
      expect(new Set<string>(list).size).toBe(list.length);
    }
    const admission = new Set<string>(R1_MEET_ADMISSION_SUB_CODES);
    for (const code of R1_MEET_SIGN_IN_SUB_CODES) expect(admission.has(code), code).toBe(false);
    for (const code of [...R1_MEET_ADMISSION_SUB_CODES, ...R1_MEET_SIGN_IN_SUB_CODES]) expect(fatal.has(code), code).toBe(true);
  });

  it('every entry is a logger safe identifier (at most 64 chars) and survives the real logger as error_type', () => {
    const lines: string[] = [];
    const logger = createLogger('r1-meet', { writer: (line) => lines.push(line) });
    for (const code of R1_MEET_FATAL_SUB_CODES) {
      expect(code, code).toMatch(SAFE_IDENT_RE);
      expect(code.length, code).toBeLessThanOrEqual(64);
      logger.error('unknown_event', { error_category: r1MeetBotAlertFor(code) ?? 'r1_meet_bot_fatal', error_type: code });
    }
    const logged = lines.map((line) => JSON.parse(line) as { error_category?: string; error_type?: string });
    // Nothing was dropped by the value defences (an email, a token, a long digit run, a path).
    expect(logged.map((line) => line.error_type)).toEqual([...R1_MEET_FATAL_SUB_CODES]);
    expect(new Set(logged.map((line) => line.error_category))).toEqual(new Set([ADMISSION_WORD, SIGN_IN_WORD, 'r1_meet_bot_fatal']));
  });
});

describe('r1MeetBotAlertFor (M035 S09 D-S09-4)', () => {
  it.each([
    ...ADMISSION.map((code) => [code, ADMISSION_WORD] as const),
    ...SIGN_IN.map((code) => [code, SIGN_IN_WORD] as const),
    // Fatal, but neither a refusal at the door nor a sign-in failure: no new alert.
    ['bot_kicked_from_call', null],
    ['timeout_exceeded_recording_permission_denied', null],
    // Not fatal, unknown, empty, none.
    ['timeout_exceeded_noone_joined', null],
    ['bot_received_leave_call', null],
    ['a_sub_code_recall_added_later.v2', null],
    ['GOOGLE_MEET_BOT_BLOCKED', null],
    ['', null],
    [null, null],
  ] as const)('%s -> %s', (subCode, word) => {
    expect(r1MeetBotAlertFor(subCode)).toBe(word);
  });
});

describe('r1MeetPreCallVerdict (M035 S09 D-S09-3)', () => {
  const at = (code: string, subCode: string | null = null) => ({ code, subCode });
  const ready = at('ready');
  const joining = at('joining_call');

  it.each([
    ['a fatal status', [ready, joining, at('fatal')], true, null],
    ['a fatal status with a listed sub-code', [ready, joining, at('fatal', 'google_meet_bot_blocked'), at('done')], true, 'google_meet_bot_blocked'],
    ['a sign-in failure', [ready, joining, at('fatal', 'google_meet_sign_in_failed')], true, 'google_meet_sign_in_failed'],
    ['never in the call (no sub-code)', [ready, joining, at('call_ended'), at('done')], true, null],
    ['never in the call (a no-show sub-code)', [ready, joining, at('call_ended', 'timeout_exceeded_noone_joined')], true, null],
    ['never in the call (an unknown sub-code)', [ready, joining, at('call_ended', 'a_sub_code_recall_added_later.v2')], true, null],
    ['the waiting room, then its timeout', [ready, joining, at('in_waiting_room'), at('call_ended', 'timeout_exceeded_waiting_room')], true, 'timeout_exceeded_waiting_room'],
    ['in the call, then a kick (fatal, not listed)', [ready, joining, at('in_call_not_recording'), at('call_ended', 'bot_kicked_from_call')], true, null],
    ['in the call, then a fatal status', [ready, joining, at('in_call_recording'), at('fatal')], true, null],
    ['in the call, then nobody joined', [ready, joining, at('in_call_not_recording'), at('call_ended', 'timeout_exceeded_noone_joined')], false, null],
    ['in the call (recording), then an unknown sub-code', [ready, joining, at('in_call_recording'), at('call_ended', 'a_sub_code_recall_added_later.v2')], false, null],
    ['in the call, still live', [ready, joining, at('in_call_not_recording')], false, null],
    ['two listed sub-codes: the oldest', [joining, at('fatal', 'google_meet_sso_sign_in_failed'), at('done', 'google_meet_bot_blocked')], true, 'google_meet_sso_sign_in_failed'],
    ['no history at all', [], true, null],
  ] as const)('%s', (_label, changes, botFailed, alertSubCode) => {
    const verdict = r1MeetPreCallVerdict(changes);
    expect(verdict).toEqual({ botFailed, alertSubCode });
    expect(Object.isFrozen(verdict)).toBe(true);
  });
});

// ── Every event from every status (D-S06-24) ────────────────────────────────

type Cell = readonly [code: string, status: string, reason: string];

const OWED_LIVE: Cell = ['release_queued', 'failed', 'no_show'];
const STRAY_LIVE: Cell = ['stray_bot', 'failed', 'no_show'];
const OWED_ENDED: Cell = ['released_ended', 'failed', 'no_show'];
const STRAY_ENDED: Cell = ['stray_ended', 'failed', 'no_show'];

const unchanged = (code: string): Record<'bot_joining' | 'human_present' | 'in_call' | 'in_call_session', Cell> => ({
  bot_joining: [code, 'bot_joining', 'eligible'],
  human_present: [code, 'human_present', 'eligible'],
  in_call: [code, 'in_call', 'eligible'],
  in_call_session: [code, 'in_call', 'eligible'],
});

const JOINING_ROW: Record<Start, Cell> = {
  bot_scheduled: ['bot_joining', 'bot_joining', 'eligible'],
  ...unchanged('no_change'),
  failed_owed: OWED_LIVE,
  failed_released: STRAY_LIVE,
};
const HUMAN_ROW: Record<Start, Cell> = {
  bot_scheduled: ['armed', 'human_present', 'eligible'],
  bot_joining: ['armed', 'human_present', 'eligible'],
  human_present: ['already_present', 'human_present', 'eligible'],
  in_call: ['in_call', 'in_call', 'eligible'],
  in_call_session: ['in_call', 'in_call', 'eligible'],
  failed_owed: OWED_LIVE,
  failed_released: STRAY_LIVE,
};
const quiet = (code: string): Record<Start, Cell> => ({
  bot_scheduled: [code, 'bot_scheduled', 'eligible'],
  ...unchanged(code),
  failed_owed: OWED_LIVE,
  failed_released: STRAY_LIVE,
});
const ENDED_ROW: Record<Start, Cell> = {
  // M035 S09 D-S09-3: these fixture bots never reported an `in_call_*` status (their Recall history is
  // `ready`, maybe `joining_call`, then the terminal event), so the one read before the move says the
  // BOT never got in: a bot failure, not a candidate no-show. The in-call no-show is pinned in
  // "terminal events" below.
  bot_scheduled: ['failed_bot_fatal', 'failed', 'bot_fatal'],
  bot_joining: ['failed_bot_fatal', 'failed', 'bot_fatal'],
  human_present: ['failed_bot_fatal', 'failed', 'bot_fatal'],
  in_call: ['failed_admission_refused', 'failed', 'admission_refused'],
  in_call_session: ['attempt_decides', 'in_call', 'eligible'],
  failed_owed: OWED_ENDED,
  failed_released: STRAY_ENDED,
};
const FATAL_ROW: Record<Start, Cell> = {
  ...ENDED_ROW,
  bot_scheduled: ['failed_bot_fatal', 'failed', 'bot_fatal'],
  bot_joining: ['failed_bot_fatal', 'failed', 'bot_fatal'],
};

const MATRIX: ReadonlyArray<readonly [label: string, type: string, row: Record<Start, Cell>, delivery: Delivery]> = [
  ['bot.joining_call', 'bot.joining_call', JOINING_ROW, {}],
  ['bot.in_waiting_room', 'bot.in_waiting_room', JOINING_ROW, {}],
  ['bot.in_call_not_recording', 'bot.in_call_not_recording', JOINING_ROW, {}],
  ['bot.recording_permission_allowed', 'bot.recording_permission_allowed', JOINING_ROW, {}],
  ['bot.recording_permission_denied', 'bot.recording_permission_denied', JOINING_ROW, {}],
  ['bot.in_call_recording', 'bot.in_call_recording', HUMAN_ROW, {}],
  ['participant_events.join (human)', 'participant_events.join', HUMAN_ROW, {}],
  ['participant_events.join (is_bot)', 'participant_events.join', quiet('bot_participant'), { isBot: true }],
  ['participant_events.leave', 'participant_events.leave', quiet('participant_left'), {}],
  ['bot.call_ended', 'bot.call_ended', ENDED_ROW, {}],
  ['bot.done', 'bot.done', ENDED_ROW, {}],
  ['bot.fatal', 'bot.fatal', FATAL_ROW, {}],
];

const STARTS: readonly Start[] = [
  'bot_scheduled',
  'bot_joining',
  'human_present',
  'in_call',
  'in_call_session',
  'failed_owed',
  'failed_released',
];
/** The starts whose booking holds its bot live (the waiting-room alert's scope, D-S09-4). */
const LIVE_STARTS: ReadonlySet<Start> = new Set<Start>(['bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'in_call_session']);

describe('recall_event: every event from every booking status (D-S06-24)', () => {
  const cases = MATRIX.flatMap(([label, type, row, delivery]) =>
    STARTS.map((start) => [label, start, type, row[start], delivery] as const),
  );

  it.each(cases)('%s on %s', async (label, start, type, [code, status, reason], delivery) => {
    const h = world();
    const b = await booked(h, start);
    const result = await deliver(h, b, type, delivery);
    expect(result).toMatchObject({ outcome: 'done', code });

    const row = h.db.booking(b.id)!;
    expect({ status: row.status, reason: row.reason }).toEqual({ status, reason });
    // Exactly one arm and one page, and only for the human signal that moved the booking.
    expect(outputMedia(h)).toHaveLength(code === 'armed' ? 1 : 0);
    // A terminal move, or an owed release finished: the bot is recorded released.
    if (code.startsWith('failed_') || code.startsWith('released_')) expect(row.recall_bot_id).toBeNull();
    // A live event of a terminal booking's own bot, or of a stray: one release job, never a call.
    const releases = h.db.jobs('bot_release');
    expect(releases).toHaveLength(code === 'release_queued' || code === 'stray_bot' ? 1 : 0);
    if (releases.length === 1) {
      expect(releases[0]!.payload).toEqual({ kind: 'bot_release', recall_bot_id: b.botId, booking_id: b.id });
      expect(recallOps(h)).toEqual([]);
    }
    // A stray alerts as such; a live booking's own bot in the waiting room alerts at once (M035 S09).
    const alerts = code === 'stray_bot'
      ? ['r1_meet_stray_bot']
      : label === 'bot.in_waiting_room' && LIVE_STARTS.has(start)
        ? ['r1_meet_bot_waiting_room']
        : [];
    expect(h.alerts()).toEqual(alerts);
    // Never a create, never a PATCH; a release is at most one GET then one command.
    expect(recallOps(h)).not.toContain('create');
    expect(h.requests.map((request) => request.method)).not.toContain('PATCH');
    expectNoPii(h);
  });
});

// ── Out of order, duplicates and the booking match ──────────────────────────

describe('recall_event: order, duplicates and the booking match (D-S06-22)', () => {
  it('a human before joining: bot_scheduled -> human_present, then joining_call changes nothing', async () => {
    const h = world();
    const b = await booked(h);
    expect(await deliver(h, b, 'participant_events.join', { participantId: 5 })).toEqual(done('processed', 'armed'));
    expect(await deliver(h, b, 'bot.joining_call')).toEqual(done('ignored', 'no_change'));
    expect(await deliver(h, b, 'bot.in_waiting_room')).toEqual(done('ignored', 'no_change'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present' });
    expect(outputMedia(h)).toHaveLength(1);
  });

  it('the same event twice: the second run is a no-op', async () => {
    const h = world();
    const b = await booked(h);
    const joiningCall = event(h, b, 'bot.joining_call');
    expect(await run(h, joiningCall)).toEqual(done('processed', 'bot_joining'));
    expect(await run(h, joiningCall)).toEqual(done('ignored', 'no_change'));

    const recording = event(h, b, 'bot.in_call_recording');
    expect(await run(h, recording)).toEqual(done('processed', 'armed'));
    expect(await run(h, recording)).toEqual(done('ignored', 'already_present'));
    expect(outputMedia(h)).toHaveLength(1);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 1 });

    const ended = event(h, b, 'bot.call_ended');
    expect(await run(h, ended)).toEqual(done('processed', 'failed_bot_fatal'));
    // Now released: the same terminal event is a stray's, and needs nothing.
    expect(await run(h, ended)).toEqual(done('ignored', 'stray_ended'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: null });
  });

  it('a bot whose metadata names no booking is matched by the booking that holds it', async () => {
    const h = world();
    const b = await booked(h);
    expect(await deliver(h, b, 'bot.joining_call', { bookingId: null })).toEqual(done('processed', 'bot_joining'));
  });

  it('a named booking that is gone falls back to the holder of the bot', async () => {
    const h = world();
    const b = await booked(h);
    expect(await deliver(h, b, 'bot.joining_call', { bookingId: fixtureId() })).toEqual(done('processed', 'bot_joining'));
    expect(h.alerts()).toEqual([]);
  });

  it('events after a terminal move: a live one of the owed bot queues its release, then the bot is not current', async () => {
    const h = world();
    const b = await booked(h, 'failed_owed');
    expect(await deliver(h, b, 'participant_events.leave')).toEqual(done('processed', 'release_queued'));
    expect(await deliver(h, b, 'bot.done')).toEqual(done('processed', 'released_ended'));
    expect(h.db.booking(b.id)).toMatchObject({ recall_bot_id: null });
    expect(await deliver(h, b, 'bot.done')).toEqual(done('ignored', 'stray_ended'));
  });
});

// ── Strays (D-S06-23) ───────────────────────────────────────────────────────

/** A bot created at Recall whose attach never happened: the booking stays `pending`. */
async function unattached(h: R1MeetHarness): Promise<{ id: string; botId: string }> {
  const created = await h.createBooking({ startAt: iso(h.now() + 30 * MIN) });
  h.db.failNext('r1_meet_set_bot');
  await expect(ensureBot(h.deps, created.bookingId, h.meta())).rejects.toThrow('r1_meet_db_error');
  const botId = [...h.recall.bots.keys()].at(-1)!;
  expect(h.db.booking(created.bookingId)).toMatchObject({ status: 'pending', recall_bot_id: null });
  reset(h);
  return { id: created.bookingId, botId };
}

describe('recall_event: stray bots (D-S06-23)', () => {
  it('pending, then attached: the event waits, and once attached it is the current bot', async () => {
    const h = world();
    const s = await unattached(h);
    const payload = event(h, s, 'bot.joining_call');
    expect(await run(h, payload)).toEqual(deferred('stray_pending', 30));
    expect(recallOps(h)).toEqual([]);
    expect(h.alerts()).toEqual([]);

    // The create is retried under the same key: Recall answers the same bot, which is attached.
    expect(await ensureBot(h.deps, s.id, h.meta())).toMatchObject({ code: 'bot_scheduled' });
    expect(h.recall.bots.size).toBe(1);
    h.advance(30 * SEC);
    expect(await run(h, payload, h.meta({ deferCount: 1, deferredAt: iso(h.now() - 30 * SEC) }))).toEqual(
      done('processed', 'bot_joining'),
    );
    expect(h.db.jobs('bot_release')).toEqual([]);
  });

  it('pending for 20 waits: the key is rotated FIRST, then alert and release; the next create makes a new bot', async () => {
    const h = world();
    const s = await unattached(h);
    const payload = event(h, s, 'bot.joining_call');
    const meta = h.meta({ deferCount: 20, deferredAt: iso(h.now() - 10 * MIN) });
    expect(await run(h, payload, meta)).toEqual(done('processed', 'stray_bot'));
    expect(steps(h)).toEqual(['db:set_bot:rotate_key', 'queue:bot_release']);
    expect(h.db.booking(s.id)).toMatchObject({ status: 'pending', key_attempt: 1 });
    expect(h.logs).toContainEqual({ level: 'error', meta: { error_category: 'r1_meet_stray_bot', error_type: 'pending' } });
    expect(h.db.jobs('bot_release')[0]!.dedup_key).toBe(`r1-meet:bot-release:${s.botId}`);

    // The release job removes the stray (no live booking holds it) ...
    const release = h.db.jobs('bot_release')[0]!.payload as Record<string, unknown>;
    expect(await runJob(h, r1MeetBotReleaseDefinition, release)).toMatchObject({ code: 'released_left' });
    // ... and the next create is not answered with it from Recall's cache.
    expect(await ensureBot(h.deps, s.id, h.meta())).toMatchObject({ code: 'bot_scheduled' });
    const attached = h.db.booking(s.id)!.recall_bot_id as string;
    expect(attached).not.toBe(s.botId);
    expect(h.recall.bots.size).toBe(2);
  });

  it('the deferral bound also ends the wait', async () => {
    const h = world();
    const s = await unattached(h);
    const meta = h.meta({ deferCount: 3, deferredAt: iso(h.now() - 61 * MIN) });
    expect(await deliver(h, s, 'bot.joining_call', {}, meta)).toEqual(done('processed', 'stray_bot'));
  });

  it('a blocked booking: alert and release at once, no wait and no rotation', async () => {
    const h = world();
    const s = await unattached(h);
    expect((await h.db.store.transition({ bookingId: s.id, from: 'pending', to: 'blocked', reason: 'not_scheduled', nowIso: iso(h.now()) })).status).toBe('ok');
    reset(h);
    expect(await deliver(h, s, 'bot.in_waiting_room')).toEqual(done('processed', 'stray_bot'));
    expect(steps(h)).toEqual(['queue:bot_release']);
    expect(h.logs).toContainEqual({ level: 'error', meta: { error_category: 'r1_meet_stray_bot', error_type: 'blocked' } });
  });

  it('another bot on a booking that holds a bot: alert and release; the current bot is untouched', async () => {
    const h = world();
    const b = await booked(h);
    const other = fixtureId();
    expect(await deliver(h, b, 'participant_events.join', { botId: other })).toEqual(done('processed', 'stray_bot'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_scheduled', recall_bot_id: b.botId });
    expect(h.db.jobs('bot_release').map((job) => job.payload.recall_bot_id)).toEqual([other]);
  });

  it('a deleted booking: alert and release; a terminal event needs nothing', async () => {
    const h = world();
    const gone = { id: fixtureId(), botId: fixtureId() };
    expect(await deliver(h, gone, 'bot.call_ended')).toEqual(done('ignored', 'stray_ended'));
    expect(h.db.jobs('bot_release')).toEqual([]);
    expect(await deliver(h, gone, 'bot.joining_call')).toEqual(done('processed', 'stray_bot'));
    expect(h.logs).toContainEqual({ level: 'error', meta: { error_category: 'r1_meet_stray_bot', error_type: 'booking_gone' } });
    expect(h.db.jobs('bot_release')[0]!.payload).toEqual({ kind: 'bot_release', recall_bot_id: gone.botId, booking_id: gone.id });
  });

  it('a bot that is not ours (no booking named, none holds it) is never touched', async () => {
    const h = world();
    await booked(h);
    const foreign = { id: fixtureId(), botId: fixtureId() };
    for (const type of ['bot.joining_call', 'bot.in_call_recording', 'participant_events.join', 'bot.fatal']) {
      expect(await deliver(h, foreign, type, { bookingId: null })).toEqual(done('ignored', 'unknown_bot'));
    }
    expect(h.requests).toEqual([]);
    expect(steps(h)).toEqual([]);
    expect(h.alerts()).toEqual([]);
    expect(h.hot).toEqual([]);
  });
});

// ── Human present (D-S06-25, D-S06-26) ──────────────────────────────────────

describe('recall_event: the human-present arm (D-S06-25)', () => {
  it('the winner arms in order: transition, GET, arm, bridge check, output_media', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    expect(await deliver(h, b, 'bot.in_call_recording')).toEqual(done('processed', 'armed'));
    expect(steps(h)).toEqual([
      'db:transition:human_present',
      'recall:get',
      'db:arm_ticket',
      'queue:bridge_check',
      'recall:output_media',
    ]);
    const ticket = lastTicket(h);
    expect(ticket).toMatch(R1_MEET_TICKET_PATTERN);
    expect(h.db.booking(b.id)).toMatchObject({ ticket_digest: digestOf(ticket), ticket_arms: 1, ticket_claimed_at: null });
    expectNoPii(h, ticket, digestOf(ticket));
  });

  it('both signals at once: exactly one arm and one output_media', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    const join = event(h, b, 'participant_events.join', { participantId: 7 });
    const recording = event(h, b, 'bot.in_call_recording');
    const results = await Promise.all([run(h, join), run(h, recording)]);
    expect(results.map((result) => result.code).sort()).toEqual([
      'already_present',
      'armed',
    ]);
    expect(outputMedia(h)).toHaveLength(1);
    expect(steps(h).filter((step) => step === 'db:arm_ticket')).toHaveLength(1);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 1 });
    expect(h.db.jobs('bridge_check')).toHaveLength(1);
  });

  it('both signals one after the other, and a third duplicate: still one arm', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    expect(await deliver(h, b, 'bot.in_call_recording')).toEqual(done('processed', 'armed'));
    expect(await deliver(h, b, 'participant_events.join', { participantId: 3 })).toEqual(done('ignored', 'already_present'));
    expect(await deliver(h, b, 'participant_events.join', { participantId: 3 })).toEqual(done('ignored', 'already_present'));
    expect(outputMedia(h)).toHaveLength(1);
  });

  it('the winner crashed after the transition: a fresh second signal does not arm, the re-run does', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    const payload = event(h, b, 'bot.in_call_recording');
    h.db.failNext('r1_meet_transition_booking', 'lost');
    await expect(run(h, payload)).rejects.toThrow('r1_meet_db_error');
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 0 });

    expect(await deliver(h, b, 'participant_events.join', { participantId: 9 })).toEqual(done('ignored', 'already_present'));
    expect(outputMedia(h)).toHaveLength(0);

    h.advance(60 * SEC);
    expect(await run(h, payload, h.meta({ attempts: 2 }))).toEqual(done('processed', 'armed'));
    expect(outputMedia(h)).toHaveLength(1);
    expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 1, ticket_digest: digestOf(lastTicket(h)) });
  });

  it('the winner crashed after the arm: the re-run (60 s later) arms a fresh ticket and posts it', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    const payload = event(h, b, 'bot.in_call_recording');
    h.db.failNext('r1_meet_arm_ticket', 'lost');
    await expect(run(h, payload)).rejects.toThrow('r1_meet_db_error');
    expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 1 });
    expect(outputMedia(h)).toHaveLength(0);

    h.advance(60 * SEC);
    expect(await run(h, payload, h.meta({ attempts: 2 }))).toEqual(done('processed', 'armed'));
    expect(outputMedia(h)).toHaveLength(1);
    const row = h.db.booking(b.id)!;
    expect(row).toMatchObject({ ticket_arms: 2, ticket_digest: digestOf(lastTicket(h)) });
  });

  it('a re-run within 20 s of an arm does not replace it (a page is loading)', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    const payload = event(h, b, 'bot.in_call_recording');
    h.db.failNext('r1_meet_arm_ticket', 'lost');
    await expect(run(h, payload)).rejects.toThrow('r1_meet_db_error');
    h.advance(19 * SEC);
    expect(await run(h, payload, h.meta({ attempts: 2 }))).toEqual(done('ignored', 'already_present'));
    expect(h.requests.filter((request) => request.op !== 'get')).toEqual([]);
    expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 1 });
    h.advance(SEC);
    expect(await run(h, payload, h.meta({ attempts: 3 }))).toEqual(done('processed', 'armed'));
  });

  it('a claimed ticket is never re-armed by an event (the page is in): in_call gives nothing', async () => {
    const h = world();
    const b = await booked(h, 'in_call');
    expect(await deliver(h, b, 'bot.in_call_recording', {}, h.meta({ attempts: 3 }))).toEqual(done('ignored', 'in_call'));
    expect(h.requests).toEqual([]);
  });
});

describe('recall_event: arm at create (D-S06-26)', () => {
  const atCreate = (): R1MeetHarness => world({ config: { armAtCreate: true } });

  it('armed at create: the human signal moves the booking, never re-arms, and queues the check of that arm', async () => {
    const h = atCreate();
    const b = await booked(h, 'bot_scheduled');
    expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 1 });
    expect(await deliver(h, b, 'bot.in_call_recording')).toEqual(done('processed', 'human_present'));
    expect(steps(h)).toEqual(['db:transition:human_present', 'queue:bridge_check']);
    expect(h.requests).toEqual([]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 1 });
    expect(h.db.jobs('bridge_check')[0]).toMatchObject({
      payload: { kind: 'bridge_check', booking_id: b.id, version: 0, arm: 1 },
      scheduled_at: iso(h.now() + 45 * SEC),
    });
    // A re-run neither re-arms (still armed at create) nor queues a second check.
    expect(await deliver(h, b, 'participant_events.join', {}, h.meta({ attempts: 2 }))).toEqual(done('ignored', 'already_present'));
    expect(h.db.jobs('bridge_check')).toHaveLength(1);
    expect(outputMedia(h)).toHaveLength(0);
  });

  it('not armed at create (the arm failed): the human signal falls back to the normal arm', async () => {
    const h = atCreate();
    const created = await h.createBooking({ startAt: iso(h.now() + MIN) });
    h.db.failNext('r1_meet_arm_ticket');
    expect(await ensureBot(h.deps, created.bookingId, h.meta())).toMatchObject({ code: 'bot_scheduled' });
    const row = h.db.booking(created.bookingId)!;
    expect(row).toMatchObject({ ticket_arms: 0, ticket_not_before: null });
    reset(h);
    const b = { id: row.id as string, botId: row.recall_bot_id as string };
    expect(await deliver(h, b, 'bot.in_call_recording')).toEqual(done('processed', 'armed'));
    expect(outputMedia(h)).toHaveLength(1);
    expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 1, ticket_digest: digestOf(lastTicket(h)) });
  });

  it('already in the call (the create-time ticket was claimed): nothing', async () => {
    const h = atCreate();
    const created = await h.createBooking({ startAt: iso(h.now() + MIN) });
    await ensureBot(h.deps, created.bookingId, h.meta());
    const create = h.requests.find((request) => request.op === 'create')!;
    const ticket = ticketOf(((create.body as { output_media: { camera: { config: { url: string } } } }).output_media.camera.config.url));
    expect((await h.db.claimTicket(ticket, iso(h.now()), BRIDGE_SOURCE)).data).toMatchObject({ status: 'ok' });
    reset(h);
    const row = h.db.booking(created.bookingId)!;
    const b = { id: row.id as string, botId: row.recall_bot_id as string };
    expect(await deliver(h, b, 'bot.in_call_recording', {}, h.meta({ attempts: 2 }))).toEqual(done('ignored', 'in_call'));
    expect(h.requests).toEqual([]);
    expect(h.db.jobs('bridge_check')).toEqual([]);
  });
});

// ── Terminal events: sub-codes, our own leave, the release ──────────────────

describe('recall_event: terminal events (D-S06-24, M035 S09 D-S09-3)', () => {
  /**
   * `inCall`: Recall's history of the bot holds `in_call_not_recording` before the terminal event (it
   * got into the call). The expected alert is `r1MeetBotAlertFor(subCode)` (pinned in its own table).
   */
  const subCodeCases: ReadonlyArray<readonly [type: string, subCode: string | null, inCall: boolean, reason: string]> = [
    // A fatal sub-code is a bot failure from the event alone (no read before the move).
    ...R1_MEET_FATAL_SUB_CODES.map((code) => ['bot.call_ended', code, false, 'bot_fatal'] as const),
    ...R1_MEET_FATAL_SUB_CODES.map((code) => ['bot.done', code, false, 'bot_fatal'] as const),
    ['bot.call_ended', 'bot_kicked_from_call', true, 'bot_fatal'],
    ['bot.call_ended', 'timeout_exceeded_recording_permission_denied', true, 'bot_fatal'],
    // In the call, nobody came: a no-show, whatever other sub-code (unknown ones unchanged).
    ['bot.call_ended', null, true, 'no_show'],
    ['bot.call_ended', 'timeout_exceeded_noone_joined', true, 'no_show'],
    ['bot.call_ended', 'timeout_exceeded_everyone_left', true, 'no_show'],
    ['bot.call_ended', 'call_ended_by_host', true, 'no_show'],
    ['bot.call_ended', 'a_sub_code_recall_added_later.v2', true, 'no_show'],
    ['bot.done', null, true, 'no_show'],
    // Never in the call: the bot failed, whatever the event's sub-code (no alert: none is listed).
    ['bot.call_ended', null, false, 'bot_fatal'],
    ['bot.call_ended', 'timeout_exceeded_noone_joined', false, 'bot_fatal'],
    ['bot.call_ended', 'a_sub_code_recall_added_later.v2', false, 'bot_fatal'],
    ['bot.done', null, false, 'bot_fatal'],
    // bot.fatal is a bot failure from the event alone.
    ['bot.fatal', null, false, 'bot_fatal'],
    ['bot.fatal', null, true, 'bot_fatal'],
    ['bot.fatal', 'google_meet_sign_in_failed', false, 'bot_fatal'],
    ['bot.fatal', 'a_sub_code_recall_added_later.v2', false, 'bot_fatal'],
  ];

  it.each(subCodeCases.flatMap((entry) => (['bot_scheduled', 'bot_joining'] as const).map((start) => [...entry, start] as const)))(
    '%s with sub-code %s (in the call before: %s) -> failed/%s (from %s)',
    async (type, subCode, inCall, reason, start) => {
      const h = world();
      const b = await booked(h, start);
      if (inCall) h.recall.setStatus(b.botId, 'in_call_not_recording');
      expect(await deliver(h, b, type, { subCode })).toEqual(done('processed', `failed_${reason}`));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason, recall_bot_id: null });
      const alert = r1MeetBotAlertFor(subCode);
      expect(errorLines(h)).toEqual(alert === null ? [] : [{ level: 'error', meta: { error_category: alert, error_type: subCode } }]);
      // The terminal event of a bot that is over: at most the one GET, never a leave.
      expect(recallOps(h)).toEqual(['get']);
      expectNoPii(h);
    },
  );

  it('a no-show: Recall first (ONE GET before the move, which says ended), then the move, then the release mark', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.recall.setStatus(b.botId, 'in_call_not_recording');
    expect(await deliver(h, b, 'bot.call_ended', { subCode: 'timeout_exceeded_noone_joined' })).toEqual(
      done('processed', 'failed_no_show'),
    );
    expect(steps(h)).toEqual(['recall:get', 'db:transition:failed', 'db:set_bot:release']);
    expect(h.alerts()).toEqual([]);
  });

  it('a bot failure the event alone decides: the move, then the release GET (says ended), then the mark', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    expect(await deliver(h, b, 'bot.fatal', { subCode: 'google_meet_knocking_disabled' })).toEqual(done('processed', 'failed_bot_fatal'));
    expect(steps(h)).toEqual(['db:transition:failed', 'recall:get', 'db:set_bot:release']);
  });

  it('a bot whose call ended but Recall still reports it live (out of order) is left first', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    expect(await deliver(h, b, 'bot.fatal', { mirror: false })).toEqual(done('processed', 'failed_bot_fatal'));
    expect(recallOps(h)).toEqual(['get', 'leave']);
    expect(h.db.booking(b.id)).toMatchObject({ recall_bot_id: null });
  });

  it('our own leave (bot_received_leave_call) waits once, 60 s (no Recall read), then maps on a fresh read', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.recall.setStatus(b.botId, 'in_call_not_recording');
    const payload = event(h, b, 'bot.call_ended', { subCode: 'bot_received_leave_call' });
    expect(await run(h, payload)).toEqual(deferred('own_leave', 60));
    expect(h.requests).toEqual([]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining' });
    h.advance(60 * SEC);
    expect(await run(h, payload, h.meta({ deferCount: 1, deferredAt: iso(h.now() - 60 * SEC) }))).toEqual(
      done('processed', 'failed_no_show'),
    );
  });

  it('our own leave whose job marked the booking meanwhile: the wait ends in the owed release', async () => {
    const h = world();
    const b = await booked(h, 'human_present');
    const payload = event(h, b, 'bot.call_ended', { subCode: 'bot_received_leave_call' });
    expect(await run(h, payload)).toEqual(deferred('own_leave', 60));
    // The leaving job (here: the multi-human policy) marked it, and died before its release mark.
    expect((await h.db.store.transition({ bookingId: b.id, from: 'human_present', to: 'failed', reason: 'multiple_humans', nowIso: iso(h.now()) })).status).toBe('ok');
    expect(await run(h, payload, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }))).toEqual(done('processed', 'released_ended'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'multiple_humans', recall_bot_id: null });
  });

  it('a lost release mark after the move: the re-run finishes the owed release', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    const payload = event(h, b, 'bot.call_ended');
    h.db.failNext('r1_meet_set_bot');
    await expect(run(h, payload)).rejects.toThrow('r1_meet_db_error');
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', recall_bot_id: b.botId });
    expect(await run(h, payload, h.meta({ attempts: 2 }))).toEqual(done('processed', 'released_ended'));
    expect(h.db.booking(b.id)).toMatchObject({ recall_bot_id: null });
  });

  it('Recall down at the read before the move: deferred BEFORE the move (the booking stays live, no alert); the re-run maps', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.recall.setStatus(b.botId, 'in_call_not_recording');
    const payload = event(h, b, 'bot.call_ended');
    h.intercept('get', { status: 503 });
    expect(await run(h, payload)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(steps(h)).toEqual(['recall:get']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', reason: 'eligible', recall_bot_id: b.botId });
    expect(h.alerts()).toEqual([]);
    expect(await run(h, payload, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }))).toEqual(done('processed', 'failed_no_show'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
  });

  it('Recall down at the read, past the deferral bound: the job throws, still before the move', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    h.intercept('get', 'network');
    await expect(deliver(h, b, 'bot.done', {}, h.meta({ deferCount: 30, deferredAt: iso(h.now()) }))).rejects.toThrow('r1_meet_recall_network');
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_scheduled', recall_bot_id: b.botId });
    expect(h.alerts()).toEqual([]);
  });

  it('Recall no longer knows the bot (404 on the read): the event\'s own reason, released with no further Recall call', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.intercept('get', { status: 404 });
    expect(await deliver(h, b, 'bot.call_ended', { subCode: 'timeout_exceeded_noone_joined' })).toEqual(done('processed', 'failed_no_show'));
    expect(steps(h)).toEqual(['recall:get', 'db:transition:failed', 'db:set_bot:release']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
    expect(h.alerts()).toEqual([]);
  });

  it('out of order on a would-be no-show: Recall still reports the bot live in the call: GET, move, GET, leave', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.recall.setStatus(b.botId, 'in_call_not_recording');
    expect(await deliver(h, b, 'bot.call_ended', { mirror: false })).toEqual(done('processed', 'failed_no_show'));
    expect(steps(h)).toEqual(['recall:get', 'db:transition:failed', 'recall:get', 'recall:leave', 'db:set_bot:release']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
  });

  it('Recall down at the release after the move (the bot still live in the call): deferred, the move stays; the re-run releases', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.recall.setStatus(b.botId, 'in_call_not_recording');
    const payload = event(h, b, 'bot.call_ended', { mirror: false });
    let gets = 0;
    // The read before the move answers; the release's own GET after it does not.
    h.intercept((_req, op) => op === 'get' && ++gets === 2, { status: 503 });
    expect(await run(h, payload)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(steps(h)).toEqual(['recall:get', 'db:transition:failed', 'recall:get']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: b.botId });
    expect(await run(h, payload, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }))).toEqual(done('processed', 'released_left'));
    expect(h.db.booking(b.id)).toMatchObject({ recall_bot_id: null });
    expect(h.alerts()).toEqual([]);
  });
});

// ── A refused bot (M035 S09 D-S09-3/4) ──────────────────────────────────────

describe('recall_event: a bot held, denied, blocked or unable to sign in fails the bot, never a candidate no-show (M035 S09)', () => {
  const listed = [
    ...R1_MEET_ADMISSION_SUB_CODES.map((code) => [code, ADMISSION_WORD] as const),
    ...R1_MEET_SIGN_IN_SUB_CODES.map((code) => [code, SIGN_IN_WORD] as const),
  ];
  const cases = listed.flatMap(([code, word]) =>
    (['bot.fatal', 'bot.call_ended'] as const).flatMap((type) =>
      (['bot_scheduled', 'bot_joining'] as const).map((start) => [code, type, start, word] as const),
    ),
  );

  it.each(cases)('%s on %s from %s: failed/bot_fatal and exactly one alert naming it', async (code, type, start, word) => {
    const h = world();
    const b = await booked(h, start);
    expect(await deliver(h, b, type, { subCode: code })).toEqual(done('processed', 'failed_bot_fatal'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: null });
    expect(errorLines(h)).toEqual([{ level: 'error', meta: { error_category: word, error_type: code } }]);
    // The event alone decides: no read before the move; the one GET is the release's (it says ended).
    expect(steps(h)).toEqual(['db:transition:failed', 'recall:get', 'db:set_bot:release']);
    expectNoPii(h);
  });

  it.each(['bot_scheduled', 'bot_joining'] as const)(
    'out of order (from %s): bot.done first while Recall already holds fatal/google_meet_bot_blocked -> bot_fatal, one alert; the later bot.fatal adds none',
    async (start) => {
      const h = world();
      const b = await booked(h, start);
      // Recall's real order is fatal, then done; Svix delivers done first.
      h.recall.setStatus(b.botId, 'fatal', 'google_meet_bot_blocked');
      expect(await deliver(h, b, 'bot.done')).toEqual(done('processed', 'failed_bot_fatal'));
      expect(steps(h)).toEqual(['recall:get', 'db:transition:failed', 'db:set_bot:release']);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: null });
      expect(errorLines(h)).toEqual([{ level: 'error', meta: { error_category: ADMISSION_WORD, error_type: 'google_meet_bot_blocked' } }]);
      // The bot.fatal that was sent first arrives now: the bot is released, so it needs nothing.
      expect(await deliver(h, b, 'bot.fatal', { subCode: 'google_meet_bot_blocked', mirror: false })).toEqual(done('ignored', 'stray_ended'));
      expect(h.alerts()).toEqual([ADMISSION_WORD]);
      expectNoPii(h);
    },
  );

  it('out of order with the release mark lost: the later bot.fatal finishes the owed release, and adds no alert', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.recall.setStatus(b.botId, 'fatal', 'google_meet_sso_sign_in_failed');
    h.db.failNext('r1_meet_set_bot');
    await expect(deliver(h, b, 'bot.done')).rejects.toThrow('r1_meet_db_error');
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: b.botId });
    expect(await deliver(h, b, 'bot.fatal', { subCode: 'google_meet_sso_sign_in_failed', mirror: false })).toEqual(
      done('processed', 'released_ended'),
    );
    expect(h.db.booking(b.id)).toMatchObject({ recall_bot_id: null });
    expect(errorLines(h)).toEqual([{ level: 'error', meta: { error_category: SIGN_IN_WORD, error_type: 'google_meet_sso_sign_in_failed' } }]);
  });

  it.each(['bot_scheduled', 'bot_joining'] as const)('never in the call (from %s): bot.done with no sub-code -> failed/bot_fatal, no alert', async (start) => {
    const h = world();
    const b = await booked(h, start);
    expect(await deliver(h, b, 'bot.done')).toEqual(done('processed', 'failed_bot_fatal'));
    expect(steps(h)).toEqual(['recall:get', 'db:transition:failed', 'db:set_bot:release']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: null });
    expect(h.alerts()).toEqual([]);
  });

  it('the waiting room, then Recall\'s timeout of it on call_ended: bot_fatal with the admission alert', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    expect(await deliver(h, b, 'bot.in_waiting_room')).toEqual(done('processed', 'bot_joining'));
    h.advance(10 * MIN);
    expect(await deliver(h, b, 'bot.call_ended', { subCode: 'timeout_exceeded_waiting_room' })).toEqual(done('processed', 'failed_bot_fatal'));
    expect(errorLines(h).map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_bot_waiting_room' },
      { error_category: ADMISSION_WORD, error_type: 'timeout_exceeded_waiting_room' },
    ]);
    expectNoPii(h);
  });

  it('a move lost to another job (it ended the booking first) never alerts: one alert per booking', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    let raced = false;
    const deps: R1MeetFlowDeps = {
      ...h.deps,
      store: {
        ...h.deps.store,
        transition: async (input) => {
          if (!raced && input.to === 'failed') {
            raced = true;
            // Another job's move wins first (and alerts, if it is the one that owns it).
            expect((await h.deps.store.transition({ ...input, reason: 'bot_fatal' })).status).toBe('ok');
          }
          return h.deps.store.transition(input);
        },
      },
    };
    const payload = event(h, b, 'bot.fatal', { subCode: 'google_meet_bot_blocked' });
    expect(await runJob(h, r1MeetRecallEventDefinition, payload, h.meta(), deps)).toEqual(done('processed', 'released_ended'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: null });
    expect(h.alerts()).toEqual([]);
  });
});

// ── The waiting room (M035 S09 D-S09-4(b)) ──────────────────────────────────

describe('recall_event: a bot held in the waiting room alerts at once (M035 S09)', () => {
  const WAITING_ROOM = { level: 'error', meta: { error_category: 'r1_meet_bot_waiting_room' } };

  it('bot_scheduled: -> bot_joining (unchanged mapping) and one alert, no Recall call', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    expect(await deliver(h, b, 'bot.in_waiting_room')).toEqual(done('processed', 'bot_joining'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', reason: 'eligible' });
    expect(errorLines(h)).toEqual([WAITING_ROOM]);
    expect(h.requests).toEqual([]);
    expectNoPii(h);
  });

  it('bot_joining: no change and one alert', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    expect(await deliver(h, b, 'bot.in_waiting_room')).toEqual(done('ignored', 'no_change'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining' });
    expect(errorLines(h)).toEqual([WAITING_ROOM]);
  });

  it('a run that is a re-run (attempts 2) still alerts: one line per run that ends (PR #449 review S09-R1)', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    expect(await deliver(h, b, 'bot.in_waiting_room', {}, h.meta({ attempts: 2 }))).toEqual(done('processed', 'bot_joining'));
    expect(errorLines(h)).toEqual([WAITING_ROOM]);
  });

  it('the first attempt dies at the booking read: no alert; its retry (attempts 2) alerts once', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    const payload = event(h, b, 'bot.in_waiting_room');
    h.db.failNext('r1_meet_bookings');
    await expect(run(h, payload)).rejects.toThrow('r1_meet_db_error');
    expect(h.alerts()).toEqual([]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_scheduled' });
    expect(await run(h, payload, h.meta({ attempts: 2 }))).toEqual(done('processed', 'bot_joining'));
    expect(errorLines(h)).toEqual([WAITING_ROOM]);
  });

  it('the status step fails (a database error): that run writes no alert, its retry writes the one line', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    const payload = event(h, b, 'bot.in_waiting_room');
    h.db.failNext('r1_meet_transition_booking');
    await expect(run(h, payload)).rejects.toThrow('r1_meet_db_error');
    expect(h.alerts()).toEqual([]);
    expect(await run(h, payload, h.meta({ attempts: 2 }))).toEqual(done('processed', 'bot_joining'));
    expect(errorLines(h)).toEqual([WAITING_ROOM]);
  });

  it('the event of a bot a pending booking is attaching: deferred with no alert; the re-run against the attached booking alerts once', async () => {
    const h = world();
    const s = await unattached(h);
    const payload = event(h, s, 'bot.in_waiting_room');
    expect(await run(h, payload)).toEqual(deferred('stray_pending', 30));
    expect(h.alerts()).toEqual([]);
    expect(await ensureBot(h.deps, s.id, h.meta())).toMatchObject({ code: 'bot_scheduled' });
    h.advance(30 * SEC);
    reset(h);
    expect(await run(h, payload, h.meta({ deferCount: 1, deferredAt: iso(h.now() - 30 * SEC) }))).toEqual(
      done('processed', 'bot_joining'),
    );
    expect(errorLines(h)).toEqual([WAITING_ROOM]);
    expect(h.db.jobs('bot_release')).toEqual([]);
    expectNoPii(h);
  });

  it('a compare-and-set lost and retried within the run: still one alert', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    let lost = false;
    const deps: R1MeetFlowDeps = {
      ...h.deps,
      store: {
        ...h.deps.store,
        transition: async (input) => {
          if (!lost) {
            lost = true;
            return { status: 'status_conflict' } as Awaited<ReturnType<R1MeetFlowDeps['store']['transition']>>;
          }
          return h.deps.store.transition(input);
        },
      },
    };
    expect(await runJob(h, r1MeetRecallEventDefinition, event(h, b, 'bot.in_waiting_room'), h.meta(), deps)).toEqual(
      done('processed', 'bot_joining'),
    );
    expect(errorLines(h)).toEqual([WAITING_ROOM]);
  });

  it('a terminal booking (an owed release) queues the release and raises no waiting-room alert', async () => {
    const h = world();
    const b = await booked(h, 'failed_owed');
    expect(await deliver(h, b, 'bot.in_waiting_room')).toEqual(done('processed', 'release_queued'));
    expect(h.alerts()).toEqual([]);
  });

  it('a stray or a bot that is not ours raises only what it raised before', async () => {
    const h = world();
    const b = await booked(h, 'failed_released');
    expect(await deliver(h, b, 'bot.in_waiting_room')).toEqual(done('processed', 'stray_bot'));
    expect(await deliver(h, { id: fixtureId(), botId: fixtureId() }, 'bot.in_waiting_room', { bookingId: null })).toEqual(
      done('ignored', 'unknown_bot'),
    );
    expect(h.alerts()).toEqual(['r1_meet_stray_bot']);
  });
});

// ── Multiple humans (D-S06-28) ──────────────────────────────────────────────

describe('multiple humans (D-S06-28)', () => {
  const checkPayload = (b: Booked, version = 0) => ({ kind: 'multi_human_check', booking_id: b.id, version });
  const check = (h: R1MeetHarness, b: Booked, meta?: R1MeetJobMeta) =>
    runJob(h, r1MeetMultiHumanCheckDefinition, checkPayload(b), meta ?? h.meta());

  async function present(h: R1MeetHarness): Promise<Booked> {
    const b = await booked(h, 'bot_joining');
    expect(await deliver(h, b, 'participant_events.join', { participantId: 1 })).toEqual(done('processed', 'armed'));
    reset(h);
    return b;
  }

  it('a second human queues ONE check 120 s later (per bot generation)', async () => {
    const h = world();
    const b = await present(h);
    expect(h.db.jobs('multi_human_check')).toEqual([]);
    expect(await deliver(h, b, 'participant_events.join', { participantId: 2 })).toEqual(done('ignored', 'already_present'));
    expect(h.db.jobs('multi_human_check')).toEqual([
      expect.objectContaining({
        payload: { kind: 'multi_human_check', booking_id: b.id, version: 0 },
        dedup_key: `r1-meet:multi-human:${b.id}:v0`,
        max_attempts: 10,
        scheduled_at: iso(h.now() + 120 * SEC),
      }),
    ]);
    await deliver(h, b, 'participant_events.join', { participantId: 3 });
    expect(h.db.jobs('multi_human_check')).toHaveLength(1);
    expectNoPii(h);
  });

  it('a rejoin (a leave, then a new id) is one human: no check', async () => {
    const h = world();
    const b = await present(h);
    await deliver(h, b, 'participant_events.leave', { participantId: 1 });
    await deliver(h, b, 'participant_events.join', { participantId: 2 });
    expect(h.db.jobs('multi_human_check')).toEqual([]);
  });

  it('null ids, bots and other bots\' rows are not humans', async () => {
    const h = world();
    const b = await present(h);
    await deliver(h, b, 'participant_events.join', { participantId: null });
    await deliver(h, b, 'participant_events.join', { participantId: 8, isBot: true });
    // Another bot's call (its own booking): its participants are not this call's.
    event(h, { id: fixtureId(), botId: fixtureId() }, 'participant_events.join', { participantId: 2 });
    await deliver(h, b, 'participant_events.join', { participantId: null });
    expect(h.db.jobs('multi_human_check')).toEqual([]);
  });

  it('a join in the call (in_call) is counted too', async () => {
    const h = world();
    const b = await booked(h, 'in_call_session');
    event(h, b, 'participant_events.join', { participantId: 1 });
    expect(await deliver(h, b, 'participant_events.join', { participantId: 2 })).toEqual(done('ignored', 'in_call'));
    expect(h.db.jobs('multi_human_check')).toHaveLength(1);
  });

  it('still two at the check, policy end: alert, leave BEFORE the mark, failed/multiple_humans, release', async () => {
    const h = world();
    const b = await present(h);
    await deliver(h, b, 'participant_events.join', { participantId: 2 });
    reset(h);
    h.advance(120 * SEC);
    expect(await check(h, b)).toEqual(done('processed', 'multiple_humans'));
    expect(steps(h)).toEqual(['recall:get', 'recall:leave', 'db:transition:failed', 'db:set_bot:release']);
    expect(h.alerts()).toEqual(['r1_meet_multiple_humans']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'multiple_humans', recall_bot_id: null });
    expectNoPii(h);
  });

  it('down to one by the check: nothing', async () => {
    const h = world();
    const b = await present(h);
    await deliver(h, b, 'participant_events.join', { participantId: 2 });
    await deliver(h, b, 'participant_events.leave', { participantId: 2 });
    reset(h);
    expect(await check(h, b)).toEqual(done('ignored', 'one_human'));
    expect(h.requests).toEqual([]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present' });
  });

  it('policy observe: one warning, the call goes on', async () => {
    const h = world({ config: { multiHumanPolicy: 'observe' } });
    const b = await present(h);
    await deliver(h, b, 'participant_events.join', { participantId: 2 });
    reset(h);
    expect(await check(h, b)).toEqual(done('ignored', 'observed'));
    expect(h.logs).toEqual([{ level: 'warn', meta: { error_category: 'r1_meet_multi_human_observed' } }]);
    expect(h.requests).toEqual([]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', recall_bot_id: b.botId });
  });

  it('another generation, a gone or ended booking: ignored', async () => {
    const h = world();
    const b = await present(h);
    await deliver(h, b, 'participant_events.join', { participantId: 2 });
    reset(h);
    expect(await runJob(h, r1MeetMultiHumanCheckDefinition, checkPayload(b, 1))).toEqual(done('ignored', 'generation_changed'));
    expect(await runJob(h, r1MeetMultiHumanCheckDefinition, { ...checkPayload(b), booking_id: fixtureId() })).toEqual(
      done('ignored', 'booking_gone'),
    );
    const released = await booked(h, 'failed_released');
    expect(await check(h, released)).toEqual(done('ignored', 'booking_terminal'));
    expect(h.requests).toEqual([]);
  });

  it('kill point: the leave answer is lost; the re-run finds the bot ended and marks', async () => {
    const h = world();
    const b = await present(h);
    await deliver(h, b, 'participant_events.join', { participantId: 2 });
    reset(h);
    h.intercept('leave', 'lost');
    expect(await check(h, b)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present' });
    expect(await check(h, b, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }))).toEqual(done('processed', 'multiple_humans'));
    expect(recallOps(h)).toEqual(['get', 'leave', 'get']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'multiple_humans', recall_bot_id: null });
  });

  it('kill point: the release mark is lost after the move; the re-run settles the owed release', async () => {
    const h = world();
    const b = await present(h);
    await deliver(h, b, 'participant_events.join', { participantId: 2 });
    reset(h);
    h.db.failNext('r1_meet_set_bot');
    await expect(check(h, b)).rejects.toThrow('r1_meet_db_error');
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', recall_bot_id: b.botId });
    expect(await check(h, b, h.meta({ attempts: 2 }))).toEqual(done('processed', 'released_ended'));
    expect(h.db.booking(b.id)).toMatchObject({ recall_bot_id: null });
  });
});

// ── The bot's own participant is never a human (M035 S09 D-S09-6) ──────────

describe('the bot\'s own participant is never a human (M035 S09 D-S09-6, UNVERIFIED until S0c)', () => {
  /** Participant ids: the bot's own join, the candidate, a candidate named like the bot. */
  const BOT = 50;
  const CANDIDATE = 1;
  const NAME_ALIKE = 51;
  /** A join the receiver marked `is_bot` (Recall said so, or the display name was the bot's own). */
  const marked = (id: number | null): Delivery => ({ participantId: id, isBot: true });
  const checkPayload = (b: Booked) => ({ kind: 'multi_human_check', booking_id: b.id, version: 0 });
  const check = (h: R1MeetHarness, b: Booked, meta?: R1MeetJobMeta) =>
    runJob(h, r1MeetMultiHumanCheckDefinition, checkPayload(b), meta ?? h.meta());

  /** A `bot_joining` booking whose bot Recall reports in the call from now (T0). */
  async function inCall(h: R1MeetHarness): Promise<Booked> {
    const b = await booked(h, 'bot_joining');
    h.recall.setStatus(b.botId, 'in_call_not_recording');
    return b;
  }

  it('H1: the bot\'s own join (marked, at its in-call time) is ignored; the candidate\'s join arms, with no recount', async () => {
    const h = world();
    const b = await inCall(h);
    expect(await deliver(h, b, 'participant_events.join', marked(BOT))).toEqual(done('ignored', 'bot_participant'));
    // One GET for the bound; nothing moves, nothing is armed or shown.
    expect(steps(h)).toEqual(['recall:get']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', reason: 'eligible', ticket_arms: 0 });
    expect(outputMedia(h)).toHaveLength(0);

    h.advance(60 * SEC);
    reset(h);
    expect(await deliver(h, b, 'participant_events.join', { participantId: CANDIDATE })).toEqual(done('processed', 'armed'));
    // The recount reads the bound (the bot's row is marked), then the normal arm.
    expect(steps(h)).toEqual([
      'db:transition:human_present',
      'recall:get',
      'recall:get',
      'db:arm_ticket',
      'queue:bridge_check',
      'recall:output_media',
    ]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 1 });
    expect(outputMedia(h)).toHaveLength(1);
    expect(h.db.jobs('multi_human_check')).toEqual([]);
    expect(h.alerts()).toEqual([]);
    expectNoPii(h, lastTicket(h), digestOf(lastTicket(h)));
  });

  it('the candidate already present, then the bot\'s own join 2 s after it got in: ignored, no recount', async () => {
    const h = world();
    const b = await inCall(h);
    expect(await deliver(h, b, 'participant_events.join', { participantId: CANDIDATE })).toEqual(done('processed', 'armed'));
    const ticket = lastTicket(h);
    h.advance(2 * SEC);
    reset(h);
    expect(await deliver(h, b, 'participant_events.join', marked(BOT))).toEqual(done('ignored', 'bot_participant'));
    expect(steps(h)).toEqual(['recall:get']);
    expect(h.db.jobs('multi_human_check')).toEqual([]);
    expect(outputMedia(h)).toHaveLength(0);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 1 });
    expect(h.alerts()).toEqual([]);
    expectNoPii(h, ticket, digestOf(ticket));
  });

  /** H1, then the candidate at +60 s, then a second marked join (a candidate named like the bot) at +120 s. */
  async function nameAlikeCall(h: R1MeetHarness): Promise<Booked> {
    const b = await inCall(h);
    expect(await deliver(h, b, 'participant_events.join', marked(BOT))).toEqual(done('ignored', 'bot_participant'));
    h.advance(60 * SEC);
    expect(await deliver(h, b, 'participant_events.join', { participantId: CANDIDATE })).toEqual(done('processed', 'armed'));
    expect(h.db.jobs('multi_human_check')).toEqual([]);
    h.advance(60 * SEC);
    reset(h);
    // Not the bot's own: the earliest marked join (the bot's) already took that place. A person, so it
    // is counted (the recount), but a marked join never moves or arms the booking.
    expect(await deliver(h, b, 'participant_events.join', marked(NAME_ALIKE))).toEqual(done('ignored', 'marked_participant'));
    expect(steps(h)).toEqual(['recall:get', 'queue:multi_human_check']);
    expect(h.db.jobs('multi_human_check')).toEqual([
      expect.objectContaining({ payload: checkPayload(b), scheduled_at: iso(h.now() + 120 * SEC) }),
    ]);
    expect(outputMedia(h)).toHaveLength(0);
    return b;
  }

  it('a later name-alike is a person: ONE recount; at the check, policy end ends the call failed/multiple_humans', async () => {
    const h = world();
    const b = await nameAlikeCall(h);
    expectNoPii(h);
    h.advance(120 * SEC);
    reset(h);
    expect(await check(h, b)).toEqual(done('processed', 'multiple_humans'));
    // The bound's GET, then the leave (its own GET first), then the mark.
    expect(steps(h)).toEqual(['recall:get', 'recall:get', 'recall:leave', 'db:transition:failed', 'db:set_bot:release']);
    expect(h.alerts()).toEqual(['r1_meet_multiple_humans']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'multiple_humans', recall_bot_id: null });
    expectNoPii(h);
  });

  it('a later name-alike, policy observe (the default): only the warning, the call goes on', async () => {
    const h = world({ config: { multiHumanPolicy: 'observe' } });
    const b = await nameAlikeCall(h);
    h.advance(120 * SEC);
    reset(h);
    expect(await check(h, b)).toEqual(done('ignored', 'observed'));
    // The bound's GET logs its own info line; the flow itself only warns.
    expect(h.logs.filter((line) => line.level !== 'info')).toEqual([
      { level: 'warn', meta: { error_category: 'r1_meet_multi_human_observed' } },
    ]);
    expect(recallOps(h)).toEqual(['get']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', recall_bot_id: b.botId });
    expectNoPii(h);
  });

  it('H3: no join row of the bot; a lone name-alike 120 s after the bot got in counts, and bot.in_call_recording arms', async () => {
    const h = world();
    const b = await inCall(h);
    h.advance(120 * SEC);
    // A person (past the bound), one human: no recount, and a marked join never arms (S09-R4).
    expect(await deliver(h, b, 'participant_events.join', marked(NAME_ALIKE))).toEqual(done('ignored', 'marked_participant'));
    expect(steps(h)).toEqual(['recall:get']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', ticket_arms: 0 });
    expect(h.db.jobs('multi_human_check')).toEqual([]);
    // Recall starts recording when the first participant joins: that is the candidate's human signal.
    reset(h);
    expect(await deliver(h, b, 'bot.in_call_recording')).toEqual(done('processed', 'armed'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 1 });
    expect(outputMedia(h)).toHaveLength(1);
    expectNoPii(h, lastTicket(h), digestOf(lastTicket(h)));
  });

  it("the bot's own join stamped 20 s after it got in (it misses the bound): never a move or an arm (S09-R4)", async () => {
    const h = world();
    const b = await inCall(h);
    h.advance(20 * SEC);
    expect(await deliver(h, b, 'participant_events.join', marked(BOT))).toEqual(done('ignored', 'marked_participant'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', reason: 'eligible', ticket_arms: 0 });
    expect(outputMedia(h)).toHaveLength(0);
    // The candidate's own join is the human signal as usual: one arm. The missed bot join now counts
    // as a person, so this join also queues the recount (the known limit pinned below).
    h.advance(60 * SEC);
    expect(await deliver(h, b, 'participant_events.join', { participantId: CANDIDATE })).toEqual(done('processed', 'armed'));
    expect(outputMedia(h)).toHaveLength(1);
    expect(h.db.jobs('multi_human_check')).toHaveLength(1);
    expect(h.alerts()).toEqual([]);
  });

  it('a marked join with no readable time, while the bot is in the call: never a move or an arm (S09-R4)', async () => {
    const h = world();
    const b = await inCall(h);
    h.advance(2 * SEC);
    expect(await deliver(h, b, 'participant_events.join', { ...marked(BOT), occurredAt: null })).toEqual(
      done('ignored', 'marked_participant'),
    );
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', ticket_arms: 0 });
    expect(outputMedia(h)).toHaveLength(0);
  });

  it('a participant Recall itself calls a bot (no id after the receiver) is ignored outright and never counted (S09-R3)', async () => {
    const h = world();
    const b = await inCall(h);
    // What the receiver makes of Recall's own `is_bot: true` (a notetaker, say), 60 s after the bot got in.
    const notetaker = buildR1MeetRecallEventJob(
      {
        event: 'participant_events.join',
        data: {
          bot: { id: b.botId, metadata: { booking_id: b.id, profile: 'r1_dex_sales' } },
          data: { participant: { id: 8, is_host: false, is_bot: true }, timestamp: { absolute: iso(h.now() + 60 * SEC) } },
        },
      },
      'realtime',
    );
    expect(notetaker.ok && notetaker.payload.participant).toStrictEqual({ id: null, is_host: false, is_bot: true });
    // Delivered exactly as the receiver wrote it.
    const written = notetaker.ok ? notetaker.payload.participant! : { id: 8, is_bot: true };
    h.advance(60 * SEC);
    const flagged: Delivery = { participantId: written.id, isBot: written.is_bot };
    expect(await deliver(h, b, 'participant_events.join', flagged)).toEqual(done('ignored', 'bot_participant'));
    expect(h.requests).toEqual([]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', ticket_arms: 0 });
    // The candidate arms; a second flagged bot after the candidate is not a second human either.
    expect(await deliver(h, b, 'participant_events.join', { participantId: CANDIDATE })).toEqual(done('processed', 'armed'));
    expect(await deliver(h, b, 'participant_events.join', flagged)).toEqual(done('ignored', 'bot_participant'));
    expect(h.db.jobs('multi_human_check')).toEqual([]);
    reset(h);
    expect(await check(h, b)).toEqual(done('ignored', 'one_human'));
    expectNoPii(h);
  });

  it('the same lone marked join before the bot is in the call (no bound): the bot\'s own, ignored', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.advance(120 * SEC);
    expect(await deliver(h, b, 'participant_events.join', marked(NAME_ALIKE))).toEqual(done('ignored', 'bot_participant'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', ticket_arms: 0 });
    // A real person is still seen through bot.in_call_recording.
    expect(await deliver(h, b, 'bot.in_call_recording')).toEqual(done('processed', 'armed'));
  });

  it('a marked join with a null id: ignored, no Recall call, no arm', async () => {
    const h = world();
    const b = await inCall(h);
    h.advance(120 * SEC);
    expect(await deliver(h, b, 'participant_events.join', marked(null))).toEqual(done('ignored', 'bot_participant'));
    expect(h.requests).toEqual([]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', ticket_arms: 0 });
    expect(h.db.jobs('multi_human_check')).toEqual([]);
  });

  it('Recall down at the bound of a marked join: deferred before any write; the re-run decides', async () => {
    const h = world();
    const b = await inCall(h);
    h.advance(120 * SEC);
    const payload = event(h, b, 'participant_events.join', marked(NAME_ALIKE));
    h.intercept('get', { status: 503 });
    expect(await run(h, payload)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(steps(h)).toEqual(['recall:get']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', reason: 'eligible', ticket_arms: 0 });
    expect(h.alerts()).toEqual([]);
    // Past the deferral bound: thrown, still before any write.
    h.intercept('get', 'network');
    await expect(run(h, payload, h.meta({ deferCount: 30, deferredAt: iso(h.now()) }))).rejects.toThrow('r1_meet_recall_network');
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', ticket_arms: 0 });
    // Recall answers: a mark 120 s after the bot got in is a person (counted, never an arm).
    expect(await run(h, payload, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }))).toEqual(
      done('ignored', 'marked_participant'),
    );
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', ticket_arms: 0 });
  });

  it('Recall no longer knows the bot (404 at the bound): no bound, so the earliest marked join is the bot\'s', async () => {
    const h = world();
    const b = await inCall(h);
    h.advance(120 * SEC);
    h.intercept('get', { status: 404 });
    expect(await deliver(h, b, 'participant_events.join', marked(NAME_ALIKE))).toEqual(done('ignored', 'bot_participant'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'bot_joining', ticket_arms: 0 });
    expect(h.alerts()).toEqual([]);
  });

  it('Recall down at the recount of a candidate\'s join: no throw, the arm still happens, the count had no bound', async () => {
    /** The bot in the call at T0, a marked join durable at T0+60 s (not run), the candidate at T0+60 s. */
    const setUp = async (h: R1MeetHarness) => {
      const b = await inCall(h);
      h.advance(60 * SEC);
      event(h, b, 'participant_events.join', marked(NAME_ALIKE));
      return { b, candidate: event(h, b, 'participant_events.join', { participantId: CANDIDATE }) };
    };
    const h = world();
    const { b, candidate } = await setUp(h);
    h.intercept('get', { status: 503 });
    expect(await run(h, candidate)).toEqual(done('processed', 'armed'));
    expect(steps(h)).toEqual([
      'db:transition:human_present',
      'recall:get',
      'recall:get',
      'db:arm_ticket',
      'queue:bridge_check',
      'recall:output_media',
    ]);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', ticket_arms: 1 });
    // No bound: the earliest marked join counted as the bot's, so one human and no recount.
    expect(h.db.jobs('multi_human_check')).toEqual([]);
    expect(h.alerts()).toEqual([]);

    // The same call with Recall up: the mark came 60 s after the bot got in, so two people, one recount.
    const up = world();
    const other = await setUp(up);
    expect(await run(up, other.candidate)).toEqual(done('processed', 'armed'));
    expect(up.db.jobs('multi_human_check')).toHaveLength(1);
  });

  it('attempt_ended: the bot\'s own join and a candidate who left: nobody to interview, failed/no_show (not a re-arm)', async () => {
    const h = world();
    // In the call from T0 (`in_call_recording`), an attempt bound, then failed and not counted.
    const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
    h.db.addAttempt({ session_id: b.sessionId!, round_id: b.roundId, outcome: 'provider_error', counted: false });
    event(h, b, 'participant_events.join', marked(BOT));
    event(h, b, 'participant_events.join', { participantId: CANDIDATE });
    event(h, b, 'participant_events.leave', { participantId: CANDIDATE });
    const payload = { kind: 'attempt_ended', booking_id: b.id, session_id: b.sessionId };

    // Recall down at the bound: deferred before any write.
    h.intercept('get', { status: 503 });
    expect(await runJob(h, r1MeetAttemptEndedDefinition, payload)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(steps(h)).toEqual(['recall:get']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'in_call', recall_bot_id: b.botId, ticket_arms: 1 });

    reset(h);
    expect(await runJob(h, r1MeetAttemptEndedDefinition, payload, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }))).toEqual(
      done('processed', 'failed_no_show'),
    );
    expect(steps(h)).toEqual(['recall:get', 'recall:get', 'recall:leave', 'db:transition:failed', 'db:set_bot:release']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null, ticket_arms: 1 });
  });

  // The known limit of a missed own join (PR #449 fix check, S09-R4 round 2; M034 behaviour, the
  // `markedJoin` docstring and contracts §9): it never STARTS the bridge (above), but it is counted
  // as a person wherever `countHumans` runs, until the live spike S0c settles the bound.
  it('known limit: the bot\'s own join past the bound still counts, so attempt_ended re-arms in an empty call (not failed/no_show)', async () => {
    const h = world();
    // In the call from T0 (`in_call_recording`), an attempt bound, then failed and not counted.
    const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
    h.db.addAttempt({ session_id: b.sessionId!, round_id: b.roundId, outcome: 'provider_error', counted: false });
    // Reported 20 s after the bot got in (a listing lag): past the 15 s bound, so not the bot's own.
    h.advance(20 * SEC);
    event(h, b, 'participant_events.join', marked(BOT));
    event(h, b, 'participant_events.join', { participantId: CANDIDATE });
    event(h, b, 'participant_events.leave', { participantId: CANDIDATE });
    const payload = { kind: 'attempt_ended', booking_id: b.id, session_id: b.sessionId };
    expect(await runJob(h, r1MeetAttemptEndedDefinition, payload)).toEqual(done('processed', 'rearmed'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'in_call', recall_bot_id: b.botId, ticket_arms: 2 });
    expect(outputMedia(h)).toHaveLength(1);
    expectNoPii(h);
  });

  it('known limit: the bot\'s own join past the bound and one candidate are two humans; policy end ends the call', async () => {
    const h = world();
    const b = await inCall(h);
    h.advance(20 * SEC);
    expect(await deliver(h, b, 'participant_events.join', marked(BOT))).toEqual(done('ignored', 'marked_participant'));
    expect(await deliver(h, b, 'participant_events.join', { participantId: CANDIDATE })).toEqual(done('processed', 'armed'));
    expect(h.db.jobs('multi_human_check')).toHaveLength(1);
    h.advance(120 * SEC);
    reset(h);
    expect(await check(h, b)).toEqual(done('processed', 'multiple_humans'));
    expect(h.alerts()).toEqual(['r1_meet_multiple_humans']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'multiple_humans', recall_bot_id: null });
    expectNoPii(h);
  });

  it('multi_human_check: the bot\'s own join and one candidate is one human; Recall down there defers', async () => {
    const h = world();
    const b = await inCall(h);
    expect(await deliver(h, b, 'participant_events.join', marked(BOT))).toEqual(done('ignored', 'bot_participant'));
    expect(await deliver(h, b, 'participant_events.join', { participantId: CANDIDATE })).toEqual(done('processed', 'armed'));
    reset(h);
    expect(await check(h, b)).toEqual(done('ignored', 'one_human'));
    expect(steps(h)).toEqual(['recall:get']);
    h.intercept('get', { status: 503 });
    expect(await check(h, b)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(h.db.booking(b.id)).toMatchObject({ status: 'human_present', recall_bot_id: b.botId });
    expect(h.alerts()).toEqual([]);
  });
});

// ── attempt_ended (D-S06-29) ────────────────────────────────────────────────

describe('attempt_ended (D-S06-29)', () => {
  const payloadOf = (b: Booked, sessionId = b.sessionId!) => ({ kind: 'attempt_ended', booking_id: b.id, session_id: sessionId });
  const ended = (h: R1MeetHarness, b: Booked, meta?: R1MeetJobMeta, sessionId?: string) =>
    runJob(h, r1MeetAttemptEndedDefinition, payloadOf(b, sessionId), meta ?? h.meta());
  /** What `r1_settle_attempt` leaves for the bound session (the route queues this job after it). */
  const settle = (h: R1MeetHarness, b: Booked, outcome: string | null = 'complete', counted = outcome === 'complete') =>
    h.db.addAttempt({ session_id: b.sessionId!, round_id: b.roundId, outcome, counted });

  it.each(['in_progress', 'completed', 'failed', 'created'])(
    'counted: leave -> completed/attempt_settled -> release, whatever the session says (%s)',
    async (sessionStatus) => {
      const h = world();
      const b = await booked(h, 'in_call_session', { sessionStatus });
      settle(h, b);
      expect(await ended(h, b)).toEqual(done('processed', 'completed'));
      expect(steps(h)).toEqual(['recall:get', 'recall:leave', 'db:transition:completed', 'db:set_bot:release']);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'completed', reason: 'attempt_settled', recall_bot_id: null });
      expect(h.alerts()).toEqual([]);
      expectNoPii(h);
    },
  );

  it('another session (the round restarted and re-bound): ignored, no Recall call', async () => {
    const h = world();
    const b = await booked(h, 'in_call_session');
    expect(await ended(h, b, undefined, fixtureId())).toEqual(done('ignored', 'other_session'));
    expect(h.requests).toEqual([]);
  });

  it('a terminal booking whose bot is released: ignored; a gone booking: ignored', async () => {
    const h = world();
    const b = await booked(h, 'in_call_session');
    settle(h, b);
    expect(await ended(h, b)).toEqual(done('processed', 'completed'));
    reset(h);
    expect(await ended(h, b)).toEqual(done('ignored', 'booking_terminal'));
    expect(await runJob(h, r1MeetAttemptEndedDefinition, { ...payloadOf(b), booking_id: fixtureId() })).toEqual(
      done('ignored', 'booking_gone'),
    );
    expect(h.requests).toEqual([]);
  });

  it('a booking already failed (another job ended the call) but still holding the bot: the release is finished', async () => {
    const h = world();
    const b = await booked(h, 'in_call_session');
    expect((await h.db.store.transition({ bookingId: b.id, from: 'in_call', to: 'failed', reason: 'multiple_humans', nowIso: iso(h.now()) })).status).toBe('ok');
    expect(await ended(h, b)).toEqual(done('processed', 'released_left'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'multiple_humans', recall_bot_id: null });
  });

  it('Recall down: deferred within the bound; past it the job throws (DLQ, maintenance re-drives)', async () => {
    const h = world();
    const b = await booked(h, 'in_call_session');
    settle(h, b);
    h.intercept('get', 'network');
    expect(await ended(h, b)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(h.db.booking(b.id)).toMatchObject({ status: 'in_call' });
    h.intercept('get', 'network');
    await expect(ended(h, b, h.meta({ deferCount: 30, deferredAt: iso(h.now()) }))).rejects.toThrow('r1_meet_recall_network');
    h.intercept('get', { status: 401 });
    expect(await ended(h, b)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_rejected' });
    expect(h.alerts()).toContain('r1_meet_recall_rejected');
    expect(h.db.booking(b.id)).toMatchObject({ status: 'in_call', recall_bot_id: b.botId });
  });

  describe('an attempt that did not count (PR #444 review S06-R1)', () => {
    const round = (h: R1MeetHarness, b: Booked) => h.db.tables.interview_rounds.find((row) => row.id === b.roundId)!;
    /** The candidate (participant 1) is in the call: a durable participant join of this bot. */
    const candidateIn = (h: R1MeetHarness, b: Booked) => event(h, b, 'participant_events.join', { participantId: 1 });

    it.each(['provider_error', 'shutdown_forced', 'configuration_failed', 'context_failed', 'no_show', 'candidate_left'])(
      '%s with a start left and the candidate in the call: re-armed, never completed, the bot stays',
      async (outcome) => {
        const h = world();
        const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
        settle(h, b, outcome, false);
        candidateIn(h, b);
        expect(await ended(h, b)).toEqual(done('processed', 'rearmed'));
        expect(steps(h)).toEqual(['recall:get', 'db:arm_ticket', 'queue:bridge_check', 'recall:output_media']);
        expect(recallOps(h)).not.toContain('leave');
        const ticket = lastTicket(h);
        expect(h.db.booking(b.id)).toMatchObject({
          status: 'in_call',
          reason: 'eligible',
          recall_bot_id: b.botId,
          session_id: b.sessionId,
          ticket_arms: 2,
          ticket_claimed_at: null,
          ticket_digest: digestOf(ticket),
        });
        expect(h.db.jobs('bridge_check').map((job) => job.payload.arm)).toContain(2);
        expect(h.hot.length).toBeGreaterThan(0);
        expect(h.alerts()).toEqual([]);
        expectNoPii(h, ticket, digestOf(ticket));
        // The page claims the new ticket; S05 admits a new attempt and re-binds: this outcome is over.
        expect((await h.db.claimTicket(ticket, iso(h.now()), BRIDGE_SOURCE)).data).toMatchObject({ status: 'ok' });
        const next = h.db.addSession({ interview_round_id: b.roundId, status: 'in_progress' });
        expect((await h.db.bind(b.id, next.id as string, iso(h.now()))).data).toMatchObject({ status: 'ok' });
        reset(h);
        expect(await ended(h, b)).toEqual(done('ignored', 'other_session'));
        expect(h.requests).toEqual([]);
      },
    );

    it('nobody left in the call: leave, failed/no_show (not completed), release', async () => {
      const h = world();
      const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
      settle(h, b, 'provider_error', false);
      candidateIn(h, b);
      event(h, b, 'participant_events.leave', { participantId: 1 });
      expect(await ended(h, b)).toEqual(done('processed', 'failed_no_show'));
      expect(steps(h)).toEqual(['recall:get', 'recall:leave', 'db:transition:failed', 'db:set_bot:release']);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null, ticket_arms: 1 });
    });

    it('the round has no start left or lapsed, the window closed or the arms are spent: leave, failed/bot_fatal', async () => {
      const cases: Array<[string, (h: R1MeetHarness, b: Booked) => void]> = [
        ['starts', (h, b) => {
          round(h, b).starts_used = 3;
        }],
        ['round_lapsed', (h, b) => {
          round(h, b).status = 'expired';
        }],
        ['window', (h, b) => {
          h.setNow(Date.parse(b.startAt) + 45 * MIN + 15 * MIN);
        }],
        ['arms', (h, b) => {
          h.db.booking(b.id)!.ticket_arms = 5;
        }],
      ];
      for (const [name, setUp] of cases) {
        const h = world();
        const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
        settle(h, b, 'provider_error', false);
        candidateIn(h, b);
        setUp(h, b);
        expect(await ended(h, b), name).toEqual(done('processed', 'failed_bot_fatal'));
        expect(steps(h), name).toEqual(['recall:get', 'recall:leave', 'db:transition:failed', 'db:set_bot:release']);
        expect(h.db.booking(b.id), name).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: null });
      }
    });

    it('the round has all its counted attempts (an earlier attempt counted): completed', async () => {
      const h = world();
      const b = await booked(h, 'in_call_session', { sessionStatus: 'completed' });
      settle(h, b, 'complete', false);
      candidateIn(h, b);
      round(h, b).attempts_counted = round(h, b).attempts_allowed;
      expect(await ended(h, b)).toEqual(done('processed', 'completed'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'completed', reason: 'attempt_settled', recall_bot_id: null });
    });

    it('the bot already left the call: the arm finds it ended, so the booking fails no_show', async () => {
      const h = world();
      const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
      settle(h, b, 'provider_error', false);
      candidateIn(h, b);
      h.recall.setStatus(b.botId, 'call_ended');
      expect(await ended(h, b)).toEqual(done('processed', 'failed_no_show'));
      expect(recallOps(h)).toEqual(['get', 'get']);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
    });

    it('a second job for the same ended session while the re-arm is out: left to its bridge check, then re-armed', async () => {
      const h = world();
      const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
      settle(h, b, 'provider_error', false);
      candidateIn(h, b);
      expect(await ended(h, b)).toEqual(done('processed', 'rearmed'));
      reset(h);
      // Maintenance (a fresh job) within the re-arm's bridge-check horizon: nothing.
      h.advance(200 * SEC);
      expect(await ended(h, b)).toEqual(done('ignored', 'rearm_pending'));
      expect(h.requests).toEqual([]);
      // Past the horizon nothing claimed it: one more arm (still bounded by the five).
      h.advance(46 * SEC);
      expect(await ended(h, b)).toEqual(done('processed', 'rearmed'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'in_call', ticket_arms: 3 });
    });

    it('a re-run of the same job (its output_media deferred) re-arms once the arm is 20 s old', async () => {
      const h = world();
      const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
      settle(h, b, 'provider_error', false);
      candidateIn(h, b);
      for (let i = 0; i < 4; i += 1) h.intercept('output_media', { status: 503 });
      expect(await ended(h, b)).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable', delaySeconds: 20 });
      expect(h.sleeps).toEqual([2 * SEC, 4 * SEC, 8 * SEC]);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'in_call', ticket_arms: 2 });
      const rerun = (): R1MeetJobMeta => h.meta({ deferCount: 1, deferredAt: iso(h.now()) });
      // The in-run retries took 14 s; 5 s more is still inside the 20 s.
      h.advance(5 * SEC);
      expect(await ended(h, b, rerun())).toEqual(done('ignored', 'rearm_pending'));
      h.advance(SEC);
      expect(await ended(h, b, rerun())).toEqual(done('processed', 'rearmed'));
      expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 3 });
    });

    describe('not settled yet', () => {
      it('waits for the worker outcome (30 s, at most 4 times); an outcome that lands meanwhile decides', async () => {
        const h = world();
        const b = await booked(h, 'in_call_session', { sessionStatus: 'failed' });
        candidateIn(h, b);
        expect(await ended(h, b)).toEqual(deferred('outcome_pending', 30));
        expect(await ended(h, b, h.meta({ deferCount: 3, deferredAt: iso(h.now()) }))).toEqual(deferred('outcome_pending', 30));
        // A row with no outcome is not settled either.
        const attempt = settle(h, b, null, false);
        expect(await ended(h, b, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }))).toEqual(deferred('outcome_pending', 30));
        expect(h.requests).toEqual([]);
        Object.assign(attempt, { outcome: 'complete', counted: true });
        expect(await ended(h, b, h.meta({ deferCount: 2, deferredAt: iso(h.now()) }))).toEqual(done('processed', 'completed'));
      });

      it.each([
        ['completed', 'processed', 'completed', 'completed'],
        ['failed', 'processed', 'rearmed', 'in_call'],
        ['expired', 'processed', 'rearmed', 'in_call'],
        ['in_progress', 'ignored', 'session_live', 'in_call'],
      ] as const)('after the waits, a session that is %s decides', async (sessionStatus, receipt, code, status) => {
        const h = world();
        const b = await booked(h, 'in_call_session', { sessionStatus });
        candidateIn(h, b);
        expect(await ended(h, b, h.meta({ deferCount: 4, deferredAt: iso(h.now()) }))).toEqual(done(receipt, code));
        expect(h.db.booking(b.id)).toMatchObject({ status });
      });
    });
  });

  describe('kill points (plan 2.5, outcome: GET -> leave | completed | release)', () => {
    it('after the leave (its answer lost): the re-run finds the bot ended and completes', async () => {
      const h = world();
      const b = await booked(h, 'in_call_session');
      settle(h, b);
      h.intercept('leave', 'lost');
      expect(await ended(h, b)).toMatchObject({ outcome: 'defer' });
      expect(await ended(h, b, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }))).toEqual(done('processed', 'completed'));
      expect(recallOps(h)).toEqual(['get', 'leave', 'get']);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'completed', recall_bot_id: null });
    });

    it('after the move (its answer lost): the re-run finishes the release', async () => {
      const h = world();
      const b = await booked(h, 'in_call_session');
      settle(h, b);
      h.db.failNext('r1_meet_transition_booking', 'lost');
      await expect(ended(h, b)).rejects.toThrow('r1_meet_db_error');
      expect(h.db.booking(b.id)).toMatchObject({ status: 'completed', recall_bot_id: b.botId });
      expect(await ended(h, b, h.meta({ attempts: 2 }))).toEqual(done('processed', 'released_ended'));
      expect(h.db.booking(b.id)).toMatchObject({ status: 'completed', recall_bot_id: null });
    });

    it('after the release mark (its answer lost): the re-run is a no-op', async () => {
      const h = world();
      const b = await booked(h, 'in_call_session');
      settle(h, b);
      h.db.failNext('r1_meet_set_bot', 'lost');
      await expect(ended(h, b)).rejects.toThrow('r1_meet_db_error');
      reset(h);
      expect(await ended(h, b, h.meta({ attempts: 2 }))).toEqual(done('ignored', 'booking_terminal'));
      expect(h.requests).toEqual([]);
      expect(h.db.booking(b.id)).toMatchObject({ status: 'completed', recall_bot_id: null });
    });
  });
});

// ── decideBridgeCheck (D-S06-27) ────────────────────────────────────────────

describe('decideBridgeCheck (D-S06-27)', () => {
  const NOW = Date.parse('2030-01-01T10:00:00.000Z');
  const BOT = '7f000000-0000-4000-8000-0000000000aa';
  type BookingFacts = NonNullable<R1MeetBridgeCheckFacts['booking']>;
  const facts = (booking: Partial<BookingFacts> = {}, rest: Partial<R1MeetBridgeCheckFacts> = {}): R1MeetBridgeCheckFacts => ({
    booking: {
      status: 'human_present',
      version: 2,
      recallBotId: BOT,
      ticketArms: 1,
      ticketNotBefore: iso(NOW - 10 * MIN),
      ticketClaimedAt: null,
      sessionId: null,
      endAt: iso(NOW + 30 * MIN),
      ...booking,
    },
    check: { version: 2, arm: 1 },
    sessionStatus: null,
    armedAtMs: NOW - 45 * SEC,
    nowMs: NOW,
    ...rest,
  });
  const SESSION = '7f000000-0000-4000-8000-0000000000bb';

  it('done: no booking, another generation, another arm, no live bot', () => {
    expect(decideBridgeCheck(facts({}, { booking: null }))).toEqual({ action: 'done', code: 'booking_gone' });
    expect(decideBridgeCheck(facts({ version: 3 }))).toEqual({ action: 'done', code: 'generation_changed' });
    expect(decideBridgeCheck(facts({ ticketArms: 2 }))).toEqual({ action: 'done', code: 'superseded' });
    for (const status of ['completed', 'cancelled', 'failed', 'drained', 'pending', 'blocked', 'unmatched_application', 'unmapped_scheduler'] as const) {
      expect(decideBridgeCheck(facts({ status })), status).toEqual({ action: 'done', code: 'booking_not_live' });
    }
    expect(decideBridgeCheck(facts({ recallBotId: null }))).toEqual({ action: 'done', code: 'booking_not_live' });
  });

  it('done: the window closed (end + 15 min), not a millisecond before', () => {
    const end = NOW + 30 * MIN;
    const at = (nowMs: number) => decideBridgeCheck(facts({}, { nowMs, armedAtMs: nowMs - 300 * SEC }));
    expect(at(end + 15 * MIN)).toEqual({ action: 'done', code: 'window_closed' });
    expect(at(end + 15 * MIN - 1)).toEqual({ action: 'rearm', code: 'unclaimed' });
  });

  it('done: the bound session is in progress, or ended', () => {
    const claimed = { ticketClaimedAt: iso(NOW - 600 * SEC), sessionId: SESSION, status: 'in_call' as const };
    expect(decideBridgeCheck(facts(claimed, { sessionStatus: 'in_progress' }))).toEqual({ action: 'done', code: 'session_in_progress' });
    for (const status of ['completed', 'failed', 'cancelled', 'expired'] as const) {
      expect(decideBridgeCheck(facts(claimed, { sessionStatus: status })), status).toEqual({ action: 'done', code: 'session_ended' });
    }
    // An in-progress session after a re-arm (ticket unclaimed again) is still done.
    expect(decideBridgeCheck(facts({ ...claimed, ticketClaimedAt: null }, { sessionStatus: 'in_progress' }))).toEqual({
      action: 'done',
      code: 'session_in_progress',
    });
  });

  it('an ended session with an UNCLAIMED ticket (a re-arm after it ended) follows the unclaimed rule (S06-R1)', () => {
    const rearmed = { ticketClaimedAt: null, sessionId: SESSION, status: 'in_call' as const, ticketArms: 2 };
    for (const status of ['completed', 'failed', 'cancelled', 'expired'] as const) {
      expect(decideBridgeCheck(facts(rearmed, { sessionStatus: status, check: { version: 2, arm: 2 } })), status).toEqual({
        action: 'recheck',
        code: 'unclaimed',
        delaySeconds: 155,
      });
      expect(
        decideBridgeCheck(facts(rearmed, { sessionStatus: status, check: { version: 2, arm: 2 }, armedAtMs: NOW - 200 * SEC })),
        status,
      ).toEqual({ action: 'rearm', code: 'unclaimed' });
    }
    expect(
      decideBridgeCheck(facts({ ...rearmed, ticketArms: 5 }, { sessionStatus: 'failed', check: { version: 2, arm: 5 }, armedAtMs: NOW - 200 * SEC })),
    ).toEqual({ action: 'give_up', code: 'arms_exhausted' });
  });

  it('unclaimed: rearm at 200 s after the arm, recheck before (landing on the threshold)', () => {
    expect(decideBridgeCheck(facts())).toEqual({ action: 'recheck', code: 'unclaimed', delaySeconds: 155 });
    expect(decideBridgeCheck(facts({}, { armedAtMs: NOW - 199_001 }))).toEqual({ action: 'recheck', code: 'unclaimed', delaySeconds: 1 });
    expect(decideBridgeCheck(facts({}, { armedAtMs: NOW - 200 * SEC }))).toEqual({ action: 'rearm', code: 'unclaimed' });
    // The page cannot claim before the window opens: counted from the opening when that is later.
    expect(decideBridgeCheck(facts({ ticketNotBefore: iso(NOW - 100 * SEC) }, { armedAtMs: NOW - 300 * SEC }))).toEqual({
      action: 'recheck',
      code: 'unclaimed',
      delaySeconds: 100,
    });
  });

  it('claimed with no session: rearm at 45 s after the claim', () => {
    const claimedAt = (ms: number) => facts({ status: 'in_call', ticketClaimedAt: iso(NOW - ms) });
    expect(decideBridgeCheck(claimedAt(44 * SEC))).toEqual({ action: 'recheck', code: 'claimed_no_session', delaySeconds: 1 });
    expect(decideBridgeCheck(claimedAt(10 * SEC))).toEqual({ action: 'recheck', code: 'claimed_no_session', delaySeconds: 35 });
    expect(decideBridgeCheck(claimedAt(45 * SEC))).toEqual({ action: 'rearm', code: 'claimed_no_session' });
    // A bound session whose row is gone counts as no session.
    expect(decideBridgeCheck(facts({ status: 'in_call', ticketClaimedAt: iso(NOW - 45 * SEC), sessionId: SESSION }))).toEqual({
      action: 'rearm',
      code: 'claimed_no_session',
    });
  });

  it('claimed with a session still created / waiting: rearm at 200 s after the claim', () => {
    for (const status of ['created', 'waiting'] as const) {
      const at = (ms: number) => facts({ status: 'in_call', ticketClaimedAt: iso(NOW - ms), sessionId: SESSION }, { sessionStatus: status });
      expect(decideBridgeCheck(at(199 * SEC)), status).toEqual({ action: 'recheck', code: 'session_not_started', delaySeconds: 1 });
      expect(decideBridgeCheck(at(200 * SEC)), status).toEqual({ action: 'rearm', code: 'session_not_started' });
    }
  });

  it('five arms spent: a rearm becomes a give-up; a recheck stays a recheck', () => {
    expect(decideBridgeCheck(facts({ ticketArms: 5 }, { check: { version: 2, arm: 5 }, armedAtMs: NOW - 200 * SEC }))).toEqual({
      action: 'give_up',
      code: 'arms_exhausted',
    });
    expect(decideBridgeCheck(facts({ ticketArms: 4 }, { check: { version: 2, arm: 4 }, armedAtMs: NOW - 200 * SEC }))).toEqual({
      action: 'rearm',
      code: 'unclaimed',
    });
    expect(decideBridgeCheck(facts({ ticketArms: 5 }, { check: { version: 2, arm: 5 } }))).toEqual({
      action: 'recheck',
      code: 'unclaimed',
      delaySeconds: 155,
    });
  });

  it('a clock value that is not a number counts as now, never as long ago', () => {
    expect(decideBridgeCheck(facts({ ticketNotBefore: null }, { armedAtMs: Number.NaN }))).toEqual({
      action: 'recheck',
      code: 'unclaimed',
      delaySeconds: 200,
    });
  });
});

// ── bridge_check: the handler (D-S06-27) ────────────────────────────────────

describe('bridge_check: recheck, rearm and give-up', () => {
  const payloadOf = (b: Booked, arm: number, version = 0) => ({ kind: 'bridge_check', booking_id: b.id, version, arm });
  const check = (h: R1MeetHarness, b: Booked, arm: number, meta: R1MeetJobMeta) =>
    runJob(h, r1MeetBridgeCheckDefinition, payloadOf(b, arm), meta);

  /** Human present and armed (arm 1) at `armedAt`. */
  async function armed(h: R1MeetHarness): Promise<{ b: Booked; armedAt: number }> {
    const b = await booked(h, 'bot_joining');
    const armedAt = h.now();
    expect(await deliver(h, b, 'bot.in_call_recording')).toEqual(done('processed', 'armed'));
    reset(h);
    return { b, armedAt };
  }

  it('at 45 s an unclaimed ticket is rechecked at the 200 s mark', async () => {
    const h = world();
    const { b, armedAt } = await armed(h);
    h.advance(45 * SEC);
    expect(await check(h, b, 1, metaAt(armedAt))).toEqual(deferred('bridge_recheck', 155));
    expect(h.requests).toEqual([]);
    expect(h.hot).toContain(h.now() + 5 * MIN);
  });

  it('the recheck bound: at most 10 rechecks', async () => {
    const h = world();
    const { b, armedAt } = await armed(h);
    h.advance(45 * SEC);
    expect(await check(h, b, 1, metaAt(armedAt, { deferCount: 10, deferredAt: iso(armedAt) }))).toEqual(
      done('ignored', 'recheck_limit'),
    );
  });

  it('unclaimed for 200 s: a fresh ticket is armed and posted, with its own check', async () => {
    const h = world();
    const { b, armedAt } = await armed(h);
    h.advance(200 * SEC);
    expect(await check(h, b, 1, metaAt(armedAt, { deferCount: 1, deferredAt: iso(armedAt + 45 * SEC) }))).toEqual(
      done('processed', 'armed'),
    );
    expect(steps(h)).toEqual(['recall:get', 'db:arm_ticket', 'queue:bridge_check', 'recall:output_media']);
    expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 2, ticket_digest: digestOf(lastTicket(h)) });
    expect(h.db.jobs('bridge_check').map((job) => job.payload.arm)).toEqual([1, 2]);
    expectNoPii(h, lastTicket(h));
  });

  it('claimed with no session for 45 s: re-armed, the claim reset, still in the call', async () => {
    const h = world();
    const b = await booked(h, 'in_call');
    const claimedAt = h.now();
    h.advance(45 * SEC);
    expect(await check(h, b, 1, metaAt(claimedAt - SEC))).toEqual(done('processed', 'armed'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'in_call', ticket_arms: 2, ticket_claimed_at: null });
  });

  it('a newer arm or the session in progress: done, nothing sent', async () => {
    const h = world();
    const { b, armedAt } = await armed(h);
    h.advance(200 * SEC);
    expect(await check(h, b, 1, metaAt(armedAt))).toEqual(done('processed', 'armed'));
    reset(h);
    expect(await check(h, b, 1, metaAt(armedAt))).toEqual(done('ignored', 'superseded'));
    expect(await runJob(h, r1MeetBridgeCheckDefinition, payloadOf(b, 2, 1), metaAt(armedAt))).toEqual(
      done('ignored', 'generation_changed'),
    );
    const s = await booked(h, 'in_call_session');
    h.advance(10 * MIN);
    expect(await check(h, s, 1, metaAt(h.now() - 10 * MIN))).toEqual(done('ignored', 'session_in_progress'));
    expect(h.requests).toEqual([]);
  });

  it('claimed, and its session ended (before it ran): done, and that session goes to attempt_ended at once', async () => {
    const h = world();
    const b = await booked(h, 'in_call_session', { sessionStatus: 'expired' });
    h.advance(45 * SEC);
    expect(await check(h, b, 1, metaAt(h.now() - 45 * SEC))).toEqual(done('ignored', 'session_ended'));
    expect(h.requests).toEqual([]);
    expect(h.db.jobs('attempt_ended')).toEqual([
      expect.objectContaining({
        payload: { kind: 'attempt_ended', booking_id: b.id, session_id: b.sessionId },
        dedup_key: `r1-meet:attempt-ended:${b.sessionId}`,
      }),
    ]);
    // The outcome route queues the same key: still one job.
    expect(await check(h, b, 1, metaAt(h.now() - 45 * SEC))).toEqual(done('ignored', 'session_ended'));
    expect(h.db.jobs('attempt_ended')).toHaveLength(1);
  });

  /** Spend all five arms (human present), the last one unclaimed or claimed. */
  async function exhausted(h: R1MeetHarness, claim: boolean): Promise<{ b: Booked; armedAt: number }> {
    const { b } = await armed(h);
    for (let arm = 2; arm <= 5; arm += 1) {
      h.advance(30 * SEC);
      expect(await armBridge(h.deps, (await h.db.store.getBooking(b.id))!, h.meta())).toMatchObject({ code: 'armed' });
    }
    const armedAt = h.now();
    if (claim) expect((await h.db.claimTicket(lastTicket(h), iso(h.now()), BRIDGE_SOURCE)).data).toMatchObject({ status: 'ok' });
    expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 5 });
    reset(h);
    return { b, armedAt };
  }

  it('five arms spent, still unclaimed: give up, leave, failed/bot_fatal, release', async () => {
    const h = world();
    const { b, armedAt } = await exhausted(h, false);
    h.advance(200 * SEC);
    expect(await check(h, b, 5, metaAt(armedAt))).toEqual(done('processed', 'bridge_gave_up'));
    expect(h.logs).toContainEqual({ level: 'error', meta: { error_category: 'r1_meet_bridge_gave_up', error_type: 'arms_exhausted' } });
    expect(steps(h)).toEqual(['recall:get', 'recall:leave', 'db:transition:failed', 'db:set_bot:release']);
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'bot_fatal', recall_bot_id: null });
  });

  it('five arms spent, claimed with no session: give up from in_call as failed/admission_refused', async () => {
    const h = world();
    const { b, armedAt } = await exhausted(h, true);
    h.advance(45 * SEC);
    expect(await check(h, b, 5, metaAt(armedAt))).toEqual(done('processed', 'bridge_gave_up'));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'admission_refused', recall_bot_id: null });
  });

  it('kill point: a give-up whose release mark failed is finished by its re-run', async () => {
    const h = world();
    const { b, armedAt } = await exhausted(h, false);
    h.advance(200 * SEC);
    h.db.failNext('r1_meet_set_bot');
    await expect(check(h, b, 5, metaAt(armedAt))).rejects.toThrow('r1_meet_db_error');
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', recall_bot_id: b.botId });
    reset(h);
    expect(await check(h, b, 5, metaAt(armedAt, { attempts: 2 }))).toEqual(done('processed', 'released_ended'));
    expect(recallOps(h)).toEqual(['get']);
    expect(h.db.booking(b.id)).toMatchObject({ recall_bot_id: null });
  });
});

// ── Kill points of the arm (plan 2.5) ───────────────────────────────────────

describe('kill points of the arm (transition | GET | arm | enqueue check | output_media)', () => {
  /** After every kill point the page Recall shows carries the ticket the booking holds, unclaimed. */
  function expectRecoverable(h: R1MeetHarness, b: Booked): void {
    const row = h.db.booking(b.id)!;
    expect(row).toMatchObject({ status: 'human_present', ticket_claimed_at: null });
    expect(row.ticket_digest).toBe(digestOf(lastTicket(h)));
    expect(h.recall.bots.get(b.botId)!.outputMedia).toBe('webpage');
    // The check of the current arm exists (a crash never leaves an arm unwatched).
    expect(h.db.jobs('bridge_check').map((job) => job.payload.arm)).toContain(row.ticket_arms);
  }

  async function killed(fail: (h: R1MeetHarness) => R1MeetFlowDeps | void, expectThrow: boolean) {
    const h = world();
    const b = await booked(h, 'bot_joining');
    const payload = event(h, b, 'bot.in_call_recording');
    const deps = fail(h) ?? h.deps;
    const first = runJob(h, r1MeetRecallEventDefinition, payload, h.meta(), deps);
    if (expectThrow) await expect(first).rejects.toThrow();
    else expect(await first).toMatchObject({ outcome: 'defer' });
    h.advance(60 * SEC);
    expect(await run(h, payload, h.meta({ attempts: 2, deferCount: expectThrow ? 0 : 1, deferredAt: iso(h.now()) }))).toEqual(
      done('processed', 'armed'),
    );
    expectRecoverable(h, b);
    return { h, b };
  }

  it('after the transition', async () => {
    const { h } = await killed((w) => w.db.failNext('r1_meet_transition_booking', 'lost'), true);
    expect(outputMedia(h)).toHaveLength(1);
  });

  it('after the GET (the arm never wrote)', async () => {
    const { h } = await killed((w) => w.db.failNext('r1_meet_arm_ticket'), true);
    expect(outputMedia(h)).toHaveLength(1);
    expect(h.db.tables.r1_meet_bookings[0]).toMatchObject({ ticket_arms: 1 });
  });

  it('after the arm', async () => {
    const { h } = await killed((w) => w.db.failNext('r1_meet_arm_ticket', 'lost'), true);
    expect(outputMedia(h)).toHaveLength(1);
  });

  it('after the bridge check was queued', async () => {
    const { h } = await killed((w) => {
      let killedOnce = false;
      return {
        ...w.deps,
        enqueue: async (spec, options) => {
          await w.deps.enqueue(spec, options);
          if (spec.payload.kind === 'bridge_check' && !killedOnce) {
            killedOnce = true;
            throw new Error('killed');
          }
        },
      };
    }, true);
    expect(outputMedia(h)).toHaveLength(1);
    expect(h.db.jobs('bridge_check').map((job) => job.payload.arm)).toEqual([1, 2]);
  });

  it('after output_media (two answers lost): the in-run retry posts the same page a third time, no new arm', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.intercept('output_media', 'lost');
    h.intercept('output_media', 'lost');
    expect(await deliver(h, b, 'bot.in_call_recording')).toEqual(done('processed', 'armed'));
    expect(outputMedia(h)).toHaveLength(3);
    expect(new Set(outputMedia(h).map(pageUrlOf)).size).toBe(1);
    expect(h.sleeps).toEqual([2 * SEC, 4 * SEC]);
    expect(h.db.booking(b.id)).toMatchObject({ ticket_arms: 1 });
    expectRecoverable(h, b);
  });

  it('after output_media (every in-run answer lost): the re-run posts a fresh page', async () => {
    const { h } = await killed((w) => {
      for (let i = 0; i < 4; i += 1) w.intercept('output_media', 'lost');
    }, false);
    // Four lost posts of arm 1 (the in-run retries), then the re-run's post of arm 2.
    expect(outputMedia(h)).toHaveLength(5);
    expect(new Set(outputMedia(h).slice(0, 4).map(pageUrlOf)).size).toBe(1);
    expect(pageUrlOf(outputMedia(h)[4]!)).not.toBe(pageUrlOf(outputMedia(h)[0]!));
  });

  it('a Recall outage of about five minutes at the human-present arm: five arms are enough (S06-R4)', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    const outageEndsAt = h.now() + 5 * MIN;
    // Recall answers output_media 503 until the outage ends; everything else works.
    const down = (): boolean => h.now() < outageEndsAt;
    for (let i = 0; i < 200; i += 1) {
      h.intercept((_req, op) => op === 'output_media' && down(), { status: 503 });
    }
    const payload = event(h, b, 'bot.in_call_recording');
    let meta = h.meta();
    let result = await run(h, payload, meta);
    let deferrals = 0;
    while (result.outcome === 'defer') {
      deferrals += 1;
      h.advance(result.delaySeconds * SEC);
      meta = h.meta({ attempts: 1, deferCount: deferrals, deferredAt: iso(h.now()) });
      result = await run(h, payload, meta);
    }
    expect(result).toEqual(done('processed', 'armed'));
    const row = h.db.booking(b.id)!;
    expect(row.ticket_arms).toBeLessThanOrEqual(5);
    expect(row.ticket_digest).toBe(digestOf(lastTicket(h)));
    expect(h.alerts()).toEqual([]);
  });
});

// ── Hot-window hints (D-S06-3) ──────────────────────────────────────────────

describe('hot-window hints (D-S06-3)', () => {
  it('every event of a live booking: 5 minutes; a booking joining: until 15 minutes after its start', async () => {
    const h = world();
    const b = await booked(h);
    await deliver(h, b, 'bot.joining_call');
    expect(h.hot).toContain(h.now() + 5 * MIN);
    expect(h.hot).toContain(Date.parse(b.startAt) + 15 * MIN);
    reset(h);
    h.advance(30 * SEC);
    await deliver(h, b, 'bot.in_waiting_room');
    expect(h.hot).toEqual([h.now() + 5 * MIN, Date.parse(b.startAt) + 15 * MIN]);
    reset(h);
    await deliver(h, b, 'participant_events.join');
    expect(h.hot).toEqual([h.now() + 5 * MIN, Date.parse(b.startAt) + 15 * MIN]);
    reset(h);
    await deliver(h, b, 'participant_events.leave');
    expect(h.hot).toEqual([h.now() + 5 * MIN]);
  });

  it('no hint for a terminal booking, a stray or a bot that is not ours', async () => {
    const h = world();
    const b = await booked(h, 'failed_owed');
    await deliver(h, b, 'bot.joining_call');
    await deliver(h, { id: fixtureId(), botId: fixtureId() }, 'bot.joining_call');
    await deliver(h, { id: fixtureId(), botId: fixtureId() }, 'bot.joining_call', { bookingId: null });
    expect(h.hot).toEqual([]);
  });

  it('flows without a lane (no hint port) work the same', async () => {
    const h = world();
    const b = await booked(h);
    const deps: R1MeetFlowDeps = { ...h.deps };
    delete (deps as { hotUntil?: unknown }).hotUntil;
    expect('hotUntil' in deps).toBe(false);
    expect(await runJob(h, r1MeetRecallEventDefinition, event(h, b, 'bot.joining_call'), h.meta(), deps)).toEqual(
      done('processed', 'bot_joining'),
    );
  });
});

// ── No PII anywhere (D-S06-33) ──────────────────────────────────────────────

describe('no PII in logs, payloads or errors', () => {
  it('a whole call: join, arm, a second human, the policy, our own leave, the release', async () => {
    const h = world();
    const b = await booked(h, 'bot_scheduled');
    await deliver(h, b, 'bot.joining_call');
    await deliver(h, b, 'participant_events.join', { participantId: 1 });
    const ticket = lastTicket(h);
    await deliver(h, b, 'participant_events.join', { participantId: 2 });
    h.advance(120 * SEC);
    await runJob(h, r1MeetMultiHumanCheckDefinition, { kind: 'multi_human_check', booking_id: b.id, version: 0 });
    await deliver(h, b, 'bot.call_ended', { subCode: 'bot_received_leave_call' }, h.meta({ deferCount: 1, deferredAt: iso(h.now()) }));
    expect(h.db.booking(b.id)).toMatchObject({ status: 'failed', reason: 'multiple_humans', recall_bot_id: null });
    expectNoPii(h, ticket, digestOf(ticket));
    // Every job S06 wrote here carries ids, kinds, counters and times only.
    for (const job of h.db.tables.job_queue) {
      if (job.payload.kind === 'recall_event') continue;
      for (const value of Object.values(job.payload as Row)) expect(['string', 'number']).toContain(typeof value);
    }
  });

  it('thrown errors carry a closed code and nothing else', async () => {
    const h = world();
    const b = await booked(h, 'bot_joining');
    h.db.failNext('r1_meet_transition_booking');
    const error = await deliver(h, b, 'bot.in_call_recording').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('r1_meet_db_error');
  });
});
