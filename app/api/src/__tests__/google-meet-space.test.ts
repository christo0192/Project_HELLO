/**
 * Google Meet spaces client for Dex (M035 S03 T3): reading a meeting's space and making it OPEN, so
 * the guest bot and a candidate who is not signed in join without knocking (owner decision
 * 2026-11-26, contract §7.6).
 *
 * Covers the exact URLs and bodies (`getSpace` by meeting code and by name; `makeSpaceOpen` with
 * `updateMask=config.accessType` only; `createOpenSpace` in space mode only), the pre-transport
 * refusals (zero calls of any kind), the closed parse, the error rows, the 401 re-mint, a
 * calendar-mode grant that cannot create a space, and a file-wide pin that no request URL ever
 * carries a `*` update mask.
 *
 * Deterministic: the network is `createFakeGoogle` (never a real request), optionally preceded by
 * scripted API answers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { GoogleError, type GoogleErrorCode } from '../integrations/google/errors.js';
import {
  GOOGLE_MEET_API_URL,
  GOOGLE_TOKEN_URL,
  isAllowedGoogleUrl,
  sendGoogleRequest,
  type GoogleLogRecord,
  type GoogleTransport,
  type GoogleTransportRequest,
} from '../integrations/google/http.js';
import {
  GOOGLE_MEET_OPEN_UPDATE_MASK,
  GOOGLE_MEET_SPACE_NAME_RE,
  createGoogleMeetClient,
  type GoogleMeetClient,
  type GoogleMeetMode,
} from '../integrations/google/meet.js';
import { GOOGLE_SCOPES, createGoogleOAuthRefreshTokenSource, type GoogleScope } from '../integrations/google/token.js';
import {
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_REFRESH_TOKEN,
  createFakeGoogle,
  fakeGoogleResponse,
  type FakeGoogle,
  type FakeGoogleCannedResponse,
  type FakeGoogleOptions,
} from './support/google-fake.js';

const BASE_SCOPES: GoogleScope[] = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings];
const SPACE_SCOPES: GoogleScope[] = [...BASE_SCOPES, GOOGLE_SCOPES.meetSpaceCreated];
const SPACES_URL = `${GOOGLE_MEET_API_URL}spaces`;

/** Every URL any client in this file sent (checked at the end: never a `*` update mask). */
const ALL_URLS: string[] = [];

type Step = FakeGoogleCannedResponse | 'fake';

interface Harness {
  fake: FakeGoogle;
  requests: GoogleTransportRequest[];
  logs: GoogleLogRecord[];
  meet: GoogleMeetClient;
  api(): GoogleTransportRequest[];
}

function harness(
  opts: { fake?: FakeGoogleOptions; script?: Step[]; meetMode?: GoogleMeetMode; scopes?: GoogleScope[] } = {},
): Harness {
  const fake = createFakeGoogle(opts.fake);
  const requests: GoogleTransportRequest[] = [];
  const logs: GoogleLogRecord[] = [];
  const script = [...(opts.script ?? [])];
  const transport: GoogleTransport = async (req) => {
    requests.push(req);
    ALL_URLS.push(req.url);
    if (req.url !== GOOGLE_TOKEN_URL && script.length > 0) {
      const step = script.shift()!;
      if (step !== 'fake') return fakeGoogleResponse(step.status, step.body, step.headers);
    }
    return fake.transport(req);
  };
  const logger = { event: (record: GoogleLogRecord) => logs.push(record) };
  const tokenSource = createGoogleOAuthRefreshTokenSource({
    clientId: FAKE_GOOGLE_CLIENT_ID,
    clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    refreshToken: FAKE_GOOGLE_REFRESH_TOKEN,
    scopes: opts.scopes ?? BASE_SCOPES,
    transport,
  });
  const meet = createGoogleMeetClient({ tokenSource, meetMode: opts.meetMode ?? 'calendar', transport, logger });
  return { fake, requests, logs, meet, api: () => requests.filter((req) => req.url !== GOOGLE_TOKEN_URL) };
}

async function rejection(promise: Promise<unknown>): Promise<GoogleError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleError);
    return error as GoogleError;
  }
  throw new Error('expected a rejection');
}

const spaceBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'spaces/fake-space-1',
  meetingUri: 'https://meet.google.com/abc-defg-hij',
  meetingCode: 'abc-defg-hij',
  config: { accessType: 'TRUSTED', entryPointAccess: 'ALL', moderation: 'OFF' },
  activeConference: { conferenceRecord: 'conferenceRecords/x' },
  ...overrides,
});

describe('Google Meet: getSpace', () => {
  it('by meeting code: GET /v2/spaces/<code>, no body; the closed space', async () => {
    const h = harness();
    const seeded = h.fake.addSpace();
    const space = await h.meet.getSpace(seeded.meetingCode);
    const sent = h.api()[0]!;
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe(`${GOOGLE_MEET_API_URL}spaces/${seeded.meetingCode}`);
    expect(sent.body).toBeUndefined();
    expect(sent.headers).toEqual({ accept: 'application/json', authorization: `Bearer ${h.fake.tokensIssued[0]}` });
    expect(space).toStrictEqual({
      name: seeded.name,
      meetingCode: seeded.meetingCode,
      meetingUri: `https://meet.google.com/${seeded.meetingCode}`,
      accessType: 'TRUSTED',
      entryPointAccess: 'ALL',
    });
    expect(Object.isFrozen(space)).toBe(true);
  });

  it('by name: GET /v2/spaces/<id>', async () => {
    const h = harness();
    const seeded = h.fake.addSpace({ accessType: 'RESTRICTED', entryPointAccess: 'CREATOR_APP_ONLY' });
    const space = await h.meet.getSpace(seeded.name);
    expect(h.api()[0]!.url).toBe(`${GOOGLE_MEET_API_URL}${seeded.name}`);
    expect(space).toMatchObject({ name: seeded.name, accessType: 'RESTRICTED', entryPointAccess: 'CREATOR_APP_ONLY' });
  });

  it('404 is null, logged once as a success with the status', async () => {
    const h = harness();
    expect(await h.meet.getSpace('zzz-zzzz-zzz')).toBeNull();
    expect(await h.meet.getSpace('spaces/unknown')).toBeNull();
    expect(h.logs).toEqual([
      { operation: 'meet.get', outcome: 'success', httpStatus: 404, durationMs: expect.any(Number) },
      { operation: 'meet.get', outcome: 'success', httpStatus: 404, durationMs: expect.any(Number) },
    ]);
  });

  it.each<[string, unknown]>([
    ['an upper-case code', 'ABC-DEFG-HIJ'],
    ['a short code', 'abc-defg-hi'],
    ['a code without dashes', 'abcdefghij'],
    ['a Meet link', 'https://meet.google.com/abc-defg-hij'],
    ['an empty name', 'spaces/'],
    ['a nested name', 'spaces/a/b'],
    ['a name with a query', 'spaces/a?updateMask=*'],
    ['a name with a dot', 'spaces/a.b'],
    ['a long name', `spaces/${'a'.repeat(129)}`],
    ['a conference record', 'conferenceRecords/abc'],
    ['empty', ''],
    ['a number', 7],
    ['null', null],
  ])('refuses %s with zero calls', async (_name, input) => {
    const h = harness();
    const error = await rejection(h.meet.getSpace(input as string));
    expect(error.code).toBe('invalid_request');
    expect(error.operation).toBe('meet.get');
    expect(h.requests).toHaveLength(0);
    expect(h.fake.tokensIssued).toHaveLength(0);
    expect(h.logs).toEqual([{ operation: 'meet.get', outcome: 'failure', code: 'invalid_request', durationMs: expect.any(Number) }]);
  });

  it('the name rule accepts the 128-character edge', () => {
    expect(GOOGLE_MEET_SPACE_NAME_RE.test(`spaces/${'a'.repeat(128)}`)).toBe(true);
    expect(GOOGLE_MEET_SPACE_NAME_RE.test('spaces/Ab_9-z')).toBe(true);
  });
});

