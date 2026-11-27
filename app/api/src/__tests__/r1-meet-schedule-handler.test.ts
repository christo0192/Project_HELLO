/**
 * M034 S06 T3: the booking side of the `r1-meet` runtime (lib/r1/meet/schedule-handler.ts), driven
 * through the REAL Recall client over the S01 fake and the in-memory 0142 port (T2 harness).
 *
 * Pinned (plan sections 2.4 and 2.5, D-S06-7..10 and 17..21):
 *  - every decision at both scopes, and every answer of the create and reschedule RPCs;
 *  - `p_attested_at` and `p_created_by` (the seam, the service user, none);
 *  - a move, more and less than 10 minutes ahead, in the exact order Recall release -> replace ->
 *    reschedule -> create -> attach, never a PATCH; a link-only change; the hold of a dispatched
 *    bot and the later revival; a move into the past touches nothing;
 *  - too far, initial and moved (failed -> revived blocked/slot_too_far, no URL in the re-run);
 *  - re-runs: only for the same reason, the ladder and its bounds, never past start - 15 min;
 *  - unschedule, cancel before and after dispatch, Recall down, the bound spent (owed release);
 *  - the reconcile (dex_absent vs event_removed, null lists, schedule scope, newer booking skipped,
 *    it runs even when the main action deferred or threw); superseded deliveries (numeric, `r`
 *    stamp, null updatedAt) but never by the same delivery;
 *  - the section 2.5 kill points for move, cancel and unschedule: the second run ends in the same
 *    state with one live bot at most; a duplicate job is a no-op;
 *  - `bot_release`, `round_cancelled`, `ensure_bot`;
 *  - (M035 S02) a public-page booking: `booking_rerun` answers `ignored('public_booking')` with no RPC,
 *    the three answers of the Ashby create RPC that name a booking refuse a public one, and an Ashby
 *    re-run sends the create RPC exactly the M034 arguments;
 *  - no id, URL, name or email in a log line, no Meet URL in a job S06 enqueues.
 */

import { describe, expect, it } from 'vitest';
import { ensureBot } from '../lib/r1/meet/bot-flow.js';
import { R1MeetJobError, type R1MeetJobMeta, type R1MeetJobResult } from '../lib/r1/meet/jobs.js';
import type { R1MeetJobDefinition } from '../lib/r1/meet/recall-actions.js';
import {
  R1_MEET_HOLD_DEFER_SEC,
  R1_MEET_SCHEDULE_DEFINITIONS,
  r1MeetAshbyScheduleDefinition,
  r1MeetBookingRerunDefinition,
  r1MeetBotReleaseDefinition,
  r1MeetEnsureBotDefinition,
  r1MeetRoundCancelledDefinition,
  worstR1MeetResult,
} from '../lib/r1/meet/schedule-handler.js';
import type { R1MeetCreateAnswer } from '../lib/r1/meet/runtime-store.js';
import type { Row } from './support/r1-meet-fake-db.js';
import {
  HARNESS_NOW,
  MEET_URL,
  OTHER_MEET_URL,
  SCHEDULER_ID,
  STAFF_USER_ID,
  createR1MeetHarness,
  fixtureId,
  type HarnessOptions,
  type R1MeetHarness,
} from './support/r1-meet-harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Ashby `updatedAt` stamps: strictly increasing through the file, always before the harness clock. */
let stampMs = Date.parse(HARNESS_NOW) - 6 * HOUR;
const nextStamp = (): string => iso((stampMs += 1000));

interface Ev {
  readonly eventId: string;
  readonly applicationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly meetUrl: string;
}

interface JobOverrides {
  readonly decision?: string;
  readonly updatedAt?: string | null;
  readonly receivedAt?: string | null;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly meetUrl?: string | null;
  readonly scheduledBy?: string | null;
  readonly scheduleEventIds?: readonly string[];
  readonly dexEventIds?: readonly string[];
}

const ENDED = new Set(['call_ended', 'done', 'fatal']);

async function runDef<T>(
  h: R1MeetHarness,
  definition: R1MeetJobDefinition<T>,
  payload: unknown,
  meta: R1MeetJobMeta = h.meta(),
): Promise<R1MeetJobResult> {
  const job = definition.parse(payload);
  if (job === null) throw new Error('test: the payload did not parse');
  return definition.run(h.deps, job, meta);
}

function world(options: HarnessOptions = {}) {
  const h = createR1MeetHarness(options);
  const scheduleId = fixtureId();
  /** Every event made here: a job's two lists default to all of them (each one keeps Dex). */
  const events: string[] = [];

  const reset = (): void => {
    h.timeline.length = 0;
    h.requests.length = 0;
    h.logs.length = 0;
  };

  /** A Dex event of this schedule for its own (linked) application. */
  const event = (startInMs = DAY, meetUrl = MEET_URL, durationMs = 45 * MINUTE): Ev => {
    const applicationId = fixtureId();
    h.db.linkApplication(applicationId, fixtureId());
    const start = h.now() + startInMs;
    const eventId = fixtureId();
    events.push(eventId);
    return { eventId, applicationId, startAt: iso(start), endAt: iso(start + durationMs), meetUrl };
  };

  /** An S03 `event` payload, keys in S03's order, plus what the receipt RPC adds. */
  const job = (ev: Ev, o: JobOverrides = {}): Record<string, unknown> => ({
    kind: 'ashby_schedule',
    scope: 'event',
    ashby_interview_event_id: ev.eventId,
    ashby_schedule_id: scheduleId,
    ashby_application_id: ev.applicationId,
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_scheduled_by_user_id: o.scheduledBy === undefined ? SCHEDULER_ID : o.scheduledBy,
    ashby_updated_at: o.updatedAt === undefined ? nextStamp() : o.updatedAt,
    decision: o.decision ?? 'eligible',
    start_at: o.startAt ?? ev.startAt,
    end_at: o.endAt ?? ev.endAt,
    meet_url: o.meetUrl === undefined ? ev.meetUrl : o.meetUrl,
    received_at: o.receivedAt === undefined ? HARNESS_NOW : o.receivedAt,
    ashby_schedule_event_ids: o.scheduleEventIds ?? [...events],
    ashby_dex_event_ids: o.dexEventIds ?? [...events],
    receipt_id: fixtureId(),
    source: 'ashby',
  });

  /** An S03 `schedule` payload (null lists = an identity job). */
  const scheduleJob = (
    decision: 'cancelled' | 'dex_absent',
    lists: { readonly scheduleEventIds: readonly string[]; readonly dexEventIds: readonly string[] } | null,
    updatedAt: string | null = nextStamp(),
  ): Record<string, unknown> => ({
    kind: 'ashby_schedule',
    scope: 'schedule',
    ashby_interview_event_id: null,
    ashby_schedule_id: scheduleId,
    ashby_application_id: null,
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_scheduled_by_user_id: null,
    ashby_updated_at: updatedAt,
    decision,
    start_at: null,
    end_at: null,
    meet_url: null,
    received_at: HARNESS_NOW,
    ashby_schedule_event_ids: lists === null ? null : lists.scheduleEventIds,
    ashby_dex_event_ids: lists === null ? null : lists.dexEventIds,
    receipt_id: fixtureId(),
    source: 'ashby',
  });

  const run = (payload: unknown, meta?: R1MeetJobMeta): Promise<R1MeetJobResult> =>
    runDef(h, r1MeetAshbyScheduleDefinition, payload, meta);

  const bookingOf = (ev: Ev): Row | undefined =>
    h.db.tables.r1_meet_bookings.find((row) => row.ashby_interview_event_id === ev.eventId);

  /**
   * Book the event through the handler (a bot is scheduled), then clear the traces. Answers a COPY
   * of the row as it was then (the fake updates its rows in place).
   */
  const book = async (ev: Ev, o: JobOverrides = {}): Promise<Row> => {
    const result = await run(job(ev, o));
    expect(result).toMatchObject({ outcome: 'done', code: 'bot_scheduled' });
    reset();
    return { ...bookingOf(ev)! };
  };

  /** Recall bots that exist and whose call has not ended. */
  const liveBots = (): string[] =>
    [...h.recall.bots.values()]
      .filter((bot) => !bot.status_changes.some((change) => ENDED.has(change.code)))
      .map((bot) => bot.id);

  const seedReceipt = (key: string, receivedAt: string): void => {
    h.db.tables.r1_meet_receipts.push({
      id: fixtureId(),
      source: 'ashby',
      dedupe_key: key,
      event_type: 'interviewScheduleUpdate',
      booking_id: null,
      outcome: 'enqueued',
      received_at: receivedAt,
      processed_at: null,
    });
  };

  return { h, scheduleId, reset, event, job, scheduleJob, run, bookingOf, book, liveBots, seedReceipt };
}

const done = (receipt: 'processed' | 'ignored', code: string) => ({ outcome: 'done', receipt, code });
const keyOf = (eventId: string, version: number, keyAttempt: number) => `r1-meet-${eventId}-v${version}-k${keyAttempt}`;
const creates = (h: R1MeetHarness) => h.requests.filter((request) => request.op === 'create');

function expectNoPii(h: R1MeetHarness, ...values: string[]): void {
  const text = JSON.stringify(h.logs);
  for (const value of [...values, 'meet.google.com', '@', 'hello.example.test']) expect(text).not.toContain(value);
}

/** Move a booking along the 0142 matrix as another writer would. */
async function transition(h: R1MeetHarness, id: string, from: string, to: string, reason: string): Promise<void> {
  const answer = await h.db.store.transition({
    bookingId: id,
    from: from as never,
    to: to as never,
    reason: reason as never,
    nowIso: iso(h.now()),
  });
  expect(answer.status).toBe('ok');
}

// ── Definitions and the outcome rule ────────────────────────────────────────

