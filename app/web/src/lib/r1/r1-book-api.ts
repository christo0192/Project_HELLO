/**
 * Typed client for the public Dex booking routes (M035 S07; `.gsd/milestones/M035/contracts/
 * public-contracts.md` section 6, served by S06 behind `R1_MEET_PUBLIC_BOOKING_ENABLED`).
 *
 * `/book` (register and book a slot) and `/book/manage` (move, cancel, re-consent from the invite
 * link) are public and unauthenticated. Every path, request field, response field and error word
 * the two pages depend on is declared in THIS file (`R1_BOOK_ROUTES`, `R1_BOOK_CONTRACT`, the
 * `parse*` functions) and nowhere else; `r1-book-contract.test.ts` checks them against
 * `app/api/openapi/openapi.yaml` once the spec documents them.
 *
 * Invariants:
 *   - One transport (D-S07-M1). Every call goes through `r1Request` (the `send` of r1-api.ts):
 *     credentials omitted, so the recruiter's Supabase bearer and cookies are never attached;
 *     `cache: 'no-store'`; `referrerPolicy: 'no-referrer'`; a JSON body only on a POST; only the
 *     machine code of an error (`{error}`) is surfaced, never server prose. This module never
 *     opens a network request of its own.
 *   - Secrets and typed values travel in the JSON body only (D-S07-M8). The manage token, the grid
 *     token, the name, email and phone never go in a URL, a query string or a header. The GET
 *     routes take no input at all.
 *   - Bodies are built key by key from the declared fields, never by spreading a caller's object,
 *     so an extra property on an argument can never reach the server. `name`, `email` and `phone`
 *     are trimmed (the server normalises the rest); `slot_start` is sent byte for byte as the
 *     grid's `start_at`; `website` (the honeypot) is always sent.
 *   - Strict parsers (D-S07-M2). A response is accepted only with every declared field of the
 *     declared type and every enum word known; anything else throws `r1_malformed_response`.
 *     Only declared fields are copied into fresh objects, so an extra `meet_url`, `email`, `name`,
 *     seat count or reason from the server can never reach the page. Extra keys are ignored, not
 *     fatal, so an additive server field is not an outage.
 *   - Closed error words, per route (D-S07-M3). `classifyBookFailure` tells apart only the
 *     `(status, word)` pairs a route declares in `R1_BOOK_CONTRACT`. Any other answer (a 429 from
 *     the `/api/r1` limiter, an unknown word, a known word on the wrong status or route) reads as
 *     `unavailable`. 503 `booking_disabled` reads as "not open", and so does any 401: every
 *     booking route is public, so a 401 only means the API does not serve it yet (before S06).
 *   - Uncertain outcomes (D-S07-M4). For the four POST actions a dropped request (status 0), a
 *     500, 502 or 504, or a malformed 2xx is `uncertain`: the server may have done it. For the
 *     two GETs these are `unavailable`.
 */

import { ApiError } from '../api-client';
import { isIstDate, istDateOf, type IstDate } from '../ist-datetime';
import { parseConsentTemplate, r1Request, type R1ConsentTemplate } from './r1-api';

export const R1_BOOK_ROUTES = Object.freeze({
  consentTemplate: '/api/r1/book/consent-template',
  slots: '/api/r1/book/slots',
  book: '/api/r1/book',
  manage: '/api/r1/book/manage',
  move: '/api/r1/book/manage/move',
  cancel: '/api/r1/book/manage/cancel',
  consent: '/api/r1/book/manage/consent',
});

export type R1BookRouteName = keyof typeof R1_BOOK_ROUTES;

/**
 * What this client sends to, and requires back from, each booking route, and the error words
 * the pages tell apart on it. It is the one statement of the wire contract the pages depend on.
 */
export interface R1BookRouteContract {
  method: 'GET' | 'POST';
  path: string;
  /** Top-level JSON body keys, sent on EVERY call ([] for a GET, which sends no body). */
  request: readonly string[];
  /** Keys of the nested `consent` object, [] when the route takes none. */
  consentKeys: readonly string[];
  /** Success-response fields the parser REQUIRES: it rejects the response without them. */
  response: readonly string[];
  /** Success-response fields read when present. */
  responseOptional: readonly string[];
  /** The `(status, error word)` pairs the pages act on; every other answer is `unavailable`. */
  errors: readonly (readonly [number, string])[];
}

