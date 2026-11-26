/**
 * Google client core (M035 S03 T1): the closed `GoogleError`, and `sendGoogleRequest`: the three
 * URL families and the other pre-transport refusals (zero transport calls), the request it sends,
 * the default fetch transport (redirects never followed), the status map for the api and token
 * contexts with bounded retry hints, the deadline, the byte cap, and metadata-only logging.
 *
 * Deterministic: the network is a scripted transport, or `fetch` spied (never a real request).
 * Nothing sleeps except the timeout cases, which use a 20 ms deadline. Fixtures are low-entropy.
 */
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_ERROR_CODES,
  GOOGLE_MAX_RETRY_AFTER_MS,
  GOOGLE_OPERATIONS,
  GoogleError,
  isGoogleError,
  isRetriableGoogleErrorCode,
  type GoogleErrorCode,
} from '../integrations/google/errors.js';
import {
  GOOGLE_CALENDAR_EVENTS_URL,
  GOOGLE_DEFAULT_MAX_RESPONSE_BYTES,
  GOOGLE_DEFAULT_RETRY_AFTER_MS,
  GOOGLE_DEFAULT_TIMEOUT_MS,
  GOOGLE_MAX_REQUEST_BODY_BYTES,
  GOOGLE_MAX_RESPONSE_BYTES,
  GOOGLE_MAX_TIMEOUT_MS,
  GOOGLE_MEET_API_URL,
  GOOGLE_MIN_RESPONSE_BYTES,
  GOOGLE_TOKEN_URL,
  defaultGoogleTransport,
  emitGoogleLog,
  isAllowedGoogleUrl,
  resolveGoogleMaxResponseBytes,
  resolveGoogleTimeoutMs,
  sendGoogleRequest,
  type GoogleLogRecord,
  type GoogleSendOptions,
  type GoogleSendRequest,
  type GoogleTransport,
  type GoogleTransportRequest,
  type GoogleTransportResponse,
} from '../integrations/google/http.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const EVENT_ID = 'a'.repeat(32);
const EVENT_URL = `${GOOGLE_CALENDAR_EVENTS_URL}/${EVENT_ID}`;
const INSERT_URL = `${GOOGLE_CALENDAR_EVENTS_URL}?conferenceDataVersion=1&sendUpdates=none`;
const SPACE_URL = `${GOOGLE_MEET_API_URL}spaces/abc-defg-hij`;
const OPEN_URL = `${GOOGLE_MEET_API_URL}spaces/Xy_9-z?updateMask=config.accessType`;
/** Built at run time: an access-token-shaped canary that must never leave the request headers. */
const BEARER = 'Bearer ' + 'at-core-' + 'b'.repeat(24);

type Step = GoogleTransportResponse | Error | 'hang';

function res(status: number, body: unknown = '', headers: Record<string, string> = {}): GoogleTransportResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, headers: { ...headers }, text: async () => text };
}

function scripted(steps: Step[]) {
  const calls: GoogleTransportRequest[] = [];
  let index = 0;
  const transport: GoogleTransport = async (req) => {
    calls.push(req);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === 'hang') return new Promise<GoogleTransportResponse>(() => {});
    if (step instanceof Error) throw step;
    return step as GoogleTransportResponse;
  };
  return { transport, calls };
}

function apiGet(overrides: Partial<GoogleSendRequest> = {}): GoogleSendRequest {
  return {
    operation: 'calendar.get',
    context: 'api',
    method: 'GET',
    url: EVENT_URL,
    headers: { authorization: BEARER },
    ...overrides,
  };
}

function tokenPost(overrides: Partial<GoogleSendRequest> = {}): GoogleSendRequest {
  return {
    operation: 'token.refresh',
    context: 'token',
    method: 'POST',
    url: GOOGLE_TOKEN_URL,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token',
    ...overrides,
  };
}