describe('the definitions', () => {
  it('exports five kinds with their strict parsers', () => {
    expect(R1_MEET_SCHEDULE_DEFINITIONS.map((definition) => definition.kind)).toEqual([
      'ashby_schedule',
      'booking_rerun',
      'ensure_bot',
      'bot_release',
      'round_cancelled',
    ]);
    for (const definition of R1_MEET_SCHEDULE_DEFINITIONS) {
      expect(definition.parse({ kind: definition.kind })).toBeNull();
      expect(definition.parse(null)).toBeNull();
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });

  it('the worst outcome: a deferral, then work done, then nothing; the shorter deferral of two', () => {
    const processed = done('processed', 'a') as R1MeetJobResult;
    const ignored = done('ignored', 'b') as R1MeetJobResult;
    const long = { outcome: 'defer', code: 'x', delaySeconds: 300 } as const;
    const short = { outcome: 'defer', code: 'y', delaySeconds: 5 } as const;
    expect(worstR1MeetResult([ignored, processed])).toBe(processed);
    expect(worstR1MeetResult([processed, long])).toBe(long);
    expect(worstR1MeetResult([long, short, processed])).toBe(short);
    expect(worstR1MeetResult([null, ignored, null])).toBe(ignored);
    expect(worstR1MeetResult([null])).toBeNull();
  });
});

// ── Every decision at both scopes ───────────────────────────────────────────

describe('ashby_schedule: every decision, one booking holding an undispatched bot', () => {
  const cases: Array<[string, JobOverrides, Record<string, unknown>, string]> = [
    ['eligible (same slot)', {}, { status: 'bot_scheduled', reason: 'eligible' }, 'unchanged'],
    ['cancelled', { decision: 'cancelled' }, { status: 'cancelled', reason: 'cancelled', recall_bot_id: null }, 'cancelled'],
    ['dex_absent', { decision: 'dex_absent', dexEventIds: [] }, { status: 'cancelled', reason: 'dex_absent', recall_bot_id: null }, 'cancelled'],
    ['in_past', { decision: 'in_past' }, { status: 'bot_scheduled', reason: 'eligible' }, 'held_in_past'],
    ['not_scheduled', { decision: 'not_scheduled' }, { status: 'blocked', reason: 'not_scheduled', recall_bot_id: null }, 'not_scheduled'],
    ['no_attester', { decision: 'no_attester', scheduledBy: null }, { status: 'blocked', reason: 'no_attester', recall_bot_id: null }, 'no_attester'],
    ['no_meet_link', { decision: 'no_meet_link', meetUrl: null }, { status: 'blocked', reason: 'no_meet_link', recall_bot_id: null }, 'no_meet_link'],
  ];

  it.each(cases)('event scope, %s', async (_name, overrides, expected, code) => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    const result = await w.run(w.job(ev, overrides));
    expect(result).toMatchObject({ outcome: 'done', code });
    expect(w.bookingOf(ev)).toMatchObject(expected);
    expect(w.h.requests.some((request) => request.method === 'PATCH')).toBe(false);
  });

  it.each([
    ['cancelled', 'cancelled', 'cancelled'],
    ['dex_absent', 'dex_absent', 'event_removed'],
  ] as const)('schedule scope, %s: every live booking of the schedule goes, other schedules stay', async (decision, inList, removed) => {
    const w = world();
    const listed = w.event();
    const gone = w.event();
    const elsewhere = w.event();
    await w.book(listed);
    await w.book(gone);
    // A booking of ANOTHER schedule in the same database.
    await expect(w.run({ ...w.job(elsewhere), ashby_schedule_id: fixtureId() })).resolves.toMatchObject({ code: 'bot_scheduled' });
    w.reset();

    // A schedule job: no event of the schedule has Dex any more.
    const result = await w.run(w.scheduleJob(decision, { scheduleEventIds: [listed.eventId], dexEventIds: [] }));
    expect(result).toEqual(done('processed', 'reconciled'));
    expect(w.bookingOf(listed)).toMatchObject({ status: 'cancelled', reason: inList, recall_bot_id: null });
    expect(w.bookingOf(gone)).toMatchObject({ status: 'cancelled', reason: removed, recall_bot_id: null });
    expect(w.bookingOf(elsewhere)).toMatchObject({ status: 'bot_scheduled' });
    expect(w.liveBots()).toEqual([w.bookingOf(elsewhere)!.recall_bot_id]);
  });

  it('schedule scope, an identity job (null lists) cancels every live booking with reason cancelled', async () => {
    const w = world();
    const one = w.event();
    const two = w.event();
    await w.book(one);
    await w.book(two);
    const result = await w.run(w.scheduleJob('cancelled', null));
    expect(result).toEqual(done('processed', 'reconciled'));
    expect(w.bookingOf(one)).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    expect(w.bookingOf(two)).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    expect(w.liveBots()).toEqual([]);
  });

  it('a schedule job with nothing live answers ignored', async () => {
    const w = world();
    await expect(w.run(w.scheduleJob('dex_absent', { scheduleEventIds: [], dexEventIds: [] }))).resolves.toEqual(
      done('ignored', 'nothing_to_reconcile'),
    );
  });
});

// ── Eligible: every answer of the create RPC ────────────────────────────────

