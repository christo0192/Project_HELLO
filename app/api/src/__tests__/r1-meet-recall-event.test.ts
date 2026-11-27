/**
 * M034 S03 T1: the Recall event job builder (`lib/r1/meet/recall-event.ts`).
 *
 * A verified Recall body becomes the `recall_event` job (contract §2, exact keys and order), or is
 * `ignored_event` (no Meet meaning on that endpoint) or `malformed_event`. The builder is pure, never
 * throws, freezes its result, lower-cases ids, canonicalises times, and never reads a participant's
 * email, platform or extra data. M035 S09 T2: a JOIN's display name is read once, compared in memory
 * with the bot's own display name (`r1MeetSameDisplayName`) and dropped; only `is_bot: true` is kept.
 * Fake data only: fixed fake UUIDs, `Example` names, the bot's own fixture name `Dex`,
 * `example.invalid` emails.
 */
import { describe, expect, it } from 'vitest';
import { R1_MEET_RECALL_REALTIME_PATH as CONFIG_REALTIME_PATH } from '../lib/r1/meet/config.js';
import { R1_MEET_REALTIME_EVENTS } from '../lib/r1/meet/recall-bot.js';
import {
  R1_MEET_RECALL_EVENT_FAILURES,
  R1_MEET_RECALL_MOUNT_PATH,
  R1_MEET_RECALL_REALTIME_PATH,
  R1_MEET_RECALL_STATUS_EVENTS,
  R1_MEET_RECALL_STATUS_PATH,
  R1_MEET_RECALL_SUBPATHS,
  buildR1MeetRecallEventJob,
  r1MeetRecallEventsFor,
  r1MeetSameDisplayName,
  type R1MeetRecallEndpoint,
  type R1MeetRecallEventJob,
  type R1MeetRecallEventOptions,
} from '../lib/r1/meet/recall-event.js';

const BOT_ID = '7f000000-0000-4000-8000-000000000001';
const BOOKING_ID = '7f000000-0000-4000-8000-000000000002';
const PAYLOAD_KEYS = ['kind', 'event_type', 'recall_bot_id', 'booking_id', 'occurred_at', 'sub_code', 'participant'];

const PARTICIPANT_NAME = 'Example Person';
const PARTICIPANT_EMAIL = 'person@example.invalid';
const PARTICIPANT_PLATFORM = 'desktop_fixture_platform';
const EXTRA_MARKER = 'extra_fixture_marker';

type Json = Record<string, unknown>;

function statusBody(event: string, inner: Json = {}, bot: Json = {}): Json {
  return {
    event,
    data: {
      data: { code: event.replace(/^bot\./, ''), sub_code: null, updated_at: '2026-12-01T10:29:00.123456Z', ...inner },
      bot: { id: BOT_ID, metadata: { booking_id: BOOKING_ID, profile: 'r1_dex_sales' }, ...bot },
    },
  };
}

function participantFields(overrides: Json = {}): Json {
  return {
    id: 100,
    name: PARTICIPANT_NAME,
    is_host: false,
    platform: PARTICIPANT_PLATFORM,
    extra_data: { google_meet: { static_participant_id: EXTRA_MARKER } },
    email: PARTICIPANT_EMAIL,
    ...overrides,
  };
}

function participantBody(event: string, participant: unknown = participantFields(), inner: Json = {}, bot: Json = {}): Json {
  return {
    event,
    data: {
      data: {
        participant,
        timestamp: { absolute: '2026-12-01T16:00:05.5+05:30', relative: 12.5 },
        data: null,
        ...inner,
      },
      realtime_endpoint: { id: '7f000000-0000-4000-8000-000000000011', metadata: {} },
      participant_events: { id: '7f000000-0000-4000-8000-000000000012', metadata: {} },
      recording: { id: '7f000000-0000-4000-8000-000000000013', metadata: {} },
      bot: { id: BOT_ID, metadata: { booking_id: BOOKING_ID, profile: 'r1_dex_sales' }, ...bot },
    },
  };
}

function okPayload(job: R1MeetRecallEventJob) {
  if (!job.ok) throw new Error(`expected ok, got ${job.reason}`);
  return job.payload;
}

// ── Constants ────────────────────────────────────────────────────────────────