function send(steps: Step[], request: GoogleSendRequest = apiGet(), options: Partial<GoogleSendOptions> = {}) {
  const { transport, calls } = scripted(steps);
  const logs: GoogleLogRecord[] = [];
  const promise = sendGoogleRequest(request, {
    transport,
    logger: { event: (record) => logs.push(record) },
    ...options,
  });
  return { promise, calls, logs };
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ── GoogleError ─────────────────────────────────────────────────────────────

describe('GoogleError', () => {
  it('has exactly the ten codes of contract §7.1, frozen, in order', () => {
    expect([...GOOGLE_ERROR_CODES]).toEqual([
      'unauthorized',
      'auth_revoked',
      'setup_forbidden',
      'quota',
      'not_found',
      'already_exists',
      'invalid_request',
      'unavailable',
      'timeout',
      'malformed_response',
    ]);
    expect(Object.isFrozen(GOOGLE_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(GOOGLE_OPERATIONS)).toBe(true);
    expect([...GOOGLE_OPERATIONS]).toEqual([
      'token.refresh',
      'token.jwt_bearer',
      'calendar.insert',
      'calendar.get',
      'calendar.patch',
      'calendar.delete',
      'meet.get',
      'meet.patch',
      'meet.create',
    ]);
  });

  it.each(GOOGLE_ERROR_CODES.map((code) => [code]))('%s: fixed message, name, retriable derived from the code', (code) => {
    const error = new GoogleError(code as GoogleErrorCode, { operation: 'calendar.insert', httpStatus: 418, retryAfterMs: 7_000 });
    const retriable = code === 'quota' || code === 'unavailable' || code === 'timeout';
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GoogleError');
    expect(error.message).toBe(`google_${code}`);
    expect(String(error)).toBe(`GoogleError: google_${code}`);
    expect(error.code).toBe(code);
    expect(error.retriable).toBe(retriable);
    expect(isRetriableGoogleErrorCode(code as GoogleErrorCode)).toBe(retriable);
    expect(error.retryAfterMs).toBe(retriable ? 7_000 : null);
    expect(error.operation).toBe('calendar.insert');
    expect(error.httpStatus).toBe(418);
  });

  it('toJSON serializes exactly {name, code, operation, httpStatus, retriable, retryAfterMs}', () => {
    const error = new GoogleError('quota', { operation: 'meet.patch', httpStatus: 429, retryAfterMs: 30_000 });
    expect(Object.keys(error.toJSON())).toEqual(['name', 'code', 'operation', 'httpStatus', 'retriable', 'retryAfterMs']);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'GoogleError',
      code: 'quota',
      operation: 'meet.patch',
      httpStatus: 429,
      retriable: true,
      retryAfterMs: 30_000,
    });
  });

  it.each([
    [7_000, 7_000],
    [1_234.6, 1_235],
    [0, 0],
    [300_000, 300_000],
    [999_999, GOOGLE_MAX_RETRY_AFTER_MS],
    [-1, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [undefined, null],
    [null, null],
  ])('a retriable error keeps retryAfterMs %s as %s', (input, expected) => {
    expect(new GoogleError('unavailable', { retryAfterMs: input as number | null | undefined }).retryAfterMs).toBe(expected);
  });

  it('a non-retriable error never carries a retry hint', () => {
    for (const code of ['unauthorized', 'auth_revoked', 'setup_forbidden', 'not_found', 'already_exists', 'invalid_request', 'malformed_response'] as const) {
      expect(new GoogleError(code, { retryAfterMs: 5_000 }).retryAfterMs).toBeNull();
    }
  });

  it('sanitizes the status, the operation and an unknown code', () => {
    expect(new GoogleError('not_found', { httpStatus: 404 }).httpStatus).toBe(404);
    for (const bad of [99, 1000, 1.5, -404, Number.NaN, '404']) {
      expect(new GoogleError('not_found', { httpStatus: bad as number }).httpStatus).toBeNull();
    }
    expect(new GoogleError('not_found').operation).toBeNull();
    expect(new GoogleError('not_found', { operation: 'calendar.list' as never }).operation).toBeNull();
    const odd = new GoogleError('leaked text' as GoogleErrorCode);
    expect(odd.code).toBe('malformed_response');
    expect(odd.message).toBe('google_malformed_response');
    expect(isGoogleError(new Error('google_timeout'))).toBe(false);
    expect(isGoogleError({ name: 'GoogleError', code: 'timeout' })).toBe(false);
  });
});

// ── Bounds ──────────────────────────────────────────────────────────────────

describe('sendGoogleRequest bounds', () => {
  it('exports the bounds of S03 plan R6', () => {
    expect(GOOGLE_DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(GOOGLE_MAX_TIMEOUT_MS).toBe(30_000);
    expect(GOOGLE_DEFAULT_MAX_RESPONSE_BYTES).toBe(512 * 1024);
    expect(GOOGLE_MIN_RESPONSE_BYTES).toBe(1024);
    expect(GOOGLE_MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
    expect(GOOGLE_MAX_REQUEST_BODY_BYTES).toBe(32 * 1024);
    expect({ ...GOOGLE_DEFAULT_RETRY_AFTER_MS }).toEqual({ quota: 30_000, unavailable: 10_000, network: 5_000, timeout: 5_000 });
    expect(Object.isFrozen(GOOGLE_DEFAULT_RETRY_AFTER_MS)).toBe(true);
  });

  it.each([
    [undefined, 10_000],
    [25, 25],
    [0, 1],
    [-5, 1],
    [1.5, 10_000],
    [99_999, 30_000],
    [Number.NaN, 10_000],
  ])('timeoutMs %s is sent to the transport as %s', async (input, expected) => {
    expect(resolveGoogleTimeoutMs(input as number | undefined)).toBe(expected);
    const { promise, calls } = send([res(200, '{}')], apiGet(), { timeoutMs: input as number | undefined });
    await promise;
    expect(calls[0]!.timeoutMs).toBe(expected);
  });

  it('clamps the response cap to 1 KiB..4 MiB', async () => {
    expect(resolveGoogleMaxResponseBytes()).toBe(512 * 1024);
    expect(resolveGoogleMaxResponseBytes(1)).toBe(1024);
    expect(resolveGoogleMaxResponseBytes(1e9)).toBe(4 * 1024 * 1024);
    expect(resolveGoogleMaxResponseBytes(2048.5)).toBe(512 * 1024);

    const body = (size: number) => JSON.stringify({ pad: 'x'.repeat(size - 10) });
    expect(body(1024).length).toBe(1024);
    await expect(send([res(200, body(1024))], apiGet(), { maxResponseBytes: 1 }).promise).resolves.toMatchObject({ status: 200 });
    expect(await failure(send([res(200, body(1025))], apiGet(), { maxResponseBytes: 1 }).promise)).toMatchObject({
      code: 'malformed_response',
      httpStatus: 200,
    });
    const declared = (length: number) => res(200, '{}', { 'content-length': String(length) });
    await expect(send([declared(4 * 1024 * 1024)], apiGet(), { maxResponseBytes: 1e9 }).promise).resolves.toMatchObject({ status: 200 });
    expect(await failure(send([declared(4 * 1024 * 1024 + 1)], apiGet(), { maxResponseBytes: 1e9 }).promise)).toMatchObject({
      code: 'malformed_response',
    });
  });
});

// ── URL families and other pre-transport refusals ───────────────────────────

describe('sendGoogleRequest refuses before any transport call', () => {
  it.each([
    ['POST', GOOGLE_TOKEN_URL],
    ['POST', INSERT_URL],
    ['POST', GOOGLE_CALENDAR_EVENTS_URL],
    ['GET', EVENT_URL],
    ['PATCH', `${EVENT_URL}?conferenceDataVersion=1&sendUpdates=all`],
    ['DELETE', `${EVENT_URL}?sendUpdates=none`],
    ['GET', SPACE_URL],
    ['GET', `${GOOGLE_MEET_API_URL}spaces/AbC_12-x`],
    ['POST', `${GOOGLE_MEET_API_URL}spaces`],
    ['PATCH', OPEN_URL],
  ])('allows %s %s', (method, url) => {
    expect(isAllowedGoogleUrl(method, url)).toBe(true);
  });

  it.each([
    ['GET', GOOGLE_TOKEN_URL],
    ['POST', 'http://oauth2.googleapis.com/token'],
    ['POST', 'https://oauth2.googleapis.com/token?x=1'],
    ['POST', 'https://oauth2.googleapis.com/token?'],
    ['POST', 'https://oauth2.googleapis.com/token/'],
    ['POST', 'https://oauth2.googleapis.com:443/token'],
    ['POST', 'https://oauth2.googleapis.com:8443/token'],
    ['POST', 'https://OAUTH2.googleapis.com/token'],
    ['POST', 'https://user@oauth2.googleapis.com/token'],
    ['POST', 'https://oauth2.googleapis.com.evil.test/token'],
    ['POST', 'https://oauth2.googleapis.com/token#x'],
    ['GET', 'https://accounts.google.com/o/oauth2/v2/auth'],
    ['GET', 'https://www.googleapis.com/calendar/v3/calendars/other@example.test/events'],
    ['GET', 'https://www.googleapis.com/calendar/v3/calendars/primary/events/../../../users/me/calendarList'],
    ['GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList'],
    ['GET', `${GOOGLE_CALENDAR_EVENTS_URL}/abc`],
    ['GET', `${GOOGLE_CALENDAR_EVENTS_URL}/${'w'.repeat(32)}`],
    ['GET', `${GOOGLE_CALENDAR_EVENTS_URL}/${'A'.repeat(32)}`],
    ['GET', `${GOOGLE_CALENDAR_EVENTS_URL}/${EVENT_ID}/instances`],
    ['GET', `${GOOGLE_CALENDAR_EVENTS_URL}/`],
    ['GET', `${GOOGLE_CALENDAR_EVENTS_URL}\\${EVENT_ID}`],
    ['POST', `${GOOGLE_CALENDAR_EVENTS_URL}?evil=1`],
    ['POST', `${GOOGLE_CALENDAR_EVENTS_URL}?sendUpdates=none&sendUpdates=all`],
    ['POST', `${GOOGLE_CALENDAR_EVENTS_URL}?sendUpdates=`],
    ['POST', `${GOOGLE_CALENDAR_EVENTS_URL}?sendUpdates`],
    ['POST', `${GOOGLE_CALENDAR_EVENTS_URL}?`],
    ['POST', `${GOOGLE_CALENDAR_EVENTS_URL}?sendUpdates=none#frag`],
    ['PATCH', `${GOOGLE_MEET_API_URL}spaces/abc-defg-hij?updateMask=*`],
    ['PATCH', `${GOOGLE_MEET_API_URL}spaces/abc-defg-hij?updateMask=%2A`],
    ['PATCH', `${GOOGLE_MEET_API_URL}spaces/abc-defg-hij?updateMask=config.accessType,config.entryPointAccess`],
    ['GET', 'https://meet.googleapis.com/v1/spaces'],
    ['GET', 'https://meet.googleapis.com/v2/conferenceRecords'],
    ['GET', 'https://meet.googleapis.com/v2/spaces/a/b'],
    ['GET', `https://meet.googleapis.com/v2/spaces/${'x'.repeat(129)}`],
    ['GET', 'https://meet.google.com/abc-defg-hij'],
    ['GET', 'https://example.test/v2/spaces'],
    ['GET', `${EVENT_URL}\t`],
    ['GET', `${EVENT_URL} `],
    ['GET', ''],
    ['GET', `${GOOGLE_CALENDAR_EVENTS_URL}/${'a'.repeat(2100)}`],
    ['GET', 42],
    ['GET', null],
  ])('refuses %s %s', async (method, url) => {
    expect(isAllowedGoogleUrl(method, url)).toBe(false);
    const context = url === GOOGLE_TOKEN_URL ? 'token' : 'api';
    const { promise, calls, logs } = send([res(200, '{}')], apiGet({ method: method as 'GET', url: url as string, context }));
    const error = await failure(promise);
    expect(error).toMatchObject({ code: 'invalid_request', operation: 'calendar.get', httpStatus: null, retriable: false });
    expect(calls).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]!).sort()).toEqual(['code', 'durationMs', 'operation', 'outcome']);
  });

  it.each<[string, Partial<GoogleSendRequest>]>([
    ['an unknown method', { method: 'PUT' as never }],
    ['a lower-case method', { method: 'get' as never }],
    ['an unknown context', { context: 'other' as never }],
    ['the token context on an API URL', { context: 'token' }],
    ['the api context on the token URL', { method: 'POST', url: GOOGLE_TOKEN_URL, context: 'api' }],
    ['a body on GET', { body: '{}' }],
    ['a body on DELETE', { method: 'DELETE', body: '{}' }],
    ['a body that is not a string', { method: 'POST', url: INSERT_URL, body: { a: 1 } as never }],
    ['a body over 32 KiB', { method: 'POST', url: INSERT_URL, body: 'x'.repeat(32 * 1024 + 1) }],
    ['a multi-byte body over 32 KiB', { method: 'POST', url: INSERT_URL, body: 'é'.repeat(16 * 1024 + 1) }],
    ['an upper-case header name', { headers: { Authorization: BEARER } }],
    ['a header name with a space', { headers: { 'x token': 'v' } }],
    ['a header value with CR LF', { headers: { 'x-a': 'v\r\nx-b: w' } }],
    ['a header value that is not a string', { headers: { 'x-a': 1 as never } }],
    ['a header value over 8 KiB', { headers: { 'x-a': 'v'.repeat(8193) } }],
    ['headers that are not an object', { headers: 'x' as never }],
  ])('refuses %s', async (_label, overrides) => {
    const { promise, calls } = send([res(200, '{}')], apiGet(overrides));
    expect(await failure(promise)).toMatchObject({ code: 'invalid_request', operation: 'calendar.get' });
    expect(calls).toHaveLength(0);
  });

  it('accepts a body of exactly 32 KiB', async () => {
    const { promise, calls } = send([res(200, '{}')], apiGet({ method: 'POST', url: INSERT_URL, body: 'x'.repeat(32 * 1024) }));
    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(calls).toHaveLength(1);
  });

  it('refuses a transport that is not a function, and an unknown operation (which it cannot log)', async () => {
    const logs: GoogleLogRecord[] = [];
    const logger = { event: (record: GoogleLogRecord) => logs.push(record) };
    expect(await failure(sendGoogleRequest(apiGet(), { transport: 'fetch' as never, logger }))).toMatchObject({
      code: 'invalid_request',
      operation: 'calendar.get',
    });
    const unknown = await failure(sendGoogleRequest(apiGet({ operation: 'calendar.list' as never }), { logger }));
    expect(unknown).toMatchObject({ code: 'invalid_request', operation: null });
    expect(await failure(sendGoogleRequest(undefined as never))).toMatchObject({ code: 'invalid_request' });
    expect(logs).toHaveLength(1);
  });
});