describe('ashby_schedule eligible: the create RPC answers', () => {
  it('created: one create under the generation key, then attach; the consent records the attester', async () => {
    const w = world();
    const ev = w.event();
    const stamp = nextStamp();
    const result = await w.run(w.job(ev, { updatedAt: stamp }));
    expect(result).toEqual(done('processed', 'bot_scheduled'));
    expect(w.h.timeline).toEqual(['db:create_round_from_ashby', 'recall:create', 'db:set_bot:attach']);
    expect(creates(w.h)[0]!.headers['idempotency-key']).toBe(keyOf(ev.eventId, 0, 0));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', reason: 'eligible', version: 0, ashby_updated_at: stamp });
    const create = w.h.db.calls.find((call) => call.name === 'r1_meet_create_round_from_ashby')!;
    expect(create.args).toMatchObject({
      p_ashby_scheduled_by_user_id: SCHEDULER_ID,
      p_created_by: STAFF_USER_ID,
      p_attested_at: stamp,
      p_objective_profile: 'r1_dex_sales',
    });
    expect(w.h.db.tables.interview_round_consents).toEqual([
      expect.objectContaining({ method: 'hr_attested_ashby', attested_by_external_id: SCHEDULER_ID, attested_at: stamp }),
    ]);
    expectNoPii(w.h, ev.eventId, ev.applicationId, w.bookingOf(ev)!.id as string);
  });

  it.each([
    ['a future updatedAt is clamped to now', iso(Date.parse(HARNESS_NOW) + HOUR), HARNESS_NOW, HARNESS_NOW],
    ['no updatedAt: the receipt time', null, iso(Date.parse(HARNESS_NOW) - 5 * MINUTE), iso(Date.parse(HARNESS_NOW) - 5 * MINUTE)],
    ['no updatedAt and no receipt time: now', null, null, HARNESS_NOW],
  ])('attested_at: %s', async (_name, updatedAt, receivedAt, expected) => {
    const w = world();
    const ev = w.event();
    await w.run(w.job(ev, { updatedAt, receivedAt }));
    const create = w.h.db.calls.find((call) => call.name === 'r1_meet_create_round_from_ashby')!;
    expect(create.args!.p_attested_at).toBe(expected);
  });

  it('relinked: a live, unused Meet round of the candidate is reused', async () => {
    const w = world();
    const ev = w.event();
    const candidateId = w.h.db.tables.ashby_application_links.find((l) => l.external_application_id === ev.applicationId)!.candidate_id as string;
    const round = w.h.db.addRound({ candidate_id: candidateId });
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', round_id: round.id });
  });

  it('exists, same slot, pending (Recall was down): the replay creates the bot', async () => {
    const w = world();
    const ev = w.event();
    w.h.intercept('create', { status: 503 });
    const first = await w.run(w.job(ev));
    expect(first).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(w.bookingOf(ev)).toMatchObject({ status: 'pending' });
    w.reset();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(w.h.timeline).toEqual(['db:create_round_from_ashby', 'recall:create', 'db:set_bot:attach']);
  });

  it('rebound: a pending booking whose round lapsed gets a new round and a new generation key', async () => {
    const w = world();
    const ev = w.event();
    w.h.intercept('create', { status: 503 });
    await w.run(w.job(ev));
    const oldRound = w.bookingOf(ev)!.round_id as string;
    w.h.db.tables.interview_rounds.find((round) => round.id === oldRound)!.expires_at = iso(w.h.now() - MINUTE);
    w.reset();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', version: 1 });
    expect(w.bookingOf(ev)!.round_id).not.toBe(oldRound);
    expect(creates(w.h)[0]!.headers['idempotency-key']).toBe(keyOf(ev.eventId, 1, 0));
  });

  it('exists, same slot, blocked (the daily cap): reschedule on the same slot, then create', async () => {
    const w = world({ config: { dailyBotCap: 0 } });
    const ev = w.event();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_cap_reached'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: 'bot_cap_reached' });
    w.h.config.dailyBotCap = 20;
    w.reset();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(w.h.timeline).toEqual(['db:create_round_from_ashby', 'db:reschedule_booking', 'recall:create', 'db:set_bot:attach']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', version: 0 });
  });

  it('a duplicate job is a no-op: the second run reads, compares and stops', async () => {
    const w = world();
    const ev = w.event();
    const payload = w.job(ev);
    await w.run(payload);
    const bot = w.bookingOf(ev)!.recall_bot_id;
    w.reset();
    await expect(w.run(payload)).resolves.toEqual(done('ignored', 'unchanged'));
    expect(w.h.timeline).toEqual(['db:create_round_from_ashby']);
    expect(w.h.requests).toEqual([]);
    expect(w.liveBots()).toEqual([bot]);
  });

  it('blocked by r1_send_round: stored, and a re-run is planned at +10 min (ids only)', async () => {
    const w = world();
    w.h.db.settings.sendRound = 'capacity_exhausted';
    const ev = w.event();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'capacity_exhausted'));
    const booking = w.bookingOf(ev)!;
    expect(booking).toMatchObject({ status: 'blocked', reason: 'capacity_exhausted', recall_bot_id: null });
    const [rerun] = w.h.db.jobs('booking_rerun');
    expect(rerun!.payload).toEqual({ kind: 'booking_rerun', booking_id: booking.id, reason: 'capacity_exhausted', n: 0 });
    expect(rerun!.scheduled_at).toBe(iso(w.h.now() + 10 * MINUTE));
    expect(rerun!.dedup_key).toBe(`r1-meet:rerun:${booking.id}:${w.h.now() + 10 * MINUTE}`);
    expect(w.h.requests).toEqual([]);
  });

  it('unmatched application: stored, re-run planned; a terminal application gets no re-run', async () => {
    const w = world();
    const ev = { ...w.event(), applicationId: fixtureId() };
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'application_unknown'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'unmatched_application', reason: 'application_unknown' });
    expect(w.h.db.jobs('booking_rerun')).toHaveLength(1);

    const terminal = { ...w.event(), applicationId: fixtureId() };
    w.h.db.linkApplication(terminal.applicationId, fixtureId(), 'archived');
    await expect(w.run(w.job(terminal))).resolves.toEqual(done('processed', 'application_terminal'));
    expect(w.h.db.jobs('booking_rerun')).toHaveLength(1);
  });

  it('unmapped scheduler: no service user, an unknown one, and the resolveCreatedBy seam', async () => {
    const none = world({ config: { serviceUserId: null } });
    const a = none.event();
    await expect(none.run(none.job(a))).resolves.toEqual(done('processed', 'scheduler_unmapped'));
    expect(none.bookingOf(a)).toMatchObject({ status: 'unmapped_scheduler', reason: 'scheduler_unmapped' });

    const unknown = world({ config: { serviceUserId: fixtureId() } });
    const b = unknown.event();
    await expect(unknown.run(unknown.job(b))).resolves.toEqual(done('processed', 'created_by_unknown'));
    expect(unknown.h.db.jobs('booking_rerun')).toEqual([]);

    const seam = world({ config: { serviceUserId: null } });
    const asked: string[] = [];
    const deps = { ...seam.h.deps, resolveCreatedBy: async (id: string) => (asked.push(id), STAFF_USER_ID) };
    const c = seam.event();
    const job = r1MeetAshbyScheduleDefinition.parse(seam.job(c))!;
    await expect(r1MeetAshbyScheduleDefinition.run(deps, job, seam.h.meta())).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(asked).toEqual([SCHEDULER_ID]);
  });

  it('a terminal booking is never revived on the same slot (booking_terminal), no Recall call', async () => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    await w.run(w.job(ev, { decision: 'cancelled' }));
    w.reset();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('ignored', 'booking_terminal'));
    expect(w.h.requests).toEqual([]);
  });

  it('stale_update: an older delivery than the stored one changes nothing', async () => {
    const w = world();
    w.h.db.settings.sendRound = 'capacity_exhausted';
    const ev = w.event();
    const older = nextStamp();
    await w.run(w.job(ev));
    w.h.db.settings.sendRound = 'ok';
    w.reset();
    await expect(w.run(w.job(ev, { updatedAt: older }))).resolves.toEqual(done('ignored', 'stale_update'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: 'capacity_exhausted' });
  });

  it('bot_attached: a failed booking still holding its bot is released, then revived on the new slot', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    const bot = booking.recall_bot_id as string;
    await transition(w.h, booking.id as string, 'bot_scheduled', 'failed', 'no_show');
    w.h.recall.markDispatched(bot);
    w.h.recall.setStatus(bot, 'call_ended');
    w.reset();

    const start = Date.parse(ev.startAt) + 2 * HOUR;
    const result = await w.run(w.job(ev, { startAt: iso(start), endAt: iso(start + 45 * MINUTE) }));
    expect(result).toEqual(done('processed', 'bot_scheduled'));
    expect(w.h.timeline).toEqual([
      'db:create_round_from_ashby',
      'recall:get',
      'db:set_bot:release',
      'db:create_round_from_ashby',
      'recall:create',
      'db:set_bot:attach',
    ]);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', version: 1, start_at: iso(start) });
    expect(w.bookingOf(ev)!.recall_bot_id).not.toBe(bot);
  });

  it('in_past: a never-booked event whose slot started writes nothing', async () => {
    const w = world();
    const ev = w.event(-MINUTE);
    await expect(w.run(w.job(ev))).resolves.toEqual(done('ignored', 'in_past'));
    expect(w.bookingOf(ev)).toBeUndefined();
  });

  it('in_past with a booking that never got its bot: failed/in_past', async () => {
    const w = world();
    w.h.db.settings.sendRound = 'paused';
    const ev = w.event(20 * MINUTE);
    await w.run(w.job(ev));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: 'paused' });
    w.h.advance(25 * MINUTE);
    w.h.db.settings.sendRound = 'ok';
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'in_past'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'failed', reason: 'in_past' });
  });

  it('an invalid request from the RPC is a closed failure', async () => {
    const w = world();
    const ev = w.event();
    const payload = w.job(ev);
    // The parser already refuses what the RPC would; a drifted RPC must still stop the job closed.
    const deps = { ...w.h.deps, store: { ...w.h.db.store, createRound: async () => ({ status: 'invalid_request' as const, field: 'profile' }) } };
    const job = r1MeetAshbyScheduleDefinition.parse(payload)!;
    await expect(r1MeetAshbyScheduleDefinition.run(deps, job, w.h.meta())).rejects.toThrow('r1_meet_invalid_request');
  });
});

// ── Moves ───────────────────────────────────────────────────────────────────

describe('ashby_schedule eligible: a moved slot or link', () => {
  const MOVE_ORDER = [
    'db:create_round_from_ashby',
    'recall:get',
    'recall:delete',
    'db:set_bot:replace',
    'db:reschedule_booking',
    'recall:create',
    'db:set_bot:attach',
  ];

  it('more than 10 minutes ahead: DELETE, replace, reschedule, create, attach; never a PATCH', async () => {
    const w = world();
    const ev = w.event();
    const old = await w.book(ev);
    const start = Date.parse(ev.startAt) + 2 * HOUR;
    const result = await w.run(w.job(ev, { startAt: iso(start), endAt: iso(start + 45 * MINUTE) }));
    expect(result).toEqual(done('processed', 'bot_scheduled'));
    expect(w.h.timeline).toEqual(MOVE_ORDER);
    expect(w.h.requests.map((request) => request.method)).not.toContain('PATCH');
    expect(creates(w.h)[0]!.headers['idempotency-key']).toBe(keyOf(ev.eventId, 2, 0));
    expect(creates(w.h)[0]!.body).toMatchObject({ join_at: iso(start - 120_000), meeting_url: MEET_URL });
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', version: 2, start_at: iso(start) });
    expect(w.liveBots()).toEqual([w.bookingOf(ev)!.recall_bot_id]);
    expect(w.h.recall.bots.has(old.recall_bot_id as string)).toBe(false);
  });

  it('inside the last 10 minutes: the DELETE is refused (405), so leave_call; same order otherwise', async () => {
    const w = world();
    const ev = w.event(8 * MINUTE);
    const old = await w.book(ev);
    w.h.intercept('delete', { status: 405, body: { detail: 'Method "DELETE" not allowed.' } });
    const start = Date.parse(ev.startAt) + 2 * HOUR;
    await expect(w.run(w.job(ev, { startAt: iso(start), endAt: iso(start + 45 * MINUTE) }))).resolves.toEqual(
      done('processed', 'bot_scheduled'),
    );
    expect(w.h.timeline).toEqual([...MOVE_ORDER.slice(0, 3), 'recall:leave', ...MOVE_ORDER.slice(3)]);
    expect(w.h.requests.map((request) => request.method)).not.toContain('PATCH');
    expect(w.liveBots()).toEqual([w.bookingOf(ev)!.recall_bot_id]);
    expect(w.liveBots()).not.toContain(old.recall_bot_id);
  });

  it('a link-only change is a move: the new bot gets the new Meet URL', async () => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    await expect(w.run(w.job(ev, { meetUrl: OTHER_MEET_URL }))).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(w.h.timeline).toEqual(MOVE_ORDER);
    expect(creates(w.h)[0]!.body).toMatchObject({ meeting_url: OTHER_MEET_URL });
    expect(w.bookingOf(ev)).toMatchObject({ meet_url: OTHER_MEET_URL, start_at: ev.startAt, version: 2 });
  });

  it('a move into the past is checked before any Recall call: nothing happens', async () => {
    const w = world();
    const ev = w.event();
    const before = { ...(await w.book(ev)) };
    await expect(w.run(w.job(ev, { startAt: iso(w.h.now() - MINUTE), endAt: iso(w.h.now() + HOUR) }))).resolves.toEqual(
      done('ignored', 'in_past'),
    );
    expect(w.h.requests).toEqual([]);
    expect(w.bookingOf(ev)).toEqual(before);
  });

  it('a dispatched booking holds the move (defer 300 s), then the booking is revived once the call failed', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    const bot = booking.recall_bot_id as string;
    w.h.recall.markDispatched(bot);
    await transition(w.h, booking.id as string, 'bot_scheduled', 'bot_joining', 'eligible');
    const start = Date.parse(ev.startAt) + 3 * HOUR;
    const payload = w.job(ev, { startAt: iso(start), endAt: iso(start + 45 * MINUTE) });

    await expect(w.run(payload)).resolves.toEqual({ outcome: 'defer', code: 'held_dispatched', delaySeconds: R1_MEET_HOLD_DEFER_SEC });
    expect(w.h.requests).toEqual([]);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_joining', recall_bot_id: bot });

    // The old call ends with nobody: the event handler fails the booking and releases its bot.
    await transition(w.h, booking.id as string, 'bot_joining', 'failed', 'no_show');
    w.h.recall.setStatus(bot, 'call_ended');
    await w.h.db.store.setBot({ bookingId: booking.id as string, action: 'release', expectedVersion: 0, expectedKeyAttempt: 0, nowIso: iso(w.h.now()) });
    w.reset();

    const replay = await w.run(payload, w.h.meta({ deferCount: 1, deferredAt: iso(w.h.now()) }));
    expect(replay).toEqual(done('processed', 'bot_scheduled'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', version: 1, start_at: iso(start) });
    expect(creates(w.h)[0]!.headers['idempotency-key']).toBe(keyOf(ev.eventId, 1, 0));
  });

  it('the hold ends in a closed failure once the deferral bound is spent', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    await transition(w.h, booking.id as string, 'bot_scheduled', 'bot_joining', 'eligible');
    const start = Date.parse(ev.startAt) + HOUR;
    await expect(
      w.run(w.job(ev, { startAt: iso(start), endAt: iso(start + HOUR) }), w.h.meta({ deferCount: 30 })),
    ).rejects.toThrow('r1_meet_held_dispatched');
  });

  it('bot_scheduled but Recall already dispatched it: one GET, then the move holds', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    w.h.recall.markDispatched(booking.recall_bot_id as string);
    const start = Date.parse(ev.startAt) + HOUR;
    await expect(w.run(w.job(ev, { startAt: iso(start), endAt: iso(start + HOUR) }))).resolves.toMatchObject({
      outcome: 'defer',
      code: 'held_dispatched',
    });
    expect(w.h.timeline).toEqual(['db:create_round_from_ashby', 'recall:get']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', version: 0 });
  });

  it('Recall down at the release: the move defers and nothing is written', async () => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    w.h.intercept('get', { status: 503 });
    const start = Date.parse(ev.startAt) + HOUR;
    await expect(w.run(w.job(ev, { startAt: iso(start), endAt: iso(start + HOUR) }))).resolves.toMatchObject({
      outcome: 'defer',
      code: 'r1_meet_recall_unavailable',
    });
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled', version: 0 });
  });
});