describe('Recall endpoints and event lists', () => {
  it('derives both paths from the mount, and the real-time path is the one the bot builder writes', () => {
    expect(R1_MEET_RECALL_MOUNT_PATH).toBe('/api/integrations/recall');
    expect(R1_MEET_RECALL_MOUNT_PATH + '/realtime').toBe(R1_MEET_RECALL_REALTIME_PATH);
    expect(R1_MEET_RECALL_MOUNT_PATH + '/realtime').toBe(CONFIG_REALTIME_PATH);
    expect(R1_MEET_RECALL_MOUNT_PATH + '/webhook').toBe(R1_MEET_RECALL_STATUS_PATH);
    expect(R1_MEET_RECALL_MOUNT_PATH + R1_MEET_RECALL_SUBPATHS.status).toBe(R1_MEET_RECALL_STATUS_PATH);
    expect(R1_MEET_RECALL_MOUNT_PATH + R1_MEET_RECALL_SUBPATHS.realtime).toBe(R1_MEET_RECALL_REALTIME_PATH);
    expect(Object.isFrozen(R1_MEET_RECALL_SUBPATHS)).toBe(true);
  });

  it('the status endpoint accepts the nine bot.* events in lifecycle order; real-time accepts R1_MEET_REALTIME_EVENTS', () => {
    expect([...R1_MEET_RECALL_STATUS_EVENTS]).toEqual([
      'bot.joining_call',
      'bot.in_waiting_room',
      'bot.in_call_not_recording',
      'bot.recording_permission_allowed',
      'bot.recording_permission_denied',
      'bot.in_call_recording',
      'bot.call_ended',
      'bot.done',
      'bot.fatal',
    ]);
    expect(Object.isFrozen(R1_MEET_RECALL_STATUS_EVENTS)).toBe(true);
    expect(r1MeetRecallEventsFor('status')).toBe(R1_MEET_RECALL_STATUS_EVENTS);
    expect(r1MeetRecallEventsFor('realtime')).toEqual(R1_MEET_REALTIME_EVENTS);
    expect(r1MeetRecallEventsFor('realtime')).toBe(R1_MEET_REALTIME_EVENTS);
    expect(r1MeetRecallEventsFor('elsewhere' as R1MeetRecallEndpoint)).toEqual([]);
    expect([...R1_MEET_RECALL_EVENT_FAILURES]).toEqual(['ignored_event', 'malformed_event']);
  });
});

// ── ok jobs ──────────────────────────────────────────────────────────────────

describe('buildR1MeetRecallEventJob: status events', () => {
  it.each([...R1_MEET_RECALL_STATUS_EVENTS])('%s on status gives the exact payload, participant null', (event) => {
    const job = buildR1MeetRecallEventJob(statusBody(event), 'status');
    expect(job).toStrictEqual({
      ok: true,
      eventType: event,
      bookingId: BOOKING_ID,
      payload: {
        kind: 'recall_event',
        event_type: event,
        recall_bot_id: BOT_ID,
        booking_id: BOOKING_ID,
        occurred_at: '2026-12-01T10:29:00.123Z',
        sub_code: null,
        participant: null,
      },
    });
    expect(Object.keys(okPayload(job))).toEqual(PAYLOAD_KEYS);
  });

  it('passes a sub_code through (bot.fatal, google_meet_bot_blocked)', () => {
    const payload = okPayload(
      buildR1MeetRecallEventJob(statusBody('bot.fatal', { sub_code: 'google_meet_bot_blocked' }), 'status'),
    );
    expect(payload.sub_code).toBe('google_meet_bot_blocked');
    expect(payload.event_type).toBe('bot.fatal');
  });

  it.each<[string, unknown]>([
    ['a space', 'bad code'],
    ['129 characters', 's'.repeat(129)],
    ['a number', 42],
    ['an object', { code: 'x' }],
    ['an empty string', ''],
  ])('a sub_code with %s gives null', (_label, subCode) => {
    expect(okPayload(buildR1MeetRecallEventJob(statusBody('bot.call_ended', { sub_code: subCode }), 'status')).sub_code).toBeNull();
  });

  it('keeps a 128-character sub_code', () => {
    const subCode = 'a'.repeat(128);
    expect(okPayload(buildR1MeetRecallEventJob(statusBody('bot.call_ended', { sub_code: subCode }), 'status')).sub_code).toBe(subCode);
  });

  it('reads updated_at for status events (a participant timestamp is ignored there)', () => {
    const payload = okPayload(
      buildR1MeetRecallEventJob(
        statusBody('bot.done', { updated_at: '2026-12-01T10:45:00Z', timestamp: { absolute: '2026-12-01T09:00:00Z' } }),
        'status',
      ),
    );
    expect(payload.occurred_at).toBe('2026-12-01T10:45:00.000Z');
  });

  it('a missing inner data object gives null time and sub code, still ok', () => {
    const body = { event: 'bot.done', data: { bot: { id: BOT_ID, metadata: { booking_id: BOOKING_ID } } } };
    expect(okPayload(buildR1MeetRecallEventJob(body, 'status'))).toMatchObject({ occurred_at: null, sub_code: null, participant: null });
  });
});