// ── The request it sends ────────────────────────────────────────────────────

describe('sendGoogleRequest request shape', () => {
  it('sends the method, URL, headers (accept added), body, the deadline and a live signal, once', async () => {
    const request = apiGet({
      method: 'POST',
      url: INSERT_URL,
      headers: { authorization: BEARER, 'content-type': 'application/json' },
      body: '{"id":"x"}',
      operation: 'calendar.insert',
    });
    const { promise, calls } = send([res(200, { id: 'x' })], request);
    await expect(promise).resolves.toEqual({ status: 200, json: { id: 'x' } });
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(INSERT_URL);
    expect(sent.headers).toEqual({ accept: 'application/json', authorization: BEARER, 'content-type': 'application/json' });
    expect(sent.body).toBe('{"id":"x"}');
    expect(sent.timeoutMs).toBe(10_000);
    expect(sent.signal).toBeInstanceOf(AbortSignal);
    expect(sent.signal.aborted).toBe(false);
  });

  it('a GET carries no body key, and a given accept header wins', async () => {
    const { promise, calls } = send([res(200, '{}')], apiGet({ headers: { accept: 'application/json; charset=utf-8' } }));
    await promise;
    expect('body' in calls[0]!).toBe(false);
    expect(calls[0]!.headers).toEqual({ accept: 'application/json; charset=utf-8' });
  });

  it('never retries: a retriable failure costs exactly one transport call', async () => {
    const { promise, calls } = send([res(503, ''), res(200, '{}')]);
    expect(await failure(promise)).toMatchObject({ code: 'unavailable' });
    expect(calls).toHaveLength(1);
  });
});