// ── Too far ─────────────────────────────────────────────────────────────────

describe('slot_too_far', () => {
  it('initial: blocked with a re-run at retry_after (ids only); the re-run then books it', async () => {
    const w = world();
    const ev = w.event(20 * DAY);
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'slot_too_far'));
    const booking = w.bookingOf(ev)!;
    expect(booking).toMatchObject({ status: 'blocked', reason: 'slot_too_far', round_id: null });
    const retryAfter = Date.parse(ev.endAt) + 7200 * 1000 - 14 * DAY;
    const [rerun] = w.h.db.jobs('booking_rerun');
    expect(rerun!.payload).toEqual({ kind: 'booking_rerun', booking_id: booking.id, reason: 'slot_too_far', n: 0 });
    expect(rerun!.scheduled_at).toBe(iso(retryAfter));
    expect(JSON.stringify(rerun!.payload)).not.toContain('meet.google.com');

    w.h.setNow(retryAfter + 1000);
    w.reset();
    await expect(runDef(w.h, r1MeetBookingRerunDefinition, rerun!.payload)).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled' });
    expect(creates(w.h)[0]!.body).toMatchObject({ meeting_url: MEET_URL });
  });

  it('moved: release, replace, reschedule (too far), failed, then the create replay revives it blocked/slot_too_far', async () => {
    const w = world();
    const ev = w.event();
    const old = await w.book(ev);
    const start = w.h.now() + 20 * DAY;
    const result = await w.run(w.job(ev, { startAt: iso(start), endAt: iso(start + 45 * MINUTE), meetUrl: OTHER_MEET_URL }));
    expect(result).toEqual(done('processed', 'slot_too_far'));
    expect(w.h.timeline).toEqual([
      'db:create_round_from_ashby',
      'recall:get',
      'recall:delete',
      'db:set_bot:replace',
      'db:reschedule_booking',
      'db:transition:failed',
      'db:create_round_from_ashby',
      'queue:booking_rerun',
    ]);
    expect(w.bookingOf(ev)).toMatchObject({
      status: 'blocked',
      reason: 'slot_too_far',
      start_at: iso(start),
      meet_url: OTHER_MEET_URL,
      round_id: null,
      recall_bot_id: null,
      version: 2,
    });
    expect(w.h.recall.bots.has(old.recall_bot_id as string)).toBe(false);
    for (const queued of w.h.db.jobs()) expect(JSON.stringify(queued.payload)).not.toContain('meet.google.com');
  });

  it('a run killed after the failed transition lands in the same revival', async () => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    const start = w.h.now() + 20 * DAY;
    const payload = w.job(ev, { startAt: iso(start), endAt: iso(start + 45 * MINUTE) });
    w.h.db.failNext('r1_meet_transition_booking', 'lost');
    await expect(w.run(payload)).rejects.toThrow('r1_meet_db_error');
    expect(w.bookingOf(ev)).toMatchObject({ status: 'failed', reason: 'round_expired' });
    await expect(w.run(payload, w.h.meta({ attempts: 2 }))).resolves.toEqual(done('processed', 'slot_too_far'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: 'slot_too_far', start_at: iso(start) });
    expect(w.liveBots()).toEqual([]);
  });
});

// ── Re-runs ─────────────────────────────────────────────────────────────────

describe('booking_rerun', () => {
  async function blocked(w: ReturnType<typeof world>, startInMs = 3 * DAY) {
    w.h.db.settings.sendRound = 'capacity_exhausted';
    const ev = w.event(startInMs);
    await w.run(w.job(ev));
    w.reset();
    return { ev, booking: w.bookingOf(ev)! };
  }

  const rerunJobs = (w: ReturnType<typeof world>) => w.h.db.jobs('booking_rerun');

  it('runs only while the booking keeps the same reason', async () => {
    const w = world();
    const { ev, booking } = await blocked(w);
    const payload = { kind: 'booking_rerun', booking_id: booking.id, reason: 'paused', n: 0 };
    await expect(runDef(w.h, r1MeetBookingRerunDefinition, payload)).resolves.toEqual(done('ignored', 'reason_changed'));
    expect(w.h.timeline).toEqual([]);
    expect(w.bookingOf(ev)).toMatchObject({ reason: 'capacity_exhausted' });
  });

  it('replays the stored delivery: capacity back, the bot is created', async () => {
    const w = world();
    const { ev } = await blocked(w);
    w.h.db.settings.sendRound = 'ok';
    const [rerun] = rerunJobs(w);
    w.h.setNow(Date.parse(rerun!.scheduled_at as string));
    await expect(runDef(w.h, r1MeetBookingRerunDefinition, rerun!.payload)).resolves.toEqual(done('processed', 'bot_scheduled'));
    const create = w.h.db.calls.filter((call) => call.name === 'r1_meet_create_round_from_ashby').at(-1)!;
    expect(create.args).toMatchObject({
      p_ashby_interview_event_id: ev.eventId,
      p_meet_url: MEET_URL,
      p_start_at: ev.startAt,
      p_ashby_scheduled_by_user_id: SCHEDULER_ID,
      p_created_by: STAFF_USER_ID,
    });
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled' });
  });

  it('the ladder: +10 min, +60 min, +6 h, then no more', async () => {
    const w = world();
    const { booking } = await blocked(w);
    const steps: Array<[number, number]> = [];
    for (let n = 0; n < 4; n += 1) {
      const pending = rerunJobs(w).filter((job) => job.status === 'pending');
      if (n === 3) {
        expect(pending).toEqual([]);
        break;
      }
      expect(pending).toHaveLength(1);
      const job = pending[0]!;
      steps.push([job.payload.n as number, Date.parse(job.scheduled_at as string) - w.h.now()]);
      job.status = 'completed';
      w.h.setNow(Date.parse(job.scheduled_at as string));
      await expect(runDef(w.h, r1MeetBookingRerunDefinition, job.payload)).resolves.toEqual(done('processed', 'capacity_exhausted'));
    }
    expect(steps).toEqual([
      [0, 10 * MINUTE],
      [1, 60 * MINUTE],
      [2, 6 * HOUR],
    ]);
    expect(w.bookingOf({ eventId: booking.ashby_interview_event_id } as Ev)).toMatchObject({ reason: 'capacity_exhausted' });
  });

  it('never later than 15 minutes before the slot; none at all when that is already past', async () => {
    const w = world();
    const { ev } = await blocked(w, 30 * MINUTE);
    const first = rerunJobs(w)[0]!;
    expect(first.scheduled_at).toBe(iso(w.h.now() + 10 * MINUTE));
    first.status = 'completed';
    w.h.setNow(Date.parse(first.scheduled_at as string));
    await runDef(w.h, r1MeetBookingRerunDefinition, first.payload);
    const second = rerunJobs(w).find((job) => job.status === 'pending')!;
    expect(second.scheduled_at).toBe(iso(Date.parse(ev.startAt) - 15 * MINUTE));
    second.status = 'completed';
    w.h.setNow(Date.parse(second.scheduled_at as string));
    await runDef(w.h, r1MeetBookingRerunDefinition, second.payload);
    expect(rerunJobs(w).filter((job) => job.status === 'pending')).toEqual([]);

    const late = world();
    await blocked(late, 12 * MINUTE);
    expect(rerunJobs(late)).toEqual([]);
  });

  it('a slot that has started, or a booking that is gone, is not re-run', async () => {
    const w = world();
    const { ev, booking } = await blocked(w, HOUR);
    w.h.setNow(Date.parse(ev.startAt));
    const payload = { kind: 'booking_rerun', booking_id: booking.id, reason: 'capacity_exhausted', n: 0 };
    await expect(runDef(w.h, r1MeetBookingRerunDefinition, payload)).resolves.toEqual(done('ignored', 'in_past'));
    const gone = { ...payload, booking_id: fixtureId() };
    await expect(runDef(w.h, r1MeetBookingRerunDefinition, gone)).resolves.toEqual(done('ignored', 'booking_gone'));
  });
});

