import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('../supabase', () => ({ supabase: { auth: { getSession } } }));

import { ApiError } from '../api-client';
import {
  classifyR1Error,
  normalizeLead,
  parseAttempt,
  parseConsentTemplate,
  parseExchange,
  parsePreflight,
  parseStatus,
  R1_ROUTES,
  R1_SERVER_ERROR_CODES,
  r1Api,
} from './r1-api';

const LINK = 'a'.repeat(64);

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(response: Response | Error) {
  const fetchMock = vi.fn().mockImplementation(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof mockFetch>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(String(init.body)) : null };
}

/** PR-3's `POST /api/r1/status` answer: the wire names, not the page model. */
const STATUS = {
  round_status: 'invited',
  expires_at: '2026-10-10T00:00:00.000Z',
  availability: 'open',
  attempts_allowed: 2,
  attempts_remaining: 2,
  starts_remaining: 3,
  consent: { state: 'required', template_version: 'r1-2026-10' },
  live_attempt: false,
  can_start: false,
  role_title: 'Sales Program Advisor',
  format: {
    duration_minutes: 20,
    camera_required: true,
    microphone_required: true,
    interviewer: 'ai',
    includes_role_play: true,
  },
};

describe('R1 route table', () => {
  it('declares exactly the plan section 8.3 candidate routes', () => {
    expect(R1_ROUTES).toEqual({
      status: '/api/r1/status',
      consentTemplate: '/api/r1/consent-template',
      consent: '/api/r1/consent',
      consentWithdraw: '/api/r1/consent/withdraw',
      preflight: '/api/r1/preflight',
      attempts: '/api/r1/attempts',
      exchange: '/api/r1/exchange',
      ready: '/api/r1/ready',
    });
  });
});