describe('buildR1MeetRecallEventJob: participant events', () => {
  it.each([...R1_MEET_REALTIME_EVENTS])('%s on realtime gives a participant object, is_bot null when absent, sub_code null', (event) => {
    const job = buildR1MeetRecallEventJob(participantBody(event, participantFields(), { sub_code: 'ignored_here' }), 'realtime');
    expect(job).toStrictEqual({
      ok: true,
      eventType: event,
      bookingId: BOOKING_ID,
      payload: {
        kind: 'recall_event',
        event_type: event,
        recall_bot_id: BOT_ID,
        booking_id: BOOKING_ID,
        occurred_at: '2026-12-01T10:30:05.500Z',
        sub_code: null,
        participant: { id: 100, is_host: false, is_bot: null },
      },
    });
    expect(Object.keys(okPayload(job))).toEqual(PAYLOAD_KEYS);
    expect(Object.keys(okPayload(job).participant!)).toEqual(['id', 'is_host', 'is_bot']);
  });

  it('keeps is_bot and is_host when Recall sends booleans; a participant Recall calls a bot keeps no id (S09-R3)', () => {
    const participant = (event: string, fields: Json) =>
      okPayload(buildR1MeetRecallEventJob(participantBody(event, participantFields(fields)), 'realtime')).participant;
    expect(participant('participant_events.join', { is_bot: false, is_host: true, id: 0 })).toStrictEqual({
      id: 0,
      is_host: true,
      is_bot: false,
    });
    // Recall's own verdict: never counted and never the bot's own, so the handler ignores it outright.
    for (const event of R1_MEET_REALTIME_EVENTS) {
      expect(participant(event, { is_bot: true, is_host: true, id: 0 }), event).toStrictEqual({
        id: null,
        is_host: true,
        is_bot: true,
      });
    }
  });

  it("Recall's own is_bot true: the name is never read, whatever it is (S09-R3)", () => {
    let nameReads = 0;
    const fields = participantFields({ is_bot: true });
    Object.defineProperty(fields, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        nameReads += 1;
        return 'Dex';
      },
    });
    const payload = okPayload(buildR1MeetRecallEventJob(participantBody('participant_events.join', fields), 'realtime'));
    expect(payload.participant).toStrictEqual({ id: null, is_host: false, is_bot: true });
    expect(nameReads).toBe(0);
  });

  it.each<[string, unknown]>([
    ['-1', -1],
    ['1.5', 1.5],
    ["'7'", '7'],
    ['2**53', 2 ** 53],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['missing', undefined],
  ])('a participant id of %s gives null', (_label, id) => {
    const fields = participantFields({ id });
    if (id === undefined) delete fields.id;
    const payload = okPayload(buildR1MeetRecallEventJob(participantBody('participant_events.leave', fields), 'realtime'));
    expect(payload.participant!.id).toBeNull();
  });

  it('keeps the largest safe integer id, and -0 becomes 0', () => {
    const big = okPayload(
      buildR1MeetRecallEventJob(participantBody('participant_events.join', participantFields({ id: 2 ** 53 - 1 })), 'realtime'),
    );
    expect(big.participant!.id).toBe(2 ** 53 - 1);
    const zero = okPayload(
      buildR1MeetRecallEventJob(participantBody('participant_events.join', participantFields({ id: -0 })), 'realtime'),
    );
    expect(Object.is(zero.participant!.id, 0)).toBe(true);
  });

  it('non-boolean flags give null', () => {
    const payload = okPayload(
      buildR1MeetRecallEventJob(
        participantBody('participant_events.join', participantFields({ is_host: 'true', is_bot: 'yes' })),
        'realtime',
      ),
    );
    expect(payload.participant).toStrictEqual({ id: 100, is_host: null, is_bot: null });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', PARTICIPANT_NAME],
    ['an array', [participantFields()]],
    ['missing', undefined],
  ])('a participant that is %s still gives the all-null participant object', (_label, participant) => {
    const body = participantBody('participant_events.join', participant ?? null);
    if (participant === undefined) delete ((body.data as Json).data as Json).participant;
    const payload = okPayload(buildR1MeetRecallEventJob(body, 'realtime'));
    expect(payload.participant).toStrictEqual({ id: null, is_host: null, is_bot: null });
  });

  it('reads timestamp.absolute for participant events (updated_at is ignored there)', () => {
    const payload = okPayload(
      buildR1MeetRecallEventJob(
        participantBody('participant_events.join', participantFields(), {
          timestamp: { absolute: 'not a time' },
          updated_at: '2026-12-01T10:45:00Z',
        }),
        'realtime',
      ),
    );
    expect(payload.occurred_at).toBeNull();
  });
});

// ── ids and times ────────────────────────────────────────────────────────────