// ── The default transport ───────────────────────────────────────────────────

describe('defaultGoogleTransport (fetch spied; never a real request)', () => {
  it('calls fetch once with redirect: manual, the signal and the headers, and flattens the response headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"name":"spaces/x"}', { status: 200, headers: { 'Content-Type': 'application/json', 'X-Custom': 'v' } }),
    );
    await expect(sendGoogleRequest(apiGet({ url: SPACE_URL, operation: 'meet.get' }))).resolves.toEqual({
      status: 200,
      json: { name: 'spaces/x' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(SPACE_URL);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { accept: 'application/json', authorization: BEARER } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init && 'body' in init).toBe(false);

    fetchSpy.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'X-Custom': 'v' } }));
    const direct = await defaultGoogleTransport({
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: {},
      body: 'a=b',
      timeoutMs: 10,
      signal: new AbortController().signal,
    });
    expect(direct.status).toBe(200);
    expect(direct.headers).toMatchObject({ 'x-custom': 'v' });
    expect(direct.body).not.toBeNull();
    expect(fetchSpy.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: 'a=b', redirect: 'manual' });
  });

  it('a 3xx is never followed: malformed_response after exactly one fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://evil.example.test/' } }),
    );
    expect(await failure(sendGoogleRequest(apiGet()))).toMatchObject({ code: 'malformed_response', httpStatus: 302, retriable: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('streams a real Response body under the cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('\uFEFF{"ok":true}', { status: 200 }));
    await expect(sendGoogleRequest(apiGet())).resolves.toEqual({ status: 200, json: { ok: true } });
  });
});

