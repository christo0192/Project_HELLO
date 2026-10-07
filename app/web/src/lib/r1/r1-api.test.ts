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

const STATUS = {
  state: 'invited',
  attempts_left: 2,
  consent_required: true,
  role_title: 'Sales Program Advisor',
  format: { duration_minutes: 20, summary: 'A role-play interview' },
  budget_paused: false,
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
    expect(body).toEqual({ link_token: LINK });
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
        required_consents: ['ai_interview', 'recording', 'ai_evaluation'],
      }),
    );
    const template = await r1Api.consentTemplate(LINK, 'en-IN');
    const { url, init, body } = lastCall(fetchMock);
    expect(init.method).toBe('POST');
    expect(body).toEqual({ link_token: LINK, locale: 'en-IN' });
    expect(url.endsWith('/api/r1/consent-template')).toBe(true);
    expect(url).not.toContain(LINK);
    expect(url).not.toContain('?');
    expect(template.required_consents).toEqual(['ai_interview', 'recording', 'ai_evaluation']);
  });

  it('submits consent with the version, locale and purposes', async () => {
    const fetchMock = mockFetch(reply(200, { ok: true }));
    await r1Api.submitConsent(LINK, {
      template_version: 'v1',
      locale: 'en-IN',
      consents: ['ai_interview'],
      status: 'granted',
    });
    expect(lastCall(fetchMock).body).toEqual({
      link_token: LINK,
      template_version: 'v1',
      locale: 'en-IN',
      consents: ['ai_interview'],
      status: 'granted',
    });
  });

  it('posts withdrawal and preflight with the link token only', async () => {
    const withdraw = mockFetch(reply(200, { ok: true }));
    await r1Api.withdrawConsent(LINK);
    expect(lastCall(withdraw).url.endsWith('/api/r1/consent/withdraw')).toBe(true);
    expect(lastCall(withdraw).body).toEqual({ link_token: LINK });

    const preflight = mockFetch(reply(200, { url: 'wss://lk.invalid', livekit_token: 't' }));
    await r1Api.preflight(LINK);
    expect(lastCall(preflight).body).toEqual({ link_token: LINK });
  });

  it('sends the rejoin nonce only when there is one', async () => {
    const nonce = 'n'.repeat(32);
    const fresh = mockFetch(reply(200, { attempt_token: 'tok', nonce }));
    await r1Api.createAttempt(LINK, null);
    expect(lastCall(fresh).body).toEqual({ link_token: LINK });

    const rejoin = mockFetch(reply(200, { attempt_token: 'tok', nonce }));
    await r1Api.createAttempt(LINK, nonce);
    expect(lastCall(rejoin).body).toEqual({ link_token: LINK, nonce });
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
  it('normalises a full status', () => {
    expect(parseStatus(STATUS)).toEqual({
      state: 'invited',
      attempts_left: 2,
      consent_required: true,
      role_title: 'Sales Program Advisor',
      format: { duration_minutes: 20, summary: 'A role-play interview' },
      budget_paused: false,
    });
  });

  it('defaults optional status fields', () => {
    const minimal = parseStatus({
      state: 'in_progress',
      attempts_left: 1,
      consent_required: false,
    });
    expect(minimal.role_title).toBeNull();
    expect(minimal.format).toEqual({ duration_minutes: null, summary: null });
    expect(minimal.budget_paused).toBe(false);
  });

  it.each([
    ['an unknown state', { ...STATUS, state: 'weird' }],
    ['a missing attempts count', { ...STATUS, attempts_left: undefined }],
    ['a negative attempts count', { ...STATUS, attempts_left: -1 }],
    ['a non-boolean consent flag', { ...STATUS, consent_required: 'yes' }],
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
    expect(() => parseAttempt({ attempt_token: 't' })).toThrow();
    expect(() => parseExchange({ status: 'ready' })).toThrow();
    const attempt = parseAttempt({
      attempt_token: 't',
      nonce: 'n',
      lead: { name: 'A', city: 'B' },
    });
    expect(attempt.lead).toEqual({ name: 'A', city: 'B' });
  });
});

describe('classifyR1Error', () => {
  const kind = (code: string, status: number) => classifyR1Error(new ApiError(code, status));

  it('recognises the plan codes and statuses', () => {
    expect(kind('r1_busy', 409)).toBe('busy');
    expect(kind('consent_required', 409)).toBe('consent_required');
    expect(kind('consent_withdrawn', 409)).toBe('consent_required');
    expect(kind('http_410', 410)).toBe('link_expired');
    expect(kind('http_429', 429)).toBe('rate_limited');
    expect(kind('r1_unavailable', 503)).toBe('unavailable');
    expect(kind('http_502', 502)).toBe('unavailable');
    expect(kind('network_unreachable', 0)).toBe('network');
    expect(kind('http_404', 404)).toBe('link_invalid');
    expect(kind('http_401', 401)).toBe('link_invalid');
    expect(kind('http_418', 418)).toBe('unknown');
  });

  it('treats a malformed response as unknown, not as the link being bad', () => {
    expect(kind('r1_malformed_response', 500)).toBe('unknown');
  });

  it('treats anything that is not an ApiError as unknown', () => {
    expect(classifyR1Error(new Error('boom'))).toBe('unknown');
    expect(classifyR1Error(undefined)).toBe('unknown');
  });
});
