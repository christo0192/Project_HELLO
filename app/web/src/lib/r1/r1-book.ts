/**
 * The pure booking rules of the public `/book` and `/book/manage` pages (M035 S07). No React, no
 * network: the pages call these, and the tests pin them.
 *
 *   - Grid age (D-S07-M5). The page keeps the time it RECEIVED the grid on both of its clocks
 *     (`bookStamp`) and takes the larger age of the two (a monotonic clock may pause while a phone
 *     sleeps). Before a book or move it reloads a grid older than 25 minutes (the server accepts
 *     a grid token for 30), and it never posts a grid younger than 3.5 s: it waits ONCE for the
 *     remainder (the server answers `not_found` to a token younger than 3 s, and the browser's
 *     age of a grid is always below the server's). One sleep, never a loop.
 *   - `request_id` (D-S07-M7). A new UUID v4 for every submit attempt, EXCEPT the resubmit of an
 *     unchanged form after an uncertain outcome, which reuses the id so the server replays the
 *     first booking instead of making a second. A definite refusal or any edit gives a new id
 *     (reusing an id with other details would replay the first booking for someone else).
 *   - Form checks mirror the server's limits (contracts section 6) so a person sees a field
 *     message instead of a refusal. They never decide availability: the grid's `available` does.
 */

import { formatIstLongDayLabel, formatIstTimeRange, istDateOf, type IstDate } from '../ist-datetime';
import type { R1BookGrid, R1BookSlot } from './r1-book-api';

// ── Grid age ──────────────────────────────────────────────────────────────────────────────────

/** Reload a grid older than this before a book or move. */
export const R1_BOOK_GRID_MAX_AGE_MS = 25 * 60_000;

/** Never post a grid younger than this: wait once for the remainder. */
export const R1_BOOK_GRID_MIN_AGE_MS = 3_500;

/**
 * The page's clocks and its one-shot `sleep`. A mutable object so tests can `vi.spyOn` it.
 *   - `now`: monotonic (`performance.now`), immune to a wall clock that is set back. But it may
 *     PAUSE while the device sleeps (Chromium and WebKit on macOS and iOS, Android deep sleep).
 *   - `wallNow`: the wall clock (`Date.now`), which keeps counting through sleep, as the server's
 *     30-minute `grid_token` limit does. The e2e harness freezes it, which only reads as age 0.
 */
export const r1BookClock = {
  now: (): number => performance.now(),
  wallNow: (): number => Date.now(),
  sleep: (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    }),
};

/** One reading of both clocks (`r1BookClock`): when a grid was received, or now. */
export interface R1BookStamp {
  mono: number;
  wall: number;
}

/** Read both clocks now. */
export function bookStamp(): R1BookStamp {
  return { mono: r1BookClock.now(), wall: r1BookClock.wallNow() };
}

/** A stamp for "no grid yet": any decision against it reloads. */
export const R1_BOOK_UNSTAMPED: Readonly<R1BookStamp> = Object.freeze({
  mono: Number.NaN,
  wall: Number.NaN,
});

export type R1BookGridDecision = { action: 'reload' } | { action: 'send'; waitMs: number };

/**
 * What to do with the grid received at `received` before posting at `now`. Each limit reads the
 * clock that errs on its safe side:
 *   - Too old: the LARGER age of the two clocks. The monotonic clock alone under-counts a phone
 *     that slept (the page would post a token the server has already expired and tell the person
 *     their time "was just taken"); the wall clock alone could be set back. A wall clock set
 *     forward only costs one extra grid read.
 *   - Too young: the monotonic age alone. It never runs ahead of real time, so a wall clock that
 *     jumped forward can never skip the wait (a token younger than 3 s is a `not_found`).
 * A negative age reads as 0; an unreadable one reloads.
 */
export function gridDecision(received: R1BookStamp, now: R1BookStamp): R1BookGridDecision {
  const monoAge = now.mono - received.mono;
  const oldest = Math.max(monoAge, now.wall - received.wall);
  if (!Number.isFinite(oldest)) return { action: 'reload' };
  if (Math.max(0, oldest) > R1_BOOK_GRID_MAX_AGE_MS) return { action: 'reload' };
  return { action: 'send', waitMs: Math.max(0, R1_BOOK_GRID_MIN_AGE_MS - Math.max(0, monoAge)) };
}

// ── request_id ────────────────────────────────────────────────────────────────────────────────

/** A lower-case UUID v4. */
export const BOOK_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fresh UUID v4: `crypto.randomUUID` when it gives one, else built from `getRandomValues`. */
export function newBookRequestId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    const id = String(webCrypto.randomUUID()).toLowerCase();
    if (BOOK_REQUEST_ID_RE.test(id)) return id;
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  // Version 4 in the high nibble of byte 6; the RFC 4122 variant (10xx) in byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** What identifies one submit attempt: the typed details, the time, the notice and the trap. */
export interface BookAttemptInput {
  name: string;
  email: string;
  phone: string;
  slotStart: string | null;
  templateVersion: string;
  website: string;
}

