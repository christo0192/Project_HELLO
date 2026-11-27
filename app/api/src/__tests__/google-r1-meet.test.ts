/**
 * `createR1MeetGoogle` (M035 S03 T3): the Google client for Dex as the public booking link uses it.
 *
 * Covers the token source picked by `settings.authMode` (the DEFAULT `oauth_refresh` refresh grant
 * with Dex's OAuth client; `service_account` a jwt-bearer grant whose `sub` is Dex), the scopes per
 * Meet mode (2 in calendar mode, 3 in space mode, for both auth modes), that the settings' secrets are
 * read although they are non-enumerable (and that a spread copy, which drops them, is refused), that
 * construction makes no call, one token shared by both clients, an end-to-end run against the fake
 * (insert -> conference success -> space -> OPEN -> read back -> move keeps the link -> invite ->
 * delete) inside the three allowed URL families, and a secret canary.
 *
 * The settings are built the way S05/S06 get them: through lib/r1/meet/config.ts
 * (`getR1MeetPublicDrainConfig`) from a source object, with secrets built at run time and a
 * throwaway RSA pair generated per run (no key material in the repository).
 */
import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createR1MeetGoogle,
  getR1MeetGoogle,
  r1MeetGoogleScopes,
  resetR1MeetGoogleCache,
} from '../integrations/google/client.js';
import { GoogleError } from '../integrations/google/errors.js';
import {
  GOOGLE_CALENDAR_EVENTS_URL,
  GOOGLE_MEET_API_URL,
  GOOGLE_TOKEN_URL,
  isAllowedGoogleUrl,
  type GoogleLogRecord,
  type GoogleTransport,
  type GoogleTransportRequest,
} from '../integrations/google/http.js';
import {
  GOOGLE_JWT_BEARER_GRANT_TYPE,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_REFUSAL_WINDOW_MS,
} from '../integrations/google/token.js';
import {
  getR1MeetPublicDrainConfig,
  type R1MeetGoogleEnvSource,
  type R1MeetGoogleSettings,
} from '../lib/r1/meet/config.js';
import {
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_DEX_EMAIL,
  FAKE_GOOGLE_REFRESH_TOKEN,
  FAKE_GOOGLE_SA_EMAIL,
  createFakeGoogle,
  type FakeGoogle,
  type FakeGoogleOptions,
} from './support/google-fake.js';

// ── Fixtures (built at run time, low entropy) ───────────────────────────────

const T0 = Date.UTC(2026, 11, 1, 4, 30, 0);
const PAIR = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KID = 'kid' + '0'.repeat(37);
const CALENDAR_SCOPES = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings];
const SPACE_SCOPES = [...CALENDAR_SCOPES, GOOGLE_SCOPES.meetSpaceCreated];

const BOOKING_ID = ['0123abcd', '0000', '4000', '8000', 'b'.repeat(12)].join('-');
const EVENT_ID = BOOKING_ID.replace(/-/g, '');
const START = '2026-12-01T10:00:00+05:30';
const END = '2026-12-01T10:45:00+05:30';
const ATTENDEE = 'candidate.one@mail.example.test';

const saKeyB64 = (): string =>
  Buffer.from(
    JSON.stringify({
      type: 'service_account',
      project_id: 'hello-project',
      private_key_id: KID,
      private_key: PEM,
      client_email: FAKE_GOOGLE_SA_EMAIL,
    }),
  ).toString('base64');

function oauthSettings(refreshToken: string = FAKE_GOOGLE_REFRESH_TOKEN): R1MeetGoogleSettings {
  const source: R1MeetGoogleEnvSource = {
    R1_MEET_GOOGLE_DEX_EMAIL: FAKE_GOOGLE_DEX_EMAIL,
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
  };
  source['R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET'] = FAKE_GOOGLE_CLIENT_SECRET;
  source['R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN'] = refreshToken;
  const drain = getR1MeetPublicDrainConfig(source);
  if (!drain.available || drain.google.authMode !== 'oauth_refresh') throw new Error('expected oauth settings');
  return drain.google;
}

