import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('../supabase', () => ({ supabase: { auth: { getSession } } }));

import { ApiError } from '../api-client';
import { addIstDays, istWallClockUtcIso } from '../ist-datetime';
import { R1ApiError } from './r1-api';
import {
  classifyBookFailure,
  parseBookConsentTemplate,
  parseBooked,
  parseBookSlots,
  parseCancelled,
  parseConsented,
  parseManage,
  parseMoved,
  R1_BOOK_CONTRACT,
  R1_BOOK_ERROR_WORDS,
  R1_BOOK_ROUTES,
  r1BookApi,
  type R1BookFailure,
  type R1BookRouteName,
  type R1BookSubmission,
} from './r1-book-api';

/**
 * The public booking client (M035 S07, decisions D-S07-M1..M4 and M8): strict parsers that fail
 * closed and copy only declared fields, the per-route error classification, and the request
 * hygiene of the one transport. Tokens are built at run time (gitleaks).
 */

const DAY_1 = '2026-09-16';
const DAY_2 = '2026-09-17';
const ISSUED_AT = Date.UTC(2026, 8, 16, 6, 30);
const GRID_TOKEN = `g1.${ISSUED_AT}.${'g'.repeat(43)}`;
const MANAGE_TOKEN = `${'m'.repeat(20)}-_${'n'.repeat(21)}`;
const NAMES = Object.keys(R1_BOOK_ROUTES) as R1BookRouteName[];
const GETS: R1BookRouteName[] = ['consentTemplate', 'slots'];
const POSTS: R1BookRouteName[] = ['book', 'manage', 'move', 'cancel', 'consent'];
const LEAKY_FIELDS = ['meet_url', 'email', 'name', 'seats', 'remaining', 'reason', 'candidate_id'];

const at = (date: string, hour: number, minute: number): string =>
  istWallClockUtcIso(date, hour, minute);

const plusMinutes = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

function slot(date: string, hour: number, minute: number, available = true) {
  const start = at(date, hour, minute);
  return { start_at: start, end_at: plusMinutes(start, 45), available };
}

const TEMPLATE = {
  version: 'r1-public-2026-11',
  locale: 'en-IN',
  title: 'Interview notice',
  body_md: 'Dex is an AI interviewer.\n\nThe interview is recorded.',
  required_consents: ['ai_interview', 'recording'],
  consent_items: [
    { type: 'ai_interview', label: 'I agree to an AI interview' },
    { type: 'recording', label: 'I agree to the recording' },
  ],
};

function grid() {
  return {
    timezone: 'Asia/Kolkata',
    slot_minutes: 45,
    generated_at: '2026-09-16T06:30:00Z',
    grid_token: GRID_TOKEN,
    fully_booked: false,
    days: [
      { date: DAY_1, slots: [slot(DAY_1, 9, 0), slot(DAY_1, 9, 30, false)] },
      { date: DAY_2, slots: [slot(DAY_2, 20, 30)] },
    ],
  };
}

const BOOKED_START = at(DAY_1, 9, 0);
const BOOKED_END = plusMinutes(BOOKED_START, 45);

const BOOKED = { status: 'booked', start_at: BOOKED_START, end_at: BOOKED_END };
const MOVED = { status: 'moved', start_at: BOOKED_START, end_at: BOOKED_END };
const MANAGE = {
  state: 'booked',
  start_at: BOOKED_START,
  end_at: BOOKED_END,
  can_move: true,
  can_cancel: true,
  moves_left: 2,
  consent_current: true,
};

/** Every key anywhere inside a value, for the "never copied" checks. */
function deepKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => [
      key,
      ...deepKeys(inner),
    ]);
  }
  return [];
}

function withLeaks<T extends Record<string, unknown>>(body: T): T {
  const leaks: Record<string, unknown> = {
    meet_url: 'meet.example/abc-defg-hij',
    email: 'someone@example.com',
    name: 'Some One',
    seats: 3,
    remaining: 2,
    reason: 'slot_full',
    candidate_id: 'cand-1',
  };
  return { ...body, ...leaks };
}

function expectMalformed(parse: () => unknown) {
  let thrown: unknown = null;
  try {
    parse();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  expect((thrown as ApiError).message).toBe('r1_malformed_response');
  expect((thrown as ApiError).status).toBe(500);
}

function without<T extends Record<string, unknown>>(body: T, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body };
  delete copy[key];
  return copy;
}

// ── Route table and contract ──────────────────────────────────────────────────────────────────

