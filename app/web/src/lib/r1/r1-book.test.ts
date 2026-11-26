import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import {
  formatIstLongDayLabel,
  formatIstTimeRange,
  istDateOf,
  istWallClockUtcIso,
} from '../ist-datetime';
import type { R1BookGrid } from './r1-book-api';
import {
  BOOK_REQUEST_ID_RE,
  bookAttemptKey,
  chooseRequestId,
  findBookSlot,
  firstOpenDay,
  formatBookSlot,
  gridDecision,
  gridHasOpenSlot,
  newBookRequestId,
  R1_BOOK_GRID_MAX_AGE_MS,
  R1_BOOK_GRID_MIN_AGE_MS,
  r1BookClock,
  validateBookForm,
  validateConsentOnly,
  type BookAttemptInput,
  type BookFormValues,
} from './r1-book';

/**
 * The pure booking rules (M035 S07): grid age (D-S07-M5), `request_id` choice (D-S07-M7), the
 * form checks and the grid reads. Expected time strings are computed with the ist-datetime
 * helpers, never hard-coded (the Windows ICU differs).
 */

const DAY_1 = '2026-09-16';
const DAY_2 = '2026-09-17';
const DAY_3 = '2026-09-18';
const REQUIRED = ['ai_interview', 'recording'];

const at = (date: string, hour: number, minute: number): string =>
  istWallClockUtcIso(date, hour, minute);
const plus45 = (iso: string): string => new Date(Date.parse(iso) + 45 * 60_000).toISOString();
const slot = (date: string, hour: number, minute: number, available: boolean) => ({
  start_at: at(date, hour, minute),
  end_at: plus45(at(date, hour, minute)),
  available,
});

function makeGrid(days: R1BookGrid['days']): R1BookGrid {
  return { slot_minutes: 45, grid_token: `g1.${Date.UTC(2026, 8, 16)}.${'g'.repeat(43)}`, fully_booked: false, days };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('grid age', () => {
  it('reloads after 25 minutes and waits for a 3.5 second minimum', () => {
    expect(R1_BOOK_GRID_MAX_AGE_MS).toBe(25 * 60_000);
    expect(R1_BOOK_GRID_MIN_AGE_MS).toBe(3_500);
  });

  it.each([
    ['age 0', 10_000, 10_000, { action: 'send', waitMs: 3_500 }],
    ['age 1 s', 10_000, 11_000, { action: 'send', waitMs: 2_500 }],
    ['age 3.5 s', 10_000, 13_500, { action: 'send', waitMs: 0 }],
    ['age 5 s', 10_000, 15_000, { action: 'send', waitMs: 0 }],
    ['age 25 min', 10_000, 10_000 + 25 * 60_000, { action: 'send', waitMs: 0 }],
    ['age 25 min + 1 ms', 10_000, 10_001 + 25 * 60_000, { action: 'reload' }],
    ['age 2 h', 0, 2 * 60 * 60_000, { action: 'reload' }],
    ['a negative age (read as 0)', 10_000, 9_000, { action: 'send', waitMs: 3_500 }],
    ['an unreadable age', Number.NaN, 10_000, { action: 'reload' }],
  ])('%s', (_name, receivedAt, now, expected) => {
    expect(gridDecision(receivedAt, now)).toEqual(expected);
  });

  it('reads the monotonic clock and sleeps once with a timer', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1234.5);
    expect(r1BookClock.now()).toBe(1234.5);
    vi.useFakeTimers();
    let done = false;
    const sleeping = r1BookClock.sleep(2_500).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });
});

describe('newBookRequestId', () => {
  it('returns a lower-case UUID v4 from randomUUID, a new one each time', () => {
    const first = newBookRequestId();
    const second = newBookRequestId();
    expect(first).toMatch(BOOK_REQUEST_ID_RE);
    expect(second).toMatch(BOOK_REQUEST_ID_RE);
    expect(first).not.toBe(second);
  });

  it('lower-cases an upper-case randomUUID', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '3F2B8C1E-9A4D-4C7B-8E2F-1A2B3C4D5E6F' as ReturnType<Crypto['randomUUID']>,
    );
    expect(newBookRequestId()).toBe('3f2b8c1e-9a4d-4c7b-8e2f-1a2b3c4d5e6f');
  });

  it.each([
    ['not a UUID', 'not-a-uuid'],
    ['a version 1 UUID', '3f2b8c1e-9a4d-1c7b-8e2f-1a2b3c4d5e6f'],
    ['a wrong variant', '3f2b8c1e-9a4d-4c7b-cf2f-1a2b3c4d5e6f'],
    ['an empty string', ''],
  ])('falls back to getRandomValues when randomUUID returns %s', (_name, value) => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(value as ReturnType<Crypto['randomUUID']>);
    const id = newBookRequestId();
    expect(id).toMatch(BOOK_REQUEST_ID_RE);
    expect(id).not.toBe(value);
  });

  it('builds a v4 from getRandomValues when randomUUID is absent, setting version and variant', () => {
    const fill = (byte: number) => ({
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(byte);
        return array;
      },
    });
    vi.stubGlobal('crypto', fill(0xff));
    expect(newBookRequestId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    vi.stubGlobal('crypto', fill(0x00));
    expect(newBookRequestId()).toBe('00000000-0000-4000-8000-000000000000');
    vi.stubGlobal('crypto', fill(0x5a));
    const id = newBookRequestId();
    expect(id).toMatch(BOOK_REQUEST_ID_RE);
    expect(id).toBe('5a5a5a5a-5a5a-4a5a-9a5a-5a5a5a5a5a5a');
  });
});

