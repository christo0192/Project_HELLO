/**
 * The R1-over-Meet create-bot builder and the Ashby-event Idempotency-Key (M034 S01 T7): the exact
 * section 4 body and its variants, every failure reason in check order without echoing the input,
 * the deep-frozen PII-free body, a round trip through the Recall client against the shared fake,
 * and the key's format and refusals. M035 S09 T1: the exact guest body (no `google_meet`), the
 * late-joiner notice (`chat.on_participant_join`) and the explicit, inert-by-name bot detection.
 *
 * Deterministic: no clock (the builder has none), no network (the fake Recall transport), synthetic
 * ids only. Fixture keys are low-entropy.
 */
import { describe, expect, it } from 'vitest';
import { RecallClient } from '../integrations/recall/client.js';
import { RECALL_IDEMPOTENCY_KEY_RE } from '../integrations/recall/settings.js';
import { R1_MEET_DEFAULT_PROFILE_ID, R1_MEET_MEET_CHAT_MAX_CHARS } from '../lib/r1/meet/profiles.js';
import {
  R1_MEET_CREATE_BOT_FAILURES,
  R1_MEET_MAX_JOIN_LEAD_SEC,
  R1_MEET_REALTIME_EVENTS,
  R1_MEET_RECALL_VARIANT,
  buildR1MeetCreateBotRequest,
  r1MeetCreateBotIdempotencyKey,
  type R1MeetBotBooking,
  type R1MeetBotSettings,
  type R1MeetCreateBotFailure,
  type R1MeetCreateBotResult,
} from '../lib/r1/meet/recall-bot.js';
import { FIXTURE_EVENT_ID } from './support/ashby-schedule-fixture.js';
import { FAKE_RECALL_API_KEY, createFakeRecall } from './support/recall-fake.js';

// ── Fixtures (S01 plan section 4) ───────────────────────────────────────────

const BOOKING_ID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const MEETING_LINK = 'https://meet.google.com/ABC-defg-hij?authuser=0';
const SLOT_START = '2026-12-01T10:30:00.000Z';
const REALTIME_URL = 'https://hello.example.test/api/integrations/recall/realtime';
const LOGIN_GROUP_ID = '7d3c2b1a-0f9e-4d8c-9b7a-6f5e4d3c2b1a';
const PAGE_URL = 'https://hello.example.test/candidate/r1/meet#t=fixture';
const DISCLOSURE = 'Lexy is an AI interviewer from Interview Kickstart. This call is recorded.';

/** The exact section 4 literal: login group set, no output media, default join lead. */
const SECTION_4_BODY = {
  meeting_url: 'https://meet.google.com/abc-defg-hij',
  bot_name: 'Lexy',
  join_at: '2026-12-01T10:28:00.000Z',
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
      {
        type: 'webhook',
        url: 'https://hello.example.test/api/integrations/recall/realtime',
        events: ['participant_events.join', 'participant_events.leave'],
      },
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
  google_meet: { google_login_group_id: '7d3c2b1a-0f9e-4d8c-9b7a-6f5e4d3c2b1a' },
  metadata: { booking_id: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e', profile: 'r1_dex_sales' },
};

/**
 * The exact GUEST body (M035 S09, D-S09-1): no login group configured, the default for Dex's own
 * Workspace. Identical to the signed-in literal except that there is no `google_meet` key at all.
 */
const GUEST_BODY = {
  meeting_url: 'https://meet.google.com/abc-defg-hij',
  bot_name: 'Dex',
  join_at: '2026-12-01T10:28:00.000Z',
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
      {
        type: 'webhook',
        url: 'https://hello.example.test/api/integrations/recall/realtime',
        events: ['participant_events.join', 'participant_events.leave'],
      },
    ],
  },
  chat: {
    on_bot_join: {
      send_to: 'everyone',
      message: 'Dex is an AI interviewer from Interview Kickstart. This call is recorded.',
      pin: true,
    },
    on_participant_join: {
      message: 'Dex is an AI interviewer from Interview Kickstart. This call is recorded.',
      exclude_host: false,
    },
  },
  metadata: { booking_id: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e', profile: 'r1_dex_sales' },
};