describe('the booking route table', () => {
  it('declares exactly the seven routes of contracts section 6', () => {
    expect(R1_BOOK_ROUTES).toEqual({
      consentTemplate: '/api/r1/book/consent-template',
      slots: '/api/r1/book/slots',
      book: '/api/r1/book',
      manage: '/api/r1/book/manage',
      move: '/api/r1/book/manage/move',
      cancel: '/api/r1/book/manage/cancel',
      consent: '/api/r1/book/manage/consent',
    });
    expect(Object.isFrozen(R1_BOOK_ROUTES)).toBe(true);
  });

  it('has one frozen contract per route, on its own path, with the declared methods', () => {
    expect(Object.keys(R1_BOOK_CONTRACT)).toEqual(Object.keys(R1_BOOK_ROUTES));
    for (const name of NAMES) {
      const contract = R1_BOOK_CONTRACT[name];
      expect(contract.path).toBe(R1_BOOK_ROUTES[name]);
      expect(contract.path.startsWith('/api/r1/book')).toBe(true);
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.errors)).toBe(true);
      expect(contract.method).toBe(GETS.includes(name) ? 'GET' : 'POST');
      if (contract.method === 'GET') expect(contract.request).toEqual([]);
    }
  });

  it('declares the request and response fields of each route', () => {
    expect(R1_BOOK_CONTRACT.book.request).toEqual([
      'request_id',
      'name',
      'email',
      'phone',
      'slot_start',
      'grid_token',
      'consent',
      'website',
    ]);
    expect(R1_BOOK_CONTRACT.book.consentKeys).toEqual(['template_version', 'consents', 'in_india']);
    expect(R1_BOOK_CONTRACT.consent.consentKeys).toEqual([
      'template_version',
      'consents',
      'in_india',
    ]);
    expect(R1_BOOK_CONTRACT.manage.request).toEqual(['token']);
    expect(R1_BOOK_CONTRACT.move.request).toEqual(['token', 'slot_start', 'grid_token']);
    expect(R1_BOOK_CONTRACT.cancel.request).toEqual(['token', 'withdraw_consent']);
    expect(R1_BOOK_CONTRACT.consent.request).toEqual(['token', 'consent']);
    expect(R1_BOOK_CONTRACT.consentTemplate.responseOptional).toEqual(['consent_items']);
    expect(R1_BOOK_CONTRACT.slots.response).toEqual([
      'timezone',
      'slot_minutes',
      'generated_at',
      'grid_token',
      'fully_booked',
      'days',
    ]);
    expect(R1_BOOK_CONTRACT.manage.response).toEqual([
      'state',
      'start_at',
      'end_at',
      'can_move',
      'can_cancel',
      'moves_left',
      'consent_current',
    ]);
  });

  it('names the nine error words, sorted and unique', () => {
    expect(R1_BOOK_ERROR_WORDS).toEqual([
      'already_booked',
      'booking_disabled',
      'cancel_not_allowed',
      'consent_stale',
      'invalid_request',
      'move_not_allowed',
      'not_found',
      'slot_unavailable',
      'temporarily_unavailable',
    ]);
  });
});

// ── Parsers ───────────────────────────────────────────────────────────────────────────────────

describe('parseBookConsentTemplate', () => {
  it('parses the en-IN notice and copies only the declared fields', () => {
    const parsed = parseBookConsentTemplate({
      ...withLeaks(TEMPLATE),
      consent_items: TEMPLATE.consent_items.map((item) => ({ ...item, seats: 1 })),
    });
    expect(parsed).toEqual(TEMPLATE);
    for (const leak of LEAKY_FIELDS) expect(deepKeys(parsed)).not.toContain(leak);
  });

  it('accepts a notice without the optional purpose labels', () => {
    expect(parseBookConsentTemplate(without(TEMPLATE, 'consent_items')).consent_items).toEqual([]);
  });

  it.each(['version', 'locale', 'title', 'body_md', 'required_consents'])(
    'fails closed without %s',
    (key) => {
      expectMalformed(() => parseBookConsentTemplate(without(TEMPLATE, key)));
    },
  );

  it.each([['en-US'], ['en'], ['hi-IN'], [''], [7]])('fails closed on locale %j', (locale) => {
    expectMalformed(() => parseBookConsentTemplate({ ...TEMPLATE, locale }));
  });

  it('fails closed on an empty or badly typed purpose list', () => {
    expectMalformed(() => parseBookConsentTemplate({ ...TEMPLATE, required_consents: [] }));
    expectMalformed(() => parseBookConsentTemplate({ ...TEMPLATE, required_consents: ['Bad Word'] }));
    expectMalformed(() => parseBookConsentTemplate({ ...TEMPLATE, required_consents: 'recording' }));
  });

  it.each([[null], [[]], ['notice'], [42]])('fails closed on a non-object %j', (body) => {
    expectMalformed(() => parseBookConsentTemplate(body));
  });
});