describe('r1Api requests', () => {
  beforeEach(() => {
    getSession.mockReset();
    (globalThis as { __resetNetworkCount?: () => void }).__resetNetworkCount?.();
  });

  it('sends the link token in the JSON body only, credential-free and uncached', async () => {
    const fetchMock = mockFetch(reply(200, STATUS));
    await r1Api.status(LINK);
    const { url, init, body } = lastCall(fetchMock);
    expect(url.endsWith('/api/r1/status')).toBe(true);
    expect(url).not.toContain(LINK);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(body).toEqual({ token: LINK });
    const headerNames = Object.keys(init.headers as Record<string, string>);
    expect(headerNames.map((name) => name.toLowerCase())).not.toContain('authorization');
  });

  it('never reads the recruiter session, so a signed-in recruiter leaks no bearer', async () => {
    mockFetch(reply(200, STATUS));
    await r1Api.status(LINK);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('fetches the notice with the link token in a POST body and nothing in the URL', async () => {
    const fetchMock = mockFetch(
      reply(200, {
        version: 'r1-2026-10',
        locale: 'en-IN',
        title: 'Notice',
        body_md: 'Body',
        required_consents: ['ai_interview', 'video_audio_recording', 'ai_evaluation'],
      }),
    );
    const template = await r1Api.consentTemplate(LINK);
    const { url, init, body } = lastCall(fetchMock);
    expect(init.method).toBe('POST');
    // The audience is server-owned: the body carries the token and nothing else.
    expect(body).toEqual({ token: LINK });
    expect(url.endsWith('/api/r1/consent-template')).toBe(true);
    expect(url).not.toContain(LINK);
    expect(url).not.toContain('?');
    expect(template.required_consents).toEqual([
      'ai_interview',
      'video_audio_recording',
      'ai_evaluation',
    ]);
  });

  it('submits consent with the version and purposes, and never a locale', async () => {
    const fetchMock = mockFetch(reply(201, { status: 'granted', locale: 'en-IN-x-staff' }));
    await r1Api.submitConsent(LINK, {
      template_version: 'v1',
      consents: ['ai_interview'],
      status: 'granted',
    });
    const { body } = lastCall(fetchMock);
    expect(body).toEqual({
      token: LINK,
      template_version: 'v1',
      consents: ['ai_interview'],
      status: 'granted',
    });
    expect(body).not.toHaveProperty('locale');
  });

  it('posts withdrawal and preflight with the link token only', async () => {
    const withdraw = mockFetch(reply(200, { ok: true }));
    await r1Api.withdrawConsent(LINK);
    expect(lastCall(withdraw).url.endsWith('/api/r1/consent/withdraw')).toBe(true);
    expect(lastCall(withdraw).body).toEqual({ token: LINK });

    const preflight = mockFetch(reply(200, { url: 'wss://lk.invalid', livekit_token: 't' }));
    await r1Api.preflight(LINK);
    expect(lastCall(preflight).body).toEqual({ token: LINK });
  });

  it('sends the rejoin nonce only when there is one', async () => {
    const nonce = 'n'.repeat(32);
    const fresh = mockFetch(reply(201, { attempt_token: 'tok', nonce, rejoin: false }));
    await r1Api.createAttempt(LINK, null);
    expect(lastCall(fresh).body).toEqual({ token: LINK });

    const rejoin = mockFetch(reply(200, { attempt_token: 'tok', rejoin: true }));
    await r1Api.createAttempt(LINK, nonce);
    expect(lastCall(rejoin).body).toEqual({ token: LINK, nonce });
  });

  it('keeps the nonce the page holds when the server answers a rejoin without one', async () => {
    const nonce = 'n'.repeat(32);
    mockFetch(reply(200, { attempt_token: 'tok2', attempt_id: 'a-1', rejoin: true }));
    await expect(r1Api.createAttempt(LINK, nonce)).resolves.toMatchObject({
      attempt_token: 'tok2',
      nonce,
      rejoin: true,
    });
  });

  it('takes the new nonce from a fresh attempt, and refuses a fresh attempt without one', async () => {
    const issued = 'f'.repeat(64);
    mockFetch(reply(201, { attempt_token: 'tok', nonce: issued, attempt_id: 'a-1', rejoin: false }));
    await expect(r1Api.createAttempt(LINK, null)).resolves.toMatchObject({
      nonce: issued,
      attempt_id: 'a-1',
      rejoin: false,
    });
    mockFetch(reply(201, { attempt_token: 'tok', rejoin: false }));
    await expect(r1Api.createAttempt(LINK, null)).rejects.toMatchObject({
      message: 'r1_malformed_response',
    });
  });

  it('exchanges the attempt token and nonce, and reads a 202 preparing answer', async () => {
    const fetchMock = mockFetch(reply(202, { status: 'preparing' }));
    const result = await r1Api.exchange('attempt-token', 'nonce-value');
    expect(lastCall(fetchMock).body).toEqual({
      attempt_token: 'attempt-token',
      nonce: 'nonce-value',
    });
    expect(result).toEqual({ status: 'preparing' });
  });

  it('sends "I\'m ready" as the attempt token and nonce, in the body only', async () => {
    const fetchMock = mockFetch(reply(200, { ok: true }));
    await expect(r1Api.ready('attempt-token', 'nonce-value')).resolves.toBeUndefined();
    const { url, init, body } = lastCall(fetchMock);
    expect(url.endsWith('/api/r1/ready')).toBe(true);
    expect(url).not.toContain('attempt-token');
    expect(url).not.toContain('?');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(body).toEqual({ attempt_token: 'attempt-token', nonce: 'nonce-value' });
    expect(
      Object.keys(init.headers as Record<string, string>).map((name) => name.toLowerCase()),
    ).not.toContain('authorization');
  });

  it.each([
    [409, 'not_live'],
    [429, 'http_429'],
    [404, 'r1_attempt_invalid'],
    [503, 'service_unavailable'],
  ])('rejects a %d answer to "I\'m ready" with its code', async (status, code) => {
    mockFetch(reply(status, status === 429 ? {} : { error: code }));
    const error = await r1Api.ready('attempt-token', 'nonce-value').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: code, status });
  });

  it('rejects "I\'m ready" when the network is down', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    await expect(r1Api.ready('attempt-token', 'nonce-value')).rejects.toMatchObject({
      message: 'network_unreachable',
      status: 0,
    });
  });

  it('surfaces only the machine code of an error, never server prose', async () => {
    mockFetch(reply(409, { error: 'r1_busy', message: 'internal: lease held by worker-7' }));
    const error = await r1Api.createAttempt(LINK, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('r1_busy');
    expect((error as ApiError).status).toBe(409);
  });

  it('falls back to http_<status> for an unusable error body', async () => {
    mockFetch(new Response('<html>bad gateway</html>', { status: 502 }));
    const error = await r1Api.status(LINK).catch((e: unknown) => e);
    expect((error as ApiError).message).toBe('http_502');
  });

  it('maps a network failure to status 0', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    const error = await r1Api.status(LINK).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'network_unreachable', status: 0 });
  });
});

