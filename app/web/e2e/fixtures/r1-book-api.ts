/**
 * The fake public booking API (M035 S07; `.gsd/milestones/M035/contracts/public-contracts.md`
 * section 6, which S06 builds on the server behind `R1_MEET_PUBLIC_BOOKING_ENABLED`).
 *
 * It answers ONLY the seven `/api/r1/book*` routes the public pages call, with the wire shapes,
 * status codes and error words of section 6. Anything else (another path, a route under the wrong
 * method) is `null`, which the harness answers as an unmocked endpoint and fails the test.
 *
 * Like the server:
 *   - the switch is checked first: with `disabled` every route answers 503 `booking_disabled`,
 *     whatever the request holds;
 *   - bodies are strict: an unknown or a missing key, or a value of the wrong type, is
 *     400 `{ error: 'invalid_request' }`. A GET carries no body and no query string;
 *   - error bodies are `{ error: '<word>' }` (plus `template_version` on `consent_stale`), never
 *     the shared validator's envelope;
 *   - `POST /api/r1/book` answers in the order of section 6: switch, body, grid token, honeypot,
 *     replay by `request_id`, slot, consent, match. A filled honeypot (`website`) is 404
 *     `not_found`; a grid token other than the one served, or a `slot_start` the grid does not
 *     offer as available, is 409 `slot_unavailable`; the same `request_id` again answers 201 with
 *     the slot it booked the first time;
 *   - the manage token travels in the body only; any token but `MANAGE_TOKEN` is 404
 *     `not_found`. A move sends a new invite, whose new link replaces this one, so after a move
 *     the token is spent (404). After a cancel the booking is terminal: `manage` is 404, and a
 *     repeated cancel answers `already_cancelled`.
 *
 * The grid is built from the frozen day (`FROZEN_NOW_MS`, Wed 16 Sep 2026 12:00 IST): three IST
 * days, starts from 09:00 to 20:30 every 30 minutes, 45-minute slots. A time that starts within
 * the hour is not available (the notice rule), and a few others are full. Tokens are built at run
 * time, so no token-shaped literal sits in the source.
 *
 * Like the other fakes, this mirrors the web client (src/lib/r1/r1-book-api.ts) and so proves the
 * pages are self-consistent, not that the server agrees: src/lib/r1/r1-book-contract.test.ts is
 * the guard against drift, and src/lib/r1/r1-book-e2e-fake.test.ts holds this fake to the pages'
 * own parsers. Nothing here imports app code: it runs in Node, inside the Playwright runner.
 */

import type { MockResponse } from './api-router';
import type { ApiRouter } from './harness';
import { FROZEN_NOW_MS } from './env';

/** The seven routes, by the names the web client gives them (`R1_BOOK_ROUTES`). */
export const R1_BOOK_FAKE_ROUTES = Object.freeze({
  consentTemplate: '/api/r1/book/consent-template',
  slots: '/api/r1/book/slots',
  book: '/api/r1/book',
  manage: '/api/r1/book/manage',
  move: '/api/r1/book/manage/move',
  cancel: '/api/r1/book/manage/cancel',
  consent: '/api/r1/book/manage/consent',
});

export type R1BookFakeRoute = keyof typeof R1_BOOK_FAKE_ROUTES;

export const R1_BOOK_FAKE_METHODS: Readonly<Record<R1BookFakeRoute, 'GET' | 'POST'>> = Object.freeze({
  consentTemplate: 'GET',
  slots: 'GET',
  book: 'POST',
  manage: 'POST',
  move: 'POST',
  cancel: 'POST',
  consent: 'POST',
});

/**
 * The manage token the invite's link carries in `#m=`: 43 base64url characters (section 6), and
 * plainly not a secret. Built at run time.
 */
export const MANAGE_TOKEN = 'e2e-manage-not-a-secret-'.padEnd(43, 'x');

/** The grid token the fake serves: `g1.<issued_at, 13 digits>.<43 characters>`, built at run time. */
export const BOOK_GRID_TOKEN = `g1.${FROZEN_NOW_MS}.${'g'.repeat(43)}`;