describe('parseBookSlots', () => {
  it('parses a full grid into exactly the declared fields', () => {
    const parsed = parseBookSlots(grid());
    expect(parsed).toEqual({
      slot_minutes: 45,
      grid_token: GRID_TOKEN,
      fully_booked: false,
      days: [
        { date: DAY_1, slots: [slot(DAY_1, 9, 0), slot(DAY_1, 9, 30, false)] },
        { date: DAY_2, slots: [slot(DAY_2, 20, 30)] },
      ],
    });
  });

  it('never copies an extra field from the grid, a day or a slot', () => {
    const body = grid();
    const leaky = {
      ...withLeaks(body),
      days: body.days.map((day) => ({
        ...withLeaks(day),
        slots: day.slots.map((one) => withLeaks(one)),
      })),
    };
    const parsed = parseBookSlots(leaky);
    for (const leak of LEAKY_FIELDS) expect(deepKeys(parsed)).not.toContain(leak);
    expect(Object.keys(parsed).sort()).toEqual(['days', 'fully_booked', 'grid_token', 'slot_minutes']);
    expect(Object.keys(parsed.days[0]!).sort()).toEqual(['date', 'slots']);
    expect(Object.keys(parsed.days[0]!.slots[0]!).sort()).toEqual(['available', 'end_at', 'start_at']);
  });

  it('accepts instants with an offset, fractional seconds, no seconds, a fully booked grid and no days', () => {
    const offset = {
      ...grid(),
      days: [
        {
          date: DAY_1,
          slots: [
            { start_at: '2026-09-16T09:00:00+05:30', end_at: '2026-09-16T09:45+05:30', available: true },
            { start_at: '2026-09-16T04:30:00.000Z', end_at: '2026-09-16T05:15:00.123456Z', available: true },
          ],
        },
      ],
    };
    expect(parseBookSlots(offset).days[0]!.slots[0]!.start_at).toBe('2026-09-16T09:00:00+05:30');
    expect(parseBookSlots({ ...grid(), fully_booked: true }).fully_booked).toBe(true);
    expect(parseBookSlots({ ...grid(), days: [] }).days).toEqual([]);
    expect(parseBookSlots({ ...grid(), days: [{ date: DAY_1, slots: [] }] }).days[0]!.slots).toEqual([]);
  });

  it('accepts 30 and 60 minute slots, 14 days and 96 slots a day', () => {
    expect(parseBookSlots({ ...grid(), slot_minutes: 30 }).slot_minutes).toBe(30);
    expect(parseBookSlots({ ...grid(), slot_minutes: 60 }).slot_minutes).toBe(60);
    const days = Array.from({ length: 14 }, (_, i) => ({ date: addIstDays(DAY_1, i), slots: [] }));
    expect(parseBookSlots({ ...grid(), days }).days).toHaveLength(14);
    const many = Array.from({ length: 96 }, (_, i) => {
      const start = plusMinutes(at(DAY_1, 0, 0), i * 10);
      return { start_at: start, end_at: plusMinutes(start, 5), available: true };
    });
    expect(parseBookSlots({ ...grid(), days: [{ date: DAY_1, slots: many }] }).days[0]!.slots).toHaveLength(96);
  });

  it.each(['timezone', 'slot_minutes', 'generated_at', 'grid_token', 'fully_booked', 'days'])(
    'fails closed without %s',
    (key) => {
      expectMalformed(() => parseBookSlots(without(grid(), key)));
    },
  );

  it.each([['UTC'], ['Asia/Calcutta'], ['asia/kolkata'], [''], [null]])(
    'fails closed on timezone %j',
    (timezone) => {
      expectMalformed(() => parseBookSlots({ ...grid(), timezone }));
    },
  );

  it.each([[29], [61], [0], [45.5], ['45'], [null]])('fails closed on slot_minutes %j', (minutes) => {
    expectMalformed(() => parseBookSlots({ ...grid(), slot_minutes: minutes }));
  });

  it.each([['2026-09-16T06:30:00'], ['2026-09-16'], ['yesterday'], [''], [ISSUED_AT]])(
    'fails closed on generated_at %j',
    (generatedAt) => {
      expectMalformed(() => parseBookSlots({ ...grid(), generated_at: generatedAt }));
    },
  );

  it('fails closed on every badly shaped grid token', () => {
    const mac = 'g'.repeat(43);
    const bad = [
      `g2.${ISSUED_AT}.${mac}`,
      `g1.${String(ISSUED_AT).slice(1)}.${mac}`,
      `g1.${ISSUED_AT}0.${mac}`,
      `g1.${ISSUED_AT}.${mac.slice(1)}`,
      `g1.${ISSUED_AT}.${mac}g`,
      `g1.${ISSUED_AT}.${mac.slice(1)}+`,
      `g1.${ISSUED_AT}.${mac.slice(1)}=`,
      `g1.${ISSUED_AT}${mac}`,
      ` ${GRID_TOKEN}`,
      '',
      ISSUED_AT,
      null,
    ];
    for (const token of bad) expectMalformed(() => parseBookSlots({ ...grid(), grid_token: token }));
  });

  it.each([['false'], [0], [null]])('fails closed on fully_booked %j', (value) => {
    expectMalformed(() => parseBookSlots({ ...grid(), fully_booked: value }));
  });

  it('fails closed on a malformed day list', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => ({ date: addIstDays(DAY_1, i), slots: [] }));
    const [first, second] = grid().days;
    const cases: unknown[] = [
      {},
      'days',
      fifteen,
      [{ date: '2026-02-30', slots: [] }],
      [{ date: '16-09-2026', slots: [] }],
      [{ slots: [] }],
      [{ date: DAY_1 }],
      [{ date: DAY_1, slots: {} }],
      [second, first],
      [first, first],
      [null],
    ];
    for (const days of cases) expectMalformed(() => parseBookSlots({ ...grid(), days }));
  });

  it('fails closed on a malformed slot', () => {
    const good = slot(DAY_1, 10, 0);
    const later = slot(DAY_1, 11, 0);
    const tooMany = Array.from({ length: 97 }, (_, i) => {
      const start = plusMinutes(at(DAY_1, 0, 0), i * 10);
      return { start_at: start, end_at: plusMinutes(start, 5), available: true };
    });
    const cases: unknown[] = [
      [without(good, 'start_at')],
      [without(good, 'end_at')],
      [without(good, 'available')],
      [{ ...good, available: 'yes' }],
      [{ ...good, start_at: '2026-09-16T10:00:00' }],
      [{ ...good, end_at: '2026-09-16T10:45:00' }],
      [{ ...good, start_at: 'soon' }],
      [{ ...good, end_at: good.start_at }],
      [{ ...good, end_at: plusMinutes(good.start_at, -15) }],
      // 20:00 UTC on the 16th is 01:30 IST on the 17th: the wrong IST day.
      [{ start_at: '2026-09-16T20:00:00Z', end_at: '2026-09-16T20:45:00Z', available: true }],
      [later, good],
      [good, good],
      tooMany,
      [null],
      ['slot'],
    ];
    for (const slots of cases) {
      expectMalformed(() => parseBookSlots({ ...grid(), days: [{ date: DAY_1, slots }] }));
    }
  });

  it.each([[null], [[]], ['grid'], [1]])('fails closed on a non-object %j', (body) => {
    expectMalformed(() => parseBookSlots(body));
  });
});