function serviceAccountSettings(): R1MeetGoogleSettings {
  const source: R1MeetGoogleEnvSource = {
    R1_MEET_GOOGLE_AUTH_MODE: 'service_account',
    R1_MEET_GOOGLE_DEX_EMAIL: FAKE_GOOGLE_DEX_EMAIL,
  };
  source['R1_MEET_GOOGLE_SA_KEY_B64'] = saKeyB64();
  const drain = getR1MeetPublicDrainConfig(source);
  if (!drain.available || drain.google.authMode !== 'service_account') throw new Error('expected service account settings');
  return drain.google;
}

function recording(fake: FakeGoogle, requests: GoogleTransportRequest[]): GoogleTransport {
  return (req) => {
    requests.push(req);
    return fake.transport(req);
  };
}

function setup(
  settings: R1MeetGoogleSettings,
  meetMode: 'calendar' | 'space',
  fakeOptions: FakeGoogleOptions = {},
) {
  // One clock for both sides: the fake checks the JWT `exp` against it, the token source signs `iat` with it.
  const clock = { t: T0 };
  const fake = createFakeGoogle({
    serviceAccount: { clientEmail: FAKE_GOOGLE_SA_EMAIL, publicKey: PAIR.publicKey },
    grantedScopes: SPACE_SCOPES,
    now: () => clock.t,
    ...fakeOptions,
  });
  const requests: GoogleTransportRequest[] = [];
  const logs: GoogleLogRecord[] = [];
  const google = createR1MeetGoogle({
    settings,
    meetMode,
    transport: recording(fake, requests),
    now: () => clock.t,
    logger: { event: (record) => logs.push(record) },
  });
  return { fake, requests, logs, google, clock };
}

const form = (req: GoogleTransportRequest): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(req.body ?? '').entries());

function jwtClaims(req: GoogleTransportRequest): Record<string, unknown> {
  const assertion = form(req).assertion ?? '';
  return JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

const insertArgs = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  summary: 'Interview Kickstart R1 with Dex (AI interviewer)',
  description: 'Your R1 interview with Dex.',
  startAt: START,
  endAt: END,
  requestId: BOOKING_ID,
  bookingId: BOOKING_ID,
  withConference: true,
  location: null,
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<GoogleError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleError);
    return error as GoogleError;
  }
  throw new Error('expected a rejection');
}