describe('Google Meet: makeSpaceOpen', () => {
  it('PATCH /v2/spaces/<id>?updateMask=config.accessType with exactly {"config":{"accessType":"OPEN"}}', async () => {
    const h = harness();
    const seeded = h.fake.addSpace({ accessType: 'TRUSTED', entryPointAccess: 'ALL' });
    const space = await h.meet.makeSpaceOpen(seeded.name);
    const sent = h.api()[0]!;
    expect(sent.method).toBe('PATCH');
    expect(sent.url).toBe(`${GOOGLE_MEET_API_URL}${seeded.name}?updateMask=config.accessType`);
    expect(GOOGLE_MEET_OPEN_UPDATE_MASK).toBe('config.accessType');
    expect(sent.body).toBe('{"config":{"accessType":"OPEN"}}');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(space).toStrictEqual({
      name: seeded.name,
      meetingCode: seeded.meetingCode,
      meetingUri: `https://meet.google.com/${seeded.meetingCode}`,
      accessType: 'OPEN',
      entryPointAccess: 'ALL',
    });
    // The fake changed only the access type (the mask was honoured).
    expect(h.fake.spaces.get(seeded.name)).toMatchObject({ accessType: 'OPEN', entryPointAccess: 'ALL' });
    // Reading it back says OPEN.
    expect((await h.meet.getSpace(seeded.meetingCode))!.accessType).toBe('OPEN');
  });

  it('refuses a meeting code (updates need spaces/<id>) and anything else that is not a name, with zero calls', async () => {
    const h = harness();
    for (const bad of ['abc-defg-hij', 'spaces/a/b', 'spaces/x?updateMask=*', '', 'spaces/*', null]) {
      const error = await rejection(h.meet.makeSpaceOpen(bad as string));
      expect(error.code).toBe('invalid_request');
      expect(error.operation).toBe('meet.patch');
    }
    expect(h.requests).toHaveLength(0);
  });

  it('a name mismatch in the answer is malformed_response', async () => {
    const h = harness({ script: [{ status: 200, body: spaceBody({ name: 'spaces/other' }) }] });
    expect((await rejection(h.meet.makeSpaceOpen('spaces/fake-space-1'))).code).toBe('malformed_response');
  });

  it('404 on the patch stays an error (not_found)', async () => {
    const h = harness();
    const error = await rejection(h.meet.makeSpaceOpen('spaces/unknown'));
    expect(error.code).toBe('not_found');
    expect(error.httpStatus).toBe(404);
  });

  it('control: the fake refuses a * mask and a meeting-code patch, and the client core cannot send a * mask', async () => {
    const fake = createFakeGoogle();
    const seeded = fake.addSpace();
    const tokens = createGoogleOAuthRefreshTokenSource({
      clientId: FAKE_GOOGLE_CLIENT_ID,
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
      refreshToken: FAKE_GOOGLE_REFRESH_TOKEN,
      scopes: BASE_SCOPES,
      transport: fake.transport,
    });
    const bearer = `Bearer ${await tokens.accessToken()}`;
    const signal = new AbortController().signal;
    const patch = (url: string) =>
      fake.transport({
        method: 'PATCH',
        url,
        headers: { authorization: bearer, 'content-type': 'application/json' },
        body: '{"config":{"accessType":"OPEN"}}',
        timeoutMs: 1000,
        signal,
      });
    expect((await patch(`${GOOGLE_MEET_API_URL}${seeded.name}?updateMask=*`)).status).toBe(400);
    expect((await patch(`${GOOGLE_MEET_API_URL}spaces/${seeded.meetingCode}?updateMask=config.accessType`)).status).toBe(400);
    expect(fake.spaces.get(seeded.name)!.accessType).toBe('TRUSTED');

    for (const url of [
      `${GOOGLE_MEET_API_URL}${seeded.name}?updateMask=*`,
      `${GOOGLE_MEET_API_URL}${seeded.name}?updateMask=%2A`,
      `${GOOGLE_MEET_API_URL}${seeded.name}?updateMask=config.accessType,config.moderation`,
    ]) {
      expect(isAllowedGoogleUrl('PATCH', url), url).toBe(false);
      let sent = 0;
      const error = await rejection(
        sendGoogleRequest(
          { operation: 'meet.patch', context: 'api', method: 'PATCH', url, body: '{}' },
          {
            transport: async (req) => {
              sent += 1;
              return fake.transport(req);
            },
          },
        ),
      );
      expect(error.code).toBe('invalid_request');
      expect(sent).toBe(0);
    }
  });
});