describe('parseBooked and parseMoved', () => {
  it('parse their own status word into the start and end only', () => {
    expect(parseBooked(withLeaks(BOOKED))).toEqual({ start_at: BOOKED_START, end_at: BOOKED_END });
    expect(parseMoved(withLeaks(MOVED))).toEqual({ start_at: BOOKED_START, end_at: BOOKED_END });
    expect(Object.keys(parseBooked(withLeaks(BOOKED))).sort()).toEqual(['end_at', 'start_at']);
    expect(Object.keys(parseMoved(withLeaks(MOVED))).sort()).toEqual(['end_at', 'start_at']);
  });

  it.each([
    ['booked', parseBooked, BOOKED],
    ['moved', parseMoved, MOVED],
  ] as const)('%s fails closed on any other shape', (_word, parse, body) => {
    for (const key of ['status', 'start_at', 'end_at']) expectMalformed(() => parse(without(body, key)));
    for (const status of ['ok', 'BOOKED', 'MOVED', '', 'replayed']) {
      expectMalformed(() => parse({ ...body, status }));
    }
    expectMalformed(() => parse({ ...body, start_at: '2026-09-16T09:00:00' }));
    expectMalformed(() => parse({ ...body, end_at: body.start_at }));
    expectMalformed(() => parse({ ...body, end_at: plusMinutes(body.start_at, -1) }));
    expectMalformed(() => parse(null));
    expectMalformed(() => parse([]));
  });

  it('never reads a move as a booking or a booking as a move', () => {
    expectMalformed(() => parseBooked(MOVED));
    expectMalformed(() => parseMoved(BOOKED));
  });
});