describe('createR1MeetGoogle: the token source by auth mode', () => {
  it('scopes: two in calendar mode, three in space mode', () => {
    expect([...r1MeetGoogleScopes('calendar')]).toEqual(CALENDAR_SCOPES);
    expect([...r1MeetGoogleScopes('space')]).toEqual(SPACE_SCOPES);
    expect(Object.isFrozen(r1MeetGoogleScopes('calendar'))).toBe(true);
  });

  it('oauth_refresh (DEFAULT): the first request is the refresh grant with Dex OAuth client, read from hidden fields', async () => {
    const settings = oauthSettings();
    // The secrets are non-enumerable on the settings, yet the client reads them by name.
    expect(Object.keys(settings)).toEqual(['authMode', 'dexEmail', 'clientId']);
    const { requests, google } = setup(settings, 'calendar');
    expect(requests).toHaveLength(0);
    await google.calendar.insertEvent(insertArgs());
    const token = requests[0]!;
    expect(token.url).toBe(GOOGLE_TOKEN_URL);
    expect(form(token)).toEqual({
      grant_type: 'refresh_token',
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: FAKE_GOOGLE_CLIENT_SECRET,
      refresh_token: FAKE_GOOGLE_REFRESH_TOKEN,
    });
    expect(requests[1]!.url).toBe(`${GOOGLE_CALENDAR_EVENTS_URL}?conferenceDataVersion=1&sendUpdates=none`);
  });

  it('service_account: a jwt-bearer grant whose sub is Dex, scope = 2 in calendar mode and 3 in space mode', async () => {
    const settings = serviceAccountSettings();
    for (const [meetMode, scopes] of [
      ['calendar', CALENDAR_SCOPES],
      ['space', SPACE_SCOPES],
    ] as const) {
      const { requests, google } = setup(settings, meetMode);
      await google.meet.getSpace('abc-defg-hij');
      const token = requests[0]!;
      expect(form(token).grant_type).toBe(GOOGLE_JWT_BEARER_GRANT_TYPE);
      const claims = jwtClaims(token);
      expect(claims.sub).toBe(FAKE_GOOGLE_DEX_EMAIL);
      expect(claims.iss).toBe(FAKE_GOOGLE_SA_EMAIL);
      expect(claims.aud).toBe(GOOGLE_TOKEN_URL);
      // The injected clock reached the token source.
      expect(claims.iat).toBe(Math.floor(T0 / 1000));
      expect(String(claims.scope).split(' ')).toEqual(scopes);
      // The fake verified the signature with the public key: the API call went through.
      expect(requests).toHaveLength(2);
    }
  });

  it('oauth_refresh in space mode: a grant without meetings.space.created fails closed (setup_forbidden)', async () => {
    const { requests, google } = setup(oauthSettings(), 'space', { grantedScopes: CALENDAR_SCOPES });
    const error = await rejection(google.meet.createOpenSpace());
    expect(error.code).toBe('setup_forbidden');
    expect(error.operation).toBe('token.refresh');
    expect(requests.map((req) => req.url)).toEqual([GOOGLE_TOKEN_URL]);
    // With the three scopes granted, the same mode works.
    const ok = setup(oauthSettings(), 'space');
    await expect(ok.google.meet.createOpenSpace()).resolves.toMatchObject({ accessType: 'OPEN', entryPointAccess: 'ALL' });
  });

  it('one token source is shared: a calendar call and a Meet call mint once', async () => {
    const { requests, fake, google } = setup(oauthSettings(), 'calendar');
    await google.calendar.getEvent(EVENT_ID);
    await google.meet.getSpace('abc-defg-hij');
    expect(fake.tokensIssued).toHaveLength(1);
    expect(requests.filter((req) => req.url === GOOGLE_TOKEN_URL)).toHaveLength(1);
  });

  it('refuses, synchronously and with zero calls: spread settings (secrets dropped), unknown modes, a bad seam', () => {
    const fake = createFakeGoogle();
    const requests: GoogleTransportRequest[] = [];
    const transport = recording(fake, requests);
    const oauth = oauthSettings();
    const sa = serviceAccountSettings();
    const bad: unknown[] = [
      undefined,
      null,
      { settings: null, meetMode: 'calendar', transport },
      { settings: { ...oauth }, meetMode: 'calendar', transport },
      { settings: JSON.parse(JSON.stringify(sa)), meetMode: 'calendar', transport },
      { settings: { ...oauth, authMode: 'dwd' }, meetMode: 'calendar', transport },
      { settings: oauth, meetMode: 'both', transport },
      { settings: oauth, transport },
      { settings: oauth, meetMode: 'calendar', transport: 'fetch' },
      { settings: oauth, meetMode: 'calendar', transport, logger: {} },
      { settings: oauth, meetMode: 'calendar', transport, now: 5 },
    ];
    for (const options of bad) {
      expect(() => createR1MeetGoogle(options as never)).toThrow(GoogleError);
    }
    expect(requests).toHaveLength(0);
    expect(() => createR1MeetGoogle({ settings: oauth, meetMode: 'calendar', transport })).not.toThrow();
    expect(() => createR1MeetGoogle({ settings: sa, meetMode: 'space', transport })).not.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe('createR1MeetGoogle: end to end against the fake (calendar mode)', () => {
  for (const [label, build] of [
    ['oauth_refresh', oauthSettings],
    ['service_account', serviceAccountSettings],
  ] as const) {
    it(`${label}: insert -> success -> space -> OPEN -> read back -> move keeps the link -> invite -> delete`, async () => {
      const { requests, fake, logs, google } = setup(build(), 'calendar', { conferenceReadyAfterGets: 2 });

      const inserted = await google.calendar.insertEvent(insertArgs());
      expect(inserted.conferenceStatus).toBe('pending');
      expect(inserted.organizerEmail).toBe(FAKE_GOOGLE_DEX_EMAIL);

      let event = inserted;
      for (let poll = 0; poll < 10 && event.conferenceStatus === 'pending'; poll += 1) {
        event = (await google.calendar.getEvent(EVENT_ID))!;
      }
      expect(event.conferenceStatus).toBe('success');
      expect(event.conferenceId).not.toBeNull();
      expect(event.hangoutLink).toBe(`https://meet.google.com/${event.conferenceId}`);

      const space = (await google.meet.getSpace(event.conferenceId!))!;
      expect(space.accessType).toBe('TRUSTED');
      expect(space.meetingUri).toBe(event.hangoutLink);
      const opened = await google.meet.makeSpaceOpen(space.name);
      expect(opened.accessType).toBe('OPEN');
      const readBack = (await google.meet.getSpace(space.name))!;
      expect(readBack).toMatchObject({ accessType: 'OPEN', entryPointAccess: 'ALL' });

      const moved = await google.calendar.patchEvent(
        EVENT_ID,
        { startAt: '2026-12-01T11:00:00+05:30', endAt: '2026-12-01T11:45:00+05:30' },
        'none',
      );
      expect(moved.hangoutLink).toBe(event.hangoutLink);
      expect(moved.startAt).toBe('2026-12-01T11:00:00+05:30');

      const invited = await google.calendar.patchEvent(EVENT_ID, { attendeeEmail: ATTENDEE }, 'all');
      expect(invited.attendeeEmails).toEqual([ATTENDEE]);
      expect(invited.hangoutLink).toBe(event.hangoutLink);

      expect(await google.calendar.deleteEvent(EVENT_ID, 'none')).toBe('deleted');
      expect(await google.calendar.getEvent(EVENT_ID)).toBeNull();

      // One token for the whole run; every request in the three allowed URL families.
      expect(fake.tokensIssued).toHaveLength(1);
      for (const req of requests) {
        expect(isAllowedGoogleUrl(req.method, req.url), `${req.method} ${req.url}`).toBe(true);
        expect(
          req.url === GOOGLE_TOKEN_URL || req.url.startsWith(GOOGLE_CALENDAR_EVENTS_URL) || req.url.startsWith(GOOGLE_MEET_API_URL),
        ).toBe(true);
      }
      expect(requests.map((req) => req.method)).toEqual([
        'POST', // token
        'POST', // insert
        'GET',
        'GET', // conference polls
        'GET', // space by code
        'PATCH', // OPEN
        'GET', // read back
        'PATCH', // move
        'PATCH', // invite
        'DELETE',
        'GET', // gone
      ]);
      expect(logs.every((record) => record.outcome === 'success')).toBe(true);
      expect(logs.map((record) => record.operation)).toEqual([
        label === 'oauth_refresh' ? 'token.refresh' : 'token.jwt_bearer',
        'calendar.insert',
        'calendar.get',
        'calendar.get',
        'meet.get',
        'meet.patch',
        'meet.get',
        'calendar.patch',
        'calendar.patch',
        'calendar.delete',
        'calendar.get',
      ]);
    });
  }

  it('space mode end to end: an OPEN space first, then an event with its link in location', async () => {
    const { google, fake } = setup(oauthSettings(), 'space');
    const space = await google.meet.createOpenSpace();
    const event = await google.calendar.insertEvent(
      insertArgs({ withConference: false, location: space.meetingUri }),
    );
    expect(event.conferenceStatus).toBeNull();
    expect(fake.events.get(EVENT_ID)!.fields.location).toBe(space.meetingUri);
    expect((await google.meet.getSpace(space.name))!.accessType).toBe('OPEN');
  });

  it('an expired access token mid-run is re-minted once and the run continues', async () => {
    const { google, fake } = setup(oauthSettings(), 'calendar', { conferenceReadyAfterGets: 0 });
    const event = await google.calendar.insertEvent(insertArgs());
    fake.expireAccessTokens();
    const space = await google.meet.getSpace(event.conferenceId!);
    expect(space).not.toBeNull();
    expect(fake.tokensIssued).toHaveLength(2);
  });
});

describe('getR1MeetGoogle: one process-wide instance, so the token cache and the refusal window hold per process', () => {
  beforeEach(() => resetR1MeetGoogleCache());
  afterEach(() => resetR1MeetGoogleCache());

  /** What S05/S06 do: stable module-level seams, and settings read afresh per request or job. */
  function processRig() {
    const clock = { t: T0 };
    const fake = createFakeGoogle({
      serviceAccount: { clientEmail: FAKE_GOOGLE_SA_EMAIL, publicKey: PAIR.publicKey },
      grantedScopes: SPACE_SCOPES,
      now: () => clock.t,
    });
    const requests: GoogleTransportRequest[] = [];
    const transport = recording(fake, requests);
    const now = () => clock.t;
    const logs: GoogleLogRecord[] = [];
    const logger = { event: (record: GoogleLogRecord) => logs.push(record) };
    const get = (settings: R1MeetGoogleSettings, meetMode: 'calendar' | 'space' = 'calendar') =>
      getR1MeetGoogle({ settings, meetMode, transport, now, logger });
    const tokenCalls = () => requests.filter((req) => req.url === GOOGLE_TOKEN_URL).length;
    return { clock, fake, requests, logs, transport, now, logger, get, tokenCalls };
  }

  it('fresh settings per request give back the SAME instance: many bookings mint one token', async () => {
    for (const build of [oauthSettings, serviceAccountSettings]) {
      resetR1MeetGoogleCache();
      const r = processRig();
      const first = r.get(build());
      expect(r.get(build())).toBe(first);
      expect(r.requests).toHaveLength(0);
      for (let booking = 0; booking < 5; booking += 1) {
        expect(await r.get(build()).calendar.getEvent(EVENT_ID)).toBeNull();
      }
      expect(r.fake.tokensIssued).toHaveLength(1);
      expect(r.tokenCalls()).toBe(1);
    }
  });

  it('a dead grant costs ONE token-endpoint call (and one failure record) a minute for the whole process', async () => {
    const r = processRig();
    r.fake.revokeRefreshToken();
    for (let booking = 0; booking < 10; booking += 1) {
      const error = await rejection(r.get(oauthSettings()).calendar.getEvent(EVENT_ID));
      expect(error.code).toBe('auth_revoked');
    }
    expect(r.tokenCalls()).toBe(1);
    expect(r.requests).toHaveLength(1);
    expect(r.logs.filter((record) => record.operation === 'token.refresh')).toHaveLength(1);

    // A minute later the process tries once more, and only once.
    r.clock.t += GOOGLE_TOKEN_REFUSAL_WINDOW_MS;
    for (let booking = 0; booking < 3; booking += 1) {
      expect((await rejection(r.get(oauthSettings()).meet.getSpace('abc-defg-hij'))).code).toBe('auth_revoked');
    }
    expect(r.tokenCalls()).toBe(2);
  });

  it('createR1MeetGoogle, by contrast, builds a new cache on every call (owner scripts and tests only)', async () => {
    const r = processRig();
    r.fake.revokeRefreshToken();
    for (let booking = 0; booking < 3; booking += 1) {
      const google = createR1MeetGoogle({ settings: oauthSettings(), meetMode: 'calendar', transport: r.transport, now: r.now });
      expect((await rejection(google.calendar.getEvent(EVENT_ID))).code).toBe('auth_revoked');
    }
    expect(r.tokenCalls()).toBe(3);
  });

  it('another credential, Meet mode or seam gives a new instance; the one slot keeps only the latest', () => {
    const r = processRig();
    const calendar = r.get(oauthSettings());
    const space = r.get(oauthSettings(), 'space');
    expect(space).not.toBe(calendar);
    expect(r.get(oauthSettings(), 'space')).toBe(space);
    // One slot: the calendar-mode instance was replaced, so asking again builds a new one.
    const again = r.get(oauthSettings());
    expect(again).not.toBe(calendar);
    expect(r.get(oauthSettings())).toBe(again);

    const rotated = r.get(oauthSettings('rt-' + 'q'.repeat(40)));
    expect(rotated).not.toBe(again);
    expect(r.get(serviceAccountSettings())).not.toBe(rotated);

    const settings = oauthSettings();
    const base = r.get(settings);
    expect(getR1MeetGoogle({ settings, meetMode: 'calendar', transport: r.transport, now: r.now })).not.toBe(base);
    const otherTransport = recording(r.fake, []);
    const withOther = getR1MeetGoogle({ settings, meetMode: 'calendar', transport: otherTransport, now: r.now, logger: r.logger });
    expect(withOther).not.toBe(base);
    expect(getR1MeetGoogle({ settings, meetMode: 'calendar', transport: otherTransport, now: r.now, logger: r.logger, timeoutMs: 5_000 })).not.toBe(
      withOther,
    );
    expect(r.requests).toHaveLength(0);
  });

  it('refuses what createR1MeetGoogle refuses, synchronously and with zero calls, and keeps the cached instance', () => {
    const r = processRig();
    const kept = r.get(oauthSettings());
    const oauth = oauthSettings();
    for (const bad of [
      undefined,
      null,
      { settings: { ...oauth }, meetMode: 'calendar', transport: r.transport },
      { settings: JSON.parse(JSON.stringify(serviceAccountSettings())), meetMode: 'calendar', transport: r.transport },
      { settings: { ...oauth, authMode: 'dwd' }, meetMode: 'calendar', transport: r.transport },
      { settings: oauth, meetMode: 'both', transport: r.transport, now: r.now, logger: r.logger },
      { settings: oauth, meetMode: 'calendar', transport: 'fetch', now: r.now, logger: r.logger },
    ] as unknown[]) {
      expect(() => getR1MeetGoogle(bad as never)).toThrow(GoogleError);
    }
    expect(r.get(oauthSettings())).toBe(kept);
    expect(r.requests).toHaveLength(0);
  });

  it('the process-wide instance shows no secret', async () => {
    const r = processRig();
    const google = r.get(oauthSettings());
    await google.calendar.getEvent(EVENT_ID);
    const texts = [inspect(google, { depth: 5, showHidden: true }), JSON.stringify(google), JSON.stringify(r.logs)];
    for (const text of texts) {
      for (const canary of [FAKE_GOOGLE_CLIENT_SECRET, FAKE_GOOGLE_REFRESH_TOKEN, ...r.fake.tokensIssued]) {
        expect(text).not.toContain(canary);
      }
    }
  });
});

describe('createR1MeetGoogle: the settings secrets never leak', () => {
  it('not in the client object, logs or errors, for either auth mode', async () => {
    for (const settings of [oauthSettings(), serviceAccountSettings()]) {
      const { google, logs, fake } = setup(settings, 'calendar');
      await google.calendar.insertEvent(insertArgs());
      fake.revokeRefreshToken();
      fake.expireAccessTokens();
      const errors: unknown[] = [];
      for (const failing of [
        google.calendar.getEvent(EVENT_ID),
        google.meet.makeSpaceOpen('abc-defg-hij'),
        google.calendar.insertEvent(insertArgs()),
      ]) {
        try {
          await failing;
        } catch (error) {
          errors.push(error);
        }
      }
      expect(errors.length).toBeGreaterThan(0);
      const pemBody = PEM.split('\n')[1]!;
      const canaries = [FAKE_GOOGLE_CLIENT_SECRET, FAKE_GOOGLE_REFRESH_TOKEN, pemBody, KID, ...fake.tokensIssued];
      const texts = [
        inspect(google, { depth: 5, showHidden: true }),
        JSON.stringify(google),
        JSON.stringify(logs),
        ...errors.flatMap((error) => [String(error), JSON.stringify(error), inspect(error)]),
      ];
      for (const text of texts) {
        for (const canary of canaries) expect(text).not.toContain(canary);
      }
    }
  });
});