// ── Status map: api context ─────────────────────────────────────────────────

const quotaBody = (entry: Record<string, unknown>) => ({ error: { code: 403, message: 'x', errors: [entry] } });

describe('status map, api context (Calendar, Meet)', () => {
  it.each<[string, number, unknown, GoogleErrorCode, number | null]>([
    ['400 INVALID_ARGUMENT', 400, { error: { code: 400, status: 'INVALID_ARGUMENT' } }, 'invalid_request', null],
    ['401', 401, { error: { code: 401, status: 'UNAUTHENTICATED' } }, 'unauthorized', null],
    ['403 domain usageLimits', 403, quotaBody({ domain: 'usageLimits', reason: 'somethingNew' }), 'quota', 30_000],
    ['403 rateLimitExceeded', 403, quotaBody({ domain: 'global', reason: 'rateLimitExceeded' }), 'quota', 30_000],
    ['403 userRateLimitExceeded', 403, quotaBody({ domain: 'usageLimits', reason: 'userRateLimitExceeded' }), 'quota', 30_000],
    ['403 quotaExceeded', 403, quotaBody({ domain: 'usageLimits', reason: 'quotaExceeded' }), 'quota', 30_000],
    ['403 dailyLimitExceeded', 403, quotaBody({ reason: 'dailyLimitExceeded' }), 'quota', 30_000],
    ['403 RESOURCE_EXHAUSTED', 403, { error: { code: 403, status: 'RESOURCE_EXHAUSTED' } }, 'quota', 30_000],
    [
      '403 ErrorInfo RATE_LIMIT_EXCEEDED',
      403,
      { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } },
      'quota',
      30_000,
    ],
    ['403 usageLimits accessNotConfigured (API off)', 403, quotaBody({ domain: 'usageLimits', reason: 'accessNotConfigured' }), 'setup_forbidden', null],
    ['403 forbiddenForNonOrganizer', 403, quotaBody({ domain: 'calendar', reason: 'forbiddenForNonOrganizer' }), 'setup_forbidden', null],
    ['403 PERMISSION_DENIED', 403, { error: { code: 403, status: 'PERMISSION_DENIED' } }, 'setup_forbidden', null],
    ['403 non-JSON', 403, 'Forbidden', 'setup_forbidden', null],
    ['403 empty', 403, '', 'setup_forbidden', null],
    ['403 errors not an array', 403, { error: { errors: 'usageLimits' } }, 'setup_forbidden', null],
    ['404', 404, { error: { code: 404, status: 'NOT_FOUND' } }, 'not_found', null],
    ['410', 410, { error: { code: 410, message: 'Resource has been deleted' } }, 'not_found', null],
    ['409', 409, { error: { code: 409, message: 'The requested identifier already exists.' } }, 'already_exists', null],
    ['405', 405, '', 'invalid_request', null],
    ['412', 412, { error: { code: 412, message: 'Precondition Failed' } }, 'invalid_request', null],
    ['422', 422, '', 'invalid_request', null],
    ['429', 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 'quota', 30_000],
    ['500', 500, '', 'unavailable', 10_000],
    ['502', 502, '<html>bad gateway</html>', 'unavailable', 10_000],
    ['503', 503, { error: { code: 503, status: 'UNAVAILABLE' } }, 'unavailable', 10_000],
    ['504', 504, '', 'unavailable', 10_000],
    ['301', 301, '', 'malformed_response', null],
    ['302', 302, '', 'malformed_response', null],
    ['304', 304, '', 'malformed_response', null],
    ['100', 100, '', 'malformed_response', null],
    ['600', 600, '', 'malformed_response', null],
  ])('%s -> %s (retryAfterMs %s), one call, one failure record', async (_label, status, body, code, retryAfter) => {
    const { promise, calls, logs } = send([res(status, body)], apiGet({ operation: 'calendar.patch', method: 'PATCH', url: EVENT_URL, body: '{}' }));
    const error = await failure(promise);
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.operation).toBe('calendar.patch');
    expect(error.retriable).toBe(retryAfter !== null);
    expect(error.retryAfterMs).toBe(retryAfter);
    expect(error.message).toBe(`google_${code}`);
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([{ operation: 'calendar.patch', outcome: 'failure', code, httpStatus: status, durationMs: expect.any(Number) }]);
  });

  it('a status that is not an integer is malformed_response', async () => {
    const odd = { status: '200' as unknown as number, headers: {}, text: async () => '{}' };
    expect(await failure(send([odd]).promise)).toMatchObject({ code: 'malformed_response', httpStatus: null });
  });

  it.each<[number, unknown, string, number]>([
    [429, '', '0', 1_000],
    [429, '', '7', 7_000],
    [429, '', '999', 300_000],
    [429, '', ' 12 ', 12_000],
    [429, '', 'Wed, 21 Oct 2026 07:28:00 GMT', 30_000],
    [429, '', '-3', 30_000],
    [429, '', '1.5', 30_000],
    [503, '', '0', 1_000],
    [503, '', '7', 7_000],
    [503, '', '999', 300_000],
    [503, '', 'Wed, 21 Oct 2026 07:28:00 GMT', 10_000],
    [403, quotaBody({ domain: 'usageLimits', reason: 'rateLimitExceeded' }), '7', 7_000],
  ])('%i with Retry-After %j -> retryAfterMs %i', async (status, body, header, expected) => {
    const error = await failure(send([res(status, body, { 'retry-after': header })]).promise);
    expect(error.retriable).toBe(true);
    expect(error.retryAfterMs).toBe(expected);
  });

  it('reads Retry-After case-insensitively, and ignores it on a non-retriable status', async () => {
    expect((await failure(send([res(429, '', { 'Retry-After': '9' })]).promise)).retryAfterMs).toBe(9_000);
    expect((await failure(send([res(404, '', { 'retry-after': '9' })]).promise)).retryAfterMs).toBeNull();
  });
});

