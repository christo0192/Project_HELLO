/**
 * Google token sources (M035 S03 T1): the DEFAULT OAuth refresh-token source and the service-account
 * (domain-wide delegation) source, against the shared fake token endpoint.
 *
 * Covers the request snapshots, the cache (expiry margin 60 s, a 60 s token never cached),
 * single-flight, `invalidate()`, the 60 s refusal window after `auth_revoked` / `setup_forbidden`
 * (no request inside it, exactly one after it), the token-endpoint error map, the response shape and
 * scope checks, the synchronous constructor refusals, an RS256 JWT verified with a throwaway key pair
 * generated at run time (no key material in the repo), and a secret canary over errors, logs and the
 * source object.
 *
 * Deterministic: the clock is injected; the network is `createFakeGoogle` (never a real request).
 */
import { generateKeyPairSync, verify } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { GoogleError, isGoogleError, type GoogleErrorCode } from '../integrations/google/errors.js';
import {
  GOOGLE_TOKEN_URL as HTTP_TOKEN_URL,
  type GoogleLogRecord,
  type GoogleTransport,
  type GoogleTransportRequest,
} from '../integrations/google/http.js';
import {
  GOOGLE_JWT_BEARER_GRANT_TYPE,
  GOOGLE_JWT_LIFETIME_SECONDS,
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_EXPIRY_MARGIN_MS,
  GOOGLE_TOKEN_REFUSAL_WINDOW_MS,
  GOOGLE_TOKEN_URL,
  createGoogleDwdTokenSource,
  createGoogleOAuthRefreshTokenSource,
  type GoogleDwdTokenSourceOptions,
  type GoogleOAuthRefreshTokenSourceOptions,
  type GoogleTokenSource,
} from '../integrations/google/token.js';
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
const BASE_SCOPES = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings];
const ALL_SCOPES = [...BASE_SCOPES, GOOGLE_SCOPES.meetSpaceCreated];

// Throwaway RSA pairs, generated per run: no PEM text exists in the repository.
const SIGNER = generateKeyPairSync('rsa', { modulusLength: 2048 });
const STRANGER = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SIGNER_PEM = SIGNER.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SA_KID = 'kid' + '0'.repeat(37);

interface Harness<S> {
  clock: { t: number };
  fake: FakeGoogle;
  requests: GoogleTransportRequest[];
  logs: GoogleLogRecord[];
  source: S;
}

function recording(fake: FakeGoogle, requests: GoogleTransportRequest[]): GoogleTransport {
  return (req) => {
    requests.push(req);
    return fake.transport(req);
  };
}

function refreshHarness(
  opts: { fake?: FakeGoogleOptions; source?: Partial<GoogleOAuthRefreshTokenSourceOptions> } = {},
): Harness<GoogleTokenSource> {
  const clock = { t: T0 };
  const fake = createFakeGoogle({ now: () => clock.t, ...opts.fake });
  const requests: GoogleTransportRequest[] = [];
  const logs: GoogleLogRecord[] = [];
  const source = createGoogleOAuthRefreshTokenSource({
    clientId: FAKE_GOOGLE_CLIENT_ID,
    clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    refreshToken: FAKE_GOOGLE_REFRESH_TOKEN,
    scopes: BASE_SCOPES,
    transport: recording(fake, requests),
    now: () => clock.t,
    logger: { event: (record) => logs.push(record) },
    ...opts.source,
  });
  return { clock, fake, requests, logs, source };
}

function dwdHarness(
  opts: { fake?: FakeGoogleOptions; source?: Partial<GoogleDwdTokenSourceOptions> } = {},
): Harness<GoogleTokenSource> {
  const clock = { t: T0 };
  const fake = createFakeGoogle({
    now: () => clock.t,
    serviceAccount: { clientEmail: FAKE_GOOGLE_SA_EMAIL, publicKey: SIGNER.publicKey },
    ...opts.fake,
  });
  const requests: GoogleTransportRequest[] = [];
  const logs: GoogleLogRecord[] = [];
  const source = createGoogleDwdTokenSource({
    key: { clientEmail: FAKE_GOOGLE_SA_EMAIL, privateKeyId: SA_KID, privateKey: SIGNER_PEM },
    subject: FAKE_GOOGLE_DEX_EMAIL,
    scopes: BASE_SCOPES,
    transport: recording(fake, requests),
    now: () => clock.t,
    logger: { event: (record) => logs.push(record) },
    ...opts.source,
  });
  return { clock, fake, requests, logs, source };
}

