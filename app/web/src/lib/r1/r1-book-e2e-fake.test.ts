import { describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import {
  BOOK_DAYS,
  BOOK_GRID_TOKEN,
  MANAGE_TOKEN,
  R1_BOOK_FAKE_METHODS,
  R1_BOOK_FAKE_ROUTES,
  R1_BOOK_TEMPLATE,
  bookSlotEnd,
  bookSlotStart,
  createR1BookState,
  r1BookRouter,
  type R1BookFakeRoute,
  type R1BookMockState,
} from '../../../e2e/fixtures/r1-book-api';
import { ApiError } from '../api-client';
import {
  R1_BOOK_CONTRACT,
  R1_BOOK_ROUTES,
  classifyBookFailure,
  parseBookConsentTemplate,
  parseBookSlots,
  parseBooked,
  parseCancelled,
  parseConsented,
  parseManage,
  parseMoved,
  type R1BookFailure,
} from './r1-book-api';
import { isManageToken } from './r1-book-link';

/**
 * The Playwright fake of the public booking API (e2e/fixtures/r1-book-api.ts) is only worth
 * having while it answers like the routes of contracts section 6 and the way the pages expect.
 * These tests hold it to what can be checked without a browser: that it serves exactly the seven
 * routes of the web client, that the pages' own strict parsers accept every success body it sends,
 * that every refusal it makes is read by `classifyBookFailure` as the page means it, that its
 * tokens have the shapes the pages accept, and that a body its strict schemas refuse is answered
 * `{ error: 'invalid_request' }` (a code, never the validator's envelope).
 */

type Body = Record<string, unknown> | null;

interface Answer {
  status: number;
  json?: unknown;
}

const ORIGIN = 'http://api.e2e.invalid';

function send(state: R1BookMockState, method: string, path: string, body: Body = null, query = ''): Answer {
  const answer = r1BookRouter(state)(
    method,
    new URL(`${ORIGIN}${path}${query}`),
    body,
    // The booking routes read no dataset.
    undefined as never,
  );
  if (!answer) throw new Error(`the fake does not answer ${method} ${path}`);
  return answer;
}

const route = (state: R1BookMockState, name: R1BookFakeRoute, body: Body = null): Answer =>
  send(state, R1_BOOK_FAKE_METHODS[name], R1_BOOK_FAKE_ROUTES[name], body);

/** What the page makes of a refusal: the code read the way r1-api's errorCode() reads it. */
function verdict(name: R1BookFakeRoute, answer: Answer): R1BookFailure {
  const error = (answer.json as { error?: unknown } | undefined)?.error;
  const code = typeof error === 'string' && /^[a-z0-9_]{1,64}$/.test(error) ? error : `http_${answer.status}`;
  return classifyBookFailure(name, new ApiError(code, answer.status));
}

const GRID_TOKEN_RE = /^g1\.\d{13}\.[A-Za-z0-9_-]{43}$/;
const CONSENT = {
  template_version: R1_BOOK_TEMPLATE.version,
  consents: [...R1_BOOK_TEMPLATE.required_consents],
  in_india: true,
};
const THURSDAY_TEN = bookSlotStart(1, 10, 0);
let requestCounter = 0;

/** A fresh v4 request id per call (fixed digits, so nothing random enters a test). */
function requestId(): string {
  requestCounter += 1;
  return `00000000-0000-4000-8000-${String(requestCounter).padStart(12, '0')}`;
}

function bookBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: requestId(),
    name: 'Asha Rao',
    email: 'asha.rao@example.com',
    phone: '+91 98765 43210',
    slot_start: THURSDAY_TEN,
    grid_token: BOOK_GRID_TOKEN,
    consent: CONSENT,
    website: '',
    ...overrides,
  };
}

const token = { token: MANAGE_TOKEN };
const moveBody = (slotStart: string, grid = BOOK_GRID_TOKEN) => ({
  token: MANAGE_TOKEN,
  slot_start: slotStart,
  grid_token: grid,
});