// ── Status map: token context ───────────────────────────────────────────────

describe('status map, token context (the OAuth token endpoint)', () => {
  const oauth = (error: unknown) => ({ error, error_description: 'x' });
  it.each<[string, number, unknown, GoogleErrorCode, number | null]>([
    ['invalid_grant', 400, oauth('invalid_grant'), 'auth_revoked', null],
    ['invalid_grant on a 401', 401, oauth('invalid_grant'), 'auth_revoked', null],
    ['invalid_client 401', 401, oauth('invalid_client'), 'setup_forbidden', null],
    ['invalid_client 400', 400, oauth('invalid_client'), 'setup_forbidden', null],
    ['unauthorized_client', 401, oauth('unauthorized_client'), 'setup_forbidden', null],
    ['access_denied', 400, oauth('access_denied'), 'setup_forbidden', null],
    ['invalid_scope', 400, oauth('invalid_scope'), 'setup_forbidden', null],
    ['admin_policy_enforced', 400, oauth('admin_policy_enforced'), 'setup_forbidden', null],
    ['org_internal', 403, oauth('org_internal'), 'setup_forbidden', null],
    ['an unknown error', 400, oauth('mystery_error'), 'setup_forbidden', null],
    ['an error that is not a string', 400, oauth({ code: 'invalid_grant' }), 'setup_forbidden', null],
    ['non-JSON', 400, 'Bad Request', 'setup_forbidden', null],
    ['404', 404, '', 'setup_forbidden', null],
    ['429', 429, oauth('rate_limit'), 'quota', 30_000],
    ['500', 500, oauth('server_error'), 'unavailable', 10_000],
    ['503', 503, '', 'unavailable', 10_000],
    ['302', 302, '', 'malformed_response', null],
  ])('%s (%i) -> %s', async (_label, status, body, code, retryAfter) => {
    const { promise, calls } = send([res(status, body)], tokenPost());
    const error = await failure(promise);
    expect(error).toMatchObject({ code, httpStatus: status, operation: 'token.refresh', retryAfterMs: retryAfter });
    expect(error.retriable).toBe(retryAfter !== null);
    expect(calls).toHaveLength(1);
  });
});

// ── 2xx bodies and the parse callback ───────────────────────────────────────