function form(req: GoogleTransportRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(req.body ?? '').entries());
}

async function failure(promise: Promise<unknown>): Promise<GoogleError> {
  try {
    await promise;
  } catch (error) {
    expect(isGoogleError(error)).toBe(true);
    return error as GoogleError;
  }
  throw new Error('expected a GoogleError');
}

function syncFailure(thunk: () => unknown): GoogleError {
  try {
    thunk();
  } catch (error) {
    expect(isGoogleError(error)).toBe(true);
    return error as GoogleError;
  }
  throw new Error('expected a synchronous GoogleError');
}

function decodeJwt(assertion: string) {
  const [head, payload, signature] = assertion.split('.') as [string, string, string];
  return {
    head,
    payload,
    signature,
    header: JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

// ── Constants ───────────────────────────────────────────────────────────────

describe('token constants', () => {
  it('pins the three scopes, the URLs and the cache windows', () => {
    expect({ ...GOOGLE_SCOPES }).toEqual({
      calendarEventsOwned: 'https://www.googleapis.com/auth/calendar.events.owned',
      meetSpaceSettings: 'https://www.googleapis.com/auth/meetings.space.settings',
      meetSpaceCreated: 'https://www.googleapis.com/auth/meetings.space.created',
    });
    expect(Object.isFrozen(GOOGLE_SCOPES)).toBe(true);
    expect(GOOGLE_TOKEN_URL).toBe('https://oauth2.googleapis.com/token');
    expect(GOOGLE_TOKEN_URL).toBe(HTTP_TOKEN_URL);
    expect(GOOGLE_OAUTH_AUTHORIZE_URL).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(GOOGLE_JWT_BEARER_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(GOOGLE_TOKEN_EXPIRY_MARGIN_MS).toBe(60_000);
    expect(GOOGLE_TOKEN_REFUSAL_WINDOW_MS).toBe(60_000);
    expect(GOOGLE_JWT_LIFETIME_SECONDS).toBe(3600);
  });
});

// ── OAuth refresh token (DEFAULT) ───────────────────────────────────────────

describe('createGoogleOAuthRefreshTokenSource', () => {
  it('request snapshot: one POST to the token URL, form-encoded, exactly the four fields, no scope', async () => {
    const { source, requests, fake } = refreshHarness();
    const token = await source.accessToken();
    expect(token).toBe(fake.tokensIssued[0]);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://oauth2.googleapis.com/token');
    expect(req.headers).toEqual({ accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.keys(form(req)).sort()).toEqual(['client_id', 'client_secret', 'grant_type', 'refresh_token']);
    expect(form(req)).toEqual({
      grant_type: 'refresh_token',
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: FAKE_GOOGLE_CLIENT_SECRET,
      refresh_token: FAKE_GOOGLE_REFRESH_TOKEN,
    });
    expect(req.body).not.toContain('scope');
    expect(req.timeoutMs).toBe(10_000);
  });

  it('caches the token: a second call makes no request', async () => {
    const { source, requests, logs } = refreshHarness();
    const first = await source.accessToken();
    expect(await source.accessToken()).toBe(first);
    expect(requests).toHaveLength(1);
    expect(logs).toEqual([{ operation: 'token.refresh', outcome: 'success', httpStatus: 200, durationMs: expect.any(Number) }]);
  });

  it('re-mints once now passes expires_in - 60 s', async () => {
    const { source, requests, clock, fake } = refreshHarness();
    const first = await source.accessToken();
    clock.t = T0 + 3599_000 - 60_000 - 1;
    expect(await source.accessToken()).toBe(first);
    expect(requests).toHaveLength(1);
    clock.t += 1;
    const second = await source.accessToken();
    expect(second).toBe(fake.tokensIssued[1]);
    expect(second).not.toBe(first);
    expect(requests).toHaveLength(2);
  });

  it('a token valid for 60 s or less is used once, never cached; 61 s is cached for a second', async () => {
    const short = refreshHarness({ fake: { expiresIn: 60 } });
    await short.source.accessToken();
    await short.source.accessToken();
    expect(short.requests).toHaveLength(2);

    const brief = refreshHarness({ fake: { expiresIn: 61 } });
    await brief.source.accessToken();
    brief.clock.t = T0 + 999;
    await brief.source.accessToken();
    expect(brief.requests).toHaveLength(1);
    brief.clock.t = T0 + 1_000;
    await brief.source.accessToken();
    expect(brief.requests).toHaveLength(2);
  });

  it('single-flight: concurrent calls share one mint, on success and on failure', async () => {
    const fake = createFakeGoogle();
    const requests: GoogleTransportRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: GoogleTransport = async (req) => {
      requests.push(req);
      await gate;
      return fake.transport(req);
    };
    const source = createGoogleOAuthRefreshTokenSource({
      clientId: FAKE_GOOGLE_CLIENT_ID,
      clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
      refreshToken: FAKE_GOOGLE_REFRESH_TOKEN,
      scopes: BASE_SCOPES,
      transport,
    });
    const calls = [source.accessToken(), source.accessToken(), source.accessToken()];
    release();
    const tokens = await Promise.all(calls);
    expect(new Set(tokens).size).toBe(1);
    expect(requests).toHaveLength(1);

    const failing = refreshHarness();
    failing.fake.revokeRefreshToken();
    const errors = await Promise.all([failure(failing.source.accessToken()), failure(failing.source.accessToken())]);
    expect(errors.map((error) => error.code)).toEqual(['auth_revoked', 'auth_revoked']);
    expect(failing.requests).toHaveLength(1);
  });

  it('invalidate() drops the cached token: the next call mints', async () => {
    const { source, requests, fake } = refreshHarness();
    const first = await source.accessToken();
    source.invalidate();
    const second = await source.accessToken();
    expect(second).not.toBe(first);
    expect(second).toBe(fake.tokensIssued[1]);
    expect(requests).toHaveLength(2);
    source.invalidate();
    source.invalidate();
    await source.accessToken();
    expect(requests).toHaveLength(3);
  });

  it('invalid_grant -> auth_revoked, never retried in a loop: zero requests for 60 s, then exactly one', async () => {
    const { source, requests, clock, fake, logs } = refreshHarness();
    fake.revokeRefreshToken();
    const first = await failure(source.accessToken());
    expect(first).toMatchObject({
      code: 'auth_revoked',
      retriable: false,
      retryAfterMs: null,
      httpStatus: 400,
      operation: 'token.refresh',
    });
    expect(requests).toHaveLength(1);

    clock.t = T0 + 59_999;
    const replay = await failure(source.accessToken());
    expect(replay.toJSON()).toEqual(first.toJSON());
    source.invalidate();
    expect((await failure(source.accessToken())).code).toBe('auth_revoked');
    expect(requests).toHaveLength(1);
    expect(logs).toHaveLength(1);

    clock.t = T0 + 60_000;
    expect((await failure(source.accessToken())).code).toBe('auth_revoked');
    expect(requests).toHaveLength(2);
    expect(logs.map((record) => [record.outcome, record.code, record.httpStatus])).toEqual([
      ['failure', 'auth_revoked', 400],
      ['failure', 'auth_revoked', 400],
    ]);
  });

  it('after the 60 s window a recovered grant mints again', async () => {
    const { source, requests, clock, fake } = refreshHarness();
    fake.failNext({ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } });
    expect((await failure(source.accessToken())).code).toBe('auth_revoked');
    clock.t = T0 + 60_000;
    await expect(source.accessToken()).resolves.toBe(fake.tokensIssued[0]);
    expect(requests).toHaveLength(2);
    await source.accessToken();
    expect(requests).toHaveLength(2);
  });

  it.each<[string, number, unknown]>([
    ['invalid_client', 401, { error: 'invalid_client', error_description: 'Unauthorized' }],
    ['unauthorized_client', 400, { error: 'unauthorized_client' }],
    ['access_denied', 400, { error: 'access_denied' }],
    ['invalid_scope', 400, { error: 'invalid_scope' }],
    ['admin_policy_enforced', 400, { error: 'admin_policy_enforced' }],
    ['org_internal', 403, { error: 'org_internal' }],
    ['an unknown 400', 400, { error: 'mystery_error' }],
    ['a non-JSON 400', 400, 'Bad Request'],
  ])('%s -> setup_forbidden, not retried for 60 s', async (_label, status, body) => {
    const { source, requests, fake, clock } = refreshHarness();
    fake.failNext({ status, body });
    expect(await failure(source.accessToken())).toMatchObject({
      code: 'setup_forbidden',
      retriable: false,
      httpStatus: status,
      operation: 'token.refresh',
    });
    clock.t = T0 + 30_000;
    expect((await failure(source.accessToken())).code).toBe('setup_forbidden');
    expect(requests).toHaveLength(1);
  });

  it('a wrong client secret is answered invalid_client by the fake -> setup_forbidden', async () => {
    const { source, requests } = refreshHarness({ source: { clientSecret: 'cs-' + 'x'.repeat(32) } });
    expect(await failure(source.accessToken())).toMatchObject({ code: 'setup_forbidden', httpStatus: 401 });
    expect(requests).toHaveLength(1);
  });

  it.each<[number, Record<string, string>, GoogleErrorCode, number]>([
    [429, { 'retry-after': '7' }, 'quota', 7_000],
    [429, {}, 'quota', 30_000],
    [503, {}, 'unavailable', 10_000],
    [500, { 'retry-after': '2' }, 'unavailable', 2_000],
  ])('%i -> %s (retriable), and the next call tries again', async (status, headers, code, retryAfter) => {
    const { source, requests, fake } = refreshHarness();
    fake.failNext({ status, headers, body: { error: 'x' } });
    expect(await failure(source.accessToken())).toMatchObject({ code, retriable: true, retryAfterMs: retryAfter });
    await expect(source.accessToken()).resolves.toBe(fake.tokensIssued[0]);
    expect(requests).toHaveLength(2);
  });

  const good = () => ({ access_token: 'at-shape-' + 'a'.repeat(20), expires_in: 3599, token_type: 'Bearer' });
  it.each<[string, unknown]>([
    ['an array', []],
    ['null', 'null'],
    ['a JSON string', '"at"'],
    ['an empty body', ''],
    ['an empty object', {}],
    ['no access_token', { ...good(), access_token: undefined }],
    ['an empty access_token', { ...good(), access_token: '' }],
    ['an access_token with a space', { ...good(), access_token: 'at x' }],
    ['an access_token over 4096 characters', { ...good(), access_token: 'a'.repeat(4097) }],
    ['an access_token that is a number', { ...good(), access_token: 42 }],
    ['expires_in as a string', { ...good(), expires_in: '3599' }],
    ['expires_in 0', { ...good(), expires_in: 0 }],
    ['expires_in 86401', { ...good(), expires_in: 86_401 }],
    ['expires_in 1.5', { ...good(), expires_in: 1.5 }],
    ['no expires_in', { ...good(), expires_in: undefined }],
    ['token_type mac', { ...good(), token_type: 'mac' }],
    ['no token_type', { ...good(), token_type: undefined }],
    ['scope that is not a string', { ...good(), scope: 42 }],
  ])('a 200 with %s -> malformed_response (and the next call tries again)', async (_label, body) => {
    const { source, requests, fake } = refreshHarness();
    fake.failNext({ status: 200, body });
    expect(await failure(source.accessToken())).toMatchObject({ code: 'malformed_response', httpStatus: 200, retriable: false });
    await source.accessToken();
    expect(requests).toHaveLength(2);
  });

  it('accepts the edges: a 4096-character token, expires_in 86400, token_type in any case, no scope field', async () => {
    const { source, fake } = refreshHarness();
    const long = 'a'.repeat(4096);
    fake.failNext({ status: 200, body: { access_token: long, expires_in: 86_400, token_type: 'bearer' } });
    expect(await source.accessToken()).toBe(long);
  });

  it('a granted scope list lacking a requested scope -> setup_forbidden (granular consent); extra scopes are fine', async () => {
    const narrow = refreshHarness();
    narrow.fake.setGrantedScopes([GOOGLE_SCOPES.calendarEventsOwned]);
    expect(await failure(narrow.source.accessToken())).toMatchObject({ code: 'setup_forbidden', httpStatus: 200 });
    expect((await failure(narrow.source.accessToken())).code).toBe('setup_forbidden');
    expect(narrow.requests).toHaveLength(1);

    const wide = refreshHarness({ fake: { grantedScopes: ALL_SCOPES } });
    await expect(wide.source.accessToken()).resolves.toBe(wide.fake.tokensIssued[0]);

    const space = refreshHarness({ source: { scopes: ALL_SCOPES } });
    expect((await failure(space.source.accessToken())).code).toBe('setup_forbidden');
  });

  it.each<[string, Partial<GoogleOAuthRefreshTokenSourceOptions> | null]>([
    ['an unknown scope', { scopes: ['https://www.googleapis.com/auth/calendar'] }],
    ['no scopes', { scopes: [] }],
    ['a duplicate scope', { scopes: [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.calendarEventsOwned] }],
    ['scopes that are not an array', { scopes: GOOGLE_SCOPES.calendarEventsOwned as never }],
    ['an empty client secret', { clientSecret: '' }],
    ['a client secret with a space', { clientSecret: 'cs- x' }],
    ['a client secret over 200 characters', { clientSecret: 's'.repeat(201) }],
    ['an empty refresh token', { refreshToken: '' }],
    ['a refresh token over 512 characters', { refreshToken: 'r'.repeat(513) }],
    ['a refresh token with a newline', { refreshToken: 'rt-\nx' }],
    ['a client id without the Google suffix', { clientId: 'hello-r1-fake.example.test' }],
    ['a client id with a space', { clientId: 'hello r1.apps.googleusercontent.com' }],
    ['a client id over 200 characters', { clientId: 'c'.repeat(174) + '.apps.googleusercontent.com' }],
    ['a transport that is not a function', { transport: 'fetch' as never }],
    ['a clock that is not a function', { now: 5 as never }],
    ['a logger without event()', { logger: {} as never }],
    ['a null logger', { logger: null as never }],
    ['no options at all', null],
  ])('refuses %s synchronously: invalid_request, zero requests', (_label, overrides) => {
    let transportCalls = 0;
    const transport: GoogleTransport = async () => {
      transportCalls += 1;
      throw new Error('unexpected');
    };
    const error = syncFailure(() =>
      overrides === null
        ? createGoogleOAuthRefreshTokenSource(undefined as never)
        : createGoogleOAuthRefreshTokenSource({
            clientId: FAKE_GOOGLE_CLIENT_ID,
            clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
            refreshToken: FAKE_GOOGLE_REFRESH_TOKEN,
            scopes: BASE_SCOPES,
            transport,
            ...overrides,
          }),
    );
    expect(error).toMatchObject({ code: 'invalid_request', operation: 'token.refresh', httpStatus: null });
    expect(transportCalls).toBe(0);
  });

  it('accepts all three scopes, a 200-character client id, and the deadline option', async () => {
    const clientId = 'c'.repeat(173) + '.apps.googleusercontent.com';
    expect(clientId).toHaveLength(200);
    const { source, requests } = refreshHarness({
      fake: { clientId, grantedScopes: ALL_SCOPES },
      source: { clientId, scopes: ALL_SCOPES, timeoutMs: 1_234 },
    });
    await source.accessToken();
    expect(requests[0]!.timeoutMs).toBe(1_234);
  });
});

// ── Service account + domain-wide delegation ────────────────────────────────

describe('createGoogleDwdTokenSource', () => {
  it('signs an RS256 JWT (kid, iss, sub, scope, aud, iat, exp = iat + 3600) and sends the jwt-bearer grant', async () => {
    const { source, requests, fake } = dwdHarness();
    expect(await source.accessToken()).toBe(fake.tokensIssued[0]);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(GOOGLE_TOKEN_URL);
    expect(req.headers).toEqual({ accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' });
    const body = form(req);
    expect(Object.keys(body).sort()).toEqual(['assertion', 'grant_type']);
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const jwt = decodeJwt(body.assertion!);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: SA_KID });
    const iat = Math.floor(T0 / 1000);
    expect(jwt.claims).toEqual({
      iss: FAKE_GOOGLE_SA_EMAIL,
      sub: FAKE_GOOGLE_DEX_EMAIL,
      scope: BASE_SCOPES.join(' '),
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    });
    expect((jwt.claims.exp as number) - (jwt.claims.iat as number)).toBe(3600);
    const signed = Buffer.from(`${jwt.head}.${jwt.payload}`);
    const signature = Buffer.from(jwt.signature, 'base64url');
    expect(verify('RSA-SHA256', signed, SIGNER.publicKey, signature)).toBe(true);
    expect(verify('RSA-SHA256', signed, STRANGER.publicKey, signature)).toBe(false);
    const tampered = Buffer.from(`${jwt.head}.${Buffer.from(JSON.stringify({ ...jwt.claims, sub: 'x@y.test' })).toString('base64url')}`);
    expect(verify('RSA-SHA256', tampered, SIGNER.publicKey, signature)).toBe(false);
  });

  it('puts every scope, space-joined, into the scope claim', async () => {
    const { source, requests } = dwdHarness({ fake: { grantedScopes: ALL_SCOPES }, source: { scopes: ALL_SCOPES } });
    await source.accessToken();
    expect(decodeJwt(form(requests[0]!).assertion!).claims.scope).toBe(ALL_SCOPES.join(' '));
  });

  it('caches, re-mints after expires_in - 60 s with a fresh iat, and invalidates', async () => {
    const { source, requests, clock } = dwdHarness();
    const first = await source.accessToken();
    expect(await source.accessToken()).toBe(first);
    expect(requests).toHaveLength(1);
    clock.t = T0 + 3599_000 - 60_000;
    const second = await source.accessToken();
    expect(second).not.toBe(first);
    expect(requests).toHaveLength(2);
    expect(decodeJwt(form(requests[1]!).assertion!).claims.iat).toBe(Math.floor(clock.t / 1000));
    source.invalidate();
    await source.accessToken();
    expect(requests).toHaveLength(3);
  });

  it('a private key that does not parse, or is not RSA, -> setup_forbidden with zero requests, every time', async () => {
    const junk = dwdHarness({ source: { key: { clientEmail: FAKE_GOOGLE_SA_EMAIL, privateKeyId: SA_KID, privateKey: 'not a key' } } });
    expect(await failure(junk.source.accessToken())).toMatchObject({
      code: 'setup_forbidden',
      operation: 'token.jwt_bearer',
      httpStatus: null,
      retriable: false,
    });
    junk.clock.t = T0 + 120_000;
    expect((await failure(junk.source.accessToken())).code).toBe('setup_forbidden');
    expect(junk.requests).toHaveLength(0);
    expect(junk.logs.map((record) => Object.keys(record).sort())).toEqual([
      ['code', 'durationMs', 'operation', 'outcome'],
      ['code', 'durationMs', 'operation', 'outcome'],
    ]);

    const edwards = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const notRsa = dwdHarness({ source: { key: { clientEmail: FAKE_GOOGLE_SA_EMAIL, privateKeyId: SA_KID, privateKey: edwards } } });
    expect((await failure(notRsa.source.accessToken())).code).toBe('setup_forbidden');
    expect(notRsa.requests).toHaveLength(0);
  });

  it('a signature the token endpoint does not accept -> invalid_grant -> auth_revoked', async () => {
    const { source, requests } = dwdHarness({
      fake: { serviceAccount: { clientEmail: FAKE_GOOGLE_SA_EMAIL, publicKey: STRANGER.publicKey } },
    });
    expect(await failure(source.accessToken())).toMatchObject({ code: 'auth_revoked', httpStatus: 400 });
    expect((await failure(source.accessToken())).code).toBe('auth_revoked');
    expect(requests).toHaveLength(1);
  });

  it('an undelegated subject or scope (unauthorized_client) and access_denied -> setup_forbidden', async () => {
    const otherSubject = dwdHarness({ fake: { dexEmail: 'someone-else@hello.example.test' } });
    expect(await failure(otherSubject.source.accessToken())).toMatchObject({ code: 'setup_forbidden', httpStatus: 401 });

    const undelegated = dwdHarness({ fake: { grantedScopes: [GOOGLE_SCOPES.calendarEventsOwned] } });
    expect((await failure(undelegated.source.accessToken())).code).toBe('setup_forbidden');

    const denied = dwdHarness();
    denied.fake.failNext({ status: 400, body: { error: 'access_denied', error_description: 'Requested client not authorized.' } });
    expect((await failure(denied.source.accessToken())).code).toBe('setup_forbidden');
    expect(denied.requests).toHaveLength(1);
  });

  it('a 503 is retriable and not held in the refusal window', async () => {
    const { source, requests, fake } = dwdHarness();
    fake.failNext({ status: 503, body: '' });
    expect(await failure(source.accessToken())).toMatchObject({ code: 'unavailable', retriable: true });
    await expect(source.accessToken()).resolves.toBe(fake.tokensIssued[0]);
    expect(requests).toHaveLength(2);
  });

  it.each<[string, (o: GoogleDwdTokenSourceOptions) => unknown]>([
    ['a subject without @', (o) => ({ ...o, subject: 'dex.hello.example.test' })],
    ['a subject with two @', (o) => ({ ...o, subject: 'dex@x@hello.example.test' })],
    ['a subject with a space', (o) => ({ ...o, subject: 'dex @hello.example.test' })],
    ['a subject with angle brackets', (o) => ({ ...o, subject: '<dex@hello.example.test>' })],
    ['a subject without a dot in the domain', (o) => ({ ...o, subject: 'dex@localhost' })],
    ['a subject over 254 characters', (o) => ({ ...o, subject: 'd'.repeat(245) + '@hello.test' })],
    ['a client email without @', (o) => ({ ...o, key: { ...o.key, clientEmail: 'service-account' } })],
    ['a private key id with a space', (o) => ({ ...o, key: { ...o.key, privateKeyId: 'kid 1' } })],
    ['an empty private key id', (o) => ({ ...o, key: { ...o.key, privateKeyId: '' } })],
    ['a private key id over 128 characters', (o) => ({ ...o, key: { ...o.key, privateKeyId: 'k'.repeat(129) } })],
    ['an empty private key', (o) => ({ ...o, key: { ...o.key, privateKey: '' } })],
    ['a private key that is not a string', (o) => ({ ...o, key: { ...o.key, privateKey: 42 } })],
    ['a private key over 16 KiB', (o) => ({ ...o, key: { ...o.key, privateKey: 'p'.repeat(16 * 1024 + 1) } })],
    ['no key object', (o) => ({ ...o, key: null })],
    ['an unknown scope', (o) => ({ ...o, scopes: ['https://www.googleapis.com/auth/admin.directory.user'] })],
    ['no options at all', () => undefined],
  ])('refuses %s synchronously: invalid_request, zero requests', (_label, mutate) => {
    let transportCalls = 0;
    const transport: GoogleTransport = async () => {
      transportCalls += 1;
      throw new Error('unexpected');
    };
    const base: GoogleDwdTokenSourceOptions = {
      key: { clientEmail: FAKE_GOOGLE_SA_EMAIL, privateKeyId: SA_KID, privateKey: SIGNER_PEM },
      subject: FAKE_GOOGLE_DEX_EMAIL,
      scopes: BASE_SCOPES,
      transport,
    };
    const error = syncFailure(() => createGoogleDwdTokenSource(mutate(base) as GoogleDwdTokenSourceOptions));
    expect(error).toMatchObject({ code: 'invalid_request', operation: 'token.jwt_bearer' });
    expect(transportCalls).toBe(0);
  });
});

// ── Secret canary ───────────────────────────────────────────────────────────

describe('token secret canary', () => {
  type Step = { status: number; headers?: Record<string, string>; body?: unknown } | Error | 'hang' | 'ok';

  async function exercise(source: GoogleTokenSource, logs: GoogleLogRecord[], seen: string[]): Promise<void> {
    try {
      const token = await source.accessToken();
      seen.push(inspect(source, { showHidden: true, depth: 10 }), JSON.stringify(source), JSON.stringify({ ...source }));
      expect(token.length).toBeGreaterThan(0);
    } catch (error) {
      const err = error as GoogleError;
      expect(isGoogleError(err)).toBe(true);
      seen.push(String(err), err.message, JSON.stringify(err), inspect(err, { showHidden: true }), err.stack ?? '');
    }
    seen.push(
      inspect(source, { showHidden: true, depth: 10 }),
      JSON.stringify(source),
      JSON.stringify(Object.keys(source)),
      JSON.stringify(Object.getOwnPropertyNames(source)),
      JSON.stringify({ ...source }),
      JSON.stringify(logs),
      inspect(logs),
    );
  }

  function stepTransport(fake: FakeGoogle, step: Step, requests: GoogleTransportRequest[]): GoogleTransport {
    return async (req) => {
      requests.push(req);
      if (step === 'hang') return new Promise(() => {});
      if (step instanceof Error) throw step;
      if (step !== 'ok') fake.failNext(step);
      return fake.transport(req);
    };
  }

  it('no client secret, refresh token, access token, private key or assertion reaches an error, a log or the source', async () => {
    const canarySecret = 'cs-' + 'q'.repeat(30) + '-7731';
    const canaryRefresh = 'rt-' + 'z'.repeat(30) + '-4410';
    const pemLines = SIGNER_PEM.split('\n').filter((line) => line.length > 0 && !line.startsWith('-'));
    const canaryPem = pemLines[3]!;
    expect(canaryPem.length).toBeGreaterThanOrEqual(40);

    const seen: string[] = [];
    const issued: string[] = [];
    const assertions: string[] = [];
    const echo = [canarySecret, canaryRefresh, canaryPem].join(' ');
    const steps: Step[] = [
      'ok',
      { status: 400, body: { error: 'invalid_grant', error_description: echo } },
      { status: 401, body: { error: 'invalid_client', error_description: echo } },
      { status: 403, body: { error: echo } },
      { status: 429, headers: { 'retry-after': echo }, body: echo },
      { status: 500, body: echo },
      { status: 200, body: { access_token: `${canarySecret} x`, expires_in: 3599, token_type: 'Bearer' } },
      { status: 200, body: `not json ${echo}` },
      { status: 200, body: { access_token: canaryRefresh, expires_in: 3599, token_type: 'Bearer', scope: echo } },
      { status: 302, headers: { location: `https://evil.example.test/?t=${canaryRefresh}` } },
      new Error(echo),
      'hang',
    ];

    for (const step of steps) {
      // OAuth refresh token.
      const fakeA = createFakeGoogle({ clientSecret: canarySecret, refreshToken: canaryRefresh });
      const requestsA: GoogleTransportRequest[] = [];
      const logsA: GoogleLogRecord[] = [];
      const refresh = createGoogleOAuthRefreshTokenSource({
        clientId: FAKE_GOOGLE_CLIENT_ID,
        clientSecret: canarySecret,
        refreshToken: canaryRefresh,
        scopes: BASE_SCOPES,
        transport: stepTransport(fakeA, step, requestsA),
        logger: { event: (record) => logsA.push(record) },
        timeoutMs: 20,
      });
      await exercise(refresh, logsA, seen);
      issued.push(...fakeA.tokensIssued);

      // Service account (DWD).
      const fakeB = createFakeGoogle({
        now: () => Date.now(),
        serviceAccount: { clientEmail: FAKE_GOOGLE_SA_EMAIL, publicKey: SIGNER.publicKey },
      });
      const requestsB: GoogleTransportRequest[] = [];
      const logsB: GoogleLogRecord[] = [];
      const dwd = createGoogleDwdTokenSource({
        key: { clientEmail: FAKE_GOOGLE_SA_EMAIL, privateKeyId: SA_KID, privateKey: SIGNER_PEM },
        subject: FAKE_GOOGLE_DEX_EMAIL,
        scopes: BASE_SCOPES,
        transport: stepTransport(fakeB, step, requestsB),
        logger: { event: (record) => logsB.push(record) },
        timeoutMs: 20,
      });
      await exercise(dwd, logsB, seen);
      issued.push(...fakeB.tokensIssued);
      for (const req of requestsB) assertions.push(form(req).assertion!);
    }

    // Constructor refusals that carry the canaries in their input.
    for (const thunk of [
      () => createGoogleOAuthRefreshTokenSource({ clientId: canarySecret, clientSecret: canarySecret, refreshToken: canaryRefresh, scopes: BASE_SCOPES }),
      () => createGoogleOAuthRefreshTokenSource({ clientId: FAKE_GOOGLE_CLIENT_ID, clientSecret: `${canarySecret} `, refreshToken: canaryRefresh, scopes: BASE_SCOPES }),
      () =>
        createGoogleDwdTokenSource({
          key: { clientEmail: canarySecret, privateKeyId: SA_KID, privateKey: SIGNER_PEM },
          subject: FAKE_GOOGLE_DEX_EMAIL,
          scopes: BASE_SCOPES,
        }),
    ]) {
      const err = syncFailure(thunk);
      seen.push(String(err), JSON.stringify(err), inspect(err, { showHidden: true }), err.stack ?? '');
    }

    // The 'ok' step mints once per mode.
    expect(issued).toHaveLength(2);
    expect(assertions.length).toBeGreaterThanOrEqual(10);
    const corpus = seen.join('\n');
    expect(corpus.length).toBeGreaterThan(2000);
    const canaries = [
      canarySecret,
      canaryRefresh,
      canaryPem,
      'PRIVATE',
      ...new Set(issued),
      ...assertions,
      ...assertions.map((assertion) => assertion.split('.')[2]!),
    ];
    for (const canary of canaries) expect(corpus, canary.slice(0, 12)).not.toContain(canary);
    expect(corpus).toContain('google_');
  });

  it('the source objects expose nothing: no own keys, {} as JSON', async () => {
    const { source } = refreshHarness();
    await source.accessToken();
    expect(Object.keys(source)).toEqual([]);
    expect(JSON.stringify(source)).toBe('{}');
    const dwd = dwdHarness().source;
    await dwd.accessToken();
    expect(Object.keys(dwd)).toEqual([]);
    expect(JSON.stringify(dwd)).toBe('{}');
    expect(inspect(dwd, { showHidden: true, depth: 10 })).not.toContain(SA_KID);
  });
});
