/**
 * Google Calendar client for Dex (M035 S03 T3): the events of the R1 public booking link on Dex's
 * primary calendar.
 *
 * Covers the insert request snapshots (calendar mode with a Meet create request, space mode with the
 * canonical link in `location`; never an `attendees` key or a `displayName`), every pre-transport
 * refusal (zero transport calls of any kind: no token is minted either), the closed parse, get /
 * patch / delete (the patch body holds only the given keys, `attendees` exactly one `{email}`), the
 * 401 re-mint (once), every error row of the status map, a token `auth_revoked` that never reaches
 * the API, one log record per public call, and a canary over logs and errors.
 *
 * Deterministic: the network is `createFakeGoogle` (never a real request), optionally preceded by
 * scripted API answers. Fixtures are built at run time and low in entropy.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH,
  GOOGLE_CALENDAR_MAX_PARSED_ATTENDEES,
  GOOGLE_CALENDAR_SUMMARY_MAX_LENGTH,
  GOOGLE_CALENDAR_TIME_ZONE,
  createGoogleCalendarClient,
  isGoogleIsoDateTime,
  type GoogleCalendarClient,
  type GoogleCalendarEventInsert,
  type GoogleCalendarEventPatch,
} from '../integrations/google/calendar.js';
import { GoogleError, type GoogleErrorCode } from '../integrations/google/errors.js';
import {
  GOOGLE_CALENDAR_EVENTS_URL,
  GOOGLE_TOKEN_URL,
  type GoogleLogRecord,
  type GoogleTransport,
  type GoogleTransportRequest,
} from '../integrations/google/http.js';
import { GOOGLE_SCOPES, createGoogleOAuthRefreshTokenSource, type GoogleTokenSource } from '../integrations/google/token.js';
import {
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_DEX_EMAIL,
  FAKE_GOOGLE_REFRESH_TOKEN,
  createFakeGoogle,
  fakeGoogleResponse,
  type FakeGoogle,
  type FakeGoogleCannedResponse,
  type FakeGoogleOptions,
} from './support/google-fake.js';

// ── Fixtures (built at run time, low entropy) ───────────────────────────────

const BASE_SCOPES = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings];
const BOOKING_ID = ['0123abcd', '0000', '4000', '8000', 'a'.repeat(12)].join('-');
const EVENT_ID = BOOKING_ID.replace(/-/g, '');
const START = '2026-12-01T10:00:00+05:30';
const END = '2026-12-01T10:45:00+05:30';
const SUMMARY = 'Interview Kickstart R1 with Dex (AI interviewer)';
const DESCRIPTION_CANARY = 'desc-canary-' + 'q'.repeat(8);
const DESCRIPTION = `Your R1 interview with Dex.\nJoin on a laptop in Chrome. ${DESCRIPTION_CANARY}`;
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const ATTENDEE = 'candidate.one@mail.example.test';
const INSERT_URL = `${GOOGLE_CALENDAR_EVENTS_URL}?conferenceDataVersion=1&sendUpdates=none`;
const EVENT_URL = `${GOOGLE_CALENDAR_EVENTS_URL}/${EVENT_ID}`;

const insert = (overrides: Partial<GoogleCalendarEventInsert> = {}): GoogleCalendarEventInsert => ({
  id: EVENT_ID,
  summary: SUMMARY,
  description: DESCRIPTION,
  startAt: START,
  endAt: END,
  requestId: BOOKING_ID,
  bookingId: BOOKING_ID,
  withConference: true,
  location: null,
  ...overrides,
});
const spaceInsert = (overrides: Partial<GoogleCalendarEventInsert> = {}) =>
  insert({ withConference: false, location: MEET_URL, ...overrides });

/** A scripted API answer, or 'fake' to let the simulated Google answer. Token calls always go to the fake. */
type Step = FakeGoogleCannedResponse | 'fake';

interface Harness {
  fake: FakeGoogle;
  /** Every request as the client sent it (holds the Bearer header: never logged by this file). */
  requests: GoogleTransportRequest[];
  logs: GoogleLogRecord[];
  tokens: GoogleTokenSource;
  calendar: GoogleCalendarClient;
  api(): GoogleTransportRequest[];
  tokenRequests(): GoogleTransportRequest[];
}

function harness(opts: { fake?: FakeGoogleOptions; script?: Step[] } = {}): Harness {
  const fake = createFakeGoogle(opts.fake);
  const requests: GoogleTransportRequest[] = [];
  const logs: GoogleLogRecord[] = [];
  const script = [...(opts.script ?? [])];
  const transport: GoogleTransport = async (req) => {
    requests.push(req);
    if (req.url !== GOOGLE_TOKEN_URL && script.length > 0) {
      const step = script.shift()!;
      if (step !== 'fake') return fakeGoogleResponse(step.status, step.body, step.headers);
    }
    return fake.transport(req);
  };
  const logger = { event: (record: GoogleLogRecord) => logs.push(record) };
  const tokens = createGoogleOAuthRefreshTokenSource({
    clientId: FAKE_GOOGLE_CLIENT_ID,
    clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    refreshToken: FAKE_GOOGLE_REFRESH_TOKEN,
    scopes: BASE_SCOPES,
    transport,
    logger,
  });
  const calendar = createGoogleCalendarClient({ tokenSource: tokens, transport, logger });
  return {
    fake,
    requests,
    logs,
    tokens,
    calendar,
    api: () => requests.filter((req) => req.url !== GOOGLE_TOKEN_URL),
    tokenRequests: () => requests.filter((req) => req.url === GOOGLE_TOKEN_URL),
  };
}