describe('2xx bodies and parse', () => {
  it('parses JSON, treats an empty body as undefined, and refuses non-JSON', async () => {
    await expect(send([res(200, { a: 1 })]).promise).resolves.toEqual({ status: 200, json: { a: 1 } });
    await expect(send([res(200, '')]).promise).resolves.toEqual({ status: 200, json: undefined });
    await expect(send([res(200, '  \n')]).promise).resolves.toEqual({ status: 200, json: undefined });
    await expect(send([res(204, '')], apiGet({ method: 'DELETE', operation: 'calendar.delete' })).promise).resolves.toEqual({
      status: 204,
      json: undefined,
    });
    await expect(send([res(200, '\uFEFF{"b":2}')]).promise).resolves.toEqual({ status: 200, json: { b: 2 } });
    expect(await failure(send([res(200, 'not json')]).promise)).toMatchObject({ code: 'malformed_response', httpStatus: 200 });
    expect(await failure(send([res(201, '{"a":')]).promise)).toMatchObject({ code: 'malformed_response', httpStatus: 201 });
  });

  it('resolves what parse returns, and logs one success record after it', async () => {
    const { transport } = scripted([res(200, { a: 1 })]);
    const logs: GoogleLogRecord[] = [];
    const value = await sendGoogleRequest(apiGet(), { transport, logger: { event: (r) => logs.push(r) } }, (result) => ({
      seen: result.json,
      status: result.status,
    }));
    expect(value).toEqual({ seen: { a: 1 }, status: 200 });
    expect(logs).toEqual([{ operation: 'calendar.get', outcome: 'success', httpStatus: 200, durationMs: expect.any(Number) }]);
  });

  it('a parse that throws is the outcome: its GoogleError, or malformed_response for anything else', async () => {
    const logs: GoogleLogRecord[] = [];
    const logger = { event: (r: GoogleLogRecord) => logs.push(r) };
    const own = await failure(
      sendGoogleRequest(apiGet(), { transport: scripted([res(200, '{}')]).transport, logger }, () => {
        throw new GoogleError('setup_forbidden', { operation: 'calendar.get', httpStatus: 200 });
      }),
    );
    expect(own).toMatchObject({ code: 'setup_forbidden', httpStatus: 200 });
    const other = await failure(
      sendGoogleRequest(apiGet(), { transport: scripted([res(200, '{}')]).transport, logger }, () => {
        throw new TypeError(`cannot read ${BEARER}`);
      }),
    );
    expect(other).toMatchObject({ code: 'malformed_response', httpStatus: 200, operation: 'calendar.get' });
    expect(logs.map((r) => [r.outcome, r.code])).toEqual([
      ['failure', 'setup_forbidden'],
      ['failure', 'malformed_response'],
    ]);
    expect(JSON.stringify(other) + String(other) + inspect(other)).not.toContain(BEARER);
  });

  it('parse is never called on a non-2xx', async () => {
    const parse = vi.fn();
    await failure(sendGoogleRequest(apiGet(), { transport: scripted([res(404, '')]).transport }, parse));
    expect(parse).not.toHaveBeenCalled();
  });
});

// ── Deadline, transport and size failures ───────────────────────────────────