describe('request_id reuse', () => {
  const BASE: BookAttemptInput = {
    name: 'Asha Rao',
    email: 'asha.rao@example.com',
    phone: '+91 98765 43210',
    slotStart: at(DAY_1, 9, 0),
    templateVersion: 'r1-public-2026-11',
    website: '',
  };

  it('keys an attempt by its six inputs, ignoring whitespace around the typed details', () => {
    const key = bookAttemptKey(BASE);
    expect(
      bookAttemptKey({
        ...BASE,
        name: `  ${BASE.name} `,
        email: `\t${BASE.email}`,
        phone: `${BASE.phone}  `,
      }),
    ).toBe(key);
    const changed: BookAttemptInput[] = [
      { ...BASE, name: 'Asha R' },
      { ...BASE, email: 'asha@example.com' },
      { ...BASE, phone: '+91 98765 43211' },
      { ...BASE, slotStart: at(DAY_1, 9, 30) },
      { ...BASE, slotStart: null },
      { ...BASE, templateVersion: 'r1-public-2026-12' },
      { ...BASE, website: 'x' },
      { ...BASE, website: ' ' },
    ];
    for (const input of changed) expect(bookAttemptKey(input)).not.toBe(key);
  });

  it('never confuses fields that join into the same text', () => {
    expect(bookAttemptKey({ ...BASE, name: 'a b', email: 'c' })).not.toBe(
      bookAttemptKey({ ...BASE, name: 'a', email: 'b c' }),
    );
  });

  it('reuses the id only after an uncertain outcome of the same attempt', () => {
    const key = bookAttemptKey(BASE);
    const mint = vi.fn(() => 'minted-id');
    expect(chooseRequestId(null, key, mint)).toBe('minted-id');
    expect(chooseRequestId({ key, requestId: 'first-id', uncertain: true }, key, mint)).toBe('first-id');
    expect(
      chooseRequestId({ key: bookAttemptKey({ ...BASE, phone: '9876543210' }), requestId: 'first-id', uncertain: true }, key, mint),
    ).toBe('minted-id');
    expect(chooseRequestId({ key, requestId: 'first-id', uncertain: false }, key, mint)).toBe('minted-id');
    expect(mint).toHaveBeenCalledTimes(3);
  });

  it('mints a real UUID by default', () => {
    expect(chooseRequestId(null, 'key')).toMatch(BOOK_REQUEST_ID_RE);
  });
});

describe('validateBookForm', () => {
  const VALID: BookFormValues = {
    name: 'Asha Rao',
    email: 'asha.rao@example.com',
    phone: '+91 98765 43210',
    slotStart: at(DAY_1, 9, 0),
    consents: { ai_interview: true, recording: true },
    inIndia: true,
    website: '',
  };

  it('accepts a complete form', () => {
    expect(validateBookForm(VALID, REQUIRED)).toEqual({});
    expect(validateBookForm({ ...VALID, name: `  ${'a'.repeat(100)}  ` }, REQUIRED)).toEqual({});
    expect(validateBookForm({ ...VALID, email: 'a@b.co' }, REQUIRED)).toEqual({});
    expect(validateBookForm({ ...VALID, phone: '9876543210' }, REQUIRED)).toEqual({});
    expect(validateBookForm({ ...VALID, phone: '+91 (98765) 432-10' }, REQUIRED)).toEqual({});
    expect(validateBookForm({ ...VALID, phone: '123456789012345' }, REQUIRED)).toEqual({});
    expect(validateBookForm({ ...VALID, website: 'not checked here' }, REQUIRED)).toEqual({});
  });

  it('reports every field of an empty form', () => {
    expect(
      validateBookForm(
        { name: '', email: '', phone: '', slotStart: null, consents: {}, inIndia: false, website: '' },
        REQUIRED,
      ),
    ).toEqual({
      name: 'name_required',
      email: 'email_required',
      phone: 'phone_required',
      slot: 'slot_required',
      consents: 'consents_required',
      in_india: 'in_india_required',
    });
  });

  it.each([
    ['a blank name', { name: '   ' }, { name: 'name_required' }],
    ['a name over 100 characters', { name: 'a'.repeat(101) }, { name: 'name_too_long' }],
    ['a blank email', { email: ' \t ' }, { email: 'email_required' }],
    ['an email without a domain dot', { email: 'a@b' }, { email: 'email_invalid' }],
    ['an email without @', { email: 'asha.example.com' }, { email: 'email_invalid' }],
    ['an email with two @', { email: 'asha@@example.com' }, { email: 'email_invalid' }],
    ['an email with a space', { email: 'asha rao@example.com' }, { email: 'email_invalid' }],
    ['an email over 254 characters', { email: `${'a'.repeat(249)}@b.com` }, { email: 'email_invalid' }],
    ['a blank phone', { phone: '  ' }, { phone: 'phone_required' }],
    ['a phone of 9 digits', { phone: '987654321' }, { phone: 'phone_invalid' }],
    ['a phone of 16 digits', { phone: '1234567890123456' }, { phone: 'phone_invalid' }],
    ['a phone with letters', { phone: '98765 43210 ext' }, { phone: 'phone_invalid' }],
    ['a phone with two plus signs', { phone: '++91 98765 43210' }, { phone: 'phone_invalid' }],
    ['a phone over 32 characters', { phone: `+91${' '.repeat(30)}9876543210` }, { phone: 'phone_invalid' }],
    ['no time', { slotStart: null }, { slot: 'slot_required' }],
    ['an empty time', { slotStart: '' }, { slot: 'slot_required' }],
    ['one purpose unticked', { consents: { ai_interview: true, recording: false } }, { consents: 'consents_required' }],
    ['one purpose missing', { consents: { ai_interview: true } }, { consents: 'consents_required' }],
    ['other purposes ticked instead', { consents: { marketing: true, ai_interview: true } }, { consents: 'consents_required' }],
    ['India not confirmed', { inIndia: false }, { in_india: 'in_india_required' }],
  ] as Array<[string, Partial<BookFormValues>, Record<string, string>]>)(
    'reports %s',
    (_name, change, expected) => {
      expect(validateBookForm({ ...VALID, ...change }, REQUIRED)).toEqual(expected);
    },
  );

  it('never reads an inherited property as a ticked purpose', () => {
    const inherited = Object.create({ recording: true }) as Record<string, boolean>;
    inherited.ai_interview = true;
    expect(validateBookForm({ ...VALID, consents: inherited }, REQUIRED)).toEqual({
      consents: 'consents_required',
    });
  });
});

