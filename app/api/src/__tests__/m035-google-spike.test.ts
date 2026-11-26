/**
 * M035 S03 T5: the owner-run Google spike for Dex's meetings (scripts/m035-google-spike.ts).
 *
 * The "network" is the Google fake (token endpoint, Dex's primary calendar, the Meet spaces), wrapped
 * per test where a step must fail the way Google would fail it. Nothing ever reaches Google: a dry run
 * gets no transport at all and `fetch` is spied to prove it. Fixtures are low-entropy strings built at
 * run time and an RSA pair generated per run (S03 plan R18).
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPIKE_CONFERENCE_POLLS,
  SPIKE_EVENT_DESCRIPTION,
  SPIKE_EVENT_SUMMARY,
  SPIKE_LIVE_ENV_NAME,
  SPIKE_POLL_INTERVAL_MS,
  runSpike,
  type SpikeDeps,
} from '../../scripts/m035-google-spike.js';
import {
  GOOGLE_CALENDAR_EVENTS_URL,
  GOOGLE_MEET_API_URL,
  GOOGLE_TOKEN_URL,
  type GoogleTransport,
  type GoogleTransportRequest,
  type GoogleTransportResponse,
} from '../integrations/google/http.js';
import { GOOGLE_JWT_BEARER_GRANT_TYPE, GOOGLE_SCOPES } from '../integrations/google/token.js';
import {
  getR1MeetPublicDrainConfig,
  type R1MeetGoogleEnvSource,
  type R1MeetPublicDrainConfig,
} from '../lib/r1/meet/config.js';
import {
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_DEX_EMAIL,
  FAKE_GOOGLE_REFRESH_TOKEN,
  FAKE_GOOGLE_SA_EMAIL,
  createFakeGoogle,
  fakeGoogleResponse,
  type FakeGoogle,
  type FakeGoogleOptions,
} from './support/google-fake.js';

// ── Fixtures (built at run time, low entropy) ───────────────────────────────

/** 2026-12-01 10:00 IST: the event starts an hour later, 11:00 IST (already on the 5-minute grid). */
const T0 = Date.UTC(2026, 11, 1, 4, 30, 0);
const START = '2026-12-01T11:00:00+05:30';
const END = '2026-12-01T11:45:00+05:30';
const MOVED_START = '2026-12-01T11:30:00+05:30';
const MOVED_END = '2026-12-01T12:15:00+05:30';
const TWO_SCOPES = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings];
const THREE_SCOPES = [...TWO_SCOPES, GOOGLE_SCOPES.meetSpaceCreated];
const OTHER_MEETING_CODE = ['zzz', 'zzzz', 'zzz'].join('-');

const PAIR = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KID = 'kid' + '0'.repeat(37);

/** The n-th booking UUID the spike is handed (lowercase, with dashes). */
const uuid = (n: number): string => ['0123abcd', '0000', '4000', '8000', n.toString(16).padStart(12, '0')].join('-');

function oauthDrain(): R1MeetPublicDrainConfig {
  const source: R1MeetGoogleEnvSource = {
    R1_MEET_GOOGLE_DEX_EMAIL: FAKE_GOOGLE_DEX_EMAIL,
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
  };
  source['R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET'] = FAKE_GOOGLE_CLIENT_SECRET;
  source['R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN'] = FAKE_GOOGLE_REFRESH_TOKEN;
  const drain = getR1MeetPublicDrainConfig(source);
  if (!drain.available) throw new Error('expected oauth settings');
  return drain;
}