// ── Unschedule ──────────────────────────────────────────────────────────────

describe('not_scheduled / no_attester / no_meet_link', () => {
  const unscheduleJob = (w: ReturnType<typeof world>, ev: Ev, decision = 'not_scheduled') =>
    w.job(ev, {
      decision,
      ...(decision === 'no_attester' ? { scheduledBy: null } : {}),
      ...(decision === 'no_meet_link' ? { meetUrl: null } : {}),
    });

  it.each(['not_scheduled', 'no_attester', 'no_meet_link'])('%s: an undispatched bot is deleted, replaced, and the booking blocked', async (decision) => {
    const w = world();
    const ev = w.event();
    const old = await w.book(ev);
    await expect(w.run(unscheduleJob(w, ev, decision))).resolves.toEqual(done('processed', decision));
    expect(w.h.timeline).toEqual(['recall:get', 'recall:delete', 'db:set_bot:replace', 'db:transition:blocked']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: decision, recall_bot_id: null, version: 1 });
    expect(w.h.recall.bots.has(old.recall_bot_id as string)).toBe(false);
  });

  it('a dispatched booking holds (no Recall call)', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    await transition(w.h, booking.id as string, 'bot_scheduled', 'bot_joining', 'eligible');
    await expect(w.run(unscheduleJob(w, ev))).resolves.toEqual(done('ignored', 'held_dispatched'));
    expect(w.h.requests).toEqual([]);
  });

  it('bot_scheduled but already dispatched at Recall: one GET, then hold', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    w.h.recall.markDispatched(booking.recall_bot_id as string);
    await expect(w.run(unscheduleJob(w, ev))).resolves.toEqual(done('ignored', 'held_dispatched'));
    expect(w.h.timeline).toEqual(['recall:get']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled' });
  });

  it('a pending booking is blocked; the same decision again is unchanged; a later eligible re-arms it', async () => {
    const w = world();
    const ev = w.event();
    w.h.intercept('create', { status: 503 });
    await w.run(w.job(ev));
    w.reset();
    await expect(w.run(unscheduleJob(w, ev))).resolves.toEqual(done('processed', 'not_scheduled'));
    // The key is retired before the booking leaves pending (S06-R2).
    expect(w.h.timeline).toEqual(['db:set_bot:rotate_key', 'db:transition:blocked']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: 'not_scheduled', version: 0, key_attempt: 1 });
    await expect(w.run(unscheduleJob(w, ev))).resolves.toEqual(done('ignored', 'unchanged'));
    w.reset();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(w.h.timeline).toEqual(['db:create_round_from_ashby', 'db:reschedule_booking', 'recall:create', 'db:set_bot:attach']);
    expect(creates(w.h).at(-1)!.headers['idempotency-key']).toBe(keyOf(ev.eventId, 0, 1));
  });

  it('S06-R2: a create in flight when the booking is unscheduled: its bot is released, and the next create is a NEW bot', async () => {
    const w = world();
    const ev = w.event();
    w.h.intercept('create', { status: 503 });
    await w.run(w.job(ev));
    const id = w.bookingOf(ev)!.id as string;
    w.reset();
    // ensureBot creates under v0-k0; before its attach, the Ashby update blocks the booking.
    let orphan: string | null = null;
    const client = w.h.client;
    const racing = {
      ...w.h.deps,
      recall: {
        getBot: client.getBot.bind(client),
        deleteScheduledBot: client.deleteScheduledBot.bind(client),
        leaveCall: client.leaveCall.bind(client),
        startOutputMedia: client.startOutputMedia.bind(client),
        createBot: async (...args: Parameters<typeof client.createBot>) => {
          const bot = await client.createBot(...args);
          orphan = bot.id;
          await expect(w.run(unscheduleJob(w, ev))).resolves.toEqual(done('processed', 'not_scheduled'));
          return bot;
        },
      },
    };
    // The attach is refused (the key moved on: version_conflict), so the orphan's release is queued.
    await expect(ensureBot(racing, id, w.h.meta())).resolves.toMatchObject({ outcome: 'done', receipt: 'ignored' });
    expect(orphan).not.toBeNull();
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: 'not_scheduled', recall_bot_id: null });
    // The orphan's release runs: Recall deletes it.
    const release = w.h.db.jobs('bot_release').find((job) => job.payload.recall_bot_id === orphan)!;
    await expect(runDef(w.h, r1MeetBotReleaseDefinition, release.payload)).resolves.toMatchObject({ outcome: 'done' });
    expect(w.h.recall.bots.has(orphan!)).toBe(false);
    // HR flips the event back to Scheduled within the hour (the same slot keeps the generation).
    w.reset();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_scheduled'));
    const booking = w.bookingOf(ev)!;
    // Never the deleted bot from Recall's one-hour cache: a live bot that will join.
    expect(booking.recall_bot_id).not.toBe(orphan);
    expect(creates(w.h).map((request) => request.headers['idempotency-key'])).toEqual([keyOf(ev.eventId, 0, 1)]);
    expect(w.h.recall.bots.has(booking.recall_bot_id as string)).toBe(true);
    expect(w.liveBots()).toEqual([booking.recall_bot_id]);
  });

  it('S06-R2: the daily cap retires the key too before it blocks a pending booking', async () => {
    const w = world({ config: { dailyBotCap: 1 } });
    await w.book(w.event());
    const ev = w.event();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_cap_reached'));
    expect(w.h.timeline).toEqual(['db:create_round_from_ashby', 'db:set_bot:rotate_key', 'db:transition:blocked']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: 'bot_cap_reached', key_attempt: 1 });
  });

  it('S06-R2: twenty key attempts spent: the booking fails bot_create_failed instead of keeping a used key', async () => {
    const w = world();
    const ev = w.event();
    w.h.intercept('create', { status: 503 });
    await w.run(w.job(ev));
    w.bookingOf(ev)!.key_attempt = 20;
    w.reset();
    await expect(w.run(unscheduleJob(w, ev))).resolves.toEqual(done('processed', 'bot_create_failed'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'failed', reason: 'bot_create_failed', recall_bot_id: null });
    expect(w.h.alerts()).toEqual(['r1_meet_bot_create_failed']);
  });

  it('no booking: nothing to do', async () => {
    const w = world();
    await expect(w.run(unscheduleJob(w, w.event()))).resolves.toEqual(done('ignored', 'no_booking'));
  });
});

// ── Cancel ──────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('before dispatch: GET, DELETE, cancel, release', async () => {
    const w = world();
    const ev = w.event();
    const old = await w.book(ev);
    await expect(w.run(w.job(ev, { decision: 'cancelled' }))).resolves.toEqual(done('processed', 'cancelled'));
    expect(w.h.timeline).toEqual(['recall:get', 'recall:delete', 'db:cancel_booking', 'db:set_bot:release']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'cancelled', reason: 'cancelled', recall_bot_id: null });
    expect(w.h.recall.bots.has(old.recall_bot_id as string)).toBe(false);
  });

  it('after dispatch (even in the call): GET, leave_call, cancel, release', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    w.h.recall.markDispatched(booking.recall_bot_id as string);
    await transition(w.h, booking.id as string, 'bot_scheduled', 'bot_joining', 'eligible');
    w.reset();
    await expect(w.run(w.job(ev, { decision: 'cancelled' }))).resolves.toEqual(done('processed', 'cancelled'));
    expect(w.h.timeline).toEqual(['recall:get', 'recall:leave', 'db:cancel_booking', 'db:set_bot:release']);
    expect(w.liveBots()).toEqual([]);
  });

  it('already cancelled, or no booking: nothing to do', async () => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    await w.run(w.job(ev, { decision: 'cancelled' }));
    w.reset();
    await expect(w.run(w.job(ev, { decision: 'cancelled' }))).resolves.toEqual(done('ignored', 'already_cancelled'));
    expect(w.h.requests).toEqual([]);
    await expect(w.run(w.job(w.event(), { decision: 'cancelled' }))).resolves.toEqual(done('ignored', 'no_booking'));
  });

  it('a booking without a bot is cancelled with no Recall call', async () => {
    const w = world();
    w.h.db.settings.sendRound = 'paused';
    const ev = w.event();
    await w.run(w.job(ev));
    w.reset();
    await expect(w.run(w.job(ev, { decision: 'cancelled' }))).resolves.toEqual(done('processed', 'cancelled'));
    expect(w.h.timeline).toEqual(['db:cancel_booking']);
  });

  it('Recall down: the cancel defers and the booking stays as it was', async () => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    w.h.intercept('get', { status: 503 });
    await expect(w.run(w.job(ev, { decision: 'cancelled' }))).resolves.toMatchObject({
      outcome: 'defer',
      code: 'r1_meet_recall_unavailable',
    });
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled' });
  });

  it('the bound spent: cancelled in the database, the bot an owed release (alert), settled later by bot_release', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    const bot = booking.recall_bot_id as string;
    w.h.intercept('get', { status: 503 });
    const result = await w.run(w.job(ev, { decision: 'cancelled' }), w.h.meta({ deferCount: 30 }));
    expect(result).toEqual(done('processed', 'cancelled_release_owed'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'cancelled', reason: 'cancelled', recall_bot_id: bot });
    expect(w.h.alerts()).toContain('r1_meet_release_owed');
    expectNoPii(w.h, bot, booking.id as string);
    w.reset();

    const payload = { kind: 'bot_release', recall_bot_id: bot, booking_id: booking.id };
    await expect(runDef(w.h, r1MeetBotReleaseDefinition, payload)).resolves.toEqual(done('processed', 'released_deleted'));
    expect(w.h.timeline).toEqual(['recall:get', 'recall:delete', 'db:set_bot:release']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'cancelled', recall_bot_id: null });
  });

  it('a bot attached between the read and the cancel is not forgotten: its release is queued', async () => {
    const w = world();
    const ev = w.event();
    w.h.intercept('create', { status: 503 });
    await w.run(w.job(ev));
    const booking = w.bookingOf(ev)!;
    expect(booking).toMatchObject({ status: 'pending', recall_bot_id: null });
    // A concurrent ensure_bot wins the race: it attaches a bot right before the cancel RPC runs.
    const store = {
      ...w.h.db.store,
      cancel: async (input: Parameters<R1MeetHarness['db']['store']['cancel']>[0]) => {
        await ensureBot(w.h.deps, booking.id as string, w.h.meta());
        return w.h.db.store.cancel(input);
      },
    };
    const job = r1MeetAshbyScheduleDefinition.parse(w.job(ev, { decision: 'cancelled' }))!;
    await expect(r1MeetAshbyScheduleDefinition.run({ ...w.h.deps, store }, job, w.h.meta())).resolves.toEqual(
      done('processed', 'cancelled'),
    );
    const late = w.bookingOf(ev)!.recall_bot_id as string;
    expect(late).toEqual(expect.any(String));
    const [release] = w.h.db.jobs('bot_release');
    expect(release!.payload).toEqual({ kind: 'bot_release', recall_bot_id: late, booking_id: booking.id });
    await expect(runDef(w.h, r1MeetBotReleaseDefinition, release!.payload)).resolves.toEqual(done('processed', 'released_deleted'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'cancelled', recall_bot_id: null });
    expect(w.liveBots()).toEqual([]);
  });

  it('a permanent Recall refusal also leaves an owed release instead of a live cancelled interview', async () => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    w.h.intercept('get', { status: 400, body: { code: 'request_blocked' } });
    await expect(w.run(w.job(ev, { decision: 'cancelled' }))).resolves.toEqual(done('processed', 'cancelled_release_owed'));
    expect(w.h.alerts()).toContain('r1_meet_release_owed');
  });
});