describe('buildR1MeetRecallEventJob: ids and times', () => {
  it('lower-cases an upper-case bot id and booking id', () => {
    const job = buildR1MeetRecallEventJob(
      statusBody('bot.in_call_recording', {}, { id: BOT_ID.toUpperCase(), metadata: { booking_id: BOOKING_ID.toUpperCase() } }),
      'status',
    );
    expect(job).toMatchObject({ ok: true, bookingId: BOOKING_ID, payload: { recall_bot_id: BOT_ID, booking_id: BOOKING_ID } });
  });

  it.each<[string, unknown]>([
    ['a non-UUID string', { booking_id: 'booking-1' }],
    ['a number', { booking_id: 12345 }],
    ['an array', { booking_id: [BOOKING_ID] }],
    ['missing', { profile: 'r1_dex_sales' }],
    ['a braced UUID', { booking_id: `{${BOOKING_ID}}` }],
    ['metadata null', null],
    ['metadata an array', [BOOKING_ID]],
    ['metadata a string', BOOKING_ID],
  ])('a booking id from %s gives null', (_label, metadata) => {
    const job = buildR1MeetRecallEventJob(statusBody('bot.joining_call', {}, { metadata }), 'status');
    expect(job).toMatchObject({ ok: true, bookingId: null, payload: { booking_id: null } });
  });

  it('missing metadata gives a null booking id', () => {
    const body = { event: 'bot.joining_call', data: { data: { updated_at: '2026-12-01T10:28:00Z' }, bot: { id: BOT_ID } } };
    expect(buildR1MeetRecallEventJob(body, 'status')).toMatchObject({ ok: true, bookingId: null });
  });

  it.each<[string, string]>([
    ['2026-12-01T16:00:05.5+05:30', '2026-12-01T10:30:05.500Z'],
    ['2026-12-01T10:29:00.123456Z', '2026-12-01T10:29:00.123Z'],
    ['2026-12-01T10:29:00.123999Z', '2026-12-01T10:29:00.123Z'],
    ['2026-12-01T10:29:00.123456789Z', '2026-12-01T10:29:00.123Z'],
    ['2026-12-01T10:29:00Z', '2026-12-01T10:29:00.000Z'],
    ['2026-12-01T05:59:00-04:30', '2026-12-01T10:29:00.000Z'],
    ['2026-12-31T23:30:00-01:00', '2027-01-01T00:30:00.000Z'],
  ])('occurred_at %s is canonicalised to %s', (raw, canonical) => {
    expect(okPayload(buildR1MeetRecallEventJob(statusBody('bot.done', { updated_at: raw }), 'status')).occurred_at).toBe(canonical);
  });

  it.each<[string, unknown]>([
    ['words', 'yesterday'],
    ['30 February', '2026-02-30T10:00:00Z'],
    ['hour 24', '2026-12-01T24:00:00Z'],
    ['no offset', '2026-12-01T10:29:00'],
    ['a space separator', '2026-12-01 10:29:00Z'],
    ['no seconds', '2026-12-01T10:29Z'],
    ['over 64 characters', `2026-12-01T10:29:00.${'1'.repeat(60)}Z`],
    ['a number', 1796120940123],
    ['null', null],
    ['an object', { absolute: '2026-12-01T10:29:00Z' }],
  ])('occurred_at from %s gives null', (_label, raw) => {
    expect(okPayload(buildR1MeetRecallEventJob(statusBody('bot.done', { updated_at: raw }), 'status')).occurred_at).toBeNull();
  });
});

// ── ignored and malformed ────────────────────────────────────────────────────

describe('buildR1MeetRecallEventJob: ignored events (no Meet meaning on that endpoint)', () => {
  it.each<[string, Json, R1MeetRecallEndpoint]>([
    ['a participant event on status', participantBody('participant_events.join'), 'status'],
    ['a bot event on realtime', statusBody('bot.in_call_recording'), 'realtime'],
    ['a breakout event', statusBody('bot.breakout_room_entered'), 'status'],
    ['recording.done', statusBody('recording.done'), 'status'],
    ['transcript.data on realtime', participantBody('transcript.data'), 'realtime'],
    ['participant_events.update', participantBody('participant_events.update'), 'realtime'],
    ['participant_events.chat_message', participantBody('participant_events.chat_message'), 'realtime'],
    ['an unknown string', statusBody('bot.something_new'), 'status'],
    ['a case variant', statusBody('BOT.DONE'), 'status'],
    ['an empty event', statusBody(''), 'status'],
  ])('%s is ignored_event', (_label, body, endpoint) => {
    const job = buildR1MeetRecallEventJob(body, endpoint);
    expect(job).toStrictEqual({ ok: false, reason: 'ignored_event' });
    expect(Object.isFrozen(job)).toBe(true);
  });

  it('an unknown event is ignored even when the rest of the body is junk', () => {
    expect(buildR1MeetRecallEventJob({ event: 'bot.output_log', data: 'junk' }, 'status')).toStrictEqual({
      ok: false,
      reason: 'ignored_event',
    });
  });
});