describe('validateConsentOnly', () => {
  it('checks only the purposes and the India tick', () => {
    expect(validateConsentOnly({ ai_interview: true, recording: true }, true, REQUIRED)).toEqual({});
    expect(validateConsentOnly({ ai_interview: true }, true, REQUIRED)).toEqual({
      consents: 'consents_required',
    });
    expect(validateConsentOnly({ ai_interview: true, recording: true }, false, REQUIRED)).toEqual({
      in_india: 'in_india_required',
    });
    expect(validateConsentOnly({}, false, REQUIRED)).toEqual({
      consents: 'consents_required',
      in_india: 'in_india_required',
    });
  });
});

describe('grid reads', () => {
  const OPEN_LATER = makeGrid([
    { date: DAY_1, slots: [slot(DAY_1, 9, 0, false), slot(DAY_1, 9, 30, false)] },
    { date: DAY_2, slots: [slot(DAY_2, 10, 0, false), slot(DAY_2, 10, 30, true)] },
    { date: DAY_3, slots: [slot(DAY_3, 11, 0, true)] },
  ]);
  const ALL_TAKEN = makeGrid([
    { date: DAY_1, slots: [slot(DAY_1, 9, 0, false)] },
    { date: DAY_2, slots: [] },
  ]);
  const EMPTY = makeGrid([]);

  it('finds the first day with a free time, else the first day, else nothing', () => {
    expect(firstOpenDay(OPEN_LATER)).toBe(DAY_2);
    expect(firstOpenDay(ALL_TAKEN)).toBe(DAY_1);
    expect(firstOpenDay(EMPTY)).toBeNull();
  });

  it('says whether any time is free', () => {
    expect(gridHasOpenSlot(OPEN_LATER)).toBe(true);
    expect(gridHasOpenSlot(ALL_TAKEN)).toBe(false);
    expect(gridHasOpenSlot(EMPTY)).toBe(false);
  });

  it('finds a slot by its exact start string only', () => {
    const start = at(DAY_2, 10, 30);
    expect(findBookSlot(OPEN_LATER, start)).toEqual(slot(DAY_2, 10, 30, true));
    expect(findBookSlot(OPEN_LATER, at(DAY_1, 9, 0))).toEqual(slot(DAY_1, 9, 0, false));
    // The same instant written another way is not the grid's string.
    expect(findBookSlot(OPEN_LATER, '2026-09-17T10:30:00+05:30')).toBeNull();
    expect(findBookSlot(OPEN_LATER, at(DAY_3, 20, 30))).toBeNull();
    expect(findBookSlot(OPEN_LATER, null)).toBeNull();
    expect(findBookSlot(EMPTY, start)).toBeNull();
  });

  it('formats a time as the long IST day and the IST range', () => {
    const start = at(DAY_2, 10, 30);
    const end = plus45(start);
    expect(formatBookSlot(start, end)).toBe(
      `${formatIstLongDayLabel(istDateOf(start) ?? '')}, ${formatIstTimeRange(start, end)}`,
    );
    expect(formatBookSlot(start, end)).toContain('IST');
    expect(formatBookSlot('soon', 'later')).toBe(
      `${formatIstLongDayLabel('')}, ${formatIstTimeRange('soon', 'later')}`,
    );
  });
});