const CONSENT_KEYS = Object.freeze(['template_version', 'consents', 'in_india']);

const GET_ERRORS = Object.freeze([
  Object.freeze([503, 'booking_disabled'] as const),
  Object.freeze([503, 'temporarily_unavailable'] as const),
]);

const bookRoute = (
  name: R1BookRouteName,
  method: R1BookRouteContract['method'],
  shape: Omit<R1BookRouteContract, 'method' | 'path'>,
): R1BookRouteContract =>
  Object.freeze({
    method,
    path: R1_BOOK_ROUTES[name],
    request: Object.freeze([...shape.request]),
    consentKeys: Object.freeze([...shape.consentKeys]),
    response: Object.freeze([...shape.response]),
    responseOptional: Object.freeze([...shape.responseOptional]),
    errors: Object.freeze(shape.errors.map((pair) => Object.freeze([pair[0], pair[1]] as const))),
  });

export const R1_BOOK_CONTRACT: Readonly<Record<R1BookRouteName, R1BookRouteContract>> =
  Object.freeze({
    consentTemplate: bookRoute('consentTemplate', 'GET', {
      request: [],
      consentKeys: [],
      response: ['version', 'locale', 'title', 'body_md', 'required_consents'],
      responseOptional: ['consent_items'],
      errors: GET_ERRORS,
    }),
    slots: bookRoute('slots', 'GET', {
      request: [],
      consentKeys: [],
      response: ['timezone', 'slot_minutes', 'generated_at', 'grid_token', 'fully_booked', 'days'],
      responseOptional: [],
      errors: GET_ERRORS,
    }),
    book: bookRoute('book', 'POST', {
      request: [
        'request_id',
        'name',
        'email',
        'phone',
        'slot_start',
        'grid_token',
        'consent',
        'website',
      ],
      consentKeys: CONSENT_KEYS,
      response: ['status', 'start_at', 'end_at'],
      responseOptional: [],
      errors: [
        [404, 'not_found'],
        [409, 'already_booked'],
        [409, 'slot_unavailable'],
        [409, 'consent_stale'],
        [400, 'invalid_request'],
        [503, 'temporarily_unavailable'],
        [503, 'booking_disabled'],
      ],
    }),
    manage: bookRoute('manage', 'POST', {
      request: ['token'],
      consentKeys: [],
      response: [
        'state',
        'start_at',
        'end_at',
        'can_move',
        'can_cancel',
        'moves_left',
        'consent_current',
      ],
      responseOptional: [],
      errors: [
        [404, 'not_found'],
        [400, 'invalid_request'],
        [503, 'booking_disabled'],
        [503, 'temporarily_unavailable'],
      ],
    }),
    move: bookRoute('move', 'POST', {
      request: ['token', 'slot_start', 'grid_token'],
      consentKeys: [],
      response: ['status', 'start_at', 'end_at'],
      responseOptional: [],
      errors: [
        [404, 'not_found'],
        [409, 'slot_unavailable'],
        [409, 'move_not_allowed'],
        [400, 'invalid_request'],
        [503, 'booking_disabled'],
        [503, 'temporarily_unavailable'],
      ],
    }),
    cancel: bookRoute('cancel', 'POST', {
      request: ['token', 'withdraw_consent'],
      consentKeys: [],
      response: ['status'],
      responseOptional: [],
      errors: [
        [404, 'not_found'],
        [409, 'cancel_not_allowed'],
        [400, 'invalid_request'],
        [503, 'booking_disabled'],
        [503, 'temporarily_unavailable'],
      ],
    }),
    consent: bookRoute('consent', 'POST', {
      request: ['token', 'consent'],
      consentKeys: CONSENT_KEYS,
      response: ['status'],
      responseOptional: [],
      errors: [
        [404, 'not_found'],
        [409, 'consent_stale'],
        [409, 'cancel_not_allowed'],
        [400, 'invalid_request'],
        [503, 'booking_disabled'],
        [503, 'temporarily_unavailable'],
      ],
    }),
  });