describe('parseCancelled and parseConsented', () => {
  it('accept cancelled and already_cancelled, returning the word', () => {
    expect(parseCancelled(withLeaks({ status: 'cancelled' }))).toBe('cancelled');
    expect(parseCancelled({ status: 'already_cancelled' })).toBe('already_cancelled');
  });

  it.each([['ok'], ['CANCELLED'], ['canceled'], [''], [true], [undefined]])(
    'cancel fails closed on status %j',
    (status) => {
      expectMalformed(() => parseCancelled({ status }));
    },
  );

  it('accepts consented only', () => {
    expect(parseConsented(withLeaks({ status: 'consented' }))).toBe('consented');
    for (const status of ['ok', 'granted', 'CONSENTED', '', undefined]) {
      expectMalformed(() => parseConsented({ status }));
    }
    expectMalformed(() => parseConsented(null));
    expectMalformed(() => parseCancelled(null));
  });
});

describe('parseManage', () => {
  it('parses the booking view into exactly the declared fields', () => {
    const parsed = parseManage(withLeaks(MANAGE));
    expect(parsed).toEqual(MANAGE);
    for (const leak of LEAKY_FIELDS) expect(deepKeys(parsed)).not.toContain(leak);
  });

  it('accepts in_progress and the bounds of moves_left', () => {
    expect(parseManage({ ...MANAGE, state: 'in_progress' }).state).toBe('in_progress');
    expect(parseManage({ ...MANAGE, moves_left: 0 }).moves_left).toBe(0);
    expect(parseManage({ ...MANAGE, moves_left: 10 }).moves_left).toBe(10);
  });

  it.each(Object.keys(MANAGE))('fails closed without %s', (key) => {
    expectMalformed(() => parseManage(without(MANAGE, key)));
  });

  it.each([['live'], ['cancelled'], ['completed'], ['BOOKED'], ['']])(
    'fails closed on state %j',
    (state) => {
      expectMalformed(() => parseManage({ ...MANAGE, state }));
    },
  );

  it('fails closed on badly typed flags, counts and times', () => {
    for (const key of ['can_move', 'can_cancel', 'consent_current']) {
      expectMalformed(() => parseManage({ ...MANAGE, [key]: 'true' }));
      expectMalformed(() => parseManage({ ...MANAGE, [key]: 1 }));
    }
    for (const moves of [11, -1, 1.5, '2', null]) {
      expectMalformed(() => parseManage({ ...MANAGE, moves_left: moves }));
    }
    expectMalformed(() => parseManage({ ...MANAGE, start_at: '2026-09-16T09:00:00' }));
    expectMalformed(() => parseManage({ ...MANAGE, end_at: MANAGE.start_at }));
    expectMalformed(() => parseManage(null));
  });
});

// ── classifyBookFailure ───────────────────────────────────────────────────────────────────────

const EXPECTED_FAILURE: Record<string, R1BookFailure> = {
  booking_disabled: 'disabled',
  temporarily_unavailable: 'unavailable',
  not_found: 'not_found',
  already_booked: 'already_booked',
  slot_unavailable: 'slot_unavailable',
  consent_stale: 'consent_stale',
  invalid_request: 'invalid',
  move_not_allowed: 'not_allowed',
  cancel_not_allowed: 'not_allowed',
};

