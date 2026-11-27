/**
 * M034 S06 T2: creating a booking's Recall bot (lib/r1/meet/bot-flow.ts, `ensureBot`), driven through
 * the REAL Recall client over the S01 fake and the in-memory 0142 port.
 *
 * Pinned (D-S06-13..16):
 *  - the create body: canonical Meet URL, join_at = start - 120 s, web_4_core, automatic_leave
 *    600/900/90/900/2700 plus explicit bot detection (M035 S09), participant events only, the
 *    disclosure pinned at bot join and re-sent at each participant join (M035 S09), no
 *    `google_meet` for the default guest bot, metadata = booking id + profile, no name or email;
 *  - the Idempotency-Key `r1-meet-<event>-v<version>-k<key_attempt>` from the booking as the LAST RPC
 *    left it;
 *  - a lost answer retried returns the SAME bot under the SAME key; a cached 500, 400 or 402 is
 *    replayed under the old key and cured only by `rotate_key`; 409 in progress, 429, 507, 502..504,
 *    network and timeout keep the key; `key_attempts_exhausted` and a permanent 4xx fail the booking;
 *  - the daily cap by IST day (other days and bot-less bookings not counted), the late limit and a
 *    round that is not live: no Recall call at all;
 *  - every attach refusal, the orphan's `bot_release` queued before anything else, `bot_in_use` never
 *    released; a run killed between create and attach replays into one bot;
 *  - no id, URL, name or email in any log line.
 */

import { describe, expect, it } from 'vitest';
import { ensureBot, R1_MEET_LATE_CREATE_LIMIT_MS } from '../lib/r1/meet/bot-flow.js';
import { R1MeetJobError } from '../lib/r1/meet/jobs.js';
import {
  MEET_URL,
  OTHER_MEET_URL,
  REALTIME_URL,
  createR1MeetHarness,
  fixtureId,
  type R1MeetHarness,
} from './support/r1-meet-harness.js';

const MINUTE = 60_000;

async function pendingBooking(h: R1MeetHarness, options: Parameters<R1MeetHarness['createBooking']>[0] = {}) {
  const eventId = options.eventId ?? fixtureId();
  const created = await h.createBooking({ ...options, eventId });
  h.timeline.length = 0;
  h.requests.length = 0;
  h.logs.length = 0;
  return { id: created.bookingId, eventId, row: () => h.db.booking(created.bookingId)! };
}

const creates = (h: R1MeetHarness) => h.requests.filter((request) => request.op === 'create');
const keyOf = (eventId: string, version: number, keyAttempt: number) => `r1-meet-${eventId}-v${version}-k${keyAttempt}`;

function expectNoPii(h: R1MeetHarness, ...values: string[]): void {
  const text = JSON.stringify(h.logs);
  for (const value of [...values, 'meet.google.com', '@', 'hello.example.test']) expect(text).not.toContain(value);
}