/** Every error word any booking route declares, sorted and unique. */
export const R1_BOOK_ERROR_WORDS: readonly string[] = Object.freeze(
  [
    ...new Set(
      Object.values(R1_BOOK_CONTRACT).flatMap((contract) => contract.errors.map((pair) => pair[1])),
    ),
  ].sort(),
);

// ── Page-facing models (only the declared fields, copied into fresh objects) ──────────────────

/** One bookable time. `available` is all the page reads: never a seat count or a reason. */
export interface R1BookSlot {
  start_at: string;
  end_at: string;
  available: boolean;
}

export interface R1BookDay {
  date: IstDate;
  slots: readonly R1BookSlot[];
}

/** `GET /api/r1/book/slots`: the IST grid the page shows. It never computes availability. */
export interface R1BookGrid {
  slot_minutes: number;
  /** Sent back unchanged with a book or move (the server's proof of which grid was shown). */
  grid_token: string;
  fully_booked: boolean;
  days: readonly R1BookDay[];
}

/** `POST /api/r1/book` 201 (a new booking or a replay of the same `request_id`). */
export interface R1BookBooked {
  start_at: string;
  end_at: string;
}

/** `POST /api/r1/book/manage` 200: the booking as the manage link may see it. */
export interface R1BookManageView {
  state: 'booked' | 'in_progress';
  start_at: string;
  end_at: string;
  can_move: boolean;
  can_cancel: boolean;
  moves_left: number;
  /** False when the notice changed since the person agreed: the page asks again. */
  consent_current: boolean;
}

/** `POST /api/r1/book/manage/move` 200. */
export interface R1BookMoved {
  start_at: string;
  end_at: string;
}

/** `POST /api/r1/book/manage/cancel` 200: both words mean the interview is cancelled. */
export type R1BookCancelled = 'cancelled' | 'already_cancelled';

/** The candidate's own consent from the form: every required purpose and the India tick. */
export interface R1BookConsentInput {
  template_version: string;
  /** The template's `required_consents`, in template order. */
  consents: readonly string[];
  in_india: true;
}

/** Exactly what `POST /api/r1/book` sends. */
export interface R1BookSubmission {
  /** A UUID v4 per submit attempt, reused only to retry the same attempt after an uncertain outcome. */
  request_id: string;
  name: string;
  email: string;
  phone: string;
  /** The grid's `start_at` string, byte for byte. */
  slot_start: string;
  /** The `grid_token` of the grid that was shown. */
  grid_token: string;
  consent: R1BookConsentInput;
  /** The honeypot's value: always sent, `''` for people. */
  website: string;
}

// ── Strict parsers ────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** `g1.<issued_at epoch ms, 13 digits>.<43-character base64url MAC>` (contracts section 6). */
const GRID_TOKEN_RE = /^g1\.\d{13}\.[A-Za-z0-9_-]{43}$/;

/** An ISO-8601 instant that names its zone (`Z` or an offset): never a bare local time. */
const ZONED_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const MAX_DAYS = 14;
const MAX_SLOTS_PER_DAY = 96;
const MAX_MOVES_LEFT = 10;

const MANAGE_STATES: readonly string[] = ['booked', 'in_progress'];
const CANCELLED_STATUSES: readonly string[] = ['cancelled', 'already_cancelled'];

function malformed(): never {
  throw new ApiError('r1_malformed_response', 500);
}

function requireRecord(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : malformed();
}

function requireBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : malformed();
}

function requireInteger(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : malformed();
}

function requireInstant(value: unknown): string {
  return typeof value === 'string'
    && ZONED_INSTANT_RE.test(value)
    && Number.isFinite(Date.parse(value))
    ? value
    : malformed();
}

/** A zoned start and end, the end strictly after the start. */
function requireSpan(body: Json): { start_at: string; end_at: string } {
  const startAt = requireInstant(body.start_at);
  const endAt = requireInstant(body.end_at);
  if (Date.parse(endAt) <= Date.parse(startAt)) malformed();
  return { start_at: startAt, end_at: endAt };
}

/** `GET /api/r1/book/consent-template`: the candidate notice, en-IN only. */
export function parseBookConsentTemplate(data: unknown): R1ConsentTemplate {
  const template = parseConsentTemplate(data);
  if (template.locale !== 'en-IN') malformed();
  return template;
}