describe('classifyBookFailure', () => {
  it('maps every declared (status, word) pair of every route', () => {
    let pairs = 0;
    for (const name of NAMES) {
      for (const [status, word] of R1_BOOK_CONTRACT[name].errors) {
        expect(classifyBookFailure(name, new R1ApiError(word, status)), `${name} ${status} ${word}`).toBe(
          EXPECTED_FAILURE[word],
        );
        expect(classifyBookFailure(name, new ApiError(word, status))).toBe(EXPECTED_FAILURE[word]);
        pairs += 1;
      }
    }
    expect(pairs).toBe(2 + 2 + 7 + 4 + 6 + 5 + 6);
  });

  it('reads a known word on a status the route does not declare for it as unavailable', () => {
    for (const name of NAMES) {
      const declared = R1_BOOK_CONTRACT[name].errors;
      for (const word of R1_BOOK_ERROR_WORDS) {
        for (const status of [400, 404, 409, 410, 422, 503]) {
          if (declared.some((pair) => pair[0] === status && pair[1] === word)) continue;
          expect(classifyBookFailure(name, new R1ApiError(word, status)), `${name} ${status} ${word}`).toBe(
            'unavailable',
          );
        }
      }
    }
  });

  it('reads a word of another route as unavailable', () => {
    expect(classifyBookFailure('manage', new R1ApiError('already_booked', 409))).toBe('unavailable');
    expect(classifyBookFailure('move', new R1ApiError('cancel_not_allowed', 409))).toBe('unavailable');
    expect(classifyBookFailure('cancel', new R1ApiError('move_not_allowed', 409))).toBe('unavailable');
    expect(classifyBookFailure('move', new R1ApiError('consent_stale', 409))).toBe('unavailable');
    expect(classifyBookFailure('slots', new R1ApiError('not_found', 404))).toBe('unavailable');
    expect(classifyBookFailure('consentTemplate', new R1ApiError('invalid_request', 400))).toBe(
      'unavailable',
    );
    expect(classifyBookFailure('book', new R1ApiError('cancel_not_allowed', 409))).toBe('unavailable');
  });

  it('reads a rate limit, an auth refusal, an unknown word or a bare status as unavailable', () => {
    const refusals = [
      new R1ApiError('rate_limited', 429),
      new R1ApiError('http_429', 429),
      new R1ApiError('unauthorized', 401),
      new R1ApiError('forbidden', 403),
      new R1ApiError('http_404', 404),
      new R1ApiError('http_503', 503),
      new R1ApiError('r1_disabled', 503),
      new R1ApiError('constructor', 404),
      new R1ApiError('__proto__', 409),
      new R1ApiError('hasOwnProperty', 400),
    ];
    for (const name of NAMES) {
      for (const error of refusals) {
        expect(classifyBookFailure(name, error), `${name} ${error.status} ${error.message}`).toBe(
          'unavailable',
        );
      }
    }
  });

  it('reads a dropped request, a 500, 502 or 504 and a malformed answer as uncertain for a POST', () => {
    const unsure = [
      new ApiError('network_unreachable', 0),
      new R1ApiError('internal_error', 500),
      new R1ApiError('http_502', 502),
      new R1ApiError('http_504', 504),
      new R1ApiError('not_found', 500),
      new ApiError('r1_malformed_response', 500),
    ];
    for (const error of unsure) {
      for (const name of POSTS) expect(classifyBookFailure(name, error), name).toBe('uncertain');
      for (const name of GETS) expect(classifyBookFailure(name, error), name).toBe('unavailable');
    }
  });

  it('reads anything that is not an ApiError as uncertain for a POST and unavailable for a GET', () => {
    for (const thrown of [new Error('boom'), new TypeError('x'), 'not_found', undefined, null, { status: 404 }]) {
      for (const name of POSTS) expect(classifyBookFailure(name, thrown), name).toBe('uncertain');
      for (const name of GETS) expect(classifyBookFailure(name, thrown), name).toBe('unavailable');
    }
  });
});