describe('Google Meet: createOpenSpace (space mode only)', () => {
  it('space mode: POST /v2/spaces with exactly {"config":{"accessType":"OPEN","entryPointAccess":"ALL"}}', async () => {
    const h = harness({ meetMode: 'space', scopes: SPACE_SCOPES, fake: { grantedScopes: SPACE_SCOPES } });
    const space = await h.meet.createOpenSpace();
    const sent = h.api()[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(SPACES_URL);
    expect(sent.body).toBe('{"config":{"accessType":"OPEN","entryPointAccess":"ALL"}}');
    expect(space.accessType).toBe('OPEN');
    expect(space.entryPointAccess).toBe('ALL');
    expect(space.name).toMatch(GOOGLE_MEET_SPACE_NAME_RE);
    expect(space.meetingUri).toBe(`https://meet.google.com/${space.meetingCode}`);
  });

  it('calendar mode: invalid_request with zero calls of any kind', async () => {
    const h = harness({ meetMode: 'calendar' });
    const error = await rejection(h.meet.createOpenSpace());
    expect(error.code).toBe('invalid_request');
    expect(error.operation).toBe('meet.create');
    expect(h.requests).toHaveLength(0);
  });

  it('a space-mode client whose grant lacks meetings.space.created fails closed (setup_forbidden)', async () => {
    // The token source asks only for the two calendar-mode scopes; the fake grants only those.
    const h = harness({ meetMode: 'space' });
    const error = await rejection(h.meet.createOpenSpace());
    expect(error.code).toBe('setup_forbidden');
    expect(error.httpStatus).toBe(403);
    expect(h.fake.spaces.size).toBe(0);
  });

  it('the constructor refuses an unknown Meet mode, a bad token source or seam, synchronously', () => {
    const tokens = { accessToken: async () => 'at-x', invalidate: () => {} };
    for (const options of [
      undefined,
      { tokenSource: tokens },
      { tokenSource: tokens, meetMode: 'SPACE' },
      { tokenSource: tokens, meetMode: 'calendar', transport: 1 },
      { tokenSource: tokens, meetMode: 'calendar', logger: { event: 'x' } },
      { tokenSource: { invalidate: () => {} }, meetMode: 'calendar' },
    ]) {
      expect(() => createGoogleMeetClient(options as never)).toThrow(GoogleError);
    }
    expect(() => createGoogleMeetClient({ tokenSource: tokens, meetMode: 'space' })).not.toThrow();
  });
});

describe('Google Meet: the parsed space is closed', () => {
  it('drops everything but the five fields and canonicalises the link', async () => {
    const h = harness({
      script: [{ status: 200, body: spaceBody({ meetingUri: 'https://meet.google.com/abc-defg-hij?authuser=0' }) }],
    });
    const space = await h.meet.getSpace('abc-defg-hij');
    expect(Object.keys(space!)).toEqual(['name', 'meetingCode', 'meetingUri', 'accessType', 'entryPointAccess']);
    expect(space!.meetingUri).toBe('https://meet.google.com/abc-defg-hij');
    expect(JSON.stringify(space)).not.toMatch(/conferenceRecords|moderation|authuser/);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['no meeting code', { meetingCode: undefined }, { meetingCode: null }],
    ['an odd meeting code', { meetingCode: 'ABC' }, { meetingCode: null }],
    ['a link on another host', { meetingUri: 'https://meet.example.test/abc-defg-hij' }, { meetingUri: null }],
    ['an unknown access type', { config: { accessType: 'PUBLIC', entryPointAccess: 'ALL' } }, { accessType: null }],
    ['a lower-case access type', { config: { accessType: 'open', entryPointAccess: 'ALL' } }, { accessType: null }],
    ['an unknown entry-point access', { config: { accessType: 'OPEN', entryPointAccess: 'SOME' } }, { entryPointAccess: null }],
    ['no config', { config: undefined }, { accessType: null, entryPointAccess: null }],
    ['a config that is not an object', { config: 'OPEN' }, { accessType: null, entryPointAccess: null }],
  ])('%s', async (_name, overrides, expected) => {
    const h = harness({ script: [{ status: 200, body: spaceBody(overrides) }] });
    expect(await h.meet.getSpace('spaces/fake-space-1')).toMatchObject(expected);
  });

  it.each<[string, string, unknown]>([
    ['no name', 'spaces/fake-space-1', spaceBody({ name: undefined })],
    ['a name that is not a space', 'spaces/fake-space-1', spaceBody({ name: 'fake-space-1' })],
    ['another name than asked for', 'spaces/fake-space-1', spaceBody({ name: 'spaces/fake-space-2' })],
    ['another meeting code than asked for', 'abc-defg-hij', spaceBody({ meetingCode: 'xyz-wxyz-xyz' })],
    ['an array', 'abc-defg-hij', [spaceBody()]],
    ['not JSON', 'abc-defg-hij', '<html>'],
  ])('%s -> malformed_response', async (_name, input, body) => {
    const h = harness({ script: [{ status: 200, body }] });
    const error = await rejection(h.meet.getSpace(input));
    expect(error.code).toBe('malformed_response');
    expect(error.operation).toBe('meet.get');
  });

  it('asked by code, an answer without a meeting code is accepted (the name is what updates need)', async () => {
    const h = harness({ script: [{ status: 200, body: spaceBody({ meetingCode: undefined }) }] });
    expect(await h.meet.getSpace('abc-defg-hij')).toMatchObject({ name: 'spaces/fake-space-1', meetingCode: null });
  });
});

describe('Google Meet: error rows and the 401 re-mint', () => {
  it.each<[string, FakeGoogleCannedResponse, GoogleErrorCode, number | null]>([
    ['400 INVALID_ARGUMENT', { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT' } } }, 'invalid_request', null],
    ['403 PERMISSION_DENIED', { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED' } } }, 'setup_forbidden', null],
    ['403 RESOURCE_EXHAUSTED', { status: 403, body: { error: { code: 403, status: 'RESOURCE_EXHAUSTED' } } }, 'quota', 30_000],
    [
      '403 with a RATE_LIMIT_EXCEEDED detail',
      { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } } },
      'quota',
      30_000,
    ],
    [
      '429 RESOURCE_EXHAUSTED with Retry-After: 12',
      { status: 429, headers: { 'Retry-After': '12' }, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } },
      'quota',
      12_000,
    ],
    ['500', { status: 500 }, 'unavailable', 10_000],
    ['503', { status: 503, body: { error: { status: 'UNAVAILABLE' } } }, 'unavailable', 10_000],
  ])('%s -> %s', async (_name, response, code, retryAfterMs) => {
    const h = harness({ script: [response] });
    const error = await rejection(h.meet.makeSpaceOpen('spaces/fake-space-1'));
    expect(error.code).toBe(code);
    expect(error.operation).toBe('meet.patch');
    expect(error.retryAfterMs).toBe(retryAfterMs);
    expect(h.api()).toHaveLength(1);
    expect(h.logs).toEqual([
      expect.objectContaining({ operation: 'meet.patch', outcome: 'failure', code, httpStatus: response.status }),
    ]);
  });

  it('401 then 200: one re-mint, one retry; 401 twice: unauthorized', async () => {
    const h = harness();
    const seeded = h.fake.addSpace();
    await h.meet.getSpace(seeded.name);
    h.fake.expireAccessTokens();
    const space = await h.meet.makeSpaceOpen(seeded.name);
    expect(space.accessType).toBe('OPEN');
    expect(h.fake.tokensIssued).toHaveLength(2);
    expect(h.api().map((req) => req.method)).toEqual(['GET', 'PATCH', 'PATCH']);

    const unauthorized: FakeGoogleCannedResponse = { status: 401 };
    const twice = harness({ script: [unauthorized, unauthorized] });
    const error = await rejection(twice.meet.getSpace('abc-defg-hij'));
    expect(error.code).toBe('unauthorized');
    expect(twice.api()).toHaveLength(2);
  });

  it('a revoked grant never reaches the Meet API', async () => {
    const h = harness();
    h.fake.revokeRefreshToken();
    const error = await rejection(h.meet.getSpace('abc-defg-hij'));
    expect(error.code).toBe('auth_revoked');
    expect(h.api()).toHaveLength(0);
  });
});

afterAll(() => {
  // File-wide pin (S03 plan T3): no request any client sent here ever carried a `*` update mask.
  expect(ALL_URLS.length).toBeGreaterThan(20);
  for (const url of ALL_URLS) {
    expect(url).not.toMatch(/updateMask=(?:\*|%2A)/i);
    expect(url.startsWith(GOOGLE_MEET_API_URL) || url === GOOGLE_TOKEN_URL, url).toBe(true);
  }
});