export const BOOK_SLOT_MINUTES = 45;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** A time that starts within this of "now" is not offered (the server's notice rule). */
const NOTICE_MS = 60 * 60_000;
const FIRST_START_MINUTES = 9 * 60;
const LAST_START_MINUTES = 20 * 60 + 30;
const STEP_MINUTES = 30;

/** The IST calendar date an instant falls on. IST has no daylight saving: a fixed offset. */
function istDateOf(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The three IST dates of the grid: the frozen day and the next two. */
export const BOOK_DAYS: readonly string[] = Object.freeze(
  [0, 1, 2].map((index) => istDateOf(FROZEN_NOW_MS + index * DAY_MS)),
);

/** The `start_at` the grid sends for `hour:minute` IST on grid day `dayIndex` (0 = the frozen day). */
export function bookSlotStart(dayIndex: number, hour: number, minute: number): string {
  const date = BOOK_DAYS[dayIndex];
  if (date === undefined) throw new Error(`the fake grid has no day ${dayIndex}`);
  const ms = Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60_000 - IST_OFFSET_MS;
  return new Date(ms).toISOString();
}

/** The `end_at` of the slot that starts at `startAt`. */
export function bookSlotEnd(startAt: string): string {
  return new Date(Date.parse(startAt) + BOOK_SLOT_MINUTES * 60_000).toISOString();
}

/** Times that are full whatever the test does: Thu 09:00 and 11:00, Fri 15:30 (IST). */
const FULL_STARTS: readonly string[] = Object.freeze([
  bookSlotStart(1, 9, 0),
  bookSlotStart(1, 11, 0),
  bookSlotStart(2, 15, 30),
]);

/** The four purposes of the candidate notice, with the wording the server returns. */
const R1_BOOK_CONSENT_ITEMS = [
  {
    type: 'ai_interview',
    label: 'I agree to take part in a first-round interview on Google Meet led by Dex, an AI interviewer, including a sales role-play.',
  },
  {
    type: 'video_audio_recording',
    label: 'I agree to my video and voice in the Google Meet being recorded for review by the hiring team.',
  },
  {
    type: 'ai_evaluation',
    label:
      'I agree to an AI evaluation of my interview that may update my application status, which the hiring team can review and change and which I can contest.',
  },
  {
    type: 'data_processing',
    label: 'I agree to the providers listed in this notice processing my data.',
  },
];

export const R1_BOOK_TEMPLATE_VERSION = 'e2e-book-v1';

/** The notice as `GET /api/r1/book/consent-template` sends it (the version comes from the state). */
export const R1_BOOK_TEMPLATE = Object.freeze({
  version: R1_BOOK_TEMPLATE_VERSION,
  locale: 'en-IN',
  title: 'Notice and consent for your interview with Dex',
  body_md: [
    '# What we collect',
    'Your video and voice in the Google Meet, the interview transcript and your scores.',
    '',
    '# Who processes it',
    '- Google (calendar and Meet)',
    '- Recall.ai (meeting bot)',
    '- The speech and language model providers named by the hiring team',
    '',
    '# Your choices',
    'You can cancel your interview and withdraw your consent from the link in your calendar invite.',
  ].join('\n'),
  required_consents: R1_BOOK_CONSENT_ITEMS.map((item) => item.type),
  consent_items: R1_BOOK_CONSENT_ITEMS,
});

export interface R1BookRecordedRequest {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

export interface R1BookForcedError {
  status: number;
  error: string;
}

/** The booking the manage token names. */
export interface R1BookManageRecord {
  state: 'booked' | 'in_progress';
  startAt: string;
  endAt: string;
  canMove: boolean;
  canCancel: boolean;
  movesLeft: number;
  consentCurrent: boolean;
}

export interface R1BookMockState {
  /** Every `/api/r1/book*` request the page sent, in order. */
  requests: R1BookRecordedRequest[];
  /** The server's switch is off: every route answers 503 `booking_disabled`, checked first. */
  disabled: boolean;
  /** Nothing can be booked: `fully_booked: true` and every slot `available: false`. */
  fullyBooked: boolean;
  /** The newest active notice. A book or re-consent naming another version is 409 `consent_stale`. */
  templateVersion: string;
  /**
   * What a valid, new booking request meets once the grid, slot and consent checks pass:
   * `booked` (201), `not_found` (no bookable application), `already_booked`, or
   * `slot_unavailable_once` (the time was taken by someone else just before: the first book
   * answers 409 `slot_unavailable` and the grid marks that time full; later ones book).
   */
  bookOutcome: 'booked' | 'not_found' | 'already_booked' | 'slot_unavailable_once';
  /** The booking behind `MANAGE_TOKEN`, or null (then every manage call is 404). */
  manage: R1BookManageRecord | null;
  /**
   * `live`: the token works. `rotated`: a move sent a new invite whose link replaced this one
   * (404 from then on). `cancelled`: the booking is terminal (`manage` 404, a repeated cancel
   * answers `already_cancelled`).
   */
  manageToken: 'live' | 'rotated' | 'cancelled';
  /** The last cancel also withdrew the consent. */
  withdrawn: boolean;
  /** Times taken while the test ran: `available: false` in every later grid. */
  taken: string[];
  /** Bookings made, by `request_id`: the same id again replays the first answer. */
  bookings: Record<string, { startAt: string; endAt: string; email: string }>;
  /** One-shot failures per route, consumed on use. */
  failures: Partial<Record<R1BookFakeRoute, R1BookForcedError>>;
}

export function createR1BookState(): R1BookMockState {
  const startAt = bookSlotStart(1, 12, 0);
  return {
    requests: [],
    disabled: false,
    fullyBooked: false,
    templateVersion: R1_BOOK_TEMPLATE_VERSION,
    bookOutcome: 'booked',
    manage: {
      state: 'booked',
      startAt,
      endAt: bookSlotEnd(startAt),
      canMove: true,
      canCancel: true,
      movesLeft: 2,
      consentCurrent: true,
    },
    manageToken: 'live',
    withdrawn: false,
    taken: [],
    bookings: {},
    failures: {},
  };
}

interface FakeSlot {
  start_at: string;
  end_at: string;
  available: boolean;
}

/** The grid as the state stands: what `GET /api/r1/book/slots` sends in `days`. */
export function bookGridDays(state: R1BookMockState): Array<{ date: string; slots: FakeSlot[] }> {
  return BOOK_DAYS.map((date, dayIndex) => {
    const slots: FakeSlot[] = [];
    for (let minutes = FIRST_START_MINUTES; minutes <= LAST_START_MINUTES; minutes += STEP_MINUTES) {
      const startAt = bookSlotStart(dayIndex, Math.floor(minutes / 60), minutes % 60);
      const available =
        !state.fullyBooked
        && Date.parse(startAt) > FROZEN_NOW_MS + NOTICE_MS
        && !FULL_STARTS.includes(startAt)
        && !state.taken.includes(startAt);
      slots.push({ start_at: startAt, end_at: bookSlotEnd(startAt), available });
    }
    return { date, slots };
  });
}

function findSlot(state: R1BookMockState, startAt: unknown): FakeSlot | null {
  if (typeof startAt !== 'string') return null;
  for (const day of bookGridDays(state)) {
    const slot = day.slots.find((entry) => entry.start_at === startAt);
    if (slot) return slot;
  }
  return null;
}

const json = (status: number, body: unknown): MockResponse => ({ status, json: body });
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): MockResponse =>
  json(status, { error, ...extra });
const INVALID = (): MockResponse => refuse(400, 'invalid_request');

type Body = Record<string, unknown>;

const hasKey = (body: Body, key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

function isRecord(value: unknown): value is Body {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exactly these keys, no more and no fewer (the routes' strict schemas). */
function exactKeys(body: unknown, keys: readonly string[]): body is Body {
  return isRecord(body) && Object.keys(body).length === keys.length && keys.every((key) => hasKey(body, key));
}

const isText = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONED_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const BOOK_KEYS = ['request_id', 'name', 'email', 'phone', 'slot_start', 'grid_token', 'consent', 'website'];
const CONSENT_KEYS = ['template_version', 'consents', 'in_india'];

/** `consent: { template_version, consents, in_india }`, each of its type (section 6, row 3). */
function consentShapeOk(consent: unknown): consent is { template_version: string; consents: string[]; in_india: boolean } {
  return (
    exactKeys(consent, CONSENT_KEYS)
    && isText(consent.template_version, 1, 64)
    && Array.isArray(consent.consents)
    && consent.consents.length >= 1
    && consent.consents.length <= 8
    && consent.consents.every((item) => typeof item === 'string')
    && typeof consent.in_india === 'boolean'
  );
}

function bookShapeOk(body: unknown): body is Body {
  return (
    exactKeys(body, BOOK_KEYS)
    && typeof body.request_id === 'string'
    && UUID_RE.test(body.request_id)
    && isText(body.name, 1, 100)
    && isText(body.email, 3, 254)
    && isText(body.phone, 1, 32)
    && typeof body.slot_start === 'string'
    && ZONED_INSTANT_RE.test(body.slot_start)
    && typeof body.grid_token === 'string'
    && consentShapeOk(body.consent)
    && isText(body.website, 0, 200)
  );
}

/** Every required purpose granted and the India tick: else the server's 400. */
function consentComplete(consent: { consents: string[]; in_india: boolean }): boolean {
  return consent.in_india === true
    && R1_BOOK_TEMPLATE.required_consents.every((type) => consent.consents.includes(type));
}

function routeOf(method: string, path: string): R1BookFakeRoute | null {
  for (const name of Object.keys(R1_BOOK_FAKE_ROUTES) as R1BookFakeRoute[]) {
    if (R1_BOOK_FAKE_ROUTES[name] === path) return R1_BOOK_FAKE_METHODS[name] === method ? name : null;
  }
  return null;
}

export function r1BookRouter(state: R1BookMockState): ApiRouter {
  return (method, url, body) => {
    if (url.pathname !== '/api/r1/book' && !url.pathname.startsWith('/api/r1/book/')) return null;
    state.requests.push({ method, path: url.pathname, query: url.search, body });
    const route = routeOf(method, url.pathname);
    // A path or method the pages do not call: the harness fails the test loudly.
    if (route === null) return null;

    // 1. The switch, before anything else (no read of the request at all).
    if (state.disabled) return refuse(503, 'booking_disabled');

    const forced = (): MockResponse | null => {
      const failure = state.failures[route];
      if (!failure) return null;
      delete state.failures[route];
      return refuse(failure.status, failure.error);
    };

    /** The manage token names a booking this link may still change. */
    const liveToken = (token: unknown): boolean =>
      token === MANAGE_TOKEN && state.manage !== null && state.manageToken === 'live';

    switch (route) {
      case 'consentTemplate': {
        // A GET takes no input: a body or a query string is refused.
        if (body !== null || url.search !== '') return INVALID();
        return forced() ?? json(200, { ...R1_BOOK_TEMPLATE, version: state.templateVersion });
      }
      case 'slots': {
        if (body !== null || url.search !== '') return INVALID();
        const days = bookGridDays(state);
        return (
          forced()
          ?? json(200, {
            timezone: 'Asia/Kolkata',
            slot_minutes: BOOK_SLOT_MINUTES,
            generated_at: new Date(FROZEN_NOW_MS).toISOString(),
            grid_token: BOOK_GRID_TOKEN,
            fully_booked: !days.some((day) => day.slots.some((slot) => slot.available)),
            days,
          })
        );
      }
      case 'book': {
        // 2. The strict body.
        if (!bookShapeOk(body)) return INVALID();
        const failure = forced();
        if (failure) return failure;
        // 3. Not the grid that was served (a stale or forged one).
        if (body.grid_token !== BOOK_GRID_TOKEN) return refuse(409, 'slot_unavailable');
        // 4. The honeypot: the one not-found answer, nothing written.
        if (body.website !== '') return refuse(404, 'not_found');
        // 6. A replay of a request that booked: the same answer, before the slot check.
        const requestId = body.request_id as string;
        const replayed = state.bookings[requestId];
        if (replayed) return json(201, { status: 'booked', start_at: replayed.startAt, end_at: replayed.endAt });
        // 7. The slot, before the person.
        const slot = findSlot(state, body.slot_start);
        if (!slot || !slot.available) return refuse(409, 'slot_unavailable');
        if (state.bookOutcome === 'slot_unavailable_once') {
          state.taken.push(slot.start_at);
          state.bookOutcome = 'booked';
          return refuse(409, 'slot_unavailable');
        }
        // 8. The consent: the newest notice, every purpose and the India tick.
        const consent = body.consent as { template_version: string; consents: string[]; in_india: boolean };
        if (consent.template_version !== state.templateVersion) {
          return refuse(409, 'consent_stale', { template_version: state.templateVersion });
        }
        if (!consentComplete(consent)) return INVALID();
        // 9. The match.
        const email = (body.email as string).trim().toLowerCase();
        if (state.bookOutcome === 'not_found') return refuse(404, 'not_found');
        const holdsOne = Object.values(state.bookings).some((booking) => booking.email === email);
        if (state.bookOutcome === 'already_booked' || holdsOne) return refuse(409, 'already_booked');
        state.bookings[requestId] = { startAt: slot.start_at, endAt: slot.end_at, email };
        return json(201, { status: 'booked', start_at: slot.start_at, end_at: slot.end_at });
      }
      case 'manage': {
        if (!exactKeys(body, ['token']) || typeof body.token !== 'string') return INVALID();
        if (!liveToken(body.token) || state.manage === null) return refuse(404, 'not_found');
        const failure = forced();
        if (failure) return failure;
        const booking = state.manage;
        return json(200, {
          state: booking.state,
          start_at: booking.startAt,
          end_at: booking.endAt,
          can_move: booking.canMove,
          can_cancel: booking.canCancel,
          moves_left: booking.movesLeft,
          consent_current: booking.consentCurrent,
        });
      }
      case 'move': {
        if (
          !exactKeys(body, ['token', 'slot_start', 'grid_token'])
          || typeof body.token !== 'string'
          || typeof body.slot_start !== 'string'
          || typeof body.grid_token !== 'string'
        ) {
          return INVALID();
        }
        if (!liveToken(body.token) || state.manage === null) return refuse(404, 'not_found');
        const failure = forced();
        if (failure) return failure;
        const booking = state.manage;
        if (!booking.canMove || booking.movesLeft < 1 || booking.state !== 'booked') {
          return refuse(409, 'move_not_allowed');
        }
        if (body.grid_token !== BOOK_GRID_TOKEN) return refuse(409, 'slot_unavailable');
        const slot = findSlot(state, body.slot_start);
        // The booking's own time is no move at all: the server has no public word for it.
        if (!slot || !slot.available || slot.start_at === booking.startAt) {
          return refuse(409, 'slot_unavailable');
        }
        booking.startAt = slot.start_at;
        booking.endAt = slot.end_at;
        booking.movesLeft -= 1;
        // The updated invite carries a new manage link: this one is spent.
        state.manageToken = 'rotated';
        return json(200, { status: 'moved', start_at: slot.start_at, end_at: slot.end_at });
      }
      case 'cancel': {
        if (
          !exactKeys(body, ['token', 'withdraw_consent'])
          || typeof body.token !== 'string'
          || typeof body.withdraw_consent !== 'boolean'
        ) {
          return INVALID();
        }
        const cancelledAlready =
          body.token === MANAGE_TOKEN && state.manage !== null && state.manageToken === 'cancelled';
        if (!cancelledAlready && !liveToken(body.token)) return refuse(404, 'not_found');
        const failure = forced();
        if (failure) return failure;
        if (cancelledAlready) return json(200, { status: 'already_cancelled' });
        const booking = state.manage;
        if (booking === null || !booking.canCancel || booking.state !== 'booked') {
          return refuse(409, 'cancel_not_allowed');
        }
        state.manageToken = 'cancelled';
        state.withdrawn = body.withdraw_consent;
        return json(200, { status: 'cancelled' });
      }
      case 'consent': {
        if (!exactKeys(body, ['token', 'consent']) || typeof body.token !== 'string' || !consentShapeOk(body.consent)) {
          return INVALID();
        }
        if (!liveToken(body.token) || state.manage === null) return refuse(404, 'not_found');
        const failure = forced();
        if (failure) return failure;
        const booking = state.manage;
        // The interview has been handed to the bot: too late to change anything.
        if (booking.state !== 'booked') return refuse(409, 'cancel_not_allowed');
        if (body.consent.template_version !== state.templateVersion) {
          return refuse(409, 'consent_stale', { template_version: state.templateVersion });
        }
        if (!consentComplete(body.consent)) return INVALID();
        booking.consentCurrent = true;
        return json(200, { status: 'consented' });
      }
    }
  };
}