// ── Reconcile ───────────────────────────────────────────────────────────────

describe('reconcile (S03 R11)', () => {
  async function three(w: ReturnType<typeof world>) {
    const [a, b, c] = [w.event(), w.event(), w.event()];
    const all = [a.eventId, b.eventId, c.eventId];
    for (const ev of [a, b, c]) await w.book(ev, { scheduleEventIds: all, dexEventIds: all });
    return { a, b, c };
  }

  it('Dex removed from an event still in the schedule: dex_absent; an event gone from it: event_removed', async () => {
    const w = world();
    const { a, b, c } = await three(w);
    const result = await w.run(w.job(a, { scheduleEventIds: [a.eventId, b.eventId], dexEventIds: [a.eventId] }));
    expect(result).toEqual(done('processed', 'reconciled'));
    expect(w.bookingOf(a)).toMatchObject({ status: 'bot_scheduled' });
    expect(w.bookingOf(b)).toMatchObject({ status: 'cancelled', reason: 'dex_absent', recall_bot_id: null });
    expect(w.bookingOf(c)).toMatchObject({ status: 'cancelled', reason: 'event_removed', recall_bot_id: null });
    expect(w.liveBots()).toEqual([w.bookingOf(a)!.recall_bot_id]);
  });

  it('a booking a newer delivery touched is skipped', async () => {
    const w = world();
    const a = w.event();
    const b = w.event();
    const older = nextStamp();
    await w.book(a);
    await w.book(b);
    // Without the stamp rule this job (which lists only `a`) would cancel `b`.
    await expect(w.run(w.job(a, { updatedAt: older, scheduleEventIds: [a.eventId], dexEventIds: [a.eventId] }))).resolves.toEqual(
      done('ignored', 'unchanged'),
    );
    expect(w.bookingOf(b)).toMatchObject({ status: 'bot_scheduled' });
    // A newer delivery with the same lists does cancel it.
    await expect(w.run(w.job(a, { scheduleEventIds: [a.eventId], dexEventIds: [a.eventId] }))).resolves.toEqual(
      done('processed', 'reconciled'),
    );
    expect(w.bookingOf(b)).toMatchObject({ status: 'cancelled', reason: 'event_removed' });
  });

  it('runs even when the main action deferred, and the deferral is the answer', async () => {
    const w = world();
    const { a, b, c } = await three(w);
    // One failed GET: the move's own release. The reconcile's release then reaches Recall.
    w.h.intercept('get', { status: 503 });
    const start = Date.parse(a.startAt) + HOUR;
    const result = await w.run(
      w.job(a, { startAt: iso(start), endAt: iso(start + HOUR), scheduleEventIds: [a.eventId, b.eventId], dexEventIds: [a.eventId, b.eventId] }),
    );
    expect(result).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(w.bookingOf(a)).toMatchObject({ status: 'bot_scheduled', version: 0 });
    expect(w.bookingOf(b)).toMatchObject({ status: 'bot_scheduled' });
    expect(w.bookingOf(c)).toMatchObject({ status: 'cancelled', reason: 'event_removed', recall_bot_id: null });
  });

  it('runs even when the main action threw, and the throw is the answer', async () => {
    const w = world();
    const { a, b, c } = await three(w);
    w.h.db.failNext('r1_meet_create_round_from_ashby', 'error');
    await expect(w.run(w.job(a, { scheduleEventIds: [a.eventId, b.eventId, c.eventId], dexEventIds: [a.eventId, b.eventId] }))).rejects.toThrow(
      'r1_meet_db_error',
    );
    expect(w.bookingOf(c)).toMatchObject({ status: 'cancelled', reason: 'dex_absent' });
    expect(w.bookingOf(b)).toMatchObject({ status: 'bot_scheduled' });
  });

  it('one booking that fails does not spare the others; the failure is thrown after them', async () => {
    const w = world();
    const { a, b, c } = await three(w);
    w.h.db.failNext('r1_meet_cancel_booking', 'error');
    await expect(w.run(w.job(a, { scheduleEventIds: [a.eventId], dexEventIds: [a.eventId] }))).rejects.toThrow('r1_meet_db_error');
    const states = [w.bookingOf(b)!.status, w.bookingOf(c)!.status].sort();
    expect(states).toEqual(['bot_scheduled', 'cancelled']);
  });
});

// ── Superseded deliveries (D-S06-7) ─────────────────────────────────────────

describe('superseded', () => {
  async function two(w: ReturnType<typeof world>) {
    const [a, b] = [w.event(), w.event()];
    const both = [a.eventId, b.eventId];
    await w.book(a, { scheduleEventIds: both, dexEventIds: both });
    await w.book(b, { scheduleEventIds: both, dexEventIds: both });
    return { a, b };
  }

  it('a newer numeric stamp drops the job: no action, no reconcile', async () => {
    const w = world();
    const { a, b } = await two(w);
    const stamp = nextStamp();
    w.seedReceipt(`ashby-schedule:${w.scheduleId}:${Date.parse(stamp) + 1000}:${a.eventId}`, HARNESS_NOW);
    await expect(w.run(w.job(a, { updatedAt: stamp, scheduleEventIds: [a.eventId], dexEventIds: [a.eventId] }))).resolves.toEqual(
      done('ignored', 'superseded'),
    );
    expect(w.h.timeline).toEqual([]);
    expect(w.bookingOf(b)).toMatchObject({ status: 'bot_scheduled' });
  });

  it('never by the same delivery (its own receipt and its sibling events share the stamp)', async () => {
    const w = world();
    const { a, b } = await two(w);
    const stamp = nextStamp();
    const base = `ashby-schedule:${w.scheduleId}:${Date.parse(stamp)}`;
    w.seedReceipt(`${base}:${a.eventId}`, HARNESS_NOW);
    w.seedReceipt(`${base}:${b.eventId}`, HARNESS_NOW);
    w.seedReceipt(`ashby-schedule:${w.scheduleId}:${Date.parse(stamp) - 1000}:${a.eventId}`, HARNESS_NOW);
    await expect(w.run(w.job(a, { updatedAt: stamp, scheduleEventIds: [a.eventId], dexEventIds: [a.eventId] }))).resolves.toEqual(
      done('processed', 'reconciled'),
    );
    expect(w.bookingOf(b)).toMatchObject({ status: 'cancelled', reason: 'event_removed' });
  });

  it('no updatedAt (an r stamp): a receipt received later supersedes; earlier or same time does not', async () => {
    const w = world();
    const { a, b } = await two(w);
    const received = Date.parse(HARNESS_NOW) - MINUTE;
    w.seedReceipt(`ashby-schedule:${w.scheduleId}:r${received - 5000}:${a.eventId}`, iso(received - 5000));
    w.seedReceipt(`ashby-schedule:${w.scheduleId}:r${received}:${a.eventId}`, iso(received));
    const payload = w.job(a, { updatedAt: null, receivedAt: iso(received), scheduleEventIds: [a.eventId], dexEventIds: [a.eventId] });
    w.seedReceipt(`ashby-schedule:${w.scheduleId}:r${received + 5000}:${b.eventId}`, iso(received + 5000));
    await expect(w.run(payload)).resolves.toEqual(done('ignored', 'superseded'));
    expect(w.bookingOf(b)).toMatchObject({ status: 'bot_scheduled' });

    const quiet = world();
    const pair = await two(quiet);
    quiet.seedReceipt(`ashby-schedule:${quiet.scheduleId}:r${received}:${pair.a.eventId}`, iso(received));
    const own = quiet.job(pair.a, { updatedAt: null, receivedAt: iso(received), scheduleEventIds: [pair.a.eventId], dexEventIds: [pair.a.eventId] });
    await expect(quiet.run(own)).resolves.toEqual(done('processed', 'reconciled'));
  });

  it('an r stamp never outranks an Ashby updatedAt', async () => {
    const w = world();
    const { a } = await two(w);
    const stamp = nextStamp();
    w.seedReceipt(`ashby-schedule:${w.scheduleId}:r${Date.parse(HARNESS_NOW) + HOUR}:${a.eventId}`, iso(Date.parse(HARNESS_NOW) + HOUR));
    await expect(w.run(w.job(a, { updatedAt: stamp, scheduleEventIds: [a.eventId], dexEventIds: [a.eventId] }))).resolves.toEqual(
      done('processed', 'reconciled'),
    );
  });
});

