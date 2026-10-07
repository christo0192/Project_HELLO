import { describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import {
  R1_ATTEMPT_TOKEN,
  R1_LINK_TOKEN,
  R1_NONCE,
  R1_TEMPLATE,
  createR1State,
  r1Router,
  type R1MockState,
} from '../../../e2e/fixtures/r1-candidate-api';
import {
  classifyR1Error,
  parseAttempt,
  parseConsentTemplate,
  parseExchange,
  parsePreflight,
  parseStatus,
} from './r1-api';
import { ApiError } from '../api-client';

/**
 * The Playwright fake of the R1 candidate API is only worth having while it answers like the
 * real routes. These tests hold it to what can be checked without a browser: that the page's
 * own parsers accept every success body it sends, that the consent a status reports follows
 * what the person did (a withdrawn link reads `withdrawn`, not `required`), and that a body it
 * refuses gets the real validator's envelope (`error` is an OBJECT there, not a code).
 */

function call(state: R1MockState, path: string, body: Record<string, unknown> | null) {
  const response = r1Router(state)(
    'POST',
    new URL(`https://api.invalid/api/r1/${path}`),
    body,
    // The R1 routes read no dataset.
    undefined as never,
  );
  if (!response) throw new Error(`the fake does not answer ${path}`);
  return response;
}

const status = (state: R1MockState) => call(state, 'status', { token: R1_LINK_TOKEN });

describe('the fake R1 candidate API', () => {
  it('answers every success with a body the page parses', () => {
    const state = createR1State();
    expect(() => parseStatus(status(state).json)).not.toThrow();
    expect(() => parseConsentTemplate(call(state, 'consent-template', { token: R1_LINK_TOKEN }).json))
      .not.toThrow();
    state.consentRequired = false;
    expect(() => parsePreflight(call(state, 'preflight', { token: R1_LINK_TOKEN }).json))
      .not.toThrow();
    const created = call(state, 'attempts', { token: R1_LINK_TOKEN });
    expect(created.status).toBe(201);
    expect(parseAttempt(created.json).nonce).toBe(R1_NONCE);
    const rejoined = call(state, 'attempts', { token: R1_LINK_TOKEN, nonce: R1_NONCE });
    expect(rejoined.status).toBe(200);
    expect(parseAttempt(rejoined.json).nonce).toBeNull();
    const room = call(state, 'exchange', { attempt_token: R1_ATTEMPT_TOKEN, nonce: R1_NONCE });
    expect(room.status).toBe(200);
    expect(parseExchange(room.json)).toMatchObject({ status: 'ready' });
  });

  it('reports the consent the way the server does as the person acts', () => {
    const consentOf = (state: R1MockState) => parseStatus(status(state).json).consent_state;
    const state = createR1State();
    expect(consentOf(state)).toBe('required');

    const grant = {
      token: R1_LINK_TOKEN,
      template_version: R1_TEMPLATE.version,
      consents: R1_TEMPLATE.required_consents,
      status: 'granted',
    };
    expect(call(state, 'consent', grant).status).toBe(201);
    expect(consentOf(state)).toBe('granted');

    expect(call(state, 'consent/withdraw', { token: R1_LINK_TOKEN }).status).toBe(200);
    // Not `required`: the page would offer a new grant to a person who has just withdrawn.
    expect(consentOf(state)).toBe('withdrawn');

    expect(call(state, 'consent', grant).status).toBe(201);
    expect(consentOf(state)).toBe('granted');

    const other = createR1State();
    call(other, 'consent', { ...grant, status: 'declined', consents: [] });
    expect(consentOf(other)).toBe('declined');
  });

  it('reports the audience, defaulting to the candidate wording', () => {
    const state = createR1State();
    expect(parseStatus(status(state).json).audience).toBe('candidate');
    state.audience = 'staff';
    expect(parseStatus(status(state).json).audience).toBe('staff');
  });

  it('refuses a body the real routes refuse with the real validator envelope', () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['status', { token: R1_LINK_TOKEN, extra: 1 }],
      ['consent-template', { token: R1_LINK_TOKEN, locale: 'en-IN-x-staff' }],
      ['consent', { token: R1_LINK_TOKEN, locale: 'en-IN' }],
      ['consent/withdraw', { token: R1_LINK_TOKEN, extra: 1 }],
      ['preflight', { token: R1_LINK_TOKEN, extra: 1 }],
      ['attempts', { token: R1_LINK_TOKEN, extra: 1 }],
      ['exchange', { attempt_token: R1_ATTEMPT_TOKEN, nonce: R1_NONCE, extra: 1 }],
    ];
    for (const [path, body] of bodies) {
      const response = call(createR1State(), path, body);
      expect(response.status, path).toBe(400);
      expect(response.json, path).toEqual({
        error: {
          type: 'validation_error',
          message: expect.any(String),
          details: expect.any(Array),
        },
      });
    }
  });

  it('is read by the page as a refused link, as the real 400 is (its code is not a string)', () => {
    const response = call(createR1State(), 'status', { token: R1_LINK_TOKEN, extra: 1 });
    // r1-api's errorCode() reads only a string `error`; an object falls back to http_400.
    const code = typeof (response.json as { error: unknown }).error === 'string'
      ? ((response.json as { error: string }).error)
      : `http_${response.status}`;
    expect(code).toBe('http_400');
    expect(classifyR1Error(new ApiError(code, response.status))).toBe('link_invalid');
  });

  it('names the missing agreements, as the real 400 does', () => {
    const response = call(createR1State(), 'consent', {
      token: R1_LINK_TOKEN,
      template_version: R1_TEMPLATE.version,
      consents: [R1_TEMPLATE.required_consents[0]],
      status: 'granted',
    });
    expect(response.status).toBe(400);
    expect(response.json).toEqual({
      error: 'required_consents_missing',
      missing_consents: R1_TEMPLATE.required_consents.slice(1),
    });
  });
});
