import { describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import {
  R1_ATTEMPT_TOKEN,
  R1_LINK_TOKEN,
  R1_MEET_RESUME_TOKEN,
  R1_MEET_TICKET,
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
  parseMeetExchange,
  parsePreflight,
  parseStatus,
} from './r1-api';
import { isMeetTicket } from './r1-link';
import { classifyMeetExchangeError } from './r1-meet';
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

  it('sends no channel for a browser round, as today\'s server does', () => {
    const state = createR1State();
    expect(state.meetRound).toBeNull();
    expect(Object.keys(status(state).json as object)).not.toContain('channel');
    expect(parseStatus(status(state).json).channel).toBe('browser');
  });

  it('answers a Google Meet round either way the contract allows, and the page reads both', () => {
    const attempt = (state: R1MockState) => call(state, 'attempts', { token: R1_LINK_TOKEN });
    const refusalKind = (response: { status: number; json?: unknown }) =>
      classifyR1Error(
        new ApiError((response.json as { error: string }).error, response.status),
      );

    const context = createR1State();
    context.meetRound = 'context';
    expect(status(context).status).toBe(200);
    expect(parseStatus(status(context).json).channel).toBe('meet');
    expect(attempt(context).status).toBe(409);
    expect(refusalKind(attempt(context))).toBe('meet_round');

    const refuse = createR1State();
    refuse.meetRound = 'refuse';
    for (const response of [status(refuse), attempt(refuse)]) {
      expect(response.status).toBe(409);
      expect(response.json).toEqual({ error: 'round_channel_meet' });
      expect(refusalKind(response)).toBe('meet_round');
    }
    // Nothing was admitted: a Meet round never holds a browser session.
    expect(refuse.liveSession).toBe(false);
    expect(context.liveSession).toBe(false);
  });

  describe('the Meet bridge exchange', () => {
    const meet = (state: R1MockState, body: Record<string, unknown> | null) =>
      call(state, 'meet/exchange', body);
    /** What the bridge makes of a refusal, read the way r1-api's errorCode() reads the body. */
    const verdictOf = (response: { status: number; json?: unknown }) => {
      const error = (response.json as { error?: unknown } | undefined)?.error;
      const code = typeof error === 'string' ? error : `http_${response.status}`;
      return classifyMeetExchangeError(new ApiError(code, response.status));
    };
    const TICKET_ONLY = { ticket: R1_MEET_TICKET };
    const RESUMED = { ticket: R1_MEET_TICKET, resume_token: R1_MEET_RESUME_TOKEN };

    it('carries a ticket the bridge page accepts from its fragment', () => {
      expect(isMeetTicket(R1_MEET_TICKET)).toBe(true);
    });

    it('answers a 202 the page parses (with the resume token), then the room for the continuation', () => {
      const state = createR1State();
      state.meetPreparing = 1;
      const preparing = meet(state, TICKET_ONLY);
      expect(preparing.status).toBe(202);
      expect(parseMeetExchange(preparing.json)).toEqual({
        status: 'preparing',
        resume_token: R1_MEET_RESUME_TOKEN,
        retry_after_sec: 3,
      });
      expect(state.meetClaimed).toBe(true);

      const ready = meet(state, RESUMED);
      expect(ready.status).toBe(200);
      expect(parseMeetExchange(ready.json)).toEqual({
        status: 'ready',
        url: 'ws://livekit.e2e.invalid',
        livekit_token: 'e2e-meet-room-token',
        expires_at: '2026-10-07T00:10:00.000Z',
      });
      // Nothing about the candidate: the room and the identity are inside the token.
      expect(Object.keys(ready.json as object).sort()).toEqual(['expires_at', 'livekit_token', 'url']);
    });

    it('answers a ready worker with the room on the first call', () => {
      const state = createR1State();
      const ready = meet(state, TICKET_ONLY);
      expect(ready.status).toBe(200);
      expect(parseMeetExchange(ready.json)).toMatchObject({ status: 'ready', livekit_token: 'e2e-meet-room-token' });
    });

    it('answers the switch being off before anything else, and the page idles on it', () => {
      for (const body of [TICKET_ONLY, RESUMED, { ticket: 'someone-elses-ticket' }, { extra: 1 }, null]) {
        const state = createR1State();
        state.meetDisabled = true;
        const response = meet(state, body);
        expect(response.status, JSON.stringify(body)).toBe(503);
        expect(response.json).toEqual({ error: 'meet_disabled' });
        expect(verdictOf(response)).toEqual({ kind: 'disabled' });
        expect(state.meetClaimed).toBe(false);
      }
    });

    it('refuses a replayed ticket as already claimed, which the page reads as terminal', () => {
      const state = createR1State();
      expect(meet(state, TICKET_ONLY).status).toBe(200);
      const replay = meet(state, TICKET_ONLY);
      expect(replay.status).toBe(409);
      expect(replay.json).toEqual({ error: 'ticket_already_claimed' });
      expect(verdictOf(replay)).toEqual({ kind: 'failed', reason: 'claimed' });
    });

    it('refuses an unknown ticket and a continuation it never handed out as unknown', () => {
      const refusals = [
        meet(createR1State(), { ticket: 'someone-elses-ticket-0123456789abcdef' }),
        // A resume token before any claim, and a wrong one after the claim.
        meet(createR1State(), RESUMED),
        (() => {
          const state = createR1State();
          state.meetPreparing = 1;
          meet(state, TICKET_ONLY);
          return meet(state, { ticket: R1_MEET_TICKET, resume_token: 'not-the-resume-token' });
        })(),
      ];
      for (const response of refusals) {
        expect(response.status).toBe(404);
        expect(response.json).toEqual({ error: 'ticket_unknown' });
        expect(verdictOf(response)).toEqual({ kind: 'failed', reason: 'invalid' });
      }
    });

    it('answers a forced refusal once, before the claim, then carries on', () => {
      const state = createR1State();
      state.failures.meetExchange = { status: 409, error: 'ticket_already_claimed' };
      const forced = meet(state, TICKET_ONLY);
      expect(forced.status).toBe(409);
      expect(verdictOf(forced)).toEqual({ kind: 'failed', reason: 'claimed' });
      expect(state.meetClaimed).toBe(false);
      expect(state.failures.meetExchange).toBeUndefined();
      expect(meet(state, TICKET_ONLY).status).toBe(200);
    });

    it('reads its strict-body refusal (the validator envelope) as an invalid request', () => {
      const response = meet(createR1State(), { ticket: R1_MEET_TICKET, extra: 1 });
      expect(response.status).toBe(400);
      expect(verdictOf(response)).toEqual({ kind: 'failed', reason: 'invalid' });
    });
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
      ['meet/exchange', { ticket: R1_MEET_TICKET, extra: 1 }],
      ['meet/exchange', { ticket: R1_MEET_TICKET, token: R1_LINK_TOKEN }],
      ['meet/exchange', { resume_token: R1_MEET_RESUME_TOKEN }],
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