describe('buildR1MeetRecallEventJob: malformed bodies', () => {
  class NotPlain {
    event = 'bot.done';
  }

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', '{"event":"bot.done"}'],
    ['a boolean', true],
    ['an array', [statusBody('bot.done')]],
    ['a class instance', new NotPlain()],
    ['a missing event', { data: statusBody('bot.done').data }],
    ['a numeric event', { event: 7, data: statusBody('bot.done').data }],
    ['a null event', { event: null, data: statusBody('bot.done').data }],
    ['an object event', { event: { name: 'bot.done' }, data: statusBody('bot.done').data }],
  ])('%s is malformed_event', (_label, body) => {
    const job = buildR1MeetRecallEventJob(body, 'status');
    expect(job).toStrictEqual({ ok: false, reason: 'malformed_event' });
    expect(Object.isFrozen(job)).toBe(true);
  });

  it.each<[string, Json]>([
    ['a missing bot id', statusBody('bot.done', {}, { id: undefined })],
    ['a non-UUID bot id', statusBody('bot.done', {}, { id: 'bot-123' })],
    ['a numeric bot id', statusBody('bot.done', {}, { id: 12345 })],
    ['a braced bot id', statusBody('bot.done', {}, { id: `{${BOT_ID}}` })],
    ['a bot that is not an object', { event: 'bot.done', data: { data: {}, bot: BOT_ID } }],
    ['a missing bot', { event: 'bot.done', data: { data: {} } }],
    ['data that is not an object', { event: 'bot.done', data: 'junk' }],
    ['missing data', { event: 'bot.done' }],
  ])('a known event with %s is malformed_event', (_label, body) => {
    expect(buildR1MeetRecallEventJob(body, 'status')).toStrictEqual({ ok: false, reason: 'malformed_event' });
  });

  it('a participant event with a bad bot id is malformed_event on realtime', () => {
    expect(buildR1MeetRecallEventJob(participantBody('participant_events.join', participantFields(), {}, { id: 'x' }), 'realtime')).toStrictEqual({
      ok: false,
      reason: 'malformed_event',
    });
  });

  it('a throwing getter (a Proxy) is malformed_event, never a throw', () => {
    const trap = new Proxy({}, { get: () => { throw new Error('trap'); } });
    expect(buildR1MeetRecallEventJob(trap, 'status')).toStrictEqual({ ok: false, reason: 'malformed_event' });
    const deepTrap = {
      event: 'bot.done',
      data: { bot: new Proxy({}, { get: () => { throw new Error('trap'); } }) },
    };
    expect(buildR1MeetRecallEventJob(deepTrap, 'status')).toStrictEqual({ ok: false, reason: 'malformed_event' });
    const participantTrap = participantBody(
      'participant_events.join',
      new Proxy(participantFields(), { get: () => { throw new Error('trap'); } }),
    );
    expect(buildR1MeetRecallEventJob(participantTrap, 'realtime')).toStrictEqual({ ok: false, reason: 'malformed_event' });
  });
});

// ── PII and freezing ─────────────────────────────────────────────────────────