describe('ensureBot: the happy path', () => {
  it('creates the bot with the pinned body and key, then attaches it', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    const startAt = b.row().start_at as string;

    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toEqual({ outcome: 'done', receipt: 'processed', code: 'bot_scheduled' });

    const [create] = creates(h);
    expect(create!.headers['idempotency-key']).toBe(keyOf(b.eventId, 0, 0));
    expect(create!.body).toEqual({
      meeting_url: MEET_URL,
      bot_name: 'Lexy',
      join_at: new Date(Date.parse(startAt) - 120_000).toISOString(),
      variant: { google_meet: 'web_4_core' },
      automatic_leave: {
        waiting_room_timeout: 600,
        noone_joined_timeout: 900,
        everyone_left_timeout: { timeout: 90 },
        in_call_not_recording_timeout: 900,
        in_call_recording_timeout: 2700,
        bot_detection: {
          using_participant_events: { timeout: 600, activate_after: 1200 },
          using_participant_names: { matches: ['notetaker', 'recorder', 'assistant'], timeout: 600, activate_after: 7200 },
        },
      },
      recording_config: {
        transcript: null,
        video_mixed_mp4: null,
        meeting_metadata: null,
        participant_events: {},
        start_recording_on: 'participant_join',
        retention: { type: 'timed', hours: 1 },
        realtime_endpoints: [
          { type: 'webhook', url: REALTIME_URL, events: ['participant_events.join', 'participant_events.leave'] },
        ],
      },
      chat: {
        on_bot_join: {
          send_to: 'everyone',
          message: 'Lexy is an AI interviewer from Interview Kickstart. This call is recorded.',
          pin: true,
        },
        on_participant_join: {
          message: 'Dex is an AI interviewer from Interview Kickstart. This call is recorded.',
          exclude_host: false,
        },
      },
      metadata: { booking_id: b.id, profile: 'r1_dex_sales' },
    });
    // The default (guest) bot: no login group, so no google_meet block at all.
    expect('google_meet' in (create!.body as Record<string, unknown>)).toBe(false);
    // No candidate data in the body: no email, no candidate or round id.
    const text = JSON.stringify(create!.body);
    expect(text).not.toContain('@');
    expect(text).not.toContain(b.row().candidate_id as string);
    expect(text).not.toContain(b.row().round_id as string);

    const [bot] = [...h.recall.bots.keys()];
    expect(b.row()).toMatchObject({ status: 'bot_scheduled', reason: 'eligible', recall_bot_id: bot, version: 0, key_attempt: 0 });
    expect(h.timeline).toEqual(['recall:create', 'db:set_bot:attach']);
    expectNoPii(h, b.id, bot!, b.eventId);
  });

  it('a signed-in login group and a bot name override reach the body', async () => {
    const h = createR1MeetHarness({
      config: { botNameOverride: 'Dex (AI)', recall: { googleLoginGroupId: '7f000000-0000-4000-8000-0000000000aa' } },
    });
    const b = await pendingBooking(h);
    await ensureBot(h.deps, b.id, h.meta());
    expect(creates(h)[0]!.body).toMatchObject({
      bot_name: 'Dex (AI)',
      google_meet: { google_login_group_id: '7f000000-0000-4000-8000-0000000000aa' },
    });
  });

  it('the key comes from the booking as the last RPC left it (a reschedule bumped the generation)', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    const start = Date.parse(b.row().start_at as string) + 60 * MINUTE;
    const moved = await h.db.store.reschedule({
      bookingId: b.id,
      expectedVersion: 0,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 45 * MINUTE).toISOString(),
      meetUrl: OTHER_MEET_URL,
      ashbyUpdatedAt: null,
      nowIso: new Date(h.now()).toISOString(),
    });
    expect(moved).toMatchObject({ status: 'ok', version: 1, keyAttempt: 0 });
    await ensureBot(h.deps, b.id, h.meta());
    expect(creates(h)[0]!.headers['idempotency-key']).toBe(keyOf(b.eventId, 1, 0));
    expect(creates(h)[0]!.body).toMatchObject({ meeting_url: OTHER_MEET_URL });
  });

  it('two runs at once make ONE bot: the second attach answers duplicate', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    const results = await Promise.all([ensureBot(h.deps, b.id, h.meta()), ensureBot(h.deps, b.id, h.meta())]);
    expect(results.map((result) => result.code)).toEqual(['bot_scheduled', 'bot_scheduled']);
    expect(h.recall.bots.size).toBe(1);
    expect(creates(h).map((request) => request.headers['idempotency-key'])).toEqual([keyOf(b.eventId, 0, 0), keyOf(b.eventId, 0, 0)]);
    expect(h.db.jobs('bot_release')).toEqual([]);
  });

  it('a booking that is not pending, or gone, is left alone', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    await ensureBot(h.deps, b.id, h.meta());
    h.requests.length = 0;
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toMatchObject({ receipt: 'ignored', code: 'not_pending' });
    await expect(ensureBot(h.deps, fixtureId(), h.meta())).resolves.toMatchObject({ receipt: 'ignored', code: 'booking_gone' });
    expect(h.requests).toEqual([]);
  });
});