// ── Kill points (plan 2.5) ──────────────────────────────────────────────────

type Kill = [string, (h: R1MeetHarness) => void, 'defer' | 'throw'];

async function firstRun(run: () => Promise<R1MeetJobResult>, expected: 'defer' | 'throw'): Promise<void> {
  if (expected === 'throw') await expect(run()).rejects.toBeInstanceOf(R1MeetJobError);
  else await expect(run()).resolves.toMatchObject({ outcome: 'defer' });
}

function retryMeta(h: R1MeetHarness, expected: 'defer' | 'throw'): R1MeetJobMeta {
  return expected === 'throw' ? h.meta({ attempts: 2 }) : h.meta({ deferCount: 1, deferredAt: iso(h.now()) });
}

describe('kill points: the second run ends in the same state with one live bot at most', () => {
  const moveKills: Kill[] = [
    ['after the DELETE', (h) => h.intercept('delete', 'lost'), 'defer'],
    ['after replace', (h) => h.db.failNext('r1_meet_set_bot', 'lost'), 'throw'],
    ['after reschedule', (h) => h.db.failNext('r1_meet_reschedule_booking', 'lost'), 'throw'],
    ['after the create', (h) => h.intercept('create', 'lost'), 'defer'],
    [
      'after attach',
      (h) => {
        h.afterRecall = (op) => {
          if (op !== 'create') return;
          h.db.failNext('r1_meet_set_bot', 'lost');
          h.afterRecall = null;
        };
      },
      'throw',
    ],
  ];

  it.each(moveKills)('move, killed %s', async (_name, kill, expected) => {
    const w = world();
    const ev = w.event();
    const old = await w.book(ev);
    const start = Date.parse(ev.startAt) + 2 * HOUR;
    const payload = w.job(ev, { startAt: iso(start), endAt: iso(start + 45 * MINUTE) });
    kill(w.h);
    await firstRun(() => w.run(payload), expected);
    const second = await w.run(payload, retryMeta(w.h, expected));
    expect(second.outcome).toBe('done');
    const booking = w.bookingOf(ev)!;
    expect(booking).toMatchObject({ status: 'bot_scheduled', version: 2, start_at: iso(start) });
    expect([...w.h.recall.bots.keys()]).toEqual([booking.recall_bot_id]);
    expect(booking.recall_bot_id).not.toBe(old.recall_bot_id);
    // A third run of the same job changes nothing.
    w.reset();
    await expect(w.run(payload)).resolves.toEqual(done('ignored', 'unchanged'));
    expect(w.h.requests).toEqual([]);
  });

  const cancelKills: Kill[] = [
    ['after the DELETE', (h) => h.intercept('delete', 'lost'), 'defer'],
    ['after the cancel RPC', (h) => h.db.failNext('r1_meet_cancel_booking', 'lost'), 'throw'],
    ['after the release mark', (h) => h.db.failNext('r1_meet_set_bot', 'lost'), 'throw'],
  ];

  it.each(cancelKills)('cancel, killed %s', async (_name, kill, expected) => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    const payload = w.job(ev, { decision: 'cancelled' });
    kill(w.h);
    await firstRun(() => w.run(payload), expected);
    await expect(w.run(payload, retryMeta(w.h, expected))).resolves.toMatchObject({ outcome: 'done' });
    expect(w.bookingOf(ev)).toMatchObject({ status: 'cancelled', reason: 'cancelled', recall_bot_id: null });
    expect([...w.h.recall.bots.keys()]).toEqual([]);
  });

  const unscheduleKills: Kill[] = [
    ['after the DELETE', (h) => h.intercept('delete', 'lost'), 'defer'],
    ['after replace', (h) => h.db.failNext('r1_meet_set_bot', 'lost'), 'throw'],
    ['after the transition', (h) => h.db.failNext('r1_meet_transition_booking', 'lost'), 'throw'],
  ];

  it.each(unscheduleKills)('unschedule, killed %s', async (_name, kill, expected) => {
    const w = world();
    const ev = w.event();
    await w.book(ev);
    const payload = w.job(ev, { decision: 'not_scheduled' });
    kill(w.h);
    await firstRun(() => w.run(payload), expected);
    await expect(w.run(payload, retryMeta(w.h, expected))).resolves.toMatchObject({ outcome: 'done' });
    expect(w.bookingOf(ev)).toMatchObject({ status: 'blocked', reason: 'not_scheduled', recall_bot_id: null, version: 1 });
    expect([...w.h.recall.bots.keys()]).toEqual([]);
  });
});

// ── bot_release, round_cancelled, ensure_bot ────────────────────────────────

describe('bot_release', () => {
  it('never touches a bot a LIVE booking holds', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    const payload = { kind: 'bot_release', recall_bot_id: booking.recall_bot_id, booking_id: booking.id };
    await expect(runDef(w.h, r1MeetBotReleaseDefinition, payload)).resolves.toEqual(done('ignored', 'in_use'));
    expect(w.h.requests).toEqual([]);
    expect(w.liveBots()).toEqual([booking.recall_bot_id]);
  });

  it('a deleted booking (the 0142 trigger job): the bot is deleted at Recall', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    w.h.db.deleteBooking(booking.id as string);
    const [queued] = w.h.db.jobs('bot_release');
    await expect(runDef(w.h, r1MeetBotReleaseDefinition, queued!.payload)).resolves.toEqual(done('processed', 'released_deleted'));
    expect(w.h.timeline).toEqual(['queue:bot_release', 'recall:get', 'recall:delete']);
    expect([...w.h.recall.bots.keys()]).toEqual([]);
  });

  it('a terminal holder: released, then the release recorded', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    w.h.recall.markDispatched(booking.recall_bot_id as string);
    await transition(w.h, booking.id as string, 'bot_scheduled', 'failed', 'bot_fatal');
    w.reset();
    const payload = { kind: 'bot_release', recall_bot_id: booking.recall_bot_id, booking_id: booking.id };
    await expect(runDef(w.h, r1MeetBotReleaseDefinition, payload)).resolves.toEqual(done('processed', 'released_left'));
    expect(w.h.timeline).toEqual(['recall:get', 'recall:leave', 'db:set_bot:release']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'failed', recall_bot_id: null });
  });

  it('a bot Recall no longer knows is gone; Recall down defers', async () => {
    const w = world();
    const payload = { kind: 'bot_release', recall_bot_id: fixtureId(), booking_id: fixtureId() };
    await expect(runDef(w.h, r1MeetBotReleaseDefinition, payload)).resolves.toEqual(done('processed', 'released_gone'));
    w.h.intercept('get', { status: 502 });
    await expect(runDef(w.h, r1MeetBotReleaseDefinition, payload)).resolves.toMatchObject({ outcome: 'defer' });
  });
});

describe('round_cancelled', () => {
  it('HR cancelled the round: the bot is released and the booking cancelled round_cancelled', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    w.h.db.cancelRound(booking.round_id as string);
    const [queued] = w.h.db.jobs('round_cancelled');
    w.reset();
    await expect(runDef(w.h, r1MeetRoundCancelledDefinition, queued!.payload)).resolves.toEqual(done('processed', 'cancelled'));
    expect(w.h.timeline).toEqual(['recall:get', 'recall:delete', 'db:cancel_booking', 'db:set_bot:release']);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'cancelled', reason: 'round_cancelled', recall_bot_id: null });
    // The same job again: terminal, no bot.
    await expect(runDef(w.h, r1MeetRoundCancelledDefinition, queued!.payload)).resolves.toEqual(done('ignored', 'booking_terminal'));
  });

  it('booking gone, or re-bound to another round: ignored', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    const gone = { kind: 'round_cancelled', booking_id: fixtureId(), round_id: booking.round_id };
    await expect(runDef(w.h, r1MeetRoundCancelledDefinition, gone)).resolves.toEqual(done('ignored', 'booking_gone'));
    const stale = { kind: 'round_cancelled', booking_id: booking.id, round_id: fixtureId() };
    await expect(runDef(w.h, r1MeetRoundCancelledDefinition, stale)).resolves.toEqual(done('ignored', 'round_rebound'));
    expect(w.h.requests).toEqual([]);
    expect(w.bookingOf(ev)).toMatchObject({ status: 'bot_scheduled' });
  });

  it('a terminal booking still holding its bot: the bot is released', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    await transition(w.h, booking.id as string, 'bot_scheduled', 'failed', 'no_show');
    const payload = { kind: 'round_cancelled', booking_id: booking.id, round_id: booking.round_id };
    await expect(runDef(w.h, r1MeetRoundCancelledDefinition, payload)).resolves.toEqual(done('processed', 'released_deleted'));
    expect(w.bookingOf(ev)).toMatchObject({ status: 'failed', reason: 'no_show', recall_bot_id: null });
  });
});