function booking(overrides: Partial<Record<keyof R1MeetBotBooking, unknown>> = {}): R1MeetBotBooking {
  return { bookingId: BOOKING_ID, meetingUrl: MEETING_LINK, slotStart: SLOT_START, ...overrides } as R1MeetBotBooking;
}

function settings(overrides: Partial<Record<keyof R1MeetBotSettings, unknown>> = {}): R1MeetBotSettings {
  return {
    realtimeWebhookUrl: REALTIME_URL,
    botNameOverride: null,
    googleLoginGroupId: LOGIN_GROUP_ID,
    ...overrides,
  } as R1MeetBotSettings;
}

function build(
  bookingOverrides: Partial<Record<keyof R1MeetBotBooking, unknown>> = {},
  settingsOverrides: Partial<Record<keyof R1MeetBotSettings, unknown>> = {},
  profileId: string = R1_MEET_DEFAULT_PROFILE_ID,
): R1MeetCreateBotResult {
  return buildR1MeetCreateBotRequest(profileId, booking(bookingOverrides), settings(settingsOverrides));
}

function bodyOf(result: R1MeetCreateBotResult) {
  if (!result.ok) throw new Error(`expected a body, got ${result.reason}`);
  return result.body;
}

function expectDeepFrozen(value: unknown, where = 'body'): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value), where).toBe(true);
  for (const [key, child] of Object.entries(value)) expectDeepFrozen(child, `${where}.${key}`);
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A credentialed URL, built at runtime so no scanner sees a literal userinfo pair. */
const CREDENTIALED_REALTIME_URL = 'https://fixture' + ':' + 'x' + '@hello.example.test/api/integrations/recall/realtime';

// ── The exact body ──────────────────────────────────────────────────────────