function serviceAccountDrain(): R1MeetPublicDrainConfig {
  const source: R1MeetGoogleEnvSource = {
    R1_MEET_GOOGLE_AUTH_MODE: 'service_account',
    R1_MEET_GOOGLE_DEX_EMAIL: FAKE_GOOGLE_DEX_EMAIL,
  };
  source['R1_MEET_GOOGLE_SA_KEY_B64'] = Buffer.from(
    JSON.stringify({
      type: 'service_account',
      project_id: 'hello-project',
      private_key_id: KID,
      private_key: PEM,
      client_email: FAKE_GOOGLE_SA_EMAIL,
    }),
  ).toString('base64');
  const drain = getR1MeetPublicDrainConfig(source);
  if (!drain.available || drain.google.authMode !== 'service_account') throw new Error('expected service account settings');
  return drain;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── The rig ─────────────────────────────────────────────────────────────────

type Wrap = (fake: FakeGoogle) => GoogleTransport;

interface RigOptions {
  fake?: FakeGoogleOptions;
  /** Replace some answers of the fake (Google failing the way it would). */
  wrap?: Wrap;
  drain?: () => R1MeetPublicDrainConfig;
}

function rig(options: RigOptions = {}) {
  const fake = createFakeGoogle({ now: () => T0, ...options.fake });
  const inner = options.wrap ? options.wrap(fake) : fake.transport;
  /** Every request the spike sent, whether the fake or a wrapper answered it. */
  const requests: GoogleTransportRequest[] = [];
  const transport = vi.fn<GoogleTransport>(async (req) => {
    requests.push(req);
    return inner(req);
  });
  const lines: string[] = [];
  const uuids: string[] = [];
  const sleep = vi.fn(async (_ms: number) => {});
  const getSettings = vi.fn(options.drain ?? oauthDrain);
  const deps: SpikeDeps = {
    getSettings,
    liveEnv: 'yes',
    transport,
    now: () => T0,
    sleep,
    randomUuid: () => {
      const id = uuid(uuids.length + 1);
      uuids.push(id);
      return id;
    },
    out: (line) => lines.push(line),
  };
  return { fake, requests, transport, lines, uuids, sleep, getSettings, deps };
}

const isCalendar = (req: GoogleTransportRequest) => req.url.startsWith(GOOGLE_CALENDAR_EVENTS_URL);
const isInsert = (req: GoogleTransportRequest) => req.method === 'POST' && isCalendar(req);
const isCalendarPatch = (req: GoogleTransportRequest) => req.method === 'PATCH' && isCalendar(req);
const isMeetPatch = (req: GoogleTransportRequest) => req.method === 'PATCH' && req.url.startsWith(GOOGLE_MEET_API_URL);
const isDelete = (req: GoogleTransportRequest) => req.method === 'DELETE' && isCalendar(req);

/** `METHOD /path` of every request. */
const shape = (requests: readonly GoogleTransportRequest[]) => requests.map((req) => `${req.method} ${new URL(req.url).pathname}`);

/** Every line is closed, and no line holds an id, a code, a link, an email, a token or a secret. */
const LINE_RE = /^(PASS|FAIL|SKIP|DRY) [a-z_]+( [a-z_0-9/]+)?$|^RESULT: /;
function expectClosedOutput(lines: readonly string[], fake: FakeGoogle, uuids: readonly string[]): void {
  for (const line of lines) expect(line).toMatch(LINE_RE);
  const text = lines.join('\n');
  const forbidden = [
    FAKE_GOOGLE_CLIENT_ID,
    FAKE_GOOGLE_CLIENT_SECRET,
    FAKE_GOOGLE_REFRESH_TOKEN,
    FAKE_GOOGLE_DEX_EMAIL,
    FAKE_GOOGLE_SA_EMAIL,
    KID,
    PEM.slice(40, 80),
    ...fake.tokensIssued,
    ...uuids,
    ...uuids.map((id) => id.replace(/-/g, '')),
    OTHER_MEETING_CODE,
    'meet.google.com',
    'googleapis',
    'spaces/',
    'http',
    '@',
  ];
  for (const space of fake.spaces.values()) forbidden.push(space.name, space.meetingCode);
  for (const value of forbidden) expect(text).not.toContain(value);
}

const googleJsonError = (status: number, statusWord: string, extra: Record<string, unknown> = {}) =>
  fakeGoogleResponse(status, { error: { code: status, message: 'Request failed.', status: statusWord, ...extra } });

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('m035-google-spike: the dry run (the default)', () => {
  it('no flags: PASS config and the DRY steps, nothing sent, exit 0', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { fake, transport, lines, uuids, sleep, deps } = rig();
    const code = await runSpike([], { ...deps, liveEnv: null });
    expect(code).toBe(0);
    expect(lines.slice(0, -1)).toEqual([
      'PASS config',
      'DRY token',
      'DRY insert',
      'DRY organizer',
      'DRY conference',
      'DRY space_get',
      'DRY space_open',
      'DRY space_readback',
      'DRY delete',
    ]);
    expect(lines.at(-1)).toMatch(/^RESULT: dry run, nothing sent/);
    expect(lines.at(-1)).toContain(SPIKE_LIVE_ENV_NAME);
    expect(transport).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(uuids).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expectClosedOutput(lines, fake, uuids);
  });

  it('a dry run never reaches the network, even with no transport given (the default would be fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { lines, deps } = rig();
    const { transport: _unused, ...withoutTransport } = deps;
    expect(await runSpike(['--patch-time', '--space', '--repeat=2'], { ...withoutTransport, liveEnv: null })).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines[0]).toBe('PASS config');
  });

  it('the options shape the DRY list (space mode, time patch, repeat)', async () => {
    const { fake, transport, lines, uuids, deps } = rig();
    const code = await runSpike(['--space', '--patch-time', '--repeat=3'], { ...deps, liveEnv: null });
    expect(code).toBe(0);
    expect(lines.slice(0, -1)).toEqual([
      'PASS config',
      'DRY token',
      'DRY space_create',
      'DRY insert',
      'DRY organizer',
      'DRY space_get',
      'DRY space_readback',
      'DRY time_patch',
      'DRY delete',
      'DRY repeat 3',
    ]);
    expect(transport).not.toHaveBeenCalled();
    expectClosedOutput(lines, fake, uuids);
  });

  it.each([
    ['unavailable', () => ({ available: false as const })],
    ['throwing', () => { throw new Error('boom'); }],
    ['not an object', () => null as unknown as R1MeetPublicDrainConfig],
  ])('settings %s: FAIL config unavailable, exit 2, zero calls (dry and live)', async (_label, drain) => {
    for (const [argv, liveEnv] of [
      [[], null],
      [['--live'], 'yes'],
    ] as const) {
      const { fake, transport, lines, uuids, deps } = rig({ drain });
      expect(await runSpike([...argv], { ...deps, liveEnv })).toBe(2);
      expect(lines).toEqual(['FAIL config unavailable', 'RESULT: 0 pass, 1 fail, 0 skipped']);
      expect(transport).not.toHaveBeenCalled();
      expectClosedOutput(lines, fake, uuids);
    }
  });

  it('by default it reads Dex\'s account from process.env through the API reader', async () => {
    const { deps, lines } = rig();
    const { getSettings: _unused, ...withoutSettings } = deps;
    vi.stubEnv('R1_MEET_GOOGLE_AUTH_MODE', '');
    vi.stubEnv('R1_MEET_GOOGLE_DEX_EMAIL', FAKE_GOOGLE_DEX_EMAIL);
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_CLIENT_ID', FAKE_GOOGLE_CLIENT_ID);
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', FAKE_GOOGLE_CLIENT_SECRET);
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', FAKE_GOOGLE_REFRESH_TOKEN);
    vi.stubEnv('R1_MEET_GOOGLE_SA_KEY_B64', '');
    expect(await runSpike([], { ...withoutSettings, liveEnv: null })).toBe(0);
    expect(lines[0]).toBe('PASS config');

    lines.length = 0;
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', 'replace_me');
    expect(await runSpike([], { ...withoutSettings, liveEnv: null })).toBe(2);
    expect(lines[0]).toBe('FAIL config unavailable');
  });
});