describe('response validation (fail closed)', () => {
  it('maps PR-3 status wire fields onto the page model', () => {
    expect(parseStatus(STATUS)).toEqual({
      state: 'invited',
      attempts_left: 2,
      attempts_allowed: 2,
      starts_left: 3,
      can_start: false,
      live_attempt: false,
      consent_state: 'required',
      role_title: 'Sales Program Advisor',
      format: { duration_minutes: 20 },
      availability: 'open',
      audience: 'candidate',
    });
  });

  it('keeps the four consent states apart: declined and withdrawn are not "required"', () => {
    const stateOf = (state: string) =>
      parseStatus({ ...STATUS, consent: { state, template_version: 'v1' } }).consent_state;
    for (const state of ['granted', 'required', 'declined', 'withdrawn']) {
      expect(stateOf(state), state).toBe(state);
    }
  });

  it('reads the audience: staff only when the server says exactly staff', () => {
    expect(parseStatus({ ...STATUS, audience: 'staff' }).audience).toBe('staff');
    expect(parseStatus({ ...STATUS, audience: 'candidate' }).audience).toBe('candidate');
    // Anything else is the stricter, candidate wording.
    for (const odd of [undefined, null, '', 'Staff', 'staff ', 'admin', 1, true, {}]) {
      expect(parseStatus({ ...STATUS, audience: odd }).audience, String(odd)).toBe('candidate');
    }
  });

  it('reads the starts, attempts and live flags, and leaves anything unreadable unknown', () => {
    const read = (over: object) => parseStatus({ ...STATUS, ...over });
    expect(read({ starts_remaining: 0, can_start: false, live_attempt: true })).toMatchObject({
      starts_left: 0,
      can_start: false,
      live_attempt: true,
    });
    for (const bad of [undefined, null, 'three', -1, 1.5, 101]) {
      expect(read({ starts_remaining: bad }).starts_left, String(bad)).toBeNull();
      expect(read({ attempts_allowed: bad }).attempts_allowed, String(bad)).toBeNull();
    }
    for (const bad of [undefined, null, 'true', 1, 0]) {
      expect(read({ can_start: bad }).can_start, String(bad)).toBeNull();
      expect(read({ live_attempt: bad }).live_attempt, String(bad)).toBeNull();
    }
  });

  it.each(['paused', 'disabled'])('reads availability %s', (availability) => {
    expect(parseStatus({ ...STATUS, availability }).availability).toBe(availability);
  });

  it('defaults optional status fields', () => {
    const minimal = parseStatus({
      round_status: 'in_progress',
      availability: 'open',
      attempts_remaining: 1,
      consent: { state: 'granted', template_version: null },
    });
    expect(minimal.role_title).toBeNull();
    expect(minimal.format).toEqual({ duration_minutes: null });
    expect(minimal.consent_state).toBe('granted');
    // A server that predates these never closes a link on them.
    expect(minimal).toMatchObject({
      attempts_allowed: null,
      starts_left: null,
      can_start: null,
      live_attempt: null,
      audience: 'candidate',
    });
  });

  it.each([
    ['an unknown state', { ...STATUS, round_status: 'weird' }],
    ['an unknown availability', { ...STATUS, availability: 'maybe' }],
    ['a missing attempts count', { ...STATUS, attempts_remaining: undefined }],
    ['a negative attempts count', { ...STATUS, attempts_remaining: -1 }],
    ['a missing consent object', { ...STATUS, consent: undefined }],
    ['an unknown consent state', { ...STATUS, consent: { state: 'maybe' } }],
    ['the old page-model names', { state: 'invited', attempts_left: 2, consent_required: true }],
    ['a non-object body', 'ok'],
    ['null', null],
  ])('rejects status with %s', (_name, body) => {
    expect(() => parseStatus(body)).toThrow(
      expect.objectContaining({ message: 'r1_malformed_response' }),
    );
  });

  it('keeps only consent items for required purposes and rejects bad purpose keys', () => {
    const base = { version: 'v1', locale: 'en-IN', title: 'T', body_md: 'B' };
    const template = parseConsentTemplate({
      ...base,
      required_consents: ['ai_interview', 'recording'],
      consent_items: [
        { type: 'ai_interview', label: 'Agree to the interview' },
        { type: 'unrelated', label: 'ignored' },
        { type: 'recording' },
      ],
    });
    expect(template.consent_items).toEqual([
      { type: 'ai_interview', label: 'Agree to the interview' },
    ]);
    expect(() => parseConsentTemplate({ ...base, required_consents: ['Bad Key'] })).toThrow();
    expect(() => parseConsentTemplate({ ...base, required_consents: [] })).toThrow();
  });

  it('sanitises the lead card and drops anything unsafe', () => {
    expect(normalizeLead({ name: 'Meera', city: 'Pune' })).toEqual({
      name: 'Meera',
      city: 'Pune',
    });
    expect(normalizeLead({ name: 'Mary-Anne O’Neil', city: 'St. Louis' })).toEqual({
      name: 'Mary-Anne O’Neil',
      city: 'St. Louis',
    });
    expect(normalizeLead({ name: '<img onerror=x>', city: 'Pune' })).toBeNull();
    expect(normalizeLead({ name: 'Meera', city: 'x'.repeat(41) })).toBeNull();
    expect(normalizeLead({ name: 'Meera' })).toBeNull();
    expect(normalizeLead('Meera from Pune')).toBeNull();
  });

  it('requires the tokens that the join depends on', () => {
    expect(() => parsePreflight({ url: 'wss://x' })).toThrow();
    expect(() => parseAttempt({ nonce: 'n' })).toThrow();
    expect(() => parseExchange({ status: 'ready' })).toThrow();
    const attempt = parseAttempt({
      attempt_token: 't',
      nonce: 'n',
      lead: { name: 'A', city: 'B' },
    });
    expect(attempt.lead).toEqual({ name: 'A', city: 'B' });
  });

  it('reads PR-3 attempt and exchange answers', () => {
    expect(
      parseAttempt({
        attempt_id: 'a-1',
        attempt_number: 1,
        attempt_token: 't',
        attempt_token_expires_at: '2026-10-07T00:00:00.000Z',
        nonce: 'n',
        rejoin: false,
      }),
    ).toEqual({
      attempt_token: 't',
      nonce: 'n',
      attempt_id: 'a-1',
      rejoin: false,
      lead: null,
      expires_at: '2026-10-07T00:00:00.000Z',
    });
    expect(parseAttempt({ attempt_token: 't', rejoin: true }).nonce).toBeNull();
    expect(
      parseExchange({
        url: 'wss://x',
        livekit_token: 'k',
        expires_at: '2026-10-07T00:10:00.000Z',
        attempt_id: 'a-1',
      }),
    ).toEqual({
      status: 'ready',
      url: 'wss://x',
      livekit_token: 'k',
      expires_at: '2026-10-07T00:10:00.000Z',
      attempt_id: 'a-1',
    });
    expect(parseExchange({ status: 'preparing', retry_after_sec: 3 })).toEqual({
      status: 'preparing',
    });
  });

  it('reads when an attempt token ends, and only as a time the browser can read', () => {
    const at = (value: unknown) =>
      parseAttempt({ attempt_token: 't', attempt_token_expires_at: value }).expires_at;
    expect(at('2026-10-07T00:05:00.000Z')).toBe('2026-10-07T00:05:00.000Z');
    // Absent or unreadable means "the server did not say": the page then trusts the token briefly.
    expect(parseAttempt({ attempt_token: 't' }).expires_at).toBeNull();
    for (const bad of ['', '   ', 'soon', '2026-99-99', 12, null, {}, []]) {
      expect(at(bad), String(bad)).toBeNull();
    }
  });
});