// ── r1BookApi requests ────────────────────────────────────────────────────────────────────────

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(make: () => Response | Error) {
  const fetchMock = vi.fn().mockImplementation(async () => {
    const response = make();
    if (response instanceof Error) throw response;
    return response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function callOf(fetchMock: ReturnType<typeof mockFetch>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
  };
}

const TYPED = {
  name: 'Asha Rao',
  email: 'asha.rao@example.com',
  phone: '+91 98765 43210',
};

function submission(): R1BookSubmission {
  return {
    request_id: '3f2b8c1e-9a4d-4c7b-8e2f-1a2b3c4d5e6f',
    name: `  ${TYPED.name} `,
    email: ` ${TYPED.email}  `,
    phone: `\t${TYPED.phone} `,
    slot_start: '2026-09-16T09:00:00+05:30',
    grid_token: GRID_TOKEN,
    consent: {
      template_version: TEMPLATE.version,
      consents: ['ai_interview', 'recording'],
      in_india: true,
    },
    website: '',
  };
}

const CONSENT_INPUT = {
  template_version: TEMPLATE.version,
  consents: ['ai_interview', 'recording'],
  in_india: true as const,
};

/** Each route invoked once, with the answer its parser accepts. */
const INVOCATIONS: Record<R1BookRouteName, { answer: () => Response; invoke: () => Promise<unknown> }> = {
  consentTemplate: { answer: () => reply(200, TEMPLATE), invoke: () => r1BookApi.consentTemplate() },
  slots: { answer: () => reply(200, grid()), invoke: () => r1BookApi.slots() },
  book: { answer: () => reply(201, BOOKED), invoke: () => r1BookApi.book(submission()) },
  manage: { answer: () => reply(200, MANAGE), invoke: () => r1BookApi.manage(MANAGE_TOKEN) },
  move: {
    answer: () => reply(200, MOVED),
    invoke: () => r1BookApi.move(MANAGE_TOKEN, BOOKED_START, GRID_TOKEN),
  },
  cancel: {
    answer: () => reply(200, { status: 'cancelled' }),
    invoke: () => r1BookApi.cancel(MANAGE_TOKEN, true),
  },
  consent: {
    answer: () => reply(200, { status: 'consented' }),
    invoke: () => r1BookApi.consent(MANAGE_TOKEN, CONSENT_INPUT),
  },
};

describe('r1BookApi requests', () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(NAMES)('%s goes to its path with the declared method, credential-free and uncached', async (name) => {
    const { answer, invoke } = INVOCATIONS[name];
    const fetchMock = mockFetch(answer);
    await invoke();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, headers } = callOf(fetchMock);
    const contract = R1_BOOK_CONTRACT[name];
    expect(url.endsWith(contract.path)).toBe(true);
    expect(url).not.toContain('?');
    expect(url).not.toContain('#');
    expect(init.method).toBe(contract.method);
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(init.referrerPolicy).toBe('no-referrer');
    const headerNames = Object.keys(headers).map((header) => header.toLowerCase());
    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('cookie');
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each(GETS)('%s sends no body and no Content-Type', async (name) => {
    const fetchMock = mockFetch(INVOCATIONS[name].answer);
    await INVOCATIONS[name].invoke();
    const { init, headers } = callOf(fetchMock);
    expect(init.body).toBeUndefined();
    expect(Object.keys(headers).map((header) => header.toLowerCase())).toEqual(['accept']);
  });

  it.each(POSTS)('%s sends exactly the declared body keys as JSON', async (name) => {
    const fetchMock = mockFetch(INVOCATIONS[name].answer);
    await INVOCATIONS[name].invoke();
    const { headers, body } = callOf(fetchMock);
    expect(headers['Content-Type']).toBe('application/json');
    expect(Object.keys(body!).sort()).toEqual([...R1_BOOK_CONTRACT[name].request].sort());
    const consentKeys = R1_BOOK_CONTRACT[name].consentKeys;
    if (consentKeys.length > 0) {
      expect(Object.keys(body!.consent as Record<string, unknown>).sort()).toEqual([...consentKeys].sort());
    } else {
      expect(body).not.toHaveProperty('consent');
    }
  });

  it('books with the typed details trimmed, the slot byte for byte and the honeypot sent', async () => {
    const fetchMock = mockFetch(INVOCATIONS.book.answer);
    await expect(r1BookApi.book(submission())).resolves.toEqual({
      start_at: BOOKED_START,
      end_at: BOOKED_END,
    });
    const { url, body } = callOf(fetchMock);
    expect(body).toEqual({
      request_id: '3f2b8c1e-9a4d-4c7b-8e2f-1a2b3c4d5e6f',
      name: TYPED.name,
      email: TYPED.email,
      phone: TYPED.phone,
      slot_start: '2026-09-16T09:00:00+05:30',
      grid_token: GRID_TOKEN,
      consent: {
        template_version: TEMPLATE.version,
        consents: ['ai_interview', 'recording'],
        in_india: true,
      },
      website: '',
    });
    for (const value of [...Object.values(TYPED), GRID_TOKEN, 'asha', '%40']) {
      expect(url).not.toContain(value);
    }
  });

  it('sends the honeypot value as it is', async () => {
    const fetchMock = mockFetch(INVOCATIONS.book.answer);
    await r1BookApi.book({ ...submission(), website: ' a bot was here ' });
    expect(callOf(fetchMock).body!.website).toBe(' a bot was here ');
  });

  it('keeps the purposes in the order given', async () => {
    const fetchMock = mockFetch(INVOCATIONS.book.answer);
    const reordered = submission();
    await r1BookApi.book({
      ...reordered,
      consent: { ...reordered.consent, consents: ['recording', 'ai_interview'] },
    });
    expect((callOf(fetchMock).body!.consent as { consents: string[] }).consents).toEqual([
      'recording',
      'ai_interview',
    ]);
  });

  it('never adds a caller object\'s extra keys to a body', async () => {
    const fetchMock = mockFetch(INVOCATIONS.book.answer);
    const extra = {
      ...submission(),
      locale: 'en-US',
      candidate_id: 'cand-1',
      consent: { ...submission().consent, status: 'granted', locale: 'en-US' },
    } as unknown as R1BookSubmission;
    await r1BookApi.book(extra);
    const { body } = callOf(fetchMock);
    expect(Object.keys(body!).sort()).toEqual([...R1_BOOK_CONTRACT.book.request].sort());
    expect(Object.keys(body!.consent as Record<string, unknown>).sort()).toEqual(
      [...R1_BOOK_CONTRACT.book.consentKeys].sort(),
    );

    const consentMock = mockFetch(INVOCATIONS.consent.answer);
    await r1BookApi.consent(MANAGE_TOKEN, {
      ...CONSENT_INPUT,
      status: 'granted',
    } as unknown as typeof CONSENT_INPUT);
    const consentBody = callOf(consentMock).body!;
    expect(Object.keys(consentBody).sort()).toEqual(['consent', 'token']);
    expect(Object.keys(consentBody.consent as Record<string, unknown>).sort()).toEqual([
      'consents',
      'in_india',
      'template_version',
    ]);
  });

  it('carries the manage token in the body only, on every manage route', async () => {
    for (const name of ['manage', 'move', 'cancel', 'consent'] as const) {
      const fetchMock = mockFetch(INVOCATIONS[name].answer);
      await INVOCATIONS[name].invoke();
      const { url, body, headers } = callOf(fetchMock);
      expect(body!.token, name).toBe(MANAGE_TOKEN);
      expect(url, name).not.toContain(MANAGE_TOKEN);
      expect(JSON.stringify(headers), name).not.toContain(MANAGE_TOKEN);
    }
  });

  it('sends the move, cancel and consent bodies exactly', async () => {
    let fetchMock = mockFetch(INVOCATIONS.move.answer);
    await expect(r1BookApi.move(MANAGE_TOKEN, BOOKED_START, GRID_TOKEN)).resolves.toEqual({
      start_at: BOOKED_START,
      end_at: BOOKED_END,
    });
    expect(callOf(fetchMock).body).toEqual({
      token: MANAGE_TOKEN,
      slot_start: BOOKED_START,
      grid_token: GRID_TOKEN,
    });

    fetchMock = mockFetch(() => reply(200, { status: 'already_cancelled' }));
    await expect(r1BookApi.cancel(MANAGE_TOKEN, false)).resolves.toBe('already_cancelled');
    expect(callOf(fetchMock).body).toEqual({ token: MANAGE_TOKEN, withdraw_consent: false });

    fetchMock = mockFetch(INVOCATIONS.consent.answer);
    await expect(r1BookApi.consent(MANAGE_TOKEN, CONSENT_INPUT)).resolves.toBe('consented');
    expect(callOf(fetchMock).body).toEqual({ token: MANAGE_TOKEN, consent: CONSENT_INPUT });
  });

  it('parses each success answer', async () => {
    mockFetch(INVOCATIONS.consentTemplate.answer);
    await expect(r1BookApi.consentTemplate()).resolves.toEqual(TEMPLATE);
    mockFetch(INVOCATIONS.slots.answer);
    await expect(r1BookApi.slots()).resolves.toMatchObject({ grid_token: GRID_TOKEN, slot_minutes: 45 });
    mockFetch(INVOCATIONS.manage.answer);
    await expect(r1BookApi.manage(MANAGE_TOKEN)).resolves.toEqual(MANAGE);
  });

  it('surfaces only the error word and status of a refusal, which then classifies per route', async () => {
    mockFetch(() => reply(404, { error: 'not_found', detail: 'no application for asha' }));
    const refusal = await r1BookApi.book(submission()).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    expect((refusal as ApiError).message).toBe('not_found');
    expect((refusal as ApiError).status).toBe(404);
    expect(classifyBookFailure('book', refusal)).toBe('not_found');

    mockFetch(() => reply(503, { error: 'booking_disabled' }));
    const disabled = await r1BookApi.slots().catch((error: unknown) => error);
    expect(classifyBookFailure('slots', disabled)).toBe('disabled');
  });

  it('reads a dropped request as uncertain for a book and unavailable for the grid', async () => {
    mockFetch(() => new TypeError('Failed to fetch'));
    const dropped = await r1BookApi.book(submission()).catch((error: unknown) => error);
    expect((dropped as ApiError).status).toBe(0);
    expect(classifyBookFailure('book', dropped)).toBe('uncertain');
    mockFetch(() => new TypeError('Failed to fetch'));
    const gridDropped = await r1BookApi.slots().catch((error: unknown) => error);
    expect(classifyBookFailure('slots', gridDropped)).toBe('unavailable');
  });

  it('fails a malformed 2xx closed, as uncertain for a POST', async () => {
    mockFetch(() => reply(201, { status: 'ok' }));
    const odd = await r1BookApi.book(submission()).catch((error: unknown) => error);
    expect((odd as ApiError).message).toBe('r1_malformed_response');
    expect(classifyBookFailure('book', odd)).toBe('uncertain');
    mockFetch(() => new Response('<html>ok</html>', { status: 200 }));
    const html = await r1BookApi.manage(MANAGE_TOKEN).catch((error: unknown) => error);
    expect((html as ApiError).message).toBe('r1_malformed_response');
  });
});