describe('deadline, transport and size failures', () => {
  it('times out a transport that never resolves (and ignores the signal): timeout, retriable 5 s, signal aborted', async () => {
    const started = Date.now();
    const { promise, calls } = send(['hang'], apiGet(), { timeoutMs: 20 });
    const error = await failure(promise);
    expect(error).toMatchObject({ code: 'timeout', retriable: true, retryAfterMs: 5_000, httpStatus: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('times out a transport that honours the signal', async () => {
    const transport: GoogleTransport = (req) =>
      new Promise((_resolve, reject) => {
        req.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    expect(await failure(sendGoogleRequest(apiGet(), { transport, timeoutMs: 20 }))).toMatchObject({ code: 'timeout', retriable: true });
  });

  it('the deadline covers the body read', async () => {
    const stalled: GoogleTransportResponse = { status: 200, headers: {}, text: () => new Promise<string>(() => {}) };
    expect(await failure(send([stalled], apiGet(), { timeoutMs: 20 }).promise)).toMatchObject({ code: 'timeout', retryAfterMs: 5_000 });
  });

  it('maps a transport throw to unavailable (retriable, 5 s) without its message', async () => {
    const { promise, calls } = send([new Error(`ECONNRESET ${BEARER}`)]);
    const error = await failure(promise);
    expect(error).toMatchObject({ code: 'unavailable', retriable: true, retryAfterMs: 5_000, httpStatus: null });
    expect(JSON.stringify(error) + String(error) + inspect(error) + (error.stack ?? '')).not.toContain(BEARER);
    expect(calls).toHaveLength(1);

    const syncThrow: GoogleTransport = () => {
      throw new Error('sync');
    };
    expect(await failure(sendGoogleRequest(apiGet(), { transport: syncThrow }))).toMatchObject({ code: 'unavailable' });
  });

  it('a failing body read, a non-byte chunk and a non-object response', async () => {
    const broken: GoogleTransportResponse = {
      status: 200,
      headers: {},
      text: async () => {
        throw new Error('socket hang up');
      },
    };
    expect(await failure(send([broken]).promise)).toMatchObject({ code: 'unavailable', retriable: true });

    const strings = new ReadableStream({
      start(controller) {
        controller.enqueue('not bytes' as unknown as Uint8Array);
        controller.close();
      },
    }) as ReadableStream<Uint8Array>;
    const odd: GoogleTransportResponse = { status: 200, headers: {}, body: strings, text: async () => '{}' };
    expect(await failure(send([odd]).promise)).toMatchObject({ code: 'unavailable' });

    const nothing: GoogleTransport = async () => undefined as unknown as GoogleTransportResponse;
    expect(await failure(sendGoogleRequest(apiGet(), { transport: nothing }))).toMatchObject({ code: 'malformed_response' });
  });

  it('a declared Content-Length over the cap is refused without reading the body, and the signal is aborted', async () => {
    let read = false;
    const declared: GoogleTransportResponse = {
      status: 200,
      headers: { 'content-length': String(512 * 1024 + 1) },
      text: async () => {
        read = true;
        return '{}';
      },
    };
    const { promise, calls } = send([declared]);
    expect(await failure(promise)).toMatchObject({ code: 'malformed_response', httpStatus: 200, retriable: false });
    expect(read).toBe(false);
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('a text() body over the cap is malformed_response, also on an error status', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(2048) });
    expect(await failure(send([res(200, big)], apiGet(), { maxResponseBytes: 1024 }).promise)).toMatchObject({ code: 'malformed_response' });
    expect(await failure(send([res(503, big)], apiGet(), { maxResponseBytes: 1024 }).promise)).toMatchObject({
      code: 'malformed_response',
      httpStatus: 503,
    });
  });

  it('enforces the cap WHILE streaming a body that declares no length, and cancels the stream', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(256).fill(0x61);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    let textCalled = false;
    const streamed: GoogleTransportResponse = {
      status: 200,
      headers: {},
      body: endless,
      text: () => {
        textCalled = true;
        return new Promise<string>(() => {});
      },
    };
    const { promise, calls } = send([streamed], apiGet(), { maxResponseBytes: 1024, timeoutMs: 2_000 });
    expect(await failure(promise)).toMatchObject({ code: 'malformed_response', httpStatus: 200 });
    expect(textCalled).toBe(false);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(8);
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('reads a streamed body under the cap across chunk boundaries, with a byte-order mark and multi-byte text', async () => {
    const bytes = new TextEncoder().encode('\uFEFF' + JSON.stringify({ note: 'é'.repeat(50) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const streamed: GoogleTransportResponse = { status: 200, headers: {}, body: stream, text: async () => 'unused' };
    await expect(send([streamed]).promise).resolves.toEqual({ status: 200, json: { note: 'é'.repeat(50) } });
  });
});

// ── Logging ─────────────────────────────────────────────────────────────────

describe('metadata-only logging', () => {
  it('one record per call with exactly the allowed keys', async () => {
    const ok = send([res(200, '{}')]);
    await ok.promise;
    expect(ok.logs).toHaveLength(1);
    expect(Object.keys(ok.logs[0]!).sort()).toEqual(['durationMs', 'httpStatus', 'operation', 'outcome']);
    expect(ok.logs[0]).toMatchObject({ operation: 'calendar.get', outcome: 'success', httpStatus: 200 });
    expect(ok.logs[0]!.durationMs).toBeGreaterThanOrEqual(0);

    const bad = send([res(409, '')]);
    await failure(bad.promise);
    expect(Object.keys(bad.logs[0]!).sort()).toEqual(['code', 'durationMs', 'httpStatus', 'operation', 'outcome']);

    const slow = send(['hang'], apiGet(), { timeoutMs: 20 });
    await failure(slow.promise);
    expect(slow.logs).toEqual([{ operation: 'calendar.get', outcome: 'failure', code: 'timeout', durationMs: expect.any(Number) }]);
  });

  it('a throwing logger never breaks a call, on success or failure', async () => {
    const logger = {
      event: () => {
        throw new Error('logger down');
      },
    };
    await expect(sendGoogleRequest(apiGet(), { transport: scripted([res(200, '{}')]).transport, logger })).resolves.toMatchObject({
      status: 200,
    });
    expect(await failure(sendGoogleRequest(apiGet(), { transport: scripted([res(404, '')]).transport, logger }))).toMatchObject({
      code: 'not_found',
    });
    expect(await failure(sendGoogleRequest(apiGet({ url: 'https://example.test/' }), { logger }))).toMatchObject({
      code: 'invalid_request',
    });
    expect(() => emitGoogleLog(logger, { operation: 'meet.get', startedAt: Date.now() })).not.toThrow();
    expect(() => emitGoogleLog(undefined, { operation: 'meet.get', startedAt: Date.now() })).not.toThrow();
    expect(() => emitGoogleLog({ event: 'x' } as never, { operation: 'meet.get', startedAt: Date.now() })).not.toThrow();
  });

  it('no token, body, URL or vendor text reaches a record or an error, on any path', async () => {
    const canaryId = 'c'.repeat(32);
    const canaryText = 'vendor-canary-' + 'v'.repeat(12);
    const echo = `${BEARER} ${canaryId} ${canaryText}`;
    const steps: Step[] = [
      res(400, { error: { message: echo } }),
      res(401, echo),
      res(403, { error: { errors: [{ domain: 'usageLimits', message: echo }] } }, { 'retry-after': echo }),
      res(403, { error: { message: echo } }),
      res(404, echo),
      res(409, echo),
      res(429, echo, { 'retry-after': '3' }),
      res(500, echo),
      res(302, echo, { location: `https://evil.example.test/${canaryId}` }),
      res(200, `not json ${echo}`),
      res(200, { id: canaryId, note: echo }),
      new Error(echo),
      'hang',
    ];
    const corpus: string[] = [];
    for (const step of steps) {
      for (const request of [
        apiGet({ url: `${GOOGLE_CALENDAR_EVENTS_URL}/${canaryId}` }),
        apiGet({ url: `${GOOGLE_CALENDAR_EVENTS_URL}/${canaryId}/x` }),
        tokenPost({ body: `refresh_token=${canaryText}` }),
      ]) {
        const { promise, logs } = send([step], request, { timeoutMs: 20 });
        try {
          await promise;
        } catch (error) {
          const err = error as GoogleError;
          corpus.push(String(err), JSON.stringify(err), inspect(err), err.stack ?? '');
        }
        corpus.push(JSON.stringify(logs), inspect(logs));
      }
    }
    const text = corpus.join('\n');
    expect(text.length).toBeGreaterThan(1000);
    for (const canary of [BEARER, canaryId, canaryText, 'evil.example.test']) expect(text).not.toContain(canary);
  });
});