/** Equal for two attempts that would send the same booking (surrounding whitespace aside). */
export function bookAttemptKey(input: BookAttemptInput): string {
  return JSON.stringify([
    input.name.trim(),
    input.email.trim(),
    input.phone.trim(),
    input.slotStart,
    input.templateVersion,
    input.website,
  ]);
}

/** The previous submit attempt: its key, its id, and whether its outcome was uncertain. */
export interface BookAttemptMemo {
  key: string;
  requestId: string;
  uncertain: boolean;
}

/** Reuse the previous id only for the same attempt after an uncertain outcome; else mint one. */
export function chooseRequestId(
  memo: BookAttemptMemo | null,
  key: string,
  mint: () => string = newBookRequestId,
): string {
  return memo && memo.uncertain && memo.key === key ? memo.requestId : mint();
}

// ── Form checks ───────────────────────────────────────────────────────────────────────────────

export interface BookFormValues {
  name: string;
  email: string;
  phone: string;
  /** The chosen grid `start_at`, or null. */
  slotStart: string | null;
  /** Purpose type -> ticked. */
  consents: Readonly<Record<string, boolean>>;
  inIndia: boolean;
  /** The honeypot's value (`''` for people). Never checked here: the server reads it. */
  website: string;
}

export type BookFieldError =
  | 'name_required'
  | 'name_too_long'
  | 'email_required'
  | 'email_invalid'
  | 'phone_required'
  | 'phone_invalid'
  | 'slot_required'
  | 'consents_required'
  | 'in_india_required';

export type BookField = 'name' | 'email' | 'phone' | 'slot' | 'consents' | 'in_india';

export type BookFieldErrors = Partial<Record<BookField, BookFieldError>>;

export type BookConsentErrors = Partial<Record<'consents' | 'in_india', BookFieldError>>;

const NAME_MAX = 100;
const EMAIL_MIN = 3;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_MAX = 32;
const PHONE_RE = /^\+?[\d\s().-]+$/;
const PHONE_DIGITS_MIN = 10;
const PHONE_DIGITS_MAX = 15;

function ticked(consents: Readonly<Record<string, boolean>>, type: string): boolean {
  return Object.prototype.hasOwnProperty.call(consents, type) && consents[type] === true;
}

/** The consent rules alone (the manage page's re-consent): every required purpose, and India. */
export function validateConsentOnly(
  consents: Readonly<Record<string, boolean>>,
  inIndia: boolean,
  requiredConsents: readonly string[],
): BookConsentErrors {
  const errors: BookConsentErrors = {};
  if (!requiredConsents.every((type) => ticked(consents, type))) {
    errors.consents = 'consents_required';
  }
  if (inIndia !== true) errors.in_india = 'in_india_required';
  return errors;
}

/** Every field rule of the booking form; `{}` when the form may be sent. */
export function validateBookForm(
  values: BookFormValues,
  requiredConsents: readonly string[],
): BookFieldErrors {
  const errors: BookFieldErrors = {};

  const name = values.name.trim();
  if (name.length === 0) errors.name = 'name_required';
  else if (name.length > NAME_MAX) errors.name = 'name_too_long';

  const email = values.email.trim();
  if (email.length === 0) errors.email = 'email_required';
  else if (email.length < EMAIL_MIN || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    errors.email = 'email_invalid';
  }

  const phone = values.phone.trim();
  const digits = (phone.match(/\d/g) ?? []).length;
  if (phone.length === 0) errors.phone = 'phone_required';
  else if (
    phone.length > PHONE_MAX
    || !PHONE_RE.test(phone)
    || digits < PHONE_DIGITS_MIN
    || digits > PHONE_DIGITS_MAX
  ) {
    errors.phone = 'phone_invalid';
  }

  if (values.slotStart === null || values.slotStart === '') errors.slot = 'slot_required';

  return { ...errors, ...validateConsentOnly(values.consents, values.inIndia, requiredConsents) };
}

// ── Grid reads (the page never computes availability; it reads `available`) ────────────────────

/** The grid slot whose `start_at` is exactly `startAt`, or null. */
export function findBookSlot(grid: R1BookGrid, startAt: string | null): R1BookSlot | null {
  if (startAt === null) return null;
  for (const day of grid.days) {
    for (const slot of day.slots) {
      if (slot.start_at === startAt) return slot;
    }
  }
  return null;
}

/** True when at least one slot of the grid is available. */
export function gridHasOpenSlot(grid: R1BookGrid): boolean {
  return grid.days.some((day) => day.slots.some((slot) => slot.available));
}

/** The first day with an available slot, else the first day, else null. */
export function firstOpenDay(grid: R1BookGrid): IstDate | null {
  const open = grid.days.find((day) => day.slots.some((slot) => slot.available));
  return open?.date ?? grid.days[0]?.date ?? null;
}

/** `Wednesday, 16 September 2026, 10:00–10:45 IST`: a booked or chosen time, in India time. */
export function formatBookSlot(startAt: string, endAt: string): string {
  return `${formatIstLongDayLabel(istDateOf(startAt) ?? '')}, ${formatIstTimeRange(startAt, endAt)}`;
}