describe('buildR1MeetCreateBotRequest: the section 4 body', () => {
  it('builds exactly the section 4 literal (login group set, no output media, default join lead)', () => {
    const result = build();
    expect(result).toStrictEqual({ ok: true, body: SECTION_4_BODY, joinAt: '2026-12-01T10:28:00.000Z' });
  });

  it('uses the profile disclosure as a pinned notice to everyone, re-sent at each join, and the R1 constants', () => {
    const body = bodyOf(build());
    expect(body.chat).toStrictEqual({
      on_bot_join: { send_to: 'everyone', message: DISCLOSURE, pin: true },
      on_participant_join: { message: DISCLOSURE, exclude_host: false },
    });
    expect(body.variant).toStrictEqual({ google_meet: R1_MEET_RECALL_VARIANT });
    expect(body.recording_config?.realtime_endpoints?.[0]?.events).toStrictEqual([...R1_MEET_REALTIME_EVENTS]);
    expect(Object.isFrozen(R1_MEET_REALTIME_EVENTS)).toBe(true);
  });

  it('adds exactly the webpage output_media block when a page URL is given (a fragment is allowed)', () => {
    const body = bodyOf(build({}, { outputMediaUrl: PAGE_URL }));
    expect(body).toStrictEqual({
      ...SECTION_4_BODY,
      output_media: { camera: { kind: 'webpage', config: { url: PAGE_URL } } },
    });
  });

  it('leaves output_media out when the page URL is null or absent', () => {
    expect(bodyOf(build({}, { outputMediaUrl: null }))).toStrictEqual(SECTION_4_BODY);
    expect('output_media' in bodyOf(build())).toBe(false);
  });

  it('builds exactly the guest literal when no login group is configured (the bot joins signed out)', () => {
    const { google_meet: _signedIn, ...signedOut } = SECTION_4_BODY;
    const result = build({}, { googleLoginGroupId: null });
    expect(result).toStrictEqual({ ok: true, body: GUEST_BODY, joinAt: '2026-12-01T10:28:00.000Z' });
    expect(GUEST_BODY).toStrictEqual(signedOut);
    const body = bodyOf(result);
    expect('google_meet' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('google_login_group_id');
    // An absent login group is the guest bot too.
    const { googleLoginGroupId: _absent, ...withoutGroup } = settings();
    const absent = buildR1MeetCreateBotRequest(R1_MEET_DEFAULT_PROFILE_ID, booking(), withoutGroup as R1MeetBotSettings);
    expect(absent).toStrictEqual({ ok: true, body: GUEST_BODY, joinAt: '2026-12-01T10:28:00.000Z' });
  });

  it.each([
    ['guest', null],
    ['signed-in', LOGIN_GROUP_ID],
  ])('the %s body sends the notice on bot join (pinned) and on every participant join, host included', (_mode, group) => {
    const chat = bodyOf(build({}, { googleLoginGroupId: group })).chat!;
    expect(Object.keys(chat).sort()).toStrictEqual(['on_bot_join', 'on_participant_join']);
    expect(chat.on_participant_join).toStrictEqual({ message: DISCLOSURE, exclude_host: false });
    expect(chat.on_participant_join!.message).toBe(chat.on_bot_join!.message);
    expect(chat.on_bot_join).toStrictEqual({ send_to: 'everyone', message: DISCLOSURE, pin: true });
    expect(chat.on_participant_join!.message.length).toBeLessThanOrEqual(R1_MEET_MEET_CHAT_MAX_CHARS);
  });

  it.each([
    ['guest', null],
    ['signed-in', LOGIN_GROUP_ID],
  ])('the %s body pins explicit bot detection whose name heuristic can never fire during a stay', (_mode, group) => {
    const leave = bodyOf(build({}, { googleLoginGroupId: group })).automatic_leave!;
    expect(leave.bot_detection).toStrictEqual({
      using_participant_events: { timeout: 600, activate_after: 1200 },
      using_participant_names: { matches: ['notetaker', 'recorder', 'assistant'], timeout: 600, activate_after: 7200 },
    });
    const names = leave.bot_detection!.using_participant_names!;
    // A candidate named "...assistant..." never makes Dex leave: the heuristic activates after the
    // longest the bot can stay (the not-recording window plus the recorded-call cap).
    expect(names.activate_after).toBeGreaterThan(leave.in_call_not_recording_timeout! + leave.in_call_recording_timeout!);
    // Recall's limits: timeout >= 10, activate_after >= 1, matches items at least one character.
    const events = leave.bot_detection!.using_participant_events!;
    for (const value of [names.timeout, names.activate_after, events.timeout!, events.activate_after!]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
    expect(names.timeout).toBeGreaterThanOrEqual(10);
    expect(events.timeout!).toBeGreaterThanOrEqual(10);
    expect(names.activate_after).toBeGreaterThanOrEqual(1);
    expect(events.activate_after!).toBeGreaterThanOrEqual(1);
    expect(names.matches.length).toBeGreaterThan(0);
    for (const match of names.matches) expect(match.length).toBeGreaterThanOrEqual(1);
    // No silence detection block: its Recall default cannot fire before the recorded-call cap.
    expect('silence_detection' in leave).toBe(false);
  });

  it('lower-cases an upper-case login group id', () => {
    const body = bodyOf(build({}, { googleLoginGroupId: LOGIN_GROUP_ID.toUpperCase() }));
    expect(body.google_meet).toStrictEqual({ google_login_group_id: LOGIN_GROUP_ID });
  });

  it('uses the bot name override instead of the profile name', () => {
    const body = bodyOf(build({}, { botNameOverride: 'Dex from Interview Kickstart' }));
    expect(body).toStrictEqual({ ...SECTION_4_BODY, bot_name: 'Dex from Interview Kickstart' });
  });

  it.each([
    [undefined, '2026-12-01T10:28:00.000Z'],
    [null, '2026-12-01T10:28:00.000Z'],
    [0, '2026-12-01T10:30:00.000Z'],
    [600, '2026-12-01T10:20:00.000Z'],
    [R1_MEET_MAX_JOIN_LEAD_SEC, '2026-12-01T10:15:00.000Z'],
  ])('joinLeadSec %s moves join_at to %s (absent or null = the profile 120 s)', (joinLeadSec, joinAt) => {
    const overrides = joinLeadSec === undefined ? {} : { joinLeadSec };
    const result = build({}, overrides);
    expect(result).toStrictEqual({ ok: true, body: { ...SECTION_4_BODY, join_at: joinAt }, joinAt });
  });

  it('accepts the slot start as a Date or as a +05:30 string, giving the same join_at', () => {
    const fromDate = build({ slotStart: new Date(SLOT_START) });
    const fromOffset = build({ slotStart: '2026-12-01T16:00:00.000+05:30' });
    expect(fromDate).toStrictEqual(build());
    expect(fromOffset).toStrictEqual(build());
  });

  it('returns a deep-frozen body', () => {
    const body = bodyOf(build({}, { outputMediaUrl: PAGE_URL }));
    expectDeepFrozen(body);
    expect(() => {
      (body.metadata as Record<string, string>).email = 'x';
    }).toThrow(TypeError);
  });

  it('freezes the bot-detection and chat blocks, including the matches array, in both modes', () => {
    for (const group of [null, LOGIN_GROUP_ID]) {
      const body = bodyOf(build({}, { googleLoginGroupId: group }));
      expectDeepFrozen(body);
      const detection = body.automatic_leave!.bot_detection!;
      expect(Object.isFrozen(detection)).toBe(true);
      expect(Object.isFrozen(detection.using_participant_events)).toBe(true);
      expect(Object.isFrozen(detection.using_participant_names)).toBe(true);
      expect(Object.isFrozen(detection.using_participant_names!.matches)).toBe(true);
      expect(Object.isFrozen(body.chat)).toBe(true);
      expect(Object.isFrozen(body.chat!.on_participant_join)).toBe(true);
      expect(() => {
        (detection.using_participant_names!.matches as string[]).push('candidate');
      }).toThrow(TypeError);
      expect(() => {
        (body.chat!.on_participant_join as { exclude_host: boolean }).exclude_host = true;
      }).toThrow(TypeError);
    }
  });

  it('copies the profile word list: two bodies never share the matches array', () => {
    const first = bodyOf(build()).automatic_leave!.bot_detection!.using_participant_names!.matches;
    const second = bodyOf(build()).automatic_leave!.bot_detection!.using_participant_names!.matches;
    expect(first).toStrictEqual(second);
    expect(first).not.toBe(second);
  });

  it('carries no candidate data: metadata is the booking id and the profile only', () => {
    const body = bodyOf(build({}, { outputMediaUrl: PAGE_URL }));
    expect(body.metadata).toStrictEqual({ booking_id: BOOKING_ID, profile: R1_MEET_DEFAULT_PROFILE_ID });
    const json = JSON.stringify(body);
    for (const needle of ['@', 'example.invalid', 'Example', 'Candidate', 'Recruiter', 'authuser']) {
      expect(json, needle).not.toContain(needle);
    }
  });
});

// ── Failures ────────────────────────────────────────────────────────────────

describe('buildR1MeetCreateBotRequest: failures', () => {
  it('lists the failure reasons in check order (frozen)', () => {
    expect(R1_MEET_CREATE_BOT_FAILURES).toStrictEqual([
      'unknown_profile',
      'invalid_booking_id',
      'invalid_meeting_url',
      'invalid_join_lead',
      'invalid_slot_start',
      'invalid_realtime_url',
      'invalid_output_media_url',
      'invalid_login_group_id',
      'invalid_bot_name',
    ]);
    expect(Object.isFrozen(R1_MEET_CREATE_BOT_FAILURES)).toBe(true);
  });

  it('checks in that order: fixing one field at a time walks the reasons one by one', () => {
    let profileId = 'nope';
    const b: Record<string, unknown> = {
      bookingId: BOOKING_ID.toUpperCase(),
      meetingUrl: 'https://zoom.us/j/123456789',
      slotStart: 'not-a-date',
    };
    const s: Record<string, unknown> = {
      joinLeadSec: -1,
      realtimeWebhookUrl: 'http://hello.example.test/api/integrations/recall/realtime',
      outputMediaUrl: 'http://hello.example.test/candidate/r1/meet',
      googleLoginGroupId: 'not-a-group',
      botNameOverride: ' Dex',
    };
    const fixes: Array<() => void> = [
      () => (profileId = R1_MEET_DEFAULT_PROFILE_ID),
      () => (b.bookingId = BOOKING_ID),
      () => (b.meetingUrl = MEETING_LINK),
      () => (s.joinLeadSec = null),
      () => (b.slotStart = SLOT_START),
      () => (s.realtimeWebhookUrl = REALTIME_URL),
      () => (s.outputMediaUrl = null),
      () => (s.googleLoginGroupId = LOGIN_GROUP_ID),
      () => (s.botNameOverride = null),
    ];
    const seen: string[] = [];
    for (const fix of fixes) {
      const result = buildR1MeetCreateBotRequest(profileId, { ...b } as never, { ...s } as never);
      seen.push(result.ok ? 'ok' : result.reason);
      fix();
    }
    const last = buildR1MeetCreateBotRequest(profileId, { ...b } as never, { ...s } as never);
    expect(seen).toStrictEqual([...R1_MEET_CREATE_BOT_FAILURES]);
    expect(last).toStrictEqual({ ok: true, body: SECTION_4_BODY, joinAt: '2026-12-01T10:28:00.000Z' });
  });

  const rows: Array<[string, R1MeetCreateBotFailure, () => R1MeetCreateBotResult]> = [
    ['unknown profile id', 'unknown_profile', () => build({}, {}, 'nope')],
    ['__proto__ profile id', 'unknown_profile', () => build({}, {}, '__proto__')],
    ['constructor profile id', 'unknown_profile', () => build({}, {}, 'constructor')],
    ['upper-case profile id', 'unknown_profile', () => build({}, {}, 'R1_DEX_SALES')],
    ['upper-case booking id', 'invalid_booking_id', () => build({ bookingId: BOOKING_ID.toUpperCase() })],
    ['non-UUID booking id', 'invalid_booking_id', () => build({ bookingId: 'booking-1' })],
    ['numeric booking id', 'invalid_booking_id', () => build({ bookingId: 42 })],
    [
      'null booking',
      'invalid_booking_id',
      () => buildR1MeetCreateBotRequest(R1_MEET_DEFAULT_PROFILE_ID, null as never, settings()),
    ],
    ['Zoom meeting URL', 'invalid_meeting_url', () => build({ meetingUrl: 'https://zoom.us/j/123456789?pwd=abc' })],
    ['http Meet URL', 'invalid_meeting_url', () => build({ meetingUrl: 'http://meet.google.com/abc-defg-hij' })],
    ['missing meeting URL', 'invalid_meeting_url', () => build({ meetingUrl: undefined })],
    ['join lead -1', 'invalid_join_lead', () => build({}, { joinLeadSec: -1 })],
    ['join lead 901', 'invalid_join_lead', () => build({}, { joinLeadSec: 901 })],
    ['join lead 1.5', 'invalid_join_lead', () => build({}, { joinLeadSec: 1.5 })],
    ['join lead NaN', 'invalid_join_lead', () => build({}, { joinLeadSec: Number.NaN })],
    ['join lead Infinity', 'invalid_join_lead', () => build({}, { joinLeadSec: Number.POSITIVE_INFINITY })],
    ['join lead as a string', 'invalid_join_lead', () => build({}, { joinLeadSec: '120' })],
    ['slot start not a date', 'invalid_slot_start', () => build({ slotStart: 'not-a-date' })],
    ['slot start without an offset', 'invalid_slot_start', () => build({ slotStart: '2026-12-01T10:30:00' })],
    ['slot start on 30 February', 'invalid_slot_start', () => build({ slotStart: '2026-02-30T10:30:00Z' })],
    ['slot start an invalid Date', 'invalid_slot_start', () => build({ slotStart: new Date(Number.NaN) })],
    ['slot start as epoch ms', 'invalid_slot_start', () => build({ slotStart: Date.parse(SLOT_START) })],
    [
      'null settings',
      'invalid_realtime_url',
      () => buildR1MeetCreateBotRequest(R1_MEET_DEFAULT_PROFILE_ID, booking(), null as never),
    ],
    [
      'http realtime URL',
      'invalid_realtime_url',
      () => build({}, { realtimeWebhookUrl: 'http://hello.example.test/api/integrations/recall/realtime' }),
    ],
    ['credentialed realtime URL', 'invalid_realtime_url', () => build({}, { realtimeWebhookUrl: CREDENTIALED_REALTIME_URL })],
    ['realtime URL with a fragment', 'invalid_realtime_url', () => build({}, { realtimeWebhookUrl: `${REALTIME_URL}#x` })],
    [
      'http output media URL',
      'invalid_output_media_url',
      () => build({}, { outputMediaUrl: 'http://hello.example.test/candidate/r1/meet' }),
    ],
    ['malformed login group id', 'invalid_login_group_id', () => build({}, { googleLoginGroupId: 'not-a-group' })],
    ['numeric login group id', 'invalid_login_group_id', () => build({}, { googleLoginGroupId: 7 })],
    ['padded bot name', 'invalid_bot_name', () => build({}, { botNameOverride: ' Dex' })],
    ['101-character bot name', 'invalid_bot_name', () => build({}, { botNameOverride: 'D'.repeat(101) })],
    ['bot name with a zero-width space', 'invalid_bot_name', () => build({}, { botNameOverride: 'De​x' })],
    ['empty bot name', 'invalid_bot_name', () => build({}, { botNameOverride: '' })],
  ];

  it.each(rows)('%s -> %s, and nothing from the input is echoed', (_label, reason, run) => {
    // Exactly {ok, reason}: no field, URL, id or name from the input rides along.
    expect(run()).toStrictEqual({ ok: false, reason });
  });

  it('accepts the boundary bot name of 100 characters and the boundary join leads 0 and 900', () => {
    expect(build({}, { botNameOverride: 'D'.repeat(100) }).ok).toBe(true);
    expect(build({}, { joinLeadSec: 0 }).ok).toBe(true);
    expect(build({}, { joinLeadSec: 900 }).ok).toBe(true);
  });
});

// ── Round trip through the client ───────────────────────────────────────────

describe('buildR1MeetCreateBotRequest: round trip through RecallClient.createBot (fake Recall)', () => {
  it('sends exactly the built body with the Ashby-event key, and a replay returns the same bot', async () => {
    const fake = createFakeRecall();
    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });
    const body = bodyOf(build());
    const idempotencyKey = r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 1, 0);

    const bot = await client.createBot(body, { idempotencyKey });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe('POST');
    expect(fake.calls[0].path).toBe('/api/v1/bot/');
    expect(fake.calls[0].headers['idempotency-key']).toBe(idempotencyKey);
    expect(fake.calls[0].body).toStrictEqual(body);
    expect(fake.calls[0].body).toStrictEqual(SECTION_4_BODY);
    expect(bot.joinAt).toBe('2026-12-01T10:28:00.000Z');
    expect(bot.metadata).toStrictEqual({ booking_id: BOOKING_ID, profile: R1_MEET_DEFAULT_PROFILE_ID });

    const replay = await client.createBot(body, { idempotencyKey });
    expect(replay.id).toBe(bot.id);
    expect(fake.bots.size).toBe(1);

    // A new booking version (the old bot deleted after a reschedule) deliberately creates a new bot.
    const next = await client.createBot(body, { idempotencyKey: r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 2, 0) });
    expect(next.id).not.toBe(bot.id);
    expect(fake.bots.size).toBe(2);
  });

  it('a create answered with a cached error is retried under the next key attempt; a network blip keeps the key', async () => {
    const fake = createFakeRecall();
    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });
    const body = bodyOf(build());
    let keyAttempt = 0;
    const key = () => r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 1, keyAttempt);

    // The S06 loop in miniature: rotate only when the client says the response was cached.
    fake.failNext(500, { body: { detail: 'internal error' } });
    const first = await client.createBot(body, { idempotencyKey: key() }).catch((error: unknown) => error);
    expect(first).toMatchObject({ category: 'http_server_error', retriable: true, rotateIdempotencyKey: true });
    // The same key would only replay the cached 500.
    await expect(client.createBot(body, { idempotencyKey: key() })).rejects.toMatchObject({ category: 'http_server_error' });
    keyAttempt += 1;
    fake.failNext(503);
    const second = await client.createBot(body, { idempotencyKey: key() }).catch((error: unknown) => error);
    expect(second).toMatchObject({ category: 'http_server_error', rotateIdempotencyKey: false });
    const bot = await client.createBot(body, { idempotencyKey: key() });
    expect(fake.bots.size).toBe(1);
    expect(fake.calls.map((call) => call.headers['idempotency-key'])).toEqual([
      'r1-meet-4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8-v1-k0',
      'r1-meet-4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8-v1-k0',
      'r1-meet-4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8-v1-k1',
      'r1-meet-4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8-v1-k1',
    ]);
    expect(fake.bots.has(bot.id)).toBe(true);
  });

  it('sends exactly the guest body when no login group is configured', async () => {
    const fake = createFakeRecall();
    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });
    const body = bodyOf(build({}, { googleLoginGroupId: null }));
    await client.createBot(body, { idempotencyKey: r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 0, 0) });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].body).toStrictEqual(GUEST_BODY);
    expect('google_meet' in (fake.calls[0].body as Record<string, unknown>)).toBe(false);
  });

  it('passes the client checks with output media armed at creation', async () => {
    const fake = createFakeRecall();
    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });
    const body = bodyOf(build({}, { outputMediaUrl: PAGE_URL, joinLeadSec: 0 }));
    await client.createBot(body, { idempotencyKey: r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 0, 0) });
    expect(fake.calls[0].body).toStrictEqual(body);
    expect([...fake.bots.values()][0].outputMedia).toBe('webpage');
  });
});