describe('ensure_bot', () => {
  it('a pending booking gets its bot', async () => {
    const w = world();
    const ev = w.event();
    w.h.intercept('create', { status: 503 });
    await w.run(w.job(ev));
    const booking = w.bookingOf(ev)!;
    await expect(runDef(w.h, r1MeetEnsureBotDefinition, { kind: 'ensure_bot', booking_id: booking.id })).resolves.toEqual(
      done('processed', 'bot_scheduled'),
    );
  });

  it('blocked by the cap: still at the cap -> nothing; raised -> reschedule (same slot), create, attach', async () => {
    const w = world({ config: { dailyBotCap: 1 } });
    await w.book(w.event());
    const ev = w.event();
    await expect(w.run(w.job(ev))).resolves.toEqual(done('processed', 'bot_cap_reached'));
    const payload = { kind: 'ensure_bot', booking_id: w.bookingOf(ev)!.id };
    w.reset();
    await expect(runDef(w.h, r1MeetEnsureBotDefinition, payload)).resolves.toEqual(done('ignored', 'bot_cap_reached'));
    expect(w.h.timeline).toEqual([]);
    expect(w.h.alerts()).toEqual([]);
    w.h.config.dailyBotCap = 2;
    await expect(runDef(w.h, r1MeetEnsureBotDefinition, payload)).resolves.toEqual(done('processed', 'bot_scheduled'));
    expect(w.h.timeline).toEqual(['db:reschedule_booking', 'recall:create', 'db:set_bot:attach']);
  });

  it('anything else is not its business', async () => {
    const w = world();
    const ev = w.event();
    const booking = await w.book(ev);
    await expect(runDef(w.h, r1MeetEnsureBotDefinition, { kind: 'ensure_bot', booking_id: booking.id })).resolves.toEqual(
      done('ignored', 'not_pending'),
    );
    await expect(runDef(w.h, r1MeetEnsureBotDefinition, { kind: 'ensure_bot', booking_id: fixtureId() })).resolves.toEqual(
      done('ignored', 'booking_gone'),
    );
    expect(w.h.requests).toEqual([]);
  });
});

// ── PII ─────────────────────────────────────────────────────────────────────

describe('no PII', () => {
  it('a whole life (book, block, move, too far, cancel) logs closed words only and enqueues no Meet URL', async () => {
    const w = world({ config: { dailyBotCap: 1 } });
    const a = w.event();
    const b = w.event();
    const booking = await w.book(a);
    await w.run(w.job(b));
    const start = Date.parse(a.startAt) + HOUR;
    await w.run(w.job(a, { startAt: iso(start), endAt: iso(start + HOUR), meetUrl: OTHER_MEET_URL }));
    const far = w.h.now() + 20 * DAY;
    await w.run(w.job(b, { startAt: iso(far), endAt: iso(far + HOUR) }));
    w.h.intercept('get', { status: 503 });
    await w.run(w.job(a, { decision: 'cancelled' }), w.h.meta({ deferCount: 30 }));
    const ids = [a.eventId, b.eventId, a.applicationId, b.applicationId, booking.id as string, w.scheduleId, SCHEDULER_ID];
    expectNoPii(w.h, ...ids, ...[...w.h.recall.bots.keys()]);
    for (const line of w.h.logs) {
      expect(Object.keys(line.meta).every((key) => ['error_category', 'error_type', 'http_status'].includes(key))).toBe(true);
    }
    for (const job of w.h.db.jobs()) {
      const text = JSON.stringify(job.payload);
      expect(text).not.toContain('meet.google.com');
      expect(text).not.toContain('@');
    }
  });
});

// ── Public-page bookings (M035 S02) ─────────────────────────────────────────

describe('public-page bookings (M035 S02): the Ashby paths refuse them', () => {
  const rpcCalls = (h: R1MeetHarness) => h.db.calls.filter((call) => call.kind === 'rpc');

  it('booking_rerun of a public row answers ignored(public_booking) before the reason check, the slot check and any RPC', async () => {
    const w = world();
    const pb = w.h.createPublicBooking();
    // A parked public row too (the public RPC never parks one, but the refusal must not depend on it).
    const parked = w.h.db.seedPublicBooking({ status: 'blocked', reason: 'capacity_exhausted' });
    w.reset();
    w.h.db.calls.length = 0;
    const payloads = [
      { kind: 'booking_rerun', booking_id: pb.bookingId, reason: 'capacity_exhausted', n: 0 },
      { kind: 'booking_rerun', booking_id: parked.id, reason: 'capacity_exhausted', n: 0 },
      { kind: 'booking_rerun', booking_id: parked.id, reason: 'paused', n: 2 },
    ];
    for (const payload of payloads) {
      await expect(runDef(w.h, r1MeetBookingRerunDefinition, payload)).resolves.toEqual(done('ignored', 'public_booking'));
    }
    // A slot that has started: still the public refusal (it comes first).
    w.h.setNow(Date.parse(w.h.db.booking(pb.bookingId)!.end_at as string));
    await expect(runDef(w.h, r1MeetBookingRerunDefinition, payloads[0])).resolves.toEqual(done('ignored', 'public_booking'));

    expect(rpcCalls(w.h)).toEqual([]);
    expect(w.h.db.calls.every((call) => call.kind === 'from' && call.name === 'r1_meet_bookings')).toBe(true);
    expect(w.h.requests).toEqual([]);
    expect(w.h.timeline).toEqual([]);
    expect(w.h.db.jobs()).toEqual([]);
    expect(w.h.db.booking(pb.bookingId)).toMatchObject({ status: 'pending', reason: 'eligible', version: 0, key_attempt: 0 });
    expect(w.h.db.booking(parked.id)).toMatchObject({ status: 'blocked', reason: 'capacity_exhausted', version: 0 });
    expectNoPii(w.h, pb.bookingId, parked.id);
  });

  it('an Ashby booking_rerun replays the stored delivery into r1_meet_create_round_from_ashby, argument for argument', async () => {
    const w = world();
    w.h.db.settings.sendRound = 'capacity_exhausted';
    const ev = w.event(3 * DAY);
    await w.run(w.job(ev));
    const stored = { ...w.bookingOf(ev)! };
    w.reset();
    w.h.db.settings.sendRound = 'ok';
    const [rerun] = w.h.db.jobs('booking_rerun');
    w.h.setNow(Date.parse(rerun!.scheduled_at as string));
    w.h.db.calls.length = 0;

    await expect(runDef(w.h, r1MeetBookingRerunDefinition, rerun!.payload)).resolves.toEqual(done('processed', 'bot_scheduled'));

    const createCalls = rpcCalls(w.h).filter((call) => call.name === 'r1_meet_create_round_from_ashby');
    expect(createCalls).toHaveLength(1);
    const expected = {
      p_ashby_interview_event_id: ev.eventId,
      p_ashby_schedule_id: w.scheduleId,
      p_ashby_application_id: ev.applicationId,
      p_ashby_interview_stage_id: null,
      p_ashby_interview_id: null,
      p_ashby_scheduled_by_user_id: SCHEDULER_ID,
      // When HR attested: the stored Ashby updatedAt (it is before now).
      p_attested_at: stored.ashby_updated_at,
      p_ashby_updated_at: stored.ashby_updated_at,
      p_meet_url: MEET_URL,
      p_start_at: ev.startAt,
      p_end_at: ev.endAt,
      p_created_by: STAFF_USER_ID,
      p_objective_profile: 'r1_dex_sales',
      p_expiry_grace_sec: 7200,
      p_now: iso(w.h.now()),
    };
    expect(createCalls[0]!.args).toEqual(expected);
    // Byte for byte, key order included: the M034 argument object is unchanged.
    expect(JSON.stringify(createCalls[0]!.args)).toBe(JSON.stringify(expected));
    expect(typeof stored.ashby_updated_at).toBe('string');
    expect(creates(w.h)[0]!.headers['idempotency-key']).toBe(keyOf(ev.eventId, 0, 0));
  });

  describe('the three places that act on a booking id the Ashby create RPC answered', () => {
    /** A public booking holding an undispatched bot, and an eligible Ashby event job for another slot. */
    async function setup() {
      const w = world();
      const pb = w.h.createPublicBooking();
      await expect(ensureBot(w.h.deps, pb.bookingId, w.h.meta())).resolves.toMatchObject({ code: 'bot_scheduled' });
      const row = w.h.db.booking(pb.bookingId)!;
      const before = { ...row };
      const ev = w.event(2 * DAY);
      w.reset();
      w.h.db.calls.length = 0;
      return { w, pb, row: () => w.h.db.booking(pb.bookingId)!, before, payload: w.job(ev) };
    }

    const answers = (pb: { bookingId: string; roundId: string }): Array<[string, R1MeetCreateAnswer]> => [
      [
        'exists',
        {
          status: 'exists',
          bookingId: pb.bookingId,
          roundId: pb.roundId,
          bookingStatus: 'bot_scheduled',
          reason: 'eligible',
          version: 0,
          keyAttempt: 0,
          roundExpiresAt: null,
          roundLive: true,
          objectiveProfile: 'r1_dex_sales',
        },
      ],
      ['bot_attached', { status: 'bot_attached', bookingId: pb.bookingId, bookingStatus: 'bot_scheduled', version: 0, keyAttempt: 0 }],
      ['in_past', { status: 'in_past', bookingId: pb.bookingId }],
    ];

    it.each(['exists', 'bot_attached', 'in_past'])('%s with a public booking id: ignored(public_booking), no Recall call, no RPC', async (status) => {
      const { w, pb, row, before, payload } = await setup();
      const answer = answers(pb).find(([name]) => name === status)![1];
      const asked: unknown[] = [];
      const deps = {
        ...w.h.deps,
        store: {
          ...w.h.deps.store,
          createRound: async (input: unknown) => {
            asked.push(input);
            return answer;
          },
        },
      };
      const job = r1MeetAshbyScheduleDefinition.parse(payload);
      if (job === null) throw new Error('test: the payload did not parse');
      await expect(r1MeetAshbyScheduleDefinition.run(deps, job, w.h.meta())).resolves.toEqual(done('ignored', 'public_booking'));
      expect(asked).toHaveLength(1);
      expect(w.h.requests).toEqual([]);
      expect(rpcCalls(w.h)).toEqual([]);
      expect(w.h.db.jobs('bot_release')).toEqual([]);
      expect(row()).toEqual(before);
      expect(w.h.recall.bots.has(before.recall_bot_id as string)).toBe(true);
      expectNoPii(w.h, pb.bookingId, before.recall_bot_id as string);
    });
  });
});