describe('ensureBot: idempotent retries and the key rotation', () => {
  it('a lost answer: deferred under the same key, and the retry returns the SAME bot', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    h.intercept('create', 'lost');
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toEqual({
      outcome: 'defer',
      code: 'r1_meet_recall_unavailable',
      delaySeconds: 5,
    });
    expect(b.row()).toMatchObject({ status: 'pending', key_attempt: 0, recall_bot_id: null });
    expect(h.recall.bots.size).toBe(1);

    await expect(ensureBot(h.deps, b.id, h.meta({ deferCount: 1 }))).resolves.toMatchObject({ code: 'bot_scheduled' });
    expect(h.recall.bots.size).toBe(1);
    expect(b.row().recall_bot_id).toBe([...h.recall.bots.keys()][0]);
    expect(creates(h).map((request) => request.headers['idempotency-key'])).toEqual([keyOf(b.eventId, 0, 0), keyOf(b.eventId, 0, 0)]);
    expect(h.timeline).not.toContain('db:set_bot:rotate_key');
  });

  it('a cached 500 is replayed under k0, rotated first, and cured under k1', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    h.recall.failNext(500);
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toEqual({
      outcome: 'defer',
      code: 'r1_meet_recall_unavailable',
      delaySeconds: 10,
    });
    // Rotated BEFORE the deferral was decided.
    expect(h.timeline).toEqual(['recall:create', 'db:set_bot:rotate_key']);
    expect(b.row()).toMatchObject({ status: 'pending', version: 0, key_attempt: 1 });

    const body = creates(h)[0]!.body as Parameters<typeof h.client.createBot>[0];
    await expect(h.client.createBot(body, { idempotencyKey: keyOf(b.eventId, 0, 0) })).rejects.toMatchObject({
      httpStatus: 500,
      rotateIdempotencyKey: true,
    });

    await expect(ensureBot(h.deps, b.id, h.meta({ deferCount: 1 }))).resolves.toMatchObject({ code: 'bot_scheduled' });
    expect(creates(h).at(-1)!.headers['idempotency-key']).toBe(keyOf(b.eventId, 0, 1));
    expect(h.recall.bots.size).toBe(1);
  });

  it('a cached 402 alerts, rotates and waits 300 s; the old key keeps answering 402, the new one works', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    h.recall.failNext(402, { body: { detail: 'Payment required.' } });
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toEqual({
      outcome: 'defer',
      code: 'r1_meet_recall_rejected',
      delaySeconds: 300,
    });
    expect(h.alerts()).toEqual(['r1_meet_recall_rejected']);
    expect(b.row().key_attempt).toBe(1);
    const body = creates(h)[0]!.body as Parameters<typeof h.client.createBot>[0];
    await expect(h.client.createBot(body, { idempotencyKey: keyOf(b.eventId, 0, 0) })).rejects.toMatchObject({ httpStatus: 402 });
    await expect(ensureBot(h.deps, b.id, h.meta({ deferCount: 1 }))).resolves.toMatchObject({ code: 'bot_scheduled' });
    expect(creates(h).at(-1)!.headers['idempotency-key']).toBe(keyOf(b.eventId, 0, 1));
  });

  it('a permanent 400 rotates, then fails the booking bot_create_failed with an alert', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    h.recall.failNext(400, { body: { meeting_url: ['Invalid.'] } });
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toEqual({
      outcome: 'done',
      receipt: 'processed',
      code: 'bot_create_failed',
    });
    expect(h.timeline).toEqual(['recall:create', 'db:set_bot:rotate_key', 'db:transition:failed']);
    expect(b.row()).toMatchObject({ status: 'failed', reason: 'bot_create_failed', key_attempt: 1 });
    expect(h.logs.filter((line) => line.level === 'error').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_bot_create_failed', error_type: 'bad_request', http_status: 400 },
    ]);
    // The cache still answers the old key with the 400.
    const body = creates(h)[0]!.body as Parameters<typeof h.client.createBot>[0];
    await expect(h.client.createBot(body, { idempotencyKey: keyOf(b.eventId, 0, 0) })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('key_attempts_exhausted fails the booking bot_create_failed with an alert', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    b.row().key_attempt = 20;
    h.recall.failNext(500);
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toMatchObject({ code: 'bot_create_failed' });
    expect(creates(h)[0]!.headers['idempotency-key']).toBe(keyOf(b.eventId, 0, 20));
    expect(b.row()).toMatchObject({ status: 'failed', reason: 'bot_create_failed', key_attempt: 20 });
    expect(h.logs.filter((line) => line.level === 'error').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_bot_create_failed', error_type: 'key_attempts_exhausted' },
    ]);
  });

  const KEEP_THE_KEY: Array<[string, (h: R1MeetHarness) => void]> = [
    ['409 in progress', (h) => h.recall.failNext(409, { body: 'Another request with this idempotency-key is being processed.' })],
    ['429', (h) => h.recall.failNext(429, { headers: { 'Retry-After': '3' } })],
    ['507', (h) => h.recall.failNext(507)],
    ['502', (h) => h.recall.failNext(502)],
    ['503', (h) => h.recall.failNext(503)],
    ['504', (h) => h.recall.failNext(504)],
    ['network', (h) => h.intercept('create', 'network')],
    ['timeout', (h) => h.intercept('create', 'hang')],
  ];

  it.each(KEEP_THE_KEY)('%s defers and keeps the key: no rotate_key, and the retry uses k0', async (_label, inject) => {
    const h = createR1MeetHarness({ timeoutMs: 20 });
    const b = await pendingBooking(h);
    inject(h);
    const first = await ensureBot(h.deps, b.id, h.meta());
    expect(first).toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(b.row().key_attempt).toBe(0);
    expect(h.timeline).not.toContain('db:set_bot:rotate_key');
    await expect(ensureBot(h.deps, b.id, h.meta({ deferCount: 1 }))).resolves.toMatchObject({ code: 'bot_scheduled' });
    expect(creates(h).map((request) => request.headers['idempotency-key'])).toEqual([keyOf(b.eventId, 0, 0), keyOf(b.eventId, 0, 0)]);
    expect(h.recall.bots.size).toBe(1);
    expect(h.alerts()).toEqual([]);
  });

  it('past the deferral bound a transient failure throws its closed code (then the DLQ)', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    h.recall.failNext(503);
    await expect(ensureBot(h.deps, b.id, h.meta({ deferCount: 30 }))).rejects.toThrow(new R1MeetJobError('r1_meet_recall_http_server_error'));
    expect(b.row()).toMatchObject({ status: 'pending', key_attempt: 0 });
  });

  it('a run killed between create and attach replays into the same bot (no second bot)', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    h.db.failNext('r1_meet_set_bot');
    await expect(ensureBot(h.deps, b.id, h.meta())).rejects.toThrow(new R1MeetJobError('r1_meet_db_error'));
    expect(b.row()).toMatchObject({ status: 'pending', recall_bot_id: null });
    await expect(ensureBot(h.deps, b.id, h.meta({ attempts: 2 }))).resolves.toMatchObject({ code: 'bot_scheduled' });
    expect(h.recall.bots.size).toBe(1);
    expect(b.row().recall_bot_id).toBe([...h.recall.bots.keys()][0]);
    expect(h.db.jobs('bot_release')).toEqual([]);
  });
});