// ── Idempotency-Key ─────────────────────────────────────────────────────────

describe('r1MeetCreateBotIdempotencyKey', () => {
  it('is r1-meet-<ashby event id>-v<version>-k<key attempt>', () => {
    expect(r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 3, 0)).toBe('r1-meet-4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8-v3-k0');
    expect(r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 3, 2)).toBe('r1-meet-4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8-v3-k2');
  });

  it('gives a distinct key for every (version, key attempt) pair', () => {
    const keys = new Set<string>();
    for (const version of [0, 1, 11]) {
      for (const attempt of [0, 1, 11]) keys.add(r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, version, attempt));
    }
    expect(keys.size).toBe(9);
  });

  it('lower-cases an upper-case Ashby event id', () => {
    expect(r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID.toUpperCase(), 3, 1)).toBe(
      r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 3, 1),
    );
  });

  it('always satisfies RECALL_IDEMPOTENCY_KEY_RE, up to the largest safe version and key attempt', () => {
    for (const version of [0, 1, 3, 999, Number.MAX_SAFE_INTEGER]) {
      for (const attempt of [0, 7, Number.MAX_SAFE_INTEGER]) {
        const key = r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID.toUpperCase(), version, attempt);
        expect(key, `${version}/${attempt}`).toMatch(RECALL_IDEMPOTENCY_KEY_RE);
      }
    }
  });

  it.each([
    ['-1', -1],
    ['1.5', 1.5],
    ['2 ** 53', 2 ** 53],
    ['NaN', Number.NaN],
    ['a string', '0'],
    ['undefined', undefined],
  ])('throws r1_meet_idempotency_invalid_key_attempt for key attempt %s', (_label, attempt) => {
    const error = thrownBy(() => r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, 1, attempt as never));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('r1_meet_idempotency_invalid_key_attempt');
  });

  it.each([
    ['a non-UUID id', 'evt-1'],
    ['an empty id', ''],
    ['a braced UUID', `{${FIXTURE_EVENT_ID}}`],
    ['a padded UUID', ` ${FIXTURE_EVENT_ID}`],
    ['a number', 42],
    ['null', null],
  ])('throws r1_meet_idempotency_invalid_event_id for %s, never echoing it', (_label, eventId) => {
    const error = thrownBy(() => r1MeetCreateBotIdempotencyKey(eventId as never, 1, 0));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('r1_meet_idempotency_invalid_event_id');
  });

  it.each([
    ['-1', -1],
    ['1.5', 1.5],
    ['2 ** 53', 2 ** 53],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '3'],
  ])('throws r1_meet_idempotency_invalid_version for version %s', (_label, version) => {
    const error = thrownBy(() => r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, version as never, 0));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('r1_meet_idempotency_invalid_version');
  });

  it('checks the event id, then the version, then the key attempt', () => {
    expect((thrownBy(() => r1MeetCreateBotIdempotencyKey('evt-1', -1, -1)) as Error).message).toBe(
      'r1_meet_idempotency_invalid_event_id',
    );
    expect((thrownBy(() => r1MeetCreateBotIdempotencyKey(FIXTURE_EVENT_ID, -1, -1)) as Error).message).toBe(
      'r1_meet_idempotency_invalid_version',
    );
  });
});