/** `GET /api/r1/book/slots`: every rule of the grid, or `r1_malformed_response`. */
export function parseBookSlots(data: unknown): R1BookGrid {
  const body = requireRecord(data);
  if (body.timezone !== 'Asia/Kolkata') malformed();
  const slotMinutes = requireInteger(body.slot_minutes, 30, 60);
  requireInstant(body.generated_at);
  const gridToken =
    typeof body.grid_token === 'string' && GRID_TOKEN_RE.test(body.grid_token)
      ? body.grid_token
      : malformed();
  const fullyBooked = requireBoolean(body.fully_booked);
  if (!Array.isArray(body.days) || body.days.length > MAX_DAYS) malformed();
  const days: R1BookDay[] = [];
  let previousDate: string | null = null;
  for (const rawDay of body.days as unknown[]) {
    const day = requireRecord(rawDay);
    const date = isIstDate(day.date) ? day.date : malformed();
    // `YYYY-MM-DD` sorts as text in calendar order.
    if (previousDate !== null && date <= previousDate) malformed();
    previousDate = date;
    if (!Array.isArray(day.slots) || day.slots.length > MAX_SLOTS_PER_DAY) malformed();
    const slots: R1BookSlot[] = [];
    let previousStartMs: number | null = null;
    for (const rawSlot of day.slots as unknown[]) {
      const slot = requireRecord(rawSlot);
      const span = requireSpan(slot);
      const available = requireBoolean(slot.available);
      if (istDateOf(span.start_at) !== date) malformed();
      const startMs = Date.parse(span.start_at);
      if (previousStartMs !== null && startMs <= previousStartMs) malformed();
      previousStartMs = startMs;
      slots.push({ start_at: span.start_at, end_at: span.end_at, available });
    }
    days.push({ date, slots });
  }
  return { slot_minutes: slotMinutes, grid_token: gridToken, fully_booked: fullyBooked, days };
}

/** `POST /api/r1/book` 201. */
export function parseBooked(data: unknown): R1BookBooked {
  const body = requireRecord(data);
  if (body.status !== 'booked') malformed();
  return requireSpan(body);
}

/** `POST /api/r1/book/manage/move` 200. */
export function parseMoved(data: unknown): R1BookMoved {
  const body = requireRecord(data);
  if (body.status !== 'moved') malformed();
  return requireSpan(body);
}

/** `POST /api/r1/book/manage/cancel` 200: `cancelled`, or `already_cancelled` on a repeat. */
export function parseCancelled(data: unknown): R1BookCancelled {
  const body = requireRecord(data);
  const status = body.status;
  return typeof status === 'string' && CANCELLED_STATUSES.includes(status)
    ? (status as R1BookCancelled)
    : malformed();
}

/** `POST /api/r1/book/manage/consent` 200. */
export function parseConsented(data: unknown): 'consented' {
  const body = requireRecord(data);
  return body.status === 'consented' ? 'consented' : malformed();
}

/** `POST /api/r1/book/manage` 200. */
export function parseManage(data: unknown): R1BookManageView {
  const body = requireRecord(data);
  const state = body.state;
  if (typeof state !== 'string' || !MANAGE_STATES.includes(state)) malformed();
  const span = requireSpan(body);
  return {
    state: state as R1BookManageView['state'],
    start_at: span.start_at,
    end_at: span.end_at,
    can_move: requireBoolean(body.can_move),
    can_cancel: requireBoolean(body.can_cancel),
    // A display hint only. §4.1 #5 computes it as `max_moves - move_count` (both 0..10) without a
    // floor, so a lowered R1_MEET_PUBLIC_MAX_MOVES can make it negative: read that as 0 rather
    // than refuse the whole answer (and with it the cancel and the consent withdrawal).
    moves_left: Math.max(0, requireInteger(body.moves_left, -MAX_MOVES_LEFT, MAX_MOVES_LEFT)),
    consent_current: requireBoolean(body.consent_current),
  };
}

// ── Failure classification ────────────────────────────────────────────────────────────────────

/** What a refused or failed booking call means to the pages. */
export type R1BookFailure =
  | 'disabled'
  | 'unavailable'
  | 'uncertain'
  | 'not_found'
  | 'already_booked'
  | 'slot_unavailable'
  | 'consent_stale'
  | 'invalid'
  | 'not_allowed';