describe('buildR1MeetRecallEventJob: PII and freezing', () => {
  it('the serialized job of a realistic participant body holds no name, email, platform or extra data', () => {
    const job = buildR1MeetRecallEventJob(participantBody('participant_events.join'), 'realtime');
    const text = JSON.stringify(job);
    for (const banned of [PARTICIPANT_NAME, 'Example', PARTICIPANT_EMAIL, '@', 'example.invalid', PARTICIPANT_PLATFORM, EXTRA_MARKER, 'extra_data', 'platform', 'realtime_endpoint', 'recording', 'participant_events.', '7f000000-0000-4000-8000-000000000011']) {
      if (banned === 'participant_events.') {
        // The event type itself names the participant_events family; nothing else may.
        expect(text.split(banned).length - 1, banned).toBe(2);
        continue;
      }
      expect(text, banned).not.toContain(banned);
    }
  });

  it.each<[string, R1MeetRecallEventOptions]>([
    ['Dex', {}],
    ['Dex (AI Interviewer)', { botNameOverride: 'Dex (AI Interviewer)' }],
  ])('a join named like the bot (%s) is marked, and the serialized job holds no trace of the name', (name, options) => {
    const job = buildR1MeetRecallEventJob(
      participantBody('participant_events.join', participantFields({ name })),
      'realtime',
      options,
    );
    expect(okPayload(job).participant).toStrictEqual({ id: 100, is_host: false, is_bot: true });
    const text = JSON.stringify(job);
    expect(text.toLowerCase()).not.toContain('dex');
    expect(text.toLowerCase()).not.toContain('interviewer');
    expect(text).not.toContain('"name"');
    for (const banned of [PARTICIPANT_EMAIL, PARTICIPANT_PLATFORM, EXTRA_MARKER, 'extra_data', 'platform']) {
      expect(text, banned).not.toContain(banned);
    }
  });

  /** A participant object (and its body) whose property reads are recorded. */
  function trackedParticipantBody(event: string, fields: Json, bot: Json = {}) {
    const participantReads: PropertyKey[] = [];
    const dataReads: PropertyKey[] = [];
    const participant = new Proxy(fields, {
      get(target, key, receiver) {
        participantReads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    const body = participantBody(event, participant, {}, bot);
    body.data = new Proxy(body.data as Json, {
      get(target, key, receiver) {
        dataReads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    const stringReads = () => participantReads.filter((key): key is string => typeof key === 'string');
    return { body, participantReads, dataReads, stringReads };
  }

  it.each<[string, string, boolean]>([
    ['another name', PARTICIPANT_NAME, false],
    ["the bot's own name", 'Dex', true],
  ])('a JOIN with %s reads exactly id, is_host, is_bot and the name (once), and none of the other artifacts', (_label, name, marked) => {
    const t = trackedParticipantBody('participant_events.join', participantFields({ name, is_bot: false }));
    const payload = okPayload(buildR1MeetRecallEventJob(t.body, 'realtime'));
    expect(payload.participant).toStrictEqual({ id: 100, is_host: false, is_bot: marked });
    for (const key of ['email', 'platform', 'extra_data']) expect(t.participantReads, key).not.toContain(key);
    expect(new Set(t.stringReads())).toEqual(new Set(['id', 'is_host', 'is_bot', 'name']));
    expect(t.stringReads().filter((key) => key === 'name')).toHaveLength(1);
    for (const key of ['realtime_endpoint', 'recording', 'participant_events']) expect(t.dataReads, key).not.toContain(key);
  });

  it('a LEAVE reads only id, is_host and is_bot (never the name), and none of the other artifacts', () => {
    const t = trackedParticipantBody('participant_events.leave', participantFields({ name: 'Dex', is_bot: false }));
    const payload = okPayload(buildR1MeetRecallEventJob(t.body, 'realtime', { botNameOverride: 'Dex' }));
    expect(payload.participant).toStrictEqual({ id: 100, is_host: false, is_bot: false });
    for (const key of ['name', 'email', 'platform', 'extra_data']) expect(t.participantReads, key).not.toContain(key);
    expect(new Set(t.stringReads())).toEqual(new Set(['id', 'is_host', 'is_bot']));
    for (const key of ['realtime_endpoint', 'recording', 'participant_events']) expect(t.dataReads, key).not.toContain(key);
  });

  it('a JOIN with no known own name (unknown profile, no override) never reads the name', () => {
    const t = trackedParticipantBody(
      'participant_events.join',
      participantFields({ name: 'Dex' }),
      { metadata: { booking_id: BOOKING_ID, profile: 'not_a_profile' } },
    );
    const payload = okPayload(buildR1MeetRecallEventJob(t.body, 'realtime'));
    expect(payload.participant).toStrictEqual({ id: 100, is_host: false, is_bot: null });
    expect(new Set(t.stringReads())).toEqual(new Set(['id', 'is_host', 'is_bot']));
  });

  it('a name getter is read at most once, even when it would answer differently the second time', () => {
    let nameReads = 0;
    const fields = participantFields();
    Object.defineProperty(fields, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        nameReads += 1;
        return nameReads === 1 ? 'Dex' : PARTICIPANT_NAME;
      },
    });
    const payload = okPayload(buildR1MeetRecallEventJob(participantBody('participant_events.join', fields), 'realtime'));
    expect(payload.participant).toStrictEqual({ id: 100, is_host: false, is_bot: true });
    expect(nameReads).toBe(1);
  });

  it('a throwing name getter on a join is malformed_event, never a throw', () => {
    const fields = participantFields();
    Object.defineProperty(fields, 'name', {
      enumerable: true,
      get() {
        throw new Error('trap');
      },
    });
    expect(buildR1MeetRecallEventJob(participantBody('participant_events.join', fields), 'realtime')).toStrictEqual({
      ok: false,
      reason: 'malformed_event',
    });
  });

  it('the result, its payload and the participant are frozen', () => {
    const job = buildR1MeetRecallEventJob(participantBody('participant_events.join'), 'realtime');
    const payload = okPayload(job);
    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.participant)).toBe(true);
    expect(Object.isFrozen(okPayload(buildR1MeetRecallEventJob(statusBody('bot.done'), 'status')))).toBe(true);
  });

  it('does not mutate the input body', () => {
    const body = participantBody('participant_events.join');
    const before = JSON.stringify(body);
    buildR1MeetRecallEventJob(body, 'realtime');
    expect(JSON.stringify(body)).toBe(before);
  });
});

// ── The bot's own display name (M035 S09 T2, D-S09-6) ────────────────────────

describe("buildR1MeetRecallEventJob: a join that carries the bot's own display name", () => {
  /** The participant of a join (or `event`) named `name`, with `fields` merged in. */
  function joinParticipant(
    name: unknown,
    options?: R1MeetRecallEventOptions,
    fields: Json = {},
    bot: Json = {},
    event = 'participant_events.join',
  ) {
    const raw = participantFields({ name, ...fields });
    if (name === undefined) delete raw.name;
    return okPayload(buildR1MeetRecallEventJob(participantBody(event, raw, {}, bot), 'realtime', options)).participant;
  }

  // The default profile (`r1_dex_sales`) shows `Dex`.
  it.each<[string, string]>([
    ['Dex', 'Dex'],
    ['surrounding spaces', ' dex '],
    ['upper case', 'DEX'],
    ['full-width letters (NFKC)', 'Ｄｅｘ'],
    ['a trailing no-break space', 'Dex '],
    ['a tab and a newline around it', '\tDex\n'],
  ])("the profile's own name with %s is marked is_bot true", (_label, name) => {
    expect(joinParticipant(name)).toStrictEqual({ id: 100, is_host: false, is_bot: true });
  });

  it.each<[string, unknown]>([
    ['Dex2', 'Dex2'],
    ['Dexter', 'Dexter'],
    ['D ex', 'D ex'],
    ['an empty name', ''],
    ['a blank name', '   '],
    ['a 300-character name that folds to the bot name', 'Dex' + ' '.repeat(297)],
    ['a zero-width space inside', 'De​x'],
    ['null', null],
    ['a number', 42],
    ['an array', ['Dex']],
    ['an object', { first: 'Dex' }],
    ['missing', undefined],
    ['another person', PARTICIPANT_NAME],
  ])('a join named %s is not marked (is_bot stays null)', (_label, name) => {
    expect(joinParticipant(name)).toStrictEqual({ id: 100, is_host: false, is_bot: null });
  });

  it("Recall's own booleans: true is kept for any name (with no id); false becomes true only for the bot's own name", () => {
    expect(joinParticipant(PARTICIPANT_NAME, {}, { is_bot: true })).toStrictEqual({ id: null, is_host: false, is_bot: true });
    expect(joinParticipant('Dex', {}, { is_bot: true })).toStrictEqual({ id: null, is_host: false, is_bot: true });
    expect(joinParticipant(PARTICIPANT_NAME, {}, { is_bot: false })).toStrictEqual({ id: 100, is_host: false, is_bot: false });
    expect(joinParticipant('Dexter', {}, { is_bot: false })).toStrictEqual({ id: 100, is_host: false, is_bot: false });
    expect(joinParticipant('Dex', {}, { is_bot: false })).toStrictEqual({ id: 100, is_host: false, is_bot: true });
    expect(joinParticipant('Dex', {}, { is_bot: 'no' })).toStrictEqual({ id: 100, is_host: false, is_bot: true });
    expect(joinParticipant('Dex', {}, { is_host: true, id: 7 })).toStrictEqual({ id: 7, is_host: true, is_bot: true });
  });

  it('the override (R1_MEET_BOT_NAME) replaces the profile name: only that name marks', () => {
    const options = { botNameOverride: 'Dex (AI Interviewer)' };
    expect(joinParticipant('Dex (AI Interviewer)', options)!.is_bot).toBe(true);
    expect(joinParticipant('  dex  (ai interviewer) ', options)!.is_bot).toBe(true);
    expect(joinParticipant('Dex', options)!.is_bot).toBeNull();
    expect(joinParticipant('Dex (AI)', options)!.is_bot).toBeNull();
  });

  it('a null, empty or over-long override falls back to the profile name', () => {
    for (const botNameOverride of [null, undefined, '', 'D'.repeat(101)]) {
      const options = { botNameOverride };
      expect(joinParticipant('Dex', options)!.is_bot, String(botNameOverride).slice(0, 8)).toBe(true);
      expect(joinParticipant('D'.repeat(101), options)!.is_bot, String(botNameOverride).slice(0, 8)).toBeNull();
    }
    // A 100-character override is used.
    const hundred = 'D'.repeat(100);
    expect(joinParticipant(hundred, { botNameOverride: hundred })!.is_bot).toBe(true);
    expect(joinParticipant('Dex', { botNameOverride: hundred })!.is_bot).toBeNull();
  });

  it('with an unknown or missing profile and no override, nothing is ever marked by name', () => {
    for (const metadata of [
      { booking_id: BOOKING_ID, profile: 'not_a_profile' },
      { booking_id: BOOKING_ID },
      { booking_id: BOOKING_ID, profile: 'toString' },
      null,
    ]) {
      expect(joinParticipant('Dex', {}, {}, { metadata })!.is_bot, JSON.stringify(metadata)).toBeNull();
    }
    // The override still works without a profile.
    const unknown = { metadata: { booking_id: BOOKING_ID, profile: 'not_a_profile' } };
    expect(joinParticipant('Dex', { botNameOverride: 'Dex' }, {}, unknown)!.is_bot).toBe(true);
  });

  it("a LEAVE named like the bot is never marked by name (Recall's boolean only)", () => {
    expect(joinParticipant('Dex', {}, {}, {}, 'participant_events.leave')).toStrictEqual({ id: 100, is_host: false, is_bot: null });
    expect(joinParticipant('Dex', { botNameOverride: 'Dex' }, {}, {}, 'participant_events.leave')!.is_bot).toBeNull();
    expect(joinParticipant('Dex', {}, { is_bot: false }, {}, 'participant_events.leave')!.is_bot).toBe(false);
    expect(joinParticipant('Dex', {}, { is_bot: true }, {}, 'participant_events.leave')).toStrictEqual({
      id: null,
      is_host: false,
      is_bot: true,
    });
  });

  it('status events are untouched by the options (participant stays null)', () => {
    const job = buildR1MeetRecallEventJob(statusBody('bot.in_call_recording'), 'status', { botNameOverride: 'Dex' });
    expect(okPayload(job).participant).toBeNull();
  });

  it('the payload keeps its exact keys and order, and the participant its three keys, when marked', () => {
    const job = buildR1MeetRecallEventJob(participantBody('participant_events.join', participantFields({ name: 'Dex' })), 'realtime');
    expect(Object.keys(okPayload(job))).toEqual(PAYLOAD_KEYS);
    expect(Object.keys(okPayload(job).participant!)).toEqual(['id', 'is_host', 'is_bot']);
    expect(Object.isFrozen(okPayload(job).participant)).toBe(true);
  });
});

describe('r1MeetSameDisplayName', () => {
  it.each<[string, string]>([
    ['Dex', 'Dex'],
    [' dex ', 'Dex'],
    ['DEX', 'dex'],
    ['Ｄｅｘ', 'Dex'],
    ['Dex ', 'Dex'],
    ['Dex　', 'Dex'],
    ['Dex  (AI   Interviewer)', 'Dex (AI Interviewer)'],
    ['dex\t(ai interviewer)\n', ' Dex (AI Interviewer) '],
    ['Dex' + ' '.repeat(253), 'Dex'],
  ])('%j is the same display name as %j', (name, own) => {
    expect(r1MeetSameDisplayName(name, own)).toBe(true);
  });

  it.each<[string, unknown, string]>([
    ['Dex2', 'Dex2', 'Dex'],
    ['Dexter', 'Dexter', 'Dex'],
    ['D ex', 'D ex', 'Dex'],
    ['a zero-width space inside', 'De​x', 'Dex'],
    ['an empty name', '', 'Dex'],
    ['a blank name', '  ', 'Dex'],
    ['257 characters', 'Dex' + ' '.repeat(254), 'Dex'],
    ['null', null, 'Dex'],
    ['undefined', undefined, 'Dex'],
    ['a number', 42, 'Dex'],
    ['a boolean', true, 'Dex'],
    ['an array', ['Dex'], 'Dex'],
    ['an object that stringifies to the name', { toString: () => 'Dex' }, 'Dex'],
    ['an empty own name', '', ''],
    ['a blank own name', ' ', '   '],
    ['an own name over 256 characters', 'Dex' + ' '.repeat(254), 'Dex' + ' '.repeat(254)],
    ['a lone surrogate', '\ud800', 'Dex'],
  ])('%s is not the same display name', (_label, name, own) => {
    expect(r1MeetSameDisplayName(name, own)).toBe(false);
  });

  it('never throws, even for a non-string own name or a throwing toString', () => {
    const hostile = {
      toString() {
        throw new Error('trap');
      },
    };
    expect(r1MeetSameDisplayName('Dex', null as unknown as string)).toBe(false);
    expect(r1MeetSameDisplayName('Dex', 42 as unknown as string)).toBe(false);
    expect(r1MeetSameDisplayName(hostile, 'Dex')).toBe(false);
    expect(r1MeetSameDisplayName('Dex', hostile as unknown as string)).toBe(false);
  });
});