describe('the fake public booking API', () => {
  it('serves exactly the seven routes of the web client, under their methods', () => {
    expect(Object.keys(R1_BOOK_FAKE_ROUTES)).toEqual(Object.keys(R1_BOOK_ROUTES));
    for (const name of Object.keys(R1_BOOK_ROUTES) as R1BookFakeRoute[]) {
      expect(R1_BOOK_FAKE_ROUTES[name], name).toBe(R1_BOOK_CONTRACT[name].path);
      expect(R1_BOOK_FAKE_METHODS[name], name).toBe(R1_BOOK_CONTRACT[name].method);
    }
  });

  it('answers nothing else: another path, or a route under the wrong method, is unmocked', () => {
    const state = createR1BookState();
    const unmocked: Array<[string, string]> = [
      ['POST', '/api/r1/book/slots'],
      ['POST', '/api/r1/book/consent-template'],
      ['GET', '/api/r1/book'],
      ['GET', '/api/r1/book/manage'],
      ['PUT', '/api/r1/book/manage/move'],
      ['POST', '/api/r1/book/unknown'],
      ['POST', '/api/r1/booking'],
      ['POST', '/api/r1/status'],
      ['GET', '/api/candidates'],
    ];
    for (const [method, path] of unmocked) {
      expect(r1BookRouter(state)(method, new URL(`${ORIGIN}${path}`), null, undefined as never), `${method} ${path}`)
        .toBeNull();
    }
  });

  it('records every booking request with its method, path, query and body', () => {
    const state = createR1BookState();
    route(state, 'slots');
    route(state, 'manage', token);
    send(state, 'GET', R1_BOOK_FAKE_ROUTES.consentTemplate, null, '?locale=en-US');
    expect(state.requests).toEqual([
      { method: 'GET', path: '/api/r1/book/slots', query: '', body: null },
      { method: 'POST', path: '/api/r1/book/manage', query: '', body: token },
      { method: 'GET', path: '/api/r1/book/consent-template', query: '?locale=en-US', body: null },
    ]);
  });

  it('carries tokens of the shapes the pages accept', () => {
    expect(MANAGE_TOKEN).toHaveLength(43);
    expect(isManageToken(MANAGE_TOKEN)).toBe(true);
    expect(BOOK_GRID_TOKEN).toMatch(GRID_TOKEN_RE);
  });

  describe('every success body parses with the pages\' own parsers', () => {
    it('the notice', () => {
      const answer = route(createR1BookState(), 'consentTemplate');
      expect(answer.status).toBe(200);
      const template = parseBookConsentTemplate(answer.json);
      expect(template.version).toBe(R1_BOOK_TEMPLATE.version);
      expect(template.required_consents).toEqual(R1_BOOK_TEMPLATE.required_consents);
      expect(template.consent_items).toHaveLength(R1_BOOK_TEMPLATE.required_consents.length);
    });

    it('the grid: three IST days from the frozen day, 09:00 to 20:30 every 30 minutes, 45-minute slots', () => {
      const answer = route(createR1BookState(), 'slots');
      expect(answer.status).toBe(200);
      const grid = parseBookSlots(answer.json);
      expect(grid.grid_token).toBe(BOOK_GRID_TOKEN);
      expect(grid.slot_minutes).toBe(45);
      expect(grid.fully_booked).toBe(false);
      expect(grid.days.map((day) => day.date)).toEqual([...BOOK_DAYS]);
      expect(BOOK_DAYS).toEqual(['2026-09-16', '2026-09-17', '2026-09-18']);
      for (const [index, day] of grid.days.entries()) {
        expect(day.slots).toHaveLength(24);
        expect(day.slots[0]?.start_at).toBe(bookSlotStart(index, 9, 0));
        expect(day.slots[23]?.start_at).toBe(bookSlotStart(index, 20, 30));
        for (const slot of day.slots) {
          expect(Date.parse(slot.end_at) - Date.parse(slot.start_at)).toBe(45 * 60_000);
        }
      }
      // Today (Wed 12:00 IST) offers nothing within the hour; a few later times are full.
      const available = (dayIndex: number, hour: number, minute: number) =>
        grid.days[dayIndex]?.slots.find((slot) => slot.start_at === bookSlotStart(dayIndex, hour, minute))?.available;
      expect(available(0, 9, 0)).toBe(false);
      expect(available(0, 13, 0)).toBe(false);
      expect(available(0, 13, 30)).toBe(true);
      expect(available(1, 9, 0)).toBe(false);
      expect(available(1, 9, 30)).toBe(true);
      expect(available(1, 10, 0)).toBe(true);
      expect(available(1, 11, 0)).toBe(false);
      expect(available(2, 15, 30)).toBe(false);
    });

    it('a fully booked grid', () => {
      const state = createR1BookState();
      state.fullyBooked = true;
      const grid = parseBookSlots(route(state, 'slots').json);
      expect(grid.fully_booked).toBe(true);
      expect(grid.days.flatMap((day) => day.slots).some((slot) => slot.available)).toBe(false);
    });

    it('a booking, and its replay by the same request_id', () => {
      const state = createR1BookState();
      const body = bookBody();
      const booked = route(state, 'book', body);
      expect(booked.status).toBe(201);
      expect(parseBooked(booked.json)).toEqual({ start_at: THURSDAY_TEN, end_at: bookSlotEnd(THURSDAY_TEN) });
      // The replay comes before the slot check: it answers even once that time is gone.
      state.taken.push(THURSDAY_TEN);
      const replay = route(state, 'book', body);
      expect(replay.status).toBe(201);
      expect(parseBooked(replay.json)).toEqual({ start_at: THURSDAY_TEN, end_at: bookSlotEnd(THURSDAY_TEN) });
    });

    it('the manage view, a move, a cancel, a repeated cancel and a re-consent', () => {
      const view = parseManage(route(createR1BookState(), 'manage', token).json);
      expect(view).toEqual({
        state: 'booked',
        start_at: bookSlotStart(1, 12, 0),
        end_at: bookSlotEnd(bookSlotStart(1, 12, 0)),
        can_move: true,
        can_cancel: true,
        moves_left: 2,
        consent_current: true,
      });

      const moving = createR1BookState();
      const moved = route(moving, 'move', moveBody(bookSlotStart(1, 14, 0)));
      expect(moved.status).toBe(200);
      expect(parseMoved(moved.json)).toEqual({
        start_at: bookSlotStart(1, 14, 0),
        end_at: bookSlotEnd(bookSlotStart(1, 14, 0)),
      });

      const cancelling = createR1BookState();
      const cancelled = route(cancelling, 'cancel', { token: MANAGE_TOKEN, withdraw_consent: true });
      expect(cancelled.status).toBe(200);
      expect(parseCancelled(cancelled.json)).toBe('cancelled');
      expect(cancelling.withdrawn).toBe(true);
      const again = route(cancelling, 'cancel', { token: MANAGE_TOKEN, withdraw_consent: false });
      expect(again.status).toBe(200);
      expect(parseCancelled(again.json)).toBe('already_cancelled');

      const reconsenting = createR1BookState();
      if (reconsenting.manage) reconsenting.manage.consentCurrent = false;
      const consented = route(reconsenting, 'consent', { token: MANAGE_TOKEN, consent: CONSENT });
      expect(consented.status).toBe(200);
      expect(parseConsented(consented.json)).toBe('consented');
      expect(parseManage(route(reconsenting, 'manage', token).json).consent_current).toBe(true);
    });
  });

  describe('every refusal reads as the page means it', () => {
    const expectRefusal = (name: R1BookFakeRoute, answer: Answer, status: number, word: string, failure: R1BookFailure) => {
      expect(answer.status, `${name} ${word}`).toBe(status);
      expect((answer.json as { error?: unknown }).error, name).toBe(word);
      expect(verdict(name, answer), `${name} ${word}`).toBe(failure);
    };

    it('the switch off: 503 booking_disabled on every route, before the body is read', () => {
      for (const name of Object.keys(R1_BOOK_FAKE_ROUTES) as R1BookFakeRoute[]) {
        for (const body of [R1_BOOK_FAKE_METHODS[name] === 'GET' ? null : token, { extra: 1 }]) {
          const state = createR1BookState();
          state.disabled = true;
          const answer = route(state, name, body);
          expectRefusal(name, answer, 503, 'booking_disabled', 'disabled');
          expect(answer.json).toEqual({ error: 'booking_disabled' });
        }
      }
    });

    it('a one-shot forced failure on each route, consumed on use', () => {
      const valid: Record<R1BookFakeRoute, () => Body> = {
        consentTemplate: () => null,
        slots: () => null,
        book: () => bookBody(),
        manage: () => token,
        move: () => moveBody(bookSlotStart(1, 14, 0)),
        cancel: () => ({ token: MANAGE_TOKEN, withdraw_consent: false }),
        consent: () => ({ token: MANAGE_TOKEN, consent: CONSENT }),
      };
      for (const name of Object.keys(valid) as R1BookFakeRoute[]) {
        const state = createR1BookState();
        state.failures[name] = { status: 503, error: 'temporarily_unavailable' };
        expectRefusal(name, route(state, name, valid[name]()), 503, 'temporarily_unavailable', 'unavailable');
        expect(state.failures[name]).toBeUndefined();
        expect(route(state, name, valid[name]()).status, name).toBeLessThan(300);
      }
      // A failure the server may have acted on reads as uncertain for a POST, unavailable for a GET.
      const posting = createR1BookState();
      posting.failures.book = { status: 502, error: 'bad_gateway' };
      expect(verdict('book', route(posting, 'book', bookBody()))).toBe('uncertain');
      const reading = createR1BookState();
      reading.failures.slots = { status: 502, error: 'bad_gateway' };
      expect(verdict('slots', route(reading, 'slots'))).toBe('unavailable');
    });

    it('book: the honeypot, a stale grid, a taken time, a changed notice, no application, already booked', () => {
      expectRefusal('book', route(createR1BookState(), 'book', bookBody({ website: 'filled-in-by-a-bot' })), 404, 'not_found', 'not_found');
      const otherGrid = `g1.${'1'.repeat(13)}.${'h'.repeat(43)}`;
      expectRefusal('book', route(createR1BookState(), 'book', bookBody({ grid_token: otherGrid })), 409, 'slot_unavailable', 'slot_unavailable');
      // Not a time of the grid, and a full one.
      expectRefusal('book', route(createR1BookState(), 'book', bookBody({ slot_start: '2026-09-17T04:35:00.000Z' })), 409, 'slot_unavailable', 'slot_unavailable');
      expectRefusal('book', route(createR1BookState(), 'book', bookBody({ slot_start: bookSlotStart(1, 9, 0) })), 409, 'slot_unavailable', 'slot_unavailable');

      const stale = createR1BookState();
      stale.templateVersion = 'e2e-book-v2';
      const changed = route(stale, 'book', bookBody());
      expectRefusal('book', changed, 409, 'consent_stale', 'consent_stale');
      expect(changed.json).toEqual({ error: 'consent_stale', template_version: 'e2e-book-v2' });

      const missing = createR1BookState();
      missing.bookOutcome = 'not_found';
      expectRefusal('book', route(missing, 'book', bookBody()), 404, 'not_found', 'not_found');

      const held = createR1BookState();
      held.bookOutcome = 'already_booked';
      expectRefusal('book', route(held, 'book', bookBody()), 409, 'already_booked', 'already_booked');
      expect(held.bookings).toEqual({});

      // A second booking by the same person, under a new request id, is refused.
      const twice = createR1BookState();
      expect(route(twice, 'book', bookBody()).status).toBe(201);
      expectRefusal('book', route(twice, 'book', bookBody({ slot_start: bookSlotStart(1, 10, 30), email: ' Asha.Rao@Example.com ' })), 409, 'already_booked', 'already_booked');
    });

    it('book: a time taken just before is refused once, then that time is full in the next grid', () => {
      const state = createR1BookState();
      state.bookOutcome = 'slot_unavailable_once';
      expectRefusal('book', route(state, 'book', bookBody()), 409, 'slot_unavailable', 'slot_unavailable');
      expect(state.bookOutcome).toBe('booked');
      const grid = parseBookSlots(route(state, 'slots').json);
      const thursday = grid.days[1]?.slots ?? [];
      expect(thursday.find((slot) => slot.start_at === THURSDAY_TEN)?.available).toBe(false);
      expect(route(state, 'book', bookBody({ slot_start: bookSlotStart(1, 10, 30) })).status).toBe(201);
    });

    it('book: every purpose and the India tick are required (the server\'s 400)', () => {
      const partial = { ...CONSENT, consents: CONSENT.consents.slice(1) };
      expectRefusal('book', route(createR1BookState(), 'book', bookBody({ consent: partial })), 400, 'invalid_request', 'invalid');
      const abroad = { ...CONSENT, in_india: false };
      expectRefusal('book', route(createR1BookState(), 'book', bookBody({ consent: abroad })), 400, 'invalid_request', 'invalid');
    });

    it('manage, move, cancel and consent: an unknown token is not found', () => {
      const other = 'n'.repeat(43);
      expectRefusal('manage', route(createR1BookState(), 'manage', { token: other }), 404, 'not_found', 'not_found');
      expectRefusal('move', route(createR1BookState(), 'move', { ...moveBody(bookSlotStart(1, 14, 0)), token: other }), 404, 'not_found', 'not_found');
      expectRefusal('cancel', route(createR1BookState(), 'cancel', { token: other, withdraw_consent: false }), 404, 'not_found', 'not_found');
      expectRefusal('consent', route(createR1BookState(), 'consent', { token: other, consent: CONSENT }), 404, 'not_found', 'not_found');
      const none = createR1BookState();
      none.manage = null;
      expectRefusal('manage', route(none, 'manage', token), 404, 'not_found', 'not_found');
    });

    it('a move spends the link, and a cancel ends the booking', () => {
      const moved = createR1BookState();
      expect(route(moved, 'move', moveBody(bookSlotStart(1, 14, 0))).status).toBe(200);
      expect(moved.manageToken).toBe('rotated');
      expect(moved.manage?.movesLeft).toBe(1);
      for (const name of ['manage', 'move', 'cancel', 'consent'] as const) {
        const body = {
          manage: token,
          move: moveBody(bookSlotStart(1, 15, 0)),
          cancel: { token: MANAGE_TOKEN, withdraw_consent: false },
          consent: { token: MANAGE_TOKEN, consent: CONSENT },
        }[name];
        expectRefusal(name, route(moved, name, body), 404, 'not_found', 'not_found');
      }

      const cancelled = createR1BookState();
      expect(route(cancelled, 'cancel', { token: MANAGE_TOKEN, withdraw_consent: false }).status).toBe(200);
      expectRefusal('manage', route(cancelled, 'manage', token), 404, 'not_found', 'not_found');
      expectRefusal('move', route(cancelled, 'move', moveBody(bookSlotStart(1, 14, 0))), 404, 'not_found', 'not_found');
    });

    it('move: the current time, a taken time or a stale grid is slot_unavailable; a spent allowance is not allowed', () => {
      expectRefusal('move', route(createR1BookState(), 'move', moveBody(bookSlotStart(1, 12, 0))), 409, 'slot_unavailable', 'slot_unavailable');
      expectRefusal('move', route(createR1BookState(), 'move', moveBody(bookSlotStart(1, 11, 0))), 409, 'slot_unavailable', 'slot_unavailable');
      expectRefusal('move', route(createR1BookState(), 'move', moveBody(bookSlotStart(1, 14, 0), `g1.${'1'.repeat(13)}.${'h'.repeat(43)}`)), 409, 'slot_unavailable', 'slot_unavailable');
      for (const change of [{ canMove: false }, { movesLeft: 0 }, { state: 'in_progress' as const }]) {
        const state = createR1BookState();
        if (state.manage) Object.assign(state.manage, change);
        expectRefusal('move', route(state, 'move', moveBody(bookSlotStart(1, 14, 0))), 409, 'move_not_allowed', 'not_allowed');
      }
    });

    it('cancel and consent: too late is cancel_not_allowed; a changed notice is consent_stale', () => {
      for (const change of [{ canCancel: false }, { state: 'in_progress' as const }]) {
        const state = createR1BookState();
        if (state.manage) Object.assign(state.manage, change);
        expectRefusal('cancel', route(state, 'cancel', { token: MANAGE_TOKEN, withdraw_consent: true }), 409, 'cancel_not_allowed', 'not_allowed');
      }
      const dispatched = createR1BookState();
      if (dispatched.manage) dispatched.manage.state = 'in_progress';
      expectRefusal('consent', route(dispatched, 'consent', { token: MANAGE_TOKEN, consent: CONSENT }), 409, 'cancel_not_allowed', 'not_allowed');

      const stale = createR1BookState();
      stale.templateVersion = 'e2e-book-v2';
      const changed = route(stale, 'consent', { token: MANAGE_TOKEN, consent: CONSENT });
      expectRefusal('consent', changed, 409, 'consent_stale', 'consent_stale');
      expect(changed.json).toEqual({ error: 'consent_stale', template_version: 'e2e-book-v2' });
      expectRefusal('consent', route(createR1BookState(), 'consent', { token: MANAGE_TOKEN, consent: { ...CONSENT, in_india: false } }), 400, 'invalid_request', 'invalid');
    });
  });

  it('answers a strict-body violation with { error: "invalid_request" }, never the validator envelope', () => {
    const withoutId = Object.fromEntries(Object.entries(bookBody()).filter(([key]) => key !== 'request_id'));
    const violations: Array<[R1BookFakeRoute, Body, string?]> = [
      ['consentTemplate', { locale: 'en-IN' }],
      ['consentTemplate', null, '?locale=en-US'],
      ['slots', null, '?day=2026-09-17'],
      ['book', { ...bookBody(), extra: 1 }],
      ['book', withoutId],
      ['book', bookBody({ request_id: 'not-a-uuid' })],
      ['book', bookBody({ name: '' })],
      ['book', bookBody({ phone: '9'.repeat(33) })],
      ['book', bookBody({ slot_start: '2026-09-17T10:00:00' })],
      ['book', bookBody({ consent: { ...CONSENT, extra: 1 } })],
      ['book', bookBody({ consent: { template_version: CONSENT.template_version, consents: CONSENT.consents } })],
      ['book', bookBody({ consent: { ...CONSENT, consents: [] } })],
      ['book', bookBody({ website: 'x'.repeat(201) })],
      ['book', null],
      ['manage', { token: MANAGE_TOKEN, extra: 1 }],
      ['manage', {}],
      ['move', { token: MANAGE_TOKEN, slot_start: bookSlotStart(1, 14, 0) }],
      ['cancel', { token: MANAGE_TOKEN, withdraw_consent: 'yes' }],
      ['cancel', token],
      ['consent', { token: MANAGE_TOKEN, consent: { ...CONSENT, in_india: 'yes' } }],
      ['consent', { token: MANAGE_TOKEN }],
    ];
    for (const [name, body, query = ''] of violations) {
      const state = createR1BookState();
      const answer = send(state, R1_BOOK_FAKE_METHODS[name], R1_BOOK_FAKE_ROUTES[name], body, query);
      const label = `${name} ${JSON.stringify(body)}${query}`;
      expect(answer.status, label).toBe(400);
      expect(answer.json, label).toEqual({ error: 'invalid_request' });
      // A GET takes no input, so the page reads a 400 there as unavailable (its routes declare
      // only the two 503 words); a POST's 400 is the "check your details" case.
      const expected: R1BookFailure = R1_BOOK_FAKE_METHODS[name] === 'GET' ? 'unavailable' : 'invalid';
      expect(verdict(name, answer), label).toBe(expected);
      // A refused body changes nothing.
      expect(state.bookings, label).toEqual({});
      expect(state.manageToken, label).toBe('live');
    }
  });
});