const json = (req: GoogleTransportRequest): Record<string, unknown> => JSON.parse(req.body ?? 'null') as Record<string, unknown>;

async function rejection(promise: Promise<unknown>): Promise<GoogleError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleError);
    return error as GoogleError;
  }
  throw new Error('expected a rejection');
}

/** A Google-shaped event body for scripted answers. */
function eventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'calendar#event',
    id: EVENT_ID,
    status: 'confirmed',
    summary: SUMMARY,
    description: DESCRIPTION,
    organizer: { email: FAKE_GOOGLE_DEX_EMAIL, self: true },
    start: { dateTime: START, timeZone: GOOGLE_CALENDAR_TIME_ZONE },
    end: { dateTime: END, timeZone: GOOGLE_CALENDAR_TIME_ZONE },
    ...overrides,
  };
}

// ── Insert ──────────────────────────────────────────────────────────────────

describe('Google Calendar: insertEvent request snapshots', () => {
  it('calendar mode: primary calendar, conferenceDataVersion=1, sendUpdates=none, the exact closed body', async () => {
    const h = harness();
    const event = await h.calendar.insertEvent(insert());

    expect(h.tokenRequests()).toHaveLength(1);
    expect(h.api()).toHaveLength(1);
    const sent = h.api()[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(INSERT_URL);
    expect(sent.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${h.fake.tokensIssued[0]}`,
    });
    const body = json(sent);
    expect(Object.keys(body)).toEqual([
      'id',
      'summary',
      'description',
      'start',
      'end',
      'conferenceData',
      'guestsCanInviteOthers',
      'guestsCanModify',
      'guestsCanSeeOtherGuests',
      'reminders',
      'extendedProperties',
    ]);
    expect(body).toEqual({
      id: EVENT_ID,
      summary: SUMMARY,
      description: DESCRIPTION,
      start: { dateTime: START, timeZone: 'Asia/Kolkata' },
      end: { dateTime: END, timeZone: 'Asia/Kolkata' },
      conferenceData: { createRequest: { requestId: BOOKING_ID, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: false,
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { hello_booking_id: BOOKING_ID } },
    });
    expect('attendees' in body).toBe(false);
    expect('location' in body).toBe(false);
    expect(sent.body).not.toMatch(/displayName/);
    expect(sent.body).not.toMatch(/attendee/i);

    // The answer: Dex is the organizer, the conference is still pending.
    expect(event).toStrictEqual({
      id: EVENT_ID,
      status: 'confirmed',
      organizerEmail: FAKE_GOOGLE_DEX_EMAIL,
      hangoutLink: null,
      conferenceStatus: 'pending',
      conferenceId: null,
      startAt: START,
      endAt: END,
      attendeeEmails: [],
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.attendeeEmails)).toBe(true);
    // The fake honoured the create request only because conferenceDataVersion=1 was sent.
    expect(h.fake.events.get(EVENT_ID)!.conference).not.toBeNull();
  });

  it('space mode: the canonical Meet link in location, no conferenceData', async () => {
    const h = harness();
    const event = await h.calendar.insertEvent(spaceInsert());
    const body = json(h.api()[0]!);
    expect(Object.keys(body)).toEqual([
      'id',
      'summary',
      'description',
      'start',
      'end',
      'location',
      'guestsCanInviteOthers',
      'guestsCanModify',
      'guestsCanSeeOtherGuests',
      'reminders',
      'extendedProperties',
    ]);
    expect(body.location).toBe(MEET_URL);
    expect('conferenceData' in body).toBe(false);
    expect('attendees' in body).toBe(false);
    expect(h.api()[0]!.url).toBe(INSERT_URL);
    expect(event.conferenceStatus).toBeNull();
    expect(event.hangoutLink).toBeNull();
  });

  it('accepts the edges: 200-character summary, 4096-character multi-line description, exactly 24 h, Z and fractions', async () => {
    const h = harness();
    await h.calendar.insertEvent(
      insert({
        summary: 'S'.repeat(GOOGLE_CALENDAR_SUMMARY_MAX_LENGTH),
        description: ('line\n'.repeat(1000) + 'x'.repeat(96)).slice(0, GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH),
        startAt: '2026-12-01T04:30:00Z',
        endAt: '2026-12-02T04:30:00.000Z',
      }),
    );
    expect(h.api()).toHaveLength(1);
    expect(json(h.api()[0]!).description).toHaveLength(GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH);
    // An empty description is allowed too.
    const second = harness();
    await second.calendar.insertEvent(insert({ description: '' }));
    expect(json(second.api()[0]!).description).toBe('');
  });

  it('a replayed insert (same id) is already_exists, not a second event', async () => {
    const h = harness();
    await h.calendar.insertEvent(insert());
    const error = await rejection(h.calendar.insertEvent(insert()));
    expect(error.code).toBe('already_exists');
    expect(error.httpStatus).toBe(409);
    expect(error.retriable).toBe(false);
    expect(h.fake.events.size).toBe(1);
  });
});

describe('Google Calendar: refusals happen before any token or network', () => {
  const longText = (n: number) => 'x'.repeat(n);
  const cases: Array<[string, Partial<GoogleCalendarEventInsert> | Record<string, unknown>]> = [
    ['id upper-case', { id: EVENT_ID.toUpperCase() }],
    ['id 31 characters', { id: EVENT_ID.slice(1) }],
    ['id with dashes', { id: BOOKING_ID }],
    ['id not the booking id', { id: 'b'.repeat(32) }],
    ['booking id upper-case', { bookingId: BOOKING_ID.toUpperCase(), id: EVENT_ID }],
    ['booking id not a UUID', { bookingId: EVENT_ID }],
    ['empty request id', { requestId: '' }],
    ['request id with a space', { requestId: 'a b' }],
    ['request id with an underscore', { requestId: 'a_b' }],
    ['request id of 65 characters', { requestId: 'a'.repeat(65) }],
    ['start without an offset', { startAt: '2026-12-01T10:00:00' }],
    ['start with a space separator', { startAt: '2026-12-01 10:00:00+05:30' }],
    ['30 February', { startAt: '2026-02-30T10:00:00+05:30', endAt: '2026-02-30T10:45:00+05:30' }],
    ['hour 24', { startAt: '2026-12-01T24:00:00+05:30' }],
    ['end equals start', { endAt: START }],
    ['end before start', { startAt: END, endAt: START }],
    ['longer than 24 hours', { endAt: '2026-12-02T10:00:01+05:30' }],
    ['empty summary', { summary: '' }],
    ['blank summary', { summary: '   ' }],
    ['summary over 200', { summary: longText(GOOGLE_CALENDAR_SUMMARY_MAX_LENGTH + 1) }],
    ['summary with a newline', { summary: 'R1\nDex' }],
    ['summary with a bidi override', { summary: 'R1 ‮ Dex' }],
    ['summary with a zero-width space', { summary: 'R1​Dex' }],
    ['summary with a bell', { summary: 'R1\x07' }],
    ['description over 4096', { description: longText(GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH + 1) }],
    ['description with a carriage return', { description: 'a\r\nb' }],
    ['description with a tab', { description: 'a\tb' }],
    ['description with a line separator', { description: 'a b' }],
    ['description with a bidi isolate', { description: 'a⁦b' }],
    ['description with a lone surrogate', { description: 'a\ud800b' }],
    ['calendar mode with a location', { location: MEET_URL }],
    ['withConference not a boolean', { withConference: 'true' }],
    ['space mode without a location', { withConference: false, location: null }],
    ['space mode with a non-canonical link', { withConference: false, location: `${MEET_URL}?authuser=0` }],
    ['space mode with another host', { withConference: false, location: 'https://meet.example.test/abc-defg-hij' }],
    ['an attendees key', { attendees: [{ email: ATTENDEE }] }],
    ['a displayName key', { displayName: 'Candidate' }],
  ];

  it.each(cases)('%s -> invalid_request, zero transport calls, one failure log', async (_name, overrides) => {
    const h = harness();
    const error = await rejection(h.calendar.insertEvent(insert(overrides as Partial<GoogleCalendarEventInsert>)));
    expect(error.code).toBe('invalid_request');
    expect(error.operation).toBe('calendar.insert');
    expect(h.requests).toHaveLength(0);
    expect(h.fake.tokensIssued).toHaveLength(0);
    expect(h.logs).toEqual([{ operation: 'calendar.insert', outcome: 'failure', code: 'invalid_request', durationMs: expect.any(Number) }]);
  });

  it('a non-object insert is refused the same way', async () => {
    const h = harness();
    for (const bad of [null, undefined, 'event', 1, []]) {
      const error = await rejection(h.calendar.insertEvent(bad as unknown as GoogleCalendarEventInsert));
      expect(error.code).toBe('invalid_request');
    }
    expect(h.requests).toHaveLength(0);
  });

  it('get, patch and delete refuse a bad id, patch shape or sendUpdates with zero calls', async () => {
    const h = harness();
    const badIds = ['', EVENT_ID.toUpperCase(), BOOKING_ID, `${EVENT_ID}/x`, 'a'.repeat(33), 7 as unknown as string];
    for (const id of badIds) {
      expect((await rejection(h.calendar.getEvent(id))).code).toBe('invalid_request');
      expect((await rejection(h.calendar.deleteEvent(id, 'none'))).code).toBe('invalid_request');
      expect((await rejection(h.calendar.patchEvent(id, { description: 'x' }, 'none'))).code).toBe('invalid_request');
    }
    const badPatches: unknown[] = [
      {},
      { startAt: undefined },
      { startAt: START },
      { endAt: END },
      { startAt: END, endAt: START },
      { startAt: START, endAt: '2026-12-03T10:00:00+05:30' },
      { attendeeEmail: 'a b@mail.example.test' },
      { attendeeEmail: 'nobody' },
      { attendeeEmail: 'a@b' },
      { attendeeEmail: 'a@@mail.example.test' },
      { attendeeEmail: '<a@mail.example.test>' },
      { attendeeEmail: 'a,b@mail.example.test' },
      { attendeeEmail: 'a;b@mail.example.test' },
      { attendeeEmail: `${'a'.repeat(250)}@b.cd` },
      { attendeeEmail: '' },
      { description: 'a\rb' },
      { description: 'x'.repeat(GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH + 1) },
      { summary: 'renamed' },
      { attendees: [{ email: ATTENDEE }] },
      null,
      'patch',
    ];
    for (const patch of badPatches) {
      const error = await rejection(h.calendar.patchEvent(EVENT_ID, patch as GoogleCalendarEventPatch, 'none'));
      expect(error.code, JSON.stringify(patch)).toBe('invalid_request');
      expect(error.operation).toBe('calendar.patch');
    }
    for (const sendUpdates of ['externalOnly', 'ALL', '', undefined]) {
      const updates = sendUpdates as unknown as 'all';
      expect((await rejection(h.calendar.patchEvent(EVENT_ID, { description: 'x' }, updates))).code).toBe('invalid_request');
      expect((await rejection(h.calendar.deleteEvent(EVENT_ID, updates))).code).toBe('invalid_request');
    }
    expect(h.requests).toHaveLength(0);
    expect(h.fake.tokensIssued).toHaveLength(0);
  });

  it('the strict ISO validator', () => {
    for (const ok of [START, END, '2026-12-01T04:30:00Z', '2028-02-29T00:00:00+00:00', '2026-12-01T10:00:00.123456789-03:30']) {
      expect(isGoogleIsoDateTime(ok), ok).toBe(true);
    }
    for (const bad of [
      '2026-12-01',
      '2026-12-01T10:00+05:30',
      '2026-12-01T10:00:00',
      '2027-02-29T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-12-01T10:60:00Z',
      '2026-12-01T10:00:00+24:00',
      ' 2026-12-01T10:00:00Z',
      '2026-12-01T10:00:00z',
      `2026-12-01T10:00:00.${'1'.repeat(60)}Z`,
      1764563400000,
      null,
    ]) {
      expect(isGoogleIsoDateTime(bad), String(bad)).toBe(false);
    }
  });
});

// ── Parse ───────────────────────────────────────────────────────────────────

describe('Google Calendar: the parsed event is closed', () => {
  it('lower-cases the organizer, canonicalises the link, reads the conference and drops everything else', async () => {
    const attendees = [
      { email: 'Candidate.One@Mail.Example.TEST', displayName: 'Candidate One', responseStatus: 'accepted' },
      { email: 'not-an-email' },
      { email: 'candidate.one@mail.example.test' },
      'junk',
      ...Array.from({ length: 12 }, (_, i) => ({ email: `guest${i}@mail.example.test` })),
    ];
    const h = harness({
      script: [
        {
          status: 200,
          body: eventBody({
            organizer: { email: 'DEX@Hello.Example.Test', displayName: 'Dex', self: true },
            hangoutLink: `${MEET_URL}?authuser=0`,
            conferenceData: {
              createRequest: { requestId: BOOKING_ID, status: { statusCode: 'success' } },
              conferenceId: 'abc-defg-hij',
              entryPoints: [{ entryPointType: 'video', uri: MEET_URL }],
              signature: 'sig',
            },
            attendees,
            extendedProperties: { private: { hello_booking_id: BOOKING_ID } },
            htmlLink: 'https://www.google.com/calendar/event?eid=x',
            location: 'somewhere',
          }),
        },
      ],
    });
    const event = await h.calendar.getEvent(EVENT_ID);
    expect(event).not.toBeNull();
    expect(Object.keys(event!)).toEqual([
      'id',
      'status',
      'organizerEmail',
      'hangoutLink',
      'conferenceStatus',
      'conferenceId',
      'startAt',
      'endAt',
      'attendeeEmails',
    ]);
    expect(event!.organizerEmail).toBe('dex@hello.example.test');
    expect(event!.hangoutLink).toBe(MEET_URL);
    expect(event!.conferenceStatus).toBe('success');
    expect(event!.conferenceId).toBe('abc-defg-hij');
    expect(event!.attendeeEmails).toHaveLength(GOOGLE_CALENDAR_MAX_PARSED_ATTENDEES);
    expect(event!.attendeeEmails[0]).toBe('candidate.one@mail.example.test');
    expect(event!.attendeeEmails).toEqual([
      'candidate.one@mail.example.test',
      ...Array.from({ length: 9 }, (_, i) => `guest${i}@mail.example.test`),
    ]);
    expect(JSON.stringify(event)).not.toMatch(/Candidate One|displayName|hello_booking_id|somewhere|htmlLink|sig/);
  });

  it.each<[string, Record<string, unknown>, Partial<Record<string, unknown>>]>([
    ['no organizer', { organizer: undefined }, { organizerEmail: null }],
    ['a malformed organizer', { organizer: { email: 'dex' } }, { organizerEmail: null }],
    ['a link on another host', { hangoutLink: 'https://meet.example.test/abc-defg-hij' }, { hangoutLink: null }],
    ['a link that is not a string', { hangoutLink: 42 }, { hangoutLink: null }],
    ['a pending conference', { conferenceData: { createRequest: { status: { statusCode: 'pending' } } } }, { conferenceStatus: 'pending' }],
    ['a failed conference', { conferenceData: { createRequest: { status: { statusCode: 'failure' } } } }, { conferenceStatus: 'failure' }],
    ['an unknown conference status', { conferenceData: { createRequest: { status: { statusCode: 'weird' } } } }, { conferenceStatus: null }],
    ['an upper-case conference id', { conferenceData: { conferenceId: 'ABC-DEFG-HIJ' } }, { conferenceId: null }],
    ['a conference id of another shape', { conferenceData: { conferenceId: 'abcdefghij' } }, { conferenceId: null }],
    ['an all-day start', { start: { date: '2026-12-01' } }, { startAt: null }],
    ['a start that is not strict ISO', { start: { dateTime: '2026-12-01T10:00' } }, { startAt: null }],
    ['no end', { end: undefined }, { endAt: null }],
    ['attendees that are not an array', { attendees: { email: ATTENDEE } }, { attendeeEmails: [] }],
  ])('%s', async (_name, overrides, expected) => {
    const h = harness({ script: [{ status: 200, body: eventBody(overrides) }] });
    const event = await h.calendar.getEvent(EVENT_ID);
    expect(event).toMatchObject(expected);
  });

  it.each<[string, unknown]>([
    ['an id that is not the one asked for', eventBody({ id: 'b'.repeat(32) })],
    ['no id', eventBody({ id: undefined })],
    ['no status', eventBody({ status: undefined })],
    ['an upper-case status', eventBody({ status: 'Confirmed' })],
    ['a status that is not a word', eventBody({ status: 'confirmed!' })],
    ['an array', [eventBody()]],
    ['a JSON string', '"event"'],
    ['not JSON', 'not json'],
    ['null', 'null'],
  ])('%s -> malformed_response', async (_name, body) => {
    const h = harness({ script: [{ status: 200, body }] });
    const error = await rejection(h.calendar.getEvent(EVENT_ID));
    expect(error.code).toBe('malformed_response');
    expect(error.operation).toBe('calendar.get');
    expect(error.httpStatus).toBe(200);
    expect(h.logs.at(-1)).toMatchObject({ operation: 'calendar.get', outcome: 'failure', code: 'malformed_response' });
  });

  it('an empty 200 body on get is malformed (an event is expected)', async () => {
    const h = harness({ script: [{ status: 200 }] });
    expect((await rejection(h.calendar.getEvent(EVENT_ID))).code).toBe('malformed_response');
  });
});

// ── Get, patch, delete ──────────────────────────────────────────────────────

describe('Google Calendar: getEvent, patchEvent, deleteEvent', () => {
  it('get: the exact URL, no body; the conference turns success after the configured gets', async () => {
    const h = harness({ fake: { conferenceReadyAfterGets: 2 } });
    await h.calendar.insertEvent(insert());
    const first = await h.calendar.getEvent(EVENT_ID);
    const second = await h.calendar.getEvent(EVENT_ID);
    const [, getOne, getTwo] = h.api();
    expect(getOne!.method).toBe('GET');
    expect(getOne!.url).toBe(EVENT_URL);
    expect(getOne!.body).toBeUndefined();
    expect('content-type' in getOne!.headers).toBe(false);
    expect(getTwo!.url).toBe(EVENT_URL);
    expect(first!.conferenceStatus).toBe('pending');
    expect(second!.conferenceStatus).toBe('success');
    const code = h.fake.events.get(EVENT_ID)!.conference!.code;
    expect(second!.conferenceId).toBe(code);
    expect(second!.hangoutLink).toBe(`https://meet.google.com/${code}`);
    // One token for the three calls.
    expect(h.tokenRequests()).toHaveLength(1);
  });

  it('get: 404 and 410 are null, logged once as a success with the status', async () => {
    const h = harness();
    expect(await h.calendar.getEvent(EVENT_ID)).toBeNull();
    await h.calendar.insertEvent(insert());
    await h.calendar.deleteEvent(EVENT_ID, 'none');
    h.logs.length = 0;
    expect(await h.calendar.getEvent(EVENT_ID)).toBeNull();
    expect(h.logs).toEqual([{ operation: 'calendar.get', outcome: 'success', httpStatus: 410, durationMs: expect.any(Number) }]);
  });

  it('patch: only the given keys; attendees exactly one {email}; conferenceDataVersion=1 and sendUpdates', async () => {
    const h = harness({ fake: { conferenceReadyAfterGets: 0 } });
    await h.calendar.insertEvent(insert());

    const moved = await h.calendar.patchEvent(
      EVENT_ID,
      { startAt: '2026-12-01T11:00:00+05:30', endAt: '2026-12-01T11:45:00+05:30' },
      'none',
    );
    let sent = h.api().at(-1)!;
    expect(sent.method).toBe('PATCH');
    expect(sent.url).toBe(`${EVENT_URL}?conferenceDataVersion=1&sendUpdates=none`);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(json(sent)).toEqual({
      start: { dateTime: '2026-12-01T11:00:00+05:30', timeZone: 'Asia/Kolkata' },
      end: { dateTime: '2026-12-01T11:45:00+05:30', timeZone: 'Asia/Kolkata' },
    });
    expect(moved.startAt).toBe('2026-12-01T11:00:00+05:30');

    await h.calendar.patchEvent(EVENT_ID, { attendeeEmail: ATTENDEE }, 'all');
    sent = h.api().at(-1)!;
    expect(sent.url).toBe(`${EVENT_URL}?conferenceDataVersion=1&sendUpdates=all`);
    expect(json(sent)).toEqual({ attendees: [{ email: ATTENDEE }] });
    expect(sent.body).not.toMatch(/displayName/);

    await h.calendar.patchEvent(EVENT_ID, { description: 'Updated notice.' }, 'none');
    expect(json(h.api().at(-1)!)).toEqual({ description: 'Updated notice.' });

    await h.calendar.patchEvent(
      EVENT_ID,
      { startAt: START, endAt: END, attendeeEmail: ATTENDEE, description: 'Both.' },
      'all',
    );
    expect(Object.keys(json(h.api().at(-1)!))).toEqual(['start', 'end', 'attendees', 'description']);
  });

  it('patch: Google replaces the attendees wholesale, so a second attendee patch leaves exactly that one', async () => {
    const h = harness();
    await h.calendar.insertEvent(insert());
    await h.calendar.patchEvent(EVENT_ID, { attendeeEmail: ATTENDEE }, 'all');
    const second = 'candidate.two@mail.example.test';
    const event = await h.calendar.patchEvent(EVENT_ID, { attendeeEmail: second }, 'all');
    expect(event.attendeeEmails).toEqual([second]);
    // A time-only patch keeps the attendee (no attendees key was sent).
    const moved = await h.calendar.patchEvent(EVENT_ID, { startAt: START, endAt: END }, 'all');
    expect(moved.attendeeEmails).toEqual([second]);
  });

  it('patch: 404 / 410 stay errors (not_found), never null', async () => {
    const h = harness();
    const error = await rejection(h.calendar.patchEvent(EVENT_ID, { description: 'x' }, 'none'));
    expect(error.code).toBe('not_found');
    expect(error.httpStatus).toBe(404);
    expect(error.operation).toBe('calendar.patch');
  });

  it('delete: 204 -> deleted with sendUpdates; then 410 -> gone; unknown 404 -> gone', async () => {
    const h = harness();
    await h.calendar.insertEvent(insert());
    expect(await h.calendar.deleteEvent(EVENT_ID, 'all')).toBe('deleted');
    const sent = h.api().at(-1)!;
    expect(sent.method).toBe('DELETE');
    expect(sent.url).toBe(`${EVENT_URL}?sendUpdates=all`);
    expect(sent.body).toBeUndefined();
    expect(await h.calendar.deleteEvent(EVENT_ID, 'none')).toBe('gone');
    expect(h.api().at(-1)!.url).toBe(`${EVENT_URL}?sendUpdates=none`);
    const other = 'c'.repeat(32);
    expect(await h.calendar.deleteEvent(other, 'none')).toBe('gone');
    expect(h.logs.filter((r) => r.operation === 'calendar.delete')).toEqual([
      { operation: 'calendar.delete', outcome: 'success', httpStatus: 204, durationMs: expect.any(Number) },
      { operation: 'calendar.delete', outcome: 'success', httpStatus: 410, durationMs: expect.any(Number) },
      { operation: 'calendar.delete', outcome: 'success', httpStatus: 404, durationMs: expect.any(Number) },
    ]);
  });

  it('delete: a 200 with a body is deleted too', async () => {
    const h = harness({ script: [{ status: 200, body: {} }] });
    expect(await h.calendar.deleteEvent(EVENT_ID, 'none')).toBe('deleted');
  });
});

// ── Auth and errors ─────────────────────────────────────────────────────────

describe('Google Calendar: the 401 re-mint and the error map', () => {
  it('401 then 200: exactly one invalidate, one new mint and one retry of the same request', async () => {
    const h = harness();
    await h.calendar.insertEvent(insert());
    h.fake.expireAccessTokens();
    h.logs.length = 0;
    const event = await h.calendar.getEvent(EVENT_ID);
    expect(event!.id).toBe(EVENT_ID);
    expect(h.requests.map((req) => [req.method, req.url === GOOGLE_TOKEN_URL ? 'token' : req.url])).toEqual([
      ['POST', 'token'],
      ['POST', INSERT_URL],
      ['GET', EVENT_URL],
      ['POST', 'token'],
      ['GET', EVENT_URL],
    ]);
    expect(h.fake.tokensIssued).toHaveLength(2);
    expect(h.requests[2]!.headers.authorization).toBe(`Bearer ${h.fake.tokensIssued[0]}`);
    expect(h.requests[4]!.headers.authorization).toBe(`Bearer ${h.fake.tokensIssued[1]}`);
    // One record for the public call, one for the re-mint.
    expect(h.logs.map((r) => [r.operation, r.outcome])).toEqual([
      ['token.refresh', 'success'],
      ['calendar.get', 'success'],
    ]);
  });

  it('401 twice -> unauthorized after exactly two API requests (not retried again)', async () => {
    const unauthorized: FakeGoogleCannedResponse = {
      status: 401,
      body: { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } },
    };
    const h = harness({ script: [unauthorized, unauthorized, unauthorized] });
    const error = await rejection(h.calendar.insertEvent(insert()));
    expect(error.code).toBe('unauthorized');
    expect(error.retriable).toBe(false);
    expect(error.httpStatus).toBe(401);
    expect(h.api()).toHaveLength(2);
    expect(h.tokenRequests()).toHaveLength(2);
    expect(h.logs.filter((r) => r.operation === 'calendar.insert')).toEqual([
      { operation: 'calendar.insert', outcome: 'failure', code: 'unauthorized', httpStatus: 401, durationMs: expect.any(Number) },
    ]);
  });

  it.each<[string, FakeGoogleCannedResponse, GoogleErrorCode, number | null]>([
    [
      '403 usageLimits with Retry-After: 7',
      {
        status: 403,
        headers: { 'Retry-After': '7' },
        body: { error: { code: 403, errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } },
      },
      'quota',
      7000,
    ],
    [
      '403 quotaExceeded',
      { status: 403, body: { error: { code: 403, errors: [{ domain: 'calendar', reason: 'quotaExceeded' }] } } },
      'quota',
      30_000,
    ],
    [
      '403 forbiddenForNonOrganizer',
      { status: 403, body: { error: { code: 403, errors: [{ domain: 'calendar', reason: 'forbiddenForNonOrganizer' }] } } },
      'setup_forbidden',
      null,
    ],
    [
      '403 accessNotConfigured (API not enabled)',
      { status: 403, body: { error: { code: 403, errors: [{ domain: 'usageLimits', reason: 'accessNotConfigured' }] } } },
      'setup_forbidden',
      null,
    ],
    ['429', { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } }, 'quota', 30_000],
    ['400', { status: 400, body: { error: { code: 400, errors: [{ reason: 'invalid' }] } } }, 'invalid_request', null],
    ['412', { status: 412 }, 'invalid_request', null],
    ['409', { status: 409 }, 'already_exists', null],
    ['503', { status: 503 }, 'unavailable', 10_000],
    ['502 with Retry-After: 2', { status: 502, headers: { 'retry-after': '2' } }, 'unavailable', 2000],
    ['302 (never followed)', { status: 302, headers: { location: 'https://elsewhere.example.test/' } }, 'malformed_response', null],
  ])('%s -> %s', async (_name, response, code, retryAfterMs) => {
    const h = harness({ script: [response] });
    const error = await rejection(h.calendar.insertEvent(insert()));
    expect(error.code).toBe(code);
    expect(error.operation).toBe('calendar.insert');
    expect(error.retryAfterMs).toBe(retryAfterMs);
    expect(h.api()).toHaveLength(1);
  });

  it('a transport failure on the API call is unavailable (retriable), not retried', async () => {
    const fake = createFakeGoogle();
    let apiCalls = 0;
    const transport: GoogleTransport = async (req) => {
      if (req.url === GOOGLE_TOKEN_URL) return fake.transport(req);
      apiCalls += 1;
      throw new Error('socket hang up');
    };
    const tokens = createGoogleOAuthRefreshTokenSource({
      clientId: FAKE_GOOGLE_CLIENT_ID,
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
      refreshToken: FAKE_GOOGLE_REFRESH_TOKEN,
      scopes: BASE_SCOPES,
      transport,
    });
    const calendar = createGoogleCalendarClient({ tokenSource: tokens, transport });
    const error = await rejection(calendar.getEvent(EVENT_ID));
    expect(error.code).toBe('unavailable');
    expect(error.retryAfterMs).toBe(5000);
    expect(apiCalls).toBe(1);
  });

  it('a revoked refresh token (auth_revoked) propagates with zero API requests', async () => {
    const h = harness();
    h.fake.revokeRefreshToken();
    const error = await rejection(h.calendar.insertEvent(insert()));
    expect(error.code).toBe('auth_revoked');
    expect(error.operation).toBe('token.refresh');
    expect(error.retriable).toBe(false);
    expect(h.api()).toHaveLength(0);
    expect(h.tokenRequests()).toHaveLength(1);
    expect(h.logs.map((r) => [r.operation, r.outcome, r.code])).toEqual([
      ['token.refresh', 'failure', 'auth_revoked'],
      ['calendar.insert', 'failure', 'auth_revoked'],
    ]);
    // Inside the refusal window the next call makes no request at all.
    await rejection(h.calendar.getEvent(EVENT_ID));
    expect(h.requests).toHaveLength(1);
  });

  it('a token source that throws something else, or answers a bad token, never reaches the API', async () => {
    const fake = createFakeGoogle();
    const calls: GoogleTransportRequest[] = [];
    const transport: GoogleTransport = async (req) => {
      calls.push(req);
      return fake.transport(req);
    };
    const throwing = createGoogleCalendarClient({
      tokenSource: { accessToken: async () => Promise.reject(new Error('boom')), invalidate: () => {} },
      transport,
    });
    expect((await rejection(throwing.getEvent(EVENT_ID))).code).toBe('unavailable');
    const spaced = createGoogleCalendarClient({
      tokenSource: { accessToken: async () => 'two words', invalidate: () => {} },
      transport,
    });
    expect((await rejection(spaced.getEvent(EVENT_ID))).code).toBe('malformed_response');
    expect(calls).toHaveLength(0);
  });

  it('the constructor refuses an unusable token source or seam, synchronously', () => {
    const tokens = { accessToken: async () => 'at-x', invalidate: () => {} };
    const bad: unknown[] = [
      undefined,
      null,
      {},
      { tokenSource: null },
      { tokenSource: { accessToken: async () => 'at-x' } },
      { tokenSource: tokens, transport: 'fetch' },
      { tokenSource: tokens, logger: {} },
      { tokenSource: tokens, logger: null },
    ];
    for (const options of bad) {
      expect(() => createGoogleCalendarClient(options as never)).toThrow(GoogleError);
    }
    expect(() => createGoogleCalendarClient({ tokenSource: tokens })).not.toThrow();
  });

  it('a throwing logger never breaks a call', async () => {
    const fake = createFakeGoogle();
    const tokens = createGoogleOAuthRefreshTokenSource({
      clientId: FAKE_GOOGLE_CLIENT_ID,
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
      refreshToken: FAKE_GOOGLE_REFRESH_TOKEN,
      scopes: BASE_SCOPES,
      transport: fake.transport,
    });
    const calendar = createGoogleCalendarClient({
      tokenSource: tokens,
      transport: fake.transport,
      logger: {
        event: () => {
          throw new Error('logger down');
        },
      },
    });
    await expect(calendar.insertEvent(insert())).resolves.toMatchObject({ id: EVENT_ID });
    await expect(calendar.getEvent('bad')).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

// ── Canary ──────────────────────────────────────────────────────────────────

describe('Google Calendar: no token, id, link, email or text in any log record or error', () => {
  it('across successes and every kind of failure', async () => {
    const h = harness({
      fake: { conferenceReadyAfterGets: 0 },
      script: ['fake', 'fake', 'fake', { status: 403, body: { error: { message: `forbidden ${ATTENDEE} ${MEET_URL}` } } }],
    });
    const errors: unknown[] = [];
    const event = await h.calendar.insertEvent(insert());
    await h.calendar.getEvent(EVENT_ID);
    await h.calendar.patchEvent(EVENT_ID, { attendeeEmail: ATTENDEE, description: DESCRIPTION }, 'all');
    for (const failing of [
      h.calendar.patchEvent(EVENT_ID, { attendeeEmail: ATTENDEE }, 'all'),
      h.calendar.insertEvent(insert()),
      h.calendar.insertEvent(insert({ summary: `${SUMMARY}\n${ATTENDEE}` })),
      h.calendar.patchEvent(EVENT_ID, { attendeeEmail: `${ATTENDEE} ` }, 'all'),
    ]) {
      errors.push(await rejection(failing));
    }
    h.fake.revokeRefreshToken();
    h.tokens.invalidate();
    errors.push(await rejection(h.calendar.getEvent(EVENT_ID)));
    expect(event.hangoutLink).not.toBeNull();

    const canaries = [
      ...h.fake.tokensIssued,
      FAKE_GOOGLE_CLIENT_SECRET,
      FAKE_GOOGLE_REFRESH_TOKEN,
      EVENT_ID,
      BOOKING_ID,
      event.hangoutLink!,
      event.conferenceId!,
      ATTENDEE,
      FAKE_GOOGLE_DEX_EMAIL,
      DESCRIPTION_CANARY,
      SUMMARY,
      'meet.google.com',
    ];
    const texts = [
      JSON.stringify(h.logs),
      ...errors.flatMap((error) => [String(error), JSON.stringify(error), inspect(error), (error as Error).stack ?? '']),
      inspect(h.calendar, { showHidden: true }),
      JSON.stringify(h.calendar),
      JSON.stringify(Object.keys(h.calendar)),
    ];
    for (const text of texts) {
      for (const canary of canaries) expect(text).not.toContain(canary);
    }
    for (const record of h.logs) {
      for (const key of Object.keys(record)) expect(['operation', 'outcome', 'code', 'httpStatus', 'durationMs']).toContain(key);
    }
  });
});