const FAILURE_OF_WORD: Readonly<Record<string, R1BookFailure>> = Object.freeze({
  booking_disabled: 'disabled',
  temporarily_unavailable: 'unavailable',
  not_found: 'not_found',
  already_booked: 'already_booked',
  slot_unavailable: 'slot_unavailable',
  consent_stale: 'consent_stale',
  invalid_request: 'invalid',
  move_not_allowed: 'not_allowed',
  cancel_not_allowed: 'not_allowed',
});

/** A dropped request or a gateway failure: the server may or may not have acted. */
const UNSURE_STATUSES: readonly number[] = [0, 500, 502, 504];

/**
 * Map a thrown value from `route` to the closed set the pages explain (D-S07-M3, D-S07-M4).
 * Only the `(status, word)` pairs the route declares are told apart; everything else is
 * `unavailable`, except an outcome the server may have acted on, which is `uncertain` for a POST.
 */
export function classifyBookFailure(route: R1BookRouteName, error: unknown): R1BookFailure {
  const contract = R1_BOOK_CONTRACT[route];
  const unsure: R1BookFailure = contract.method === 'POST' ? 'uncertain' : 'unavailable';
  if (!(error instanceof ApiError)) return unsure;
  // Every booking route is public (`security: []`): a 401 means the API does not serve it as a
  // public route yet, so booking has not opened. Nothing was done; there is nothing to retry.
  if (error.status === 401) return 'disabled';
  if (error.message === 'r1_malformed_response' || UNSURE_STATUSES.includes(error.status)) {
    return unsure;
  }
  const declared = contract.errors.some(
    (pair) => pair[0] === error.status && pair[1] === error.message,
  );
  if (declared && Object.prototype.hasOwnProperty.call(FAILURE_OF_WORD, error.message)) {
    return FAILURE_OF_WORD[error.message] as R1BookFailure;
  }
  return 'unavailable';
}

// ── Calls ─────────────────────────────────────────────────────────────────────────────────────

const call = (name: R1BookRouteName, body?: Json): Promise<unknown> =>
  r1Request(R1_BOOK_CONTRACT[name].method, R1_BOOK_CONTRACT[name].path, body);

function consentBody(consent: R1BookConsentInput): Json {
  return {
    template_version: consent.template_version,
    consents: [...consent.consents],
    in_india: consent.in_india,
  };
}

function bookBody(submission: R1BookSubmission): Json {
  return {
    request_id: submission.request_id,
    name: submission.name.trim(),
    email: submission.email.trim(),
    phone: submission.phone.trim(),
    slot_start: submission.slot_start,
    grid_token: submission.grid_token,
    consent: consentBody(submission.consent),
    website: submission.website,
  };
}

export const r1BookApi = {
  /** The newest active en-IN candidate notice. No input: nothing about the person is sent. */
  consentTemplate: async (): Promise<R1ConsentTemplate> =>
    parseBookConsentTemplate(await call('consentTemplate')),

  /** The IST grid of bookable times. No input. */
  slots: async (): Promise<R1BookGrid> => parseBookSlots(await call('slots')),

  /** Register and book. The typed details travel in the body only. */
  book: async (submission: R1BookSubmission): Promise<R1BookBooked> =>
    parseBooked(await call('book', bookBody(submission))),

  /** Read the booking the manage token names. */
  manage: async (token: string): Promise<R1BookManageView> =>
    parseManage(await call('manage', { token })),

  /** Move the booking to another time of the grid that was shown. */
  move: async (token: string, slotStart: string, gridToken: string): Promise<R1BookMoved> =>
    parseMoved(await call('move', { token, slot_start: slotStart, grid_token: gridToken })),

  /** Cancel the booking, and withdraw the consent too when the person ticked that box. */
  cancel: async (token: string, withdrawConsent: boolean): Promise<R1BookCancelled> =>
    parseCancelled(await call('cancel', { token, withdraw_consent: withdrawConsent === true })),

  /** Agree again after the notice changed. */
  consent: async (token: string, consent: R1BookConsentInput): Promise<'consented'> =>
    parseConsented(await call('consent', { token, consent: consentBody(consent) })),
};