// ── The live guards and usage ───────────────────────────────────────────────

describe('m035-google-spike: a live run needs BOTH --live and M035_GOOGLE_SPIKE_LIVE=yes', () => {
  it.each([null, '', 'no', 'YES', 'yes ', 'true', '1'])(
    '--live with the env %j: exit 2 before the settings are read, zero calls',
    async (liveEnv) => {
      const { fake, transport, lines, uuids, getSettings, deps } = rig();
      expect(await runSpike(['--live'], { ...deps, liveEnv })).toBe(2);
      expect(lines).toEqual(['FAIL config live_env_missing', 'RESULT: 0 pass, 1 fail, 0 skipped']);
      expect(getSettings).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expectClosedOutput(lines, fake, uuids);
    },
  );

  it('the env alone (no --live): exit 2, zero calls, no dry run either', async () => {
    const { fake, transport, lines, uuids, getSettings, deps } = rig();
    expect(await runSpike(['--patch-time'], { ...deps, liveEnv: 'yes' })).toBe(2);
    expect(lines).toEqual(['FAIL config live_flag_missing', 'RESULT: 0 pass, 1 fail, 0 skipped']);
    expect(getSettings).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expectClosedOutput(lines, fake, uuids);
  });

  it('by default the confirmation is process.env.M035_GOOGLE_SPIKE_LIVE', async () => {
    const { transport, lines, deps } = rig();
    const { liveEnv: _unused, ...withoutLiveEnv } = deps;
    vi.stubEnv(SPIKE_LIVE_ENV_NAME, 'yes');
    expect(await runSpike([], withoutLiveEnv)).toBe(2);
    expect(lines[0]).toBe('FAIL config live_flag_missing');

    lines.length = 0;
    vi.stubEnv(SPIKE_LIVE_ENV_NAME, '');
    expect(await runSpike(['--live'], withoutLiveEnv)).toBe(2);
    expect(lines[0]).toBe('FAIL config live_env_missing');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['--repeat=0'],
    ['--repeat=21'],
    ['--repeat=99'],
    ['--repeat=-1'],
    ['--repeat=3x'],
    ['--repeat=03'],
    ['--repeat'],
    ['--repeat='],
    ['--live', '--live'],
    ['--space=1'],
    ['--patch-time=yes'],
    ['--unknown'],
    ['live'],
  ])('usage %j: exit 2 with the usage line only, zero calls', async (...argv) => {
    const { transport, lines, getSettings, deps } = rig();
    expect(await runSpike(argv, deps)).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^usage: npx tsx scripts\/m035-google-spike\.ts /);
    expect(getSettings).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('--repeat accepts 1 and 20; --help prints the usage and exits 0', async () => {
    for (const n of [1, 20]) {
      const { lines, deps } = rig();
      expect(await runSpike([`--repeat=${n}`], { ...deps, liveEnv: null })).toBe(0);
      expect(lines).toContain(`DRY repeat ${n}`);
    }
    const { lines, transport, deps } = rig();
    expect(await runSpike(['--help'], deps)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^usage: /);
    expect(transport).not.toHaveBeenCalled();
  });
});

// ── Live runs that pass ─────────────────────────────────────────────────────

describe('m035-google-spike: a live run against the fake', () => {
  it('calendar mode: every step passes, the one event is deleted with sendUpdates=none, exit 0', async () => {
    const { fake, requests, lines, uuids, sleep, deps } = rig();
    const code = await runSpike(['--live'], deps);
    expect(code).toBe(0);
    expect(lines).toEqual([
      'PASS config',
      'PASS token',
      'SKIP space_create calendar_mode',
      'PASS insert',
      'PASS organizer',
      'PASS conference',
      'PASS space_get',
      'PASS space_open',
      'PASS space_readback',
      'SKIP time_patch not_requested',
      'PASS delete',
      'SKIP repeat not_requested',
      'RESULT: 9 pass, 0 fail, 3 skipped',
    ]);

    expect(uuids).toEqual([uuid(1)]);
    const eventId = uuid(1).replace(/-/g, '');
    const space = [...fake.spaces.values()][0]!;
    expect(fake.spaces.size).toBe(1);
    expect(shape(requests)).toEqual([
      'POST /token',
      'POST /calendar/v3/calendars/primary/events',
      `GET /calendar/v3/calendars/primary/events/${eventId}`,
      `GET /v2/spaces/${space.meetingCode}`,
      `PATCH /v2/${space.name}`,
      `GET /v2/${space.name}`,
      `DELETE /calendar/v3/calendars/primary/events/${eventId}`,
    ]);
    expect(requests[0]!.url).toBe(GOOGLE_TOKEN_URL);

    // The insert: attendee-less, an hour ahead, 45 minutes, nobody notified, a Meet requested.
    const insert = fake.calls[1]!;
    expect(insert.query).toEqual({ conferenceDataVersion: '1', sendUpdates: 'none' });
    const body = insert.body as Record<string, unknown>;
    expect('attendees' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('displayName');
    expect(body.id).toBe(eventId);
    expect(body.summary).toBe(SPIKE_EVENT_SUMMARY);
    expect(body.description).toBe(SPIKE_EVENT_DESCRIPTION);
    expect(body.start).toEqual({ dateTime: START, timeZone: 'Asia/Kolkata' });
    expect(body.end).toEqual({ dateTime: END, timeZone: 'Asia/Kolkata' });
    expect(body.conferenceData).toEqual({
      createRequest: { requestId: uuid(1), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    });
    expect('location' in body).toBe(false);
    expect(body.extendedProperties).toEqual({ private: { hello_booking_id: uuid(1) } });

    // The OPEN patch: the narrow mask only.
    const patch = fake.calls.find((call) => call.method === 'PATCH')!;
    expect(patch.query).toEqual({ updateMask: 'config.accessType' });
    expect(patch.body).toEqual({ config: { accessType: 'OPEN' } });
    expect(space.accessType).toBe('OPEN');

    // The delete: exactly once, nobody notified, and the event is gone from Dex's calendar.
    const deletes = fake.calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.query).toEqual({ sendUpdates: 'none' });
    expect(fake.events.get(eventId)!.deleted).toBe(true);

    // One conference poll, 1 s after the insert.
    expect(sleep.mock.calls).toEqual([[SPIKE_POLL_INTERVAL_MS]]);
    expect(fake.tokensIssued).toHaveLength(1);
    expectClosedOutput(lines, fake, uuids);
  });

  it('rounds the start up to the next 5 minutes, an hour ahead', async () => {
    const { fake, lines, deps } = rig();
    expect(await runSpike(['--live'], { ...deps, now: () => T0 + 60_000 })).toBe(0);
    const body = fake.calls[1]!.body as Record<string, { dateTime: string }>;
    expect(body.start!.dateTime).toBe('2026-12-01T11:05:00+05:30');
    expect(body.end!.dateTime).toBe('2026-12-01T11:50:00+05:30');
    expect(lines.at(-1)).toBe('RESULT: 9 pass, 0 fail, 3 skipped');
  });

  it('a conference that is ready on the insert answer needs no poll', async () => {
    const { lines, sleep, requests, deps } = rig({ fake: { conferenceReadyAfterGets: 0 } });
    expect(await runSpike(['--live'], deps)).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(requests.filter((req) => req.method === 'GET' && isCalendar(req))).toHaveLength(0);
    expect(lines).toContain('PASS conference');
  });

  it('--patch-time (spike S6): the event moves 30 minutes with sendUpdates=none and keeps its Meet link', async () => {
    const { fake, lines, uuids, deps } = rig();
    expect(await runSpike(['--live', '--patch-time'], deps)).toBe(0);
    expect(lines).toContain('PASS time_patch');
    expect(lines.at(-1)).toBe('RESULT: 10 pass, 0 fail, 2 skipped');
    const patch = fake.calls.find((call) => call.method === 'PATCH' && call.path.startsWith('/calendar/'))!;
    expect(patch.query).toEqual({ conferenceDataVersion: '1', sendUpdates: 'none' });
    expect(patch.body).toEqual({
      start: { dateTime: MOVED_START, timeZone: 'Asia/Kolkata' },
      end: { dateTime: MOVED_END, timeZone: 'Asia/Kolkata' },
    });
    // The patch, then a re-read, then the delete.
    const tail = fake.calls.slice(-3).map((call) => call.method);
    expect(tail).toEqual(['PATCH', 'GET', 'DELETE']);
    expectClosedOutput(lines, fake, uuids);
  });

  it('--space: a new OPEN space through the Meet API, then an event whose location is its link (three-scope grant)', async () => {
    const { fake, requests, lines, uuids, deps } = rig({ fake: { grantedScopes: THREE_SCOPES } });
    expect(await runSpike(['--live', '--space', '--patch-time'], deps)).toBe(0);
    expect(lines).toEqual([
      'PASS config',
      'PASS token',
      'PASS space_create',
      'PASS insert',
      'PASS organizer',
      'SKIP conference space_mode',
      'PASS space_get',
      'SKIP space_open space_mode',
      'PASS space_readback',
      'PASS time_patch',
      'PASS delete',
      'SKIP repeat not_requested',
      'RESULT: 9 pass, 0 fail, 3 skipped',
    ]);
    const space = [...fake.spaces.values()][0]!;
    expect(fake.spaces.size).toBe(1);
    const eventId = uuid(1).replace(/-/g, '');
    expect(shape(requests)).toEqual([
      'POST /token',
      'POST /v2/spaces',
      'POST /calendar/v3/calendars/primary/events',
      `GET /v2/spaces/${space.meetingCode}`,
      `GET /v2/${space.name}`,
      `PATCH /calendar/v3/calendars/primary/events/${eventId}`,
      `GET /calendar/v3/calendars/primary/events/${eventId}`,
      `DELETE /calendar/v3/calendars/primary/events/${eventId}`,
    ]);
    expect(fake.calls[1]!.body).toEqual({ config: { accessType: 'OPEN', entryPointAccess: 'ALL' } });
    const insert = fake.calls[2]!.body as Record<string, unknown>;
    expect('conferenceData' in insert).toBe(false);
    expect('attendees' in insert).toBe(false);
    expect(insert.location).toBe(`https://meet.google.com/${space.meetingCode}`);
    expect(requests.some(isMeetPatch)).toBe(false);
    expect(fake.events.get(eventId)!.deleted).toBe(true);
    expectClosedOutput(lines, fake, uuids);
  });

  it('--space with a two-scope grant fails at token (re-mint with the helper\'s --space), sends nothing else', async () => {
    const { fake, requests, lines, uuids, deps } = rig({ fake: { grantedScopes: TWO_SCOPES } });
    expect(await runSpike(['--live', '--space'], deps)).toBe(1);
    expect(lines).toEqual(['PASS config', 'FAIL token setup_forbidden', 'RESULT: 1 pass, 1 fail, 0 skipped']);
    expect(shape(requests)).toEqual(['POST /token']);
    expectClosedOutput(lines, fake, uuids);
  });

  it('--repeat=3 (spike S7, insert half): three more attendee-less insert + delete pairs, 1 s apart', async () => {
    const { fake, requests, lines, uuids, sleep, deps } = rig();
    expect(await runSpike(['--live', '--repeat=3'], deps)).toBe(0);
    expect(lines.slice(-2)).toEqual(['PASS repeat 3/3', 'RESULT: 10 pass, 0 fail, 2 skipped']);
    expect(uuids).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    expect(requests.filter(isInsert)).toHaveLength(4);
    expect(requests.filter(isDelete)).toHaveLength(4);
    for (const id of uuids) expect(fake.events.get(id.replace(/-/g, ''))!.deleted).toBe(true);
    for (const call of fake.calls.filter((item) => item.method === 'POST' && item.path.startsWith('/calendar/'))) {
      expect('attendees' in (call.body as Record<string, unknown>)).toBe(false);
    }
    for (const call of fake.calls.filter((item) => item.method === 'DELETE')) {
      expect(call.query).toEqual({ sendUpdates: 'none' });
    }
    // The extra pairs come after the main event's delete.
    expect(shape(requests).slice(6, 8)).toEqual([
      `DELETE /calendar/v3/calendars/primary/events/${uuid(1).replace(/-/g, '')}`,
      'POST /calendar/v3/calendars/primary/events',
    ]);
    expect(sleep.mock.calls).toEqual(Array.from({ length: 4 }, () => [SPIKE_POLL_INTERVAL_MS]));
    expectClosedOutput(lines, fake, uuids);
  });

  it('a quota answer during the repeat stops it: FAIL repeat quota, exit 1, every event deleted', async () => {
    let inserts = 0;
    const wrap: Wrap = (fake) => async (req) => {
      if (isInsert(req)) {
        inserts += 1;
        if (inserts === 3) {
          return fakeGoogleResponse(
            403,
            { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } },
            { 'retry-after': '7' },
          );
        }
      }
      return fake.transport(req);
    };
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live', '--repeat=5'], deps)).toBe(1);
    expect(lines.slice(-2)).toEqual(['FAIL repeat quota', 'RESULT: 9 pass, 1 fail, 2 skipped']);
    expect(requests.filter(isInsert)).toHaveLength(3);
    expect(requests.filter(isDelete)).toHaveLength(2);
    for (const event of fake.events.values()) expect(event.deleted).toBe(true);
    expectClosedOutput(lines, fake, uuids);
  });

  it('service_account mode: a jwt-bearer grant for Dex, then every step passes', async () => {
    const { fake, lines, uuids, deps } = rig({
      drain: serviceAccountDrain,
      fake: { serviceAccount: { clientEmail: FAKE_GOOGLE_SA_EMAIL, publicKey: PAIR.publicKey } },
    });
    expect(await runSpike(['--live', '--patch-time'], deps)).toBe(0);
    const grant = fake.calls[0]!.body as Record<string, string>;
    expect(grant.grant_type).toBe(GOOGLE_JWT_BEARER_GRANT_TYPE);
    const claims = JSON.parse(Buffer.from(grant.assertion!.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(claims.sub).toBe(FAKE_GOOGLE_DEX_EMAIL);
    expect(claims.scope).toBe(TWO_SCOPES.join(' '));
    expect(lines.at(-1)).toBe('RESULT: 10 pass, 0 fail, 2 skipped');
    expectClosedOutput([...lines], fake, uuids);
    expect(lines.join('\n')).not.toContain(grant.assertion!.slice(0, 40));
  });
});

// ── Failing steps: the event is still deleted ───────────────────────────────

describe('m035-google-spike: a failing step exits 1 and still deletes the event', () => {
  /** The run failed, and the one event it made was deleted exactly once with sendUpdates=none. */
  function expectDeletedOnce(fake: FakeGoogle, requests: readonly GoogleTransportRequest[], uuids: readonly string[]): void {
    const eventId = uuids[0]!.replace(/-/g, '');
    const deletes = requests.filter(isDelete);
    expect(deletes).toHaveLength(1);
    expect(new URL(deletes[0]!.url).pathname.endsWith(`/${eventId}`)).toBe(true);
    expect(new URL(deletes[0]!.url).searchParams.get('sendUpdates')).toBe('none');
    expect(fake.events.get(eventId)!.deleted).toBe(true);
  }

  it('organizer mismatch: the grant is not Dex\'s', async () => {
    const { fake, requests, lines, uuids, deps } = rig({ fake: { organizerEmail: 'someone.else@hello.example.test' } });
    expect(await runSpike(['--live'], deps)).toBe(1);
    expect(lines).toContain('FAIL organizer mismatch');
    expect(lines).toContain('PASS space_readback');
    expect(lines.at(-1)).toBe('RESULT: 8 pass, 1 fail, 3 skipped');
    expectDeletedOnce(fake, requests, uuids);
    expectClosedOutput(lines, fake, uuids);
    expect(lines.join('\n')).not.toContain('someone.else');
  });

  it('makeSpaceOpen 403 (spike S2 failed): FAIL space_open setup_forbidden, no read-back', async () => {
    const wrap: Wrap = (fake) => async (req) =>
      isMeetPatch(req) ? googleJsonError(403, 'PERMISSION_DENIED') : fake.transport(req);
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live'], deps)).toBe(1);
    expect(lines).toContain('FAIL space_open setup_forbidden');
    expect(lines).toContain('SKIP space_readback after_failure');
    expect(lines).toContain('PASS delete');
    expect(requests.filter((req) => req.method === 'GET' && req.url.startsWith(GOOGLE_MEET_API_URL))).toHaveLength(1);
    expectDeletedOnce(fake, requests, uuids);
    expectClosedOutput(lines, fake, uuids);
  });

  it.each([
    ['stays TRUSTED', { accessType: 'TRUSTED' }],
    ['OPEN but creator-app only', { entryPointAccess: 'CREATOR_APP_ONLY' }],
  ])('the space %s after the patch (spike S3): FAIL space_readback not_open', async (_label, override) => {
    const wrap: Wrap = (fake) => async (req) => {
      const answer = await fake.transport(req);
      if (isMeetPatch(req)) for (const space of fake.spaces.values()) Object.assign(space, override);
      return answer;
    };
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live'], deps)).toBe(1);
    expect(lines).toContain('PASS space_open');
    expect(lines).toContain('FAIL space_readback not_open');
    expectDeletedOnce(fake, requests, uuids);
    expectClosedOutput(lines, fake, uuids);
  });

  it('the conference fails: FAIL conference failure, the space steps and the time patch are skipped', async () => {
    const { fake, requests, lines, uuids, sleep, deps } = rig({ fake: { conferenceFails: true } });
    expect(await runSpike(['--live', '--patch-time'], deps)).toBe(1);
    expect(lines).toEqual([
      'PASS config',
      'PASS token',
      'SKIP space_create calendar_mode',
      'PASS insert',
      'PASS organizer',
      'FAIL conference failure',
      'SKIP space_get no_conference',
      'SKIP space_open no_conference',
      'SKIP space_readback no_conference',
      'SKIP time_patch no_link',
      'PASS delete',
      'SKIP repeat not_requested',
      'RESULT: 5 pass, 1 fail, 6 skipped',
    ]);
    expect(sleep).not.toHaveBeenCalled();
    expect(requests.some((req) => req.url.startsWith(GOOGLE_MEET_API_URL))).toBe(false);
    expectDeletedOnce(fake, requests, uuids);
    expectClosedOutput(lines, fake, uuids);
  });

  it(`the conference never succeeds: ${SPIKE_CONFERENCE_POLLS} polls 1 s apart, then FAIL conference timeout`, async () => {
    const { fake, requests, lines, uuids, sleep, deps } = rig({ fake: { conferenceReadyAfterGets: 99 } });
    expect(await runSpike(['--live'], deps)).toBe(1);
    expect(lines).toContain('FAIL conference timeout');
    expect(sleep.mock.calls).toEqual(Array.from({ length: SPIKE_CONFERENCE_POLLS }, () => [SPIKE_POLL_INTERVAL_MS]));
    expect(requests.filter((req) => req.method === 'GET' && isCalendar(req))).toHaveLength(SPIKE_CONFERENCE_POLLS);
    expectDeletedOnce(fake, requests, uuids);
    expectClosedOutput(lines, fake, uuids);
  });

  it('a conference poll that fails: FAIL conference <code>', async () => {
    const wrap: Wrap = (fake) => async (req) =>
      req.method === 'GET' && isCalendar(req) ? googleJsonError(503, 'UNAVAILABLE') : fake.transport(req);
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live'], deps)).toBe(1);
    expect(lines).toContain('FAIL conference unavailable');
    expectDeletedOnce(fake, requests, uuids);
  });

  it('a time patch that changes the Meet link (spike S6 failed): FAIL time_patch link_changed', async () => {
    const wrap: Wrap = (fake) => async (req) => {
      const answer = await fake.transport(req);
      if (isCalendarPatch(req)) {
        for (const event of fake.events.values()) {
          if (event.conference !== null) event.conference = { ...event.conference, code: OTHER_MEETING_CODE };
        }
      }
      return answer;
    };
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live', '--patch-time'], deps)).toBe(1);
    expect(lines).toContain('FAIL time_patch link_changed');
    expect(lines.at(-1)).toBe('RESULT: 9 pass, 1 fail, 2 skipped');
    expectDeletedOnce(fake, requests, uuids);
    expectClosedOutput(lines, fake, uuids);
  });

  it('a time patch that does not move the event: FAIL time_patch not_moved', async () => {
    // Google answering the patch without applying it: the fake gets an empty patch.
    const wrap: Wrap = (fake) => async (req) => (isCalendarPatch(req) ? fake.transport({ ...req, body: '{}' }) : fake.transport(req));
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live', '--patch-time'], deps)).toBe(1);
    expect(lines).toContain('FAIL time_patch not_moved');
    expectDeletedOnce(fake, requests, uuids);
  });

  it('auth_revoked at token: FAIL token auth_revoked, no insert and no delete (calendar and space mode)', async () => {
    for (const argv of [['--live'], ['--live', '--space', '--repeat=2', '--patch-time']]) {
      const { fake, requests, lines, uuids, deps } = rig({ fake: { grantedScopes: THREE_SCOPES } });
      fake.revokeRefreshToken();
      expect(await runSpike(argv, deps)).toBe(1);
      expect(lines).toEqual(['PASS config', 'FAIL token auth_revoked', 'RESULT: 1 pass, 1 fail, 0 skipped']);
      expect(shape(requests)).toEqual(['POST /token']);
      expect(fake.events.size).toBe(0);
      expect(fake.spaces.size).toBe(0);
      expectClosedOutput(lines, fake, uuids);
    }
  });

  it('an insert Google refuses (403): FAIL insert setup_forbidden, nothing to delete', async () => {
    const wrap: Wrap = (fake) => async (req) =>
      isInsert(req)
        ? fakeGoogleResponse(403, { error: { code: 403, message: 'Forbidden', errors: [{ domain: 'global', reason: 'forbidden' }] } })
        : fake.transport(req);
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live', '--repeat=2'], deps)).toBe(1);
    expect(lines).toEqual([
      'PASS config',
      'PASS token',
      'SKIP space_create calendar_mode',
      'FAIL insert setup_forbidden',
      'SKIP organizer after_failure',
      'SKIP conference after_failure',
      'SKIP space_get after_failure',
      'SKIP space_open after_failure',
      'SKIP space_readback after_failure',
      'SKIP time_patch after_failure',
      'SKIP delete no_event',
      'SKIP repeat after_failure',
      'RESULT: 2 pass, 1 fail, 9 skipped',
    ]);
    expect(requests.filter(isDelete)).toHaveLength(0);
    expectClosedOutput(lines, fake, uuids);
  });

  it('an insert whose answer is lost (503 after Google stored it): the event is deleted anyway', async () => {
    const wrap: Wrap = (fake) => async (req) => {
      if (isInsert(req)) {
        await fake.transport(req);
        return googleJsonError(503, 'UNAVAILABLE');
      }
      return fake.transport(req);
    };
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live'], deps)).toBe(1);
    expect(lines).toContain('FAIL insert unavailable');
    expect(lines).toContain('PASS delete');
    expectDeletedOnce(fake, requests, uuids);
    expectClosedOutput(lines, fake, uuids);
  });

  it('a lost insert that Google never stored: the delete answers gone, which passes', async () => {
    const wrap: Wrap = (fake) => async (req) => (isInsert(req) ? googleJsonError(503, 'UNAVAILABLE') : fake.transport(req));
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live'], deps)).toBe(1);
    expect(lines).toContain('FAIL insert unavailable');
    expect(lines).toContain('PASS delete gone');
    expect(requests.filter(isDelete)).toHaveLength(1);
    expectClosedOutput(lines, fake, uuids);
  });

  it('a delete that fails: FAIL delete <code>', async () => {
    const wrap: Wrap = (fake) => async (req) => (isDelete(req) ? googleJsonError(503, 'UNAVAILABLE') : fake.transport(req));
    const { fake, requests, lines, uuids, deps } = rig({ wrap });
    expect(await runSpike(['--live'], deps)).toBe(1);
    expect(lines).toContain('FAIL delete unavailable');
    expect(requests.filter(isDelete)).toHaveLength(1);
    expectClosedOutput(lines, fake, uuids);
  });

  it('a throwing sleep or uuid seam never leaves the event behind', async () => {
    const { fake, requests, lines, uuids, deps } = rig({ fake: { conferenceReadyAfterGets: 2 } });
    const sleep = vi.fn(async () => {
      throw new Error('timer broke');
    });
    expect(await runSpike(['--live', '--repeat=1'], { ...deps, sleep })).toBe(0);
    expect(lines).toContain('PASS conference');
    for (const event of fake.events.values()) expect(event.deleted).toBe(true);

    const second = rig();
    let n = 0;
    const randomUuid = () => {
      n += 1;
      if (n === 2) throw new Error('no entropy');
      return uuid(n);
    };
    expect(await runSpike(['--live', '--repeat=2'], { ...second.deps, randomUuid })).toBe(1);
    expect(second.lines).toContain('FAIL repeat invalid_request');
    expect(second.requests.filter(isInsert)).toHaveLength(1);
    for (const event of second.fake.events.values()) expect(event.deleted).toBe(true);
    expectClosedOutput(lines, fake, uuids);
    expect(requests.length).toBeGreaterThan(0);
  });
});

// ── Every request stays on the three Google URL families ────────────────────

describe('m035-google-spike: requests', () => {
  it('a full run with every option only ever calls the token URL, Dex\'s primary calendar and the Meet API', async () => {
    const { requests, deps } = rig();
    expect(await runSpike(['--live', '--patch-time', '--repeat=2'], deps)).toBe(0);
    for (const req of requests) {
      const ok =
        req.url === GOOGLE_TOKEN_URL || req.url.startsWith(`${GOOGLE_CALENDAR_EVENTS_URL}`) || req.url.startsWith(GOOGLE_MEET_API_URL);
      expect(ok, `${req.method} ${new URL(req.url).pathname}`).toBe(true);
      expect(req.url).not.toMatch(/updateMask=(?:\*|%2A)/i);
    }
  });

  it('the response type of the fake answers is what the client reads (control for the wrappers)', async () => {
    const answer: GoogleTransportResponse = googleJsonError(403, 'PERMISSION_DENIED');
    expect(answer.status).toBe(403);
    expect(JSON.parse(await answer.text())).toMatchObject({ error: { status: 'PERMISSION_DENIED' } });
  });
});