describe('classifyR1Error', () => {
  const kind = (code: string, status: number) => classifyR1Error(new ApiError(code, status));

  it('recognises the plan codes and statuses', () => {
    expect(kind('r1_busy', 409)).toBe('busy');
    expect(kind('r1_attempt_not_live', 409)).toBe('attempt_not_live');
    expect(kind('consent_required', 409)).toBe('consent_required');
    expect(kind('consent_template_stale', 409)).toBe('consent_required');
    expect(kind('starts_exhausted', 409)).toBe('starts_exhausted');
    expect(kind('attempts_exhausted', 409)).toBe('attempts_exhausted');
    expect(kind('http_410', 410)).toBe('link_expired');
    expect(kind('round_expired', 409)).toBe('link_expired');
    expect(kind('consent_template_unavailable', 503)).toBe('unavailable');
    expect(kind('r1_link_invalid_or_expired', 404)).toBe('link_invalid');
    expect(kind('r1_attempt_invalid', 404)).toBe('link_invalid');
    expect(kind('http_429', 429)).toBe('rate_limited');
    expect(kind('r1_unavailable', 503)).toBe('unavailable');
    expect(kind('http_502', 502)).toBe('unavailable');
    expect(kind('network_unreachable', 0)).toBe('network');
    expect(kind('http_404', 404)).toBe('link_invalid');
    expect(kind('http_401', 401)).toBe('link_invalid');
    expect(kind('http_418', 418)).toBe('unknown');
  });

  it('recognises every code it names, whatever status carries it', () => {
    expect(R1_SERVER_ERROR_CODES.length).toBeGreaterThan(10);
    for (const code of R1_SERVER_ERROR_CODES) {
      for (const status of [409, 503, 500]) {
        expect(['unknown', 'link_invalid'], `${code} ${status}`).not.toContain(kind(code, status));
      }
    }
  });

  it('never reads an Object.prototype name as a code', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(kind(name, 418), name).toBe('unknown');
      expect(kind(name, 404), name).toBe('link_invalid');
    }
  });

  it('treats a malformed response as unknown, not as the link being bad', () => {
    expect(kind('r1_malformed_response', 500)).toBe('unknown');
  });

  it('treats anything that is not an ApiError as unknown', () => {
    expect(classifyR1Error(new Error('boom'))).toBe('unknown');
    expect(classifyR1Error(undefined)).toBe('unknown');
  });
});