describe('ensureBot: refusals before any Recall call', () => {
  it('the daily cap counts bots of the same IST day only, and blocks with an alert at the cap', async () => {
    const h = createR1MeetHarness({ config: { dailyBotCap: 2 } });
    // Our slot: 2030-01-02T10:00Z, IST day = [2030-01-01T18:30Z, 2030-01-02T18:30Z).
    const b = await pendingBooking(h, { startAt: '2030-01-02T10:00:00.000Z' });
    const seed = (start: string, row: Record<string, unknown>) => {
      const round = h.db.addRound();
      return h.db.seedBooking({
        round_id: round.id,
        start_at: start,
        end_at: new Date(Date.parse(start) + 30 * MINUTE).toISOString(),
        ...row,
      });
    };
    seed('2030-01-01T18:30:00.000Z', { status: 'bot_scheduled', recall_bot_id: fixtureId() }); // first IST minute
    seed('2030-01-02T18:29:00.000Z', { status: 'completed', reason: 'attempt_settled', recall_bot_id: null });
    // Not counted: another IST day on both sides, a cancelled bot, a failure that never had a bot, a pending booking.
    seed('2030-01-02T18:30:00.000Z', { status: 'bot_scheduled', recall_bot_id: fixtureId() });
    seed('2030-01-01T18:29:00.000Z', { status: 'bot_scheduled', recall_bot_id: fixtureId() });
    seed('2030-01-02T11:00:00.000Z', { status: 'cancelled', reason: 'cancelled', recall_bot_id: null });
    seed('2030-01-02T12:00:00.000Z', { status: 'failed', reason: 'in_past', round_id: null, candidate_id: null });
    seed('2030-01-02T13:00:00.000Z', { status: 'pending' });

    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toEqual({ outcome: 'done', receipt: 'processed', code: 'bot_cap_reached' });
    expect(b.row()).toMatchObject({ status: 'blocked', reason: 'bot_cap_reached', recall_bot_id: null });
    expect(h.requests).toEqual([]);
    expect(h.alerts()).toEqual(['r1_meet_bot_cap_reached']);

    // Under the cap it creates.
    const h2 = createR1MeetHarness({ config: { dailyBotCap: 3 } });
    const b2 = await pendingBooking(h2, { startAt: '2030-01-02T10:00:00.000Z' });
    const round = h2.db.addRound();
    h2.db.seedBooking({ round_id: round.id, start_at: '2030-01-02T09:00:00.000Z', end_at: '2030-01-02T09:30:00.000Z', status: 'bot_scheduled', recall_bot_id: fixtureId() });
    await expect(ensureBot(h2.deps, b2.id, h2.meta())).resolves.toMatchObject({ code: 'bot_scheduled' });
  });

  it('a round that is not live fails the booking round_expired with no Recall call', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    h.db.tables.interview_rounds.find((round) => round.id === b.row().round_id)!.status = 'expired';
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toMatchObject({ code: 'round_expired' });
    expect(b.row()).toMatchObject({ status: 'failed', reason: 'round_expired' });
    expect(h.requests).toEqual([]);
  });

  it('past min(end, start + 15 min) no bot is created: failed bot_create_failed + alert', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    const start = Date.parse(b.row().start_at as string);
    h.setNow(start + R1_MEET_LATE_CREATE_LIMIT_MS);
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toMatchObject({ code: 'bot_create_failed' });
    expect(b.row()).toMatchObject({ status: 'failed', reason: 'bot_create_failed' });
    expect(h.requests).toEqual([]);
    expect(h.logs.map((line) => line.meta)).toEqual([{ error_category: 'r1_meet_bot_create_failed', error_type: 'too_late' }]);

    // A 10-minute slot: its end comes first.
    const h2 = createR1MeetHarness();
    const short = await pendingBooking(h2, {
      startAt: '2030-01-02T10:00:00.000Z',
      endAt: '2030-01-02T10:10:00.000Z',
    });
    h2.setNow('2030-01-02T10:10:00.000Z');
    await expect(ensureBot(h2.deps, short.id, h2.meta())).resolves.toMatchObject({ code: 'bot_create_failed' });
    expect(h2.requests).toEqual([]);
  });

  it('a late create omits join_at (the bot joins now); 5 s ahead or more keeps it', async () => {
    const cases: Array<[number, boolean]> = [
      [-60_000, false], // join_at (start - 120 s) is 60 s in the past... now = start - 60 s
      [-124_000, false], // join_at 4 s ahead
      [-125_000, true], // join_at exactly 5 s ahead
      [14 * MINUTE, false], // inside the slot, before the late limit
    ];
    for (const [offset, keeps] of cases) {
      const h = createR1MeetHarness();
      const b = await pendingBooking(h);
      const start = Date.parse(b.row().start_at as string);
      h.setNow(start + offset);
      await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toMatchObject({ code: 'bot_scheduled' });
      const body = creates(h)[0]!.body as Record<string, unknown>;
      expect('join_at' in body, String(offset)).toBe(keeps);
      if (keeps) expect(body.join_at).toBe(new Date(start - 120_000).toISOString());
    }
  });

  it('an unknown profile on the row alerts and throws; a bad configuration alerts and throws; no Recall call', async () => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    b.row().objective_profile = 'r1_not_this_build';
    await expect(ensureBot(h.deps, b.id, h.meta())).rejects.toThrow(new R1MeetJobError('r1_meet_profile_unknown'));
    expect(h.alerts()).toEqual(['r1_meet_profile_unknown']);

    const h2 = createR1MeetHarness({ config: { recallRealtimeWebhookUrl: 'http://hello.example.test/api/integrations/recall/realtime' } });
    const b2 = await pendingBooking(h2);
    await expect(ensureBot(h2.deps, b2.id, h2.meta())).rejects.toThrow(new R1MeetJobError('r1_meet_bot_body_invalid'));
    expect(h2.logs.map((line) => line.meta)).toEqual([{ error_category: 'r1_meet_bot_create_failed', error_type: 'invalid_realtime_url' }]);
    expect(h.requests).toEqual([]);
    expect(h2.requests).toEqual([]);
  });
});

describe('ensureBot: every attach refusal (D-S06-14)', () => {
  type Refusal = {
    readonly status: string;
    readonly break: (h: R1MeetHarness, b: { id: string; row: () => Record<string, any> }, botId: string) => void;
    readonly released: boolean;
    readonly final: Record<string, unknown> | null;
    readonly code: string;
  };
  const REFUSALS: Refusal[] = [
    {
      status: 'version_conflict',
      break: (_h, b) => {
        b.row().version = 1;
      },
      released: true,
      final: { status: 'pending', recall_bot_id: null },
      code: 'attach_version_conflict',
    },
    {
      status: 'not_allowed',
      break: (_h, b) => Object.assign(b.row(), { status: 'blocked', reason: 'paused' }),
      released: true,
      final: { status: 'blocked', recall_bot_id: null },
      code: 'attach_not_allowed',
    },
    {
      status: 'bot_conflict',
      break: (_h, b) => Object.assign(b.row(), { status: 'bot_scheduled', recall_bot_id: '7f000000-0000-4000-8000-0000000000e9' }),
      released: true,
      final: { status: 'bot_scheduled', recall_bot_id: '7f000000-0000-4000-8000-0000000000e9' },
      code: 'attach_bot_conflict',
    },
    {
      status: 'in_past',
      break: (h, b) => h.setNow(Date.parse(b.row().end_at)),
      released: true,
      final: { status: 'failed', reason: 'in_past', recall_bot_id: null },
      code: 'in_past',
    },
    {
      status: 'round_not_live',
      break: (h, b) => {
        h.db.tables.interview_rounds.find((round) => round.id === b.row().round_id)!.status = 'cancelled';
      },
      released: true,
      final: { status: 'failed', reason: 'round_expired', recall_bot_id: null },
      code: 'round_expired',
    },
    {
      status: 'not_found',
      break: (h, b) => h.db.deleteBooking(b.id),
      released: true,
      final: null,
      code: 'attach_not_found',
    },
    {
      status: 'bot_in_use',
      break: (h, _b, botId) => {
        const round = h.db.addRound();
        h.db.seedBooking({ round_id: round.id, status: 'bot_scheduled', recall_bot_id: botId });
      },
      released: false,
      final: { status: 'pending', recall_bot_id: null },
      code: 'attach_bot_in_use',
    },
  ];

  it.each(REFUSALS)('$status', async (refusal) => {
    const h = createR1MeetHarness();
    const b = await pendingBooking(h);
    let botId = '';
    h.afterRecall = (op, response) => {
      if (op !== 'create') return;
      botId = (response as { id: string }).id;
      refusal.break(h, b, botId);
    };
    await expect(ensureBot(h.deps, b.id, h.meta())).resolves.toMatchObject({ code: refusal.code });
    const releases = h.db.jobs('bot_release');
    if (refusal.released) {
      expect(releases.map((job) => [job.payload, job.dedup_key, job.max_attempts])).toEqual([
        [{ kind: 'bot_release', recall_bot_id: botId, booking_id: b.id }, `r1-meet:bot-release:${botId}`, 10],
      ]);
      // Queued right after the refused attach, before the booking is marked.
      const attachAt = h.timeline.indexOf('db:set_bot:attach');
      expect(h.timeline[attachAt + 1]).toBe('queue:bot_release');
    } else {
      expect(releases).toEqual([]);
      expect(h.alerts()).toEqual(['r1_meet_bot_in_use']);
    }
    if (refusal.final === null) expect(h.db.booking(b.id)).toBeUndefined();
    else expect(b.row()).toMatchObject(refusal.final);
    // The bot itself is untouched by this run: the release job removes it.
    expect(h.recall.bots.has(botId)).toBe(true);
  });
});
