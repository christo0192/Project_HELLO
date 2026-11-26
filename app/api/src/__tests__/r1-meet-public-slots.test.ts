/**
 * M035 S04 T3: the public booking page's IST slot grid (lib/r1/meet/public/slots.ts; D-S04-2,
 * D-S04-3, D-S04-19..D-S04-21).
 *
 * The grid is a pure projection of the R1 caps: one stable reason per slot, first match wins
 * (fully_booked > closed_date > notice > not_offered > day_full > slot_full > open), half-open
 * overlap counting, a strict notice edge and 0142's 14-day expiry bound. The module may not import
 * lib/phone-screening (r1-scorer-isolation), so its fixed-offset IST arithmetic is pinned here
 * against the Intl helpers of lib/phone-screening/ist-window.ts and against `r1MeetIstDay`; a test
 * file may import anything.
 *
 * Every expected instant below is derived through Intl (`istWallClockToInstant`), never through the
 * module under test. 2026-11-26 is a Thursday.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { istDate, istWallClockToInstant } from '../lib/phone-screening/ist-window.js';
import { istDayInstantRange } from '../lib/phone-screening/slots.js';
import { R1_MEET_ROUND_EXPIRY_GRACE_SEC, r1MeetIstDay } from '../lib/r1/meet/runtime-store.js';
import {
  R1_PUBLIC_EARLIEST_START_MINUTE_IST,
  R1_PUBLIC_EXPIRY_GRACE_SEC,
  R1_PUBLIC_GRID_MAX_HORIZON_DAYS,
  R1_PUBLIC_MAX_EXPIRY_AHEAD_MS,
  R1_PUBLIC_SLOT_REASONS,
  buildR1PublicSlotGrid,
  findR1PublicSlot,
  r1PublicSlotSeats,
  r1PublicSlotWindow,
  type R1MeetPublicSlotRules,
  type R1PublicSlot,
  type R1PublicSlotGrid,
  type R1PublicSlotGridInput,
} from '../lib/r1/meet/public/slots.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const CODE = 'r1_public_slot_input_invalid';

/** The contract's §2 field order. */
const SECTION_2_FIELDS = [
  'slotMinutes',
  'stepMinutes',
  'firstStartMinuteIst',
  'lastStartMinuteIst',
  'isoWeekdays',
  'closedDates',
  'minNoticeMinutes',
  'horizonDays',
  'slotCapacity',
  'browserHeadroom',
  'publicDailyCap',
];

/** The §2 defaults: 45-minute slots every 30 minutes, 09:00..20:30 starts, every day, 1 h notice. */
const DEFAULT_RULES = Object.freeze({
  slotMinutes: 45,
  stepMinutes: 30,
  firstStartMinuteIst: 540,
  lastStartMinuteIst: 1230,
  isoWeekdays: Object.freeze([1, 2, 3, 4, 5, 6, 7]),
  closedDates: Object.freeze([] as string[]),
  minNoticeMinutes: 60,
  horizonDays: 7,
  slotCapacity: 2,
  browserHeadroom: 0,
  publicDailyCap: 20,
}) satisfies R1MeetPublicSlotRules;

const rules = (o: Partial<R1MeetPublicSlotRules> = {}): R1MeetPublicSlotRules => ({ ...DEFAULT_RULES, ...o });

/** Split `YYYY-MM-DD`. */
const ymd = (date: string): [number, number, number] => {
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m!, d!];
};

/** The instant of an IST wall clock `HH:MM` on `date`, through Intl, plus `extraMs`. */
const ist = (date: string, hhmm: string, extraMs = 0): number => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return istWallClockToInstant(...ymd(date), hh! * 3600 + mm! * 60).getTime() + extraMs;
};
const isoAt = (date: string, hhmm: string, extraMs = 0): string => new Date(ist(date, hhmm, extraMs)).toISOString();
/** The same instant written with the IST offset instead of Z (test-side only). */
const offsetForm = (ms: number): string =>
  new Date(ms + (5 * 60 + 30) * MIN).toISOString().replace(/Z$/, '+05:30');
/** The IST date `offset` days after `date` (calendar arithmetic, no time zone). */
const addDays = (date: string, offset: number): string => {
  const [y, m, d] = ymd(date);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
};
const isoWeekday = (date: string): number => {
  const [y, m, d] = ymd(date);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
};

const NOW = ist('2026-11-26', '08:00'); // Thursday, 08:00 IST

const grid = (o: Partial<R1PublicSlotGridInput> = {}): R1PublicSlotGrid =>
  buildR1PublicSlotGrid({
    nowMs: NOW,
    rules: DEFAULT_RULES,
    dailyBotCap: 20,
    effectiveConcurrency: 2,
    admits: true,
    intervals: [],
    dayCounts: {},
    ...o,
  });

const dayOf = (g: R1PublicSlotGrid, date: string) => {
  const day = g.days.find((d) => d.date === date);
  if (!day) throw new Error(`no day ${date}`);
  return day;
};
const slotAt = (g: R1PublicSlotGrid, date: string, hhmm: string): R1PublicSlot => {
  const at = isoAt(date, hhmm);
  const slot = dayOf(g, date).slots.find((s) => s.startAt === at);
  if (!slot) throw new Error(`no slot ${date} ${hhmm}`);
  return slot;
};
const allSlots = (g: R1PublicSlotGrid): R1PublicSlot[] => g.days.flatMap((d) => [...d.slots]);
const booking = (date: string, from: string, to: string) => ({ startAt: isoAt(date, from), endAt: isoAt(date, to) });

const expectInvalid = (run: () => unknown): void => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(CODE);
  expect(String(caught)).toBe(`Error: ${CODE}`);
};

// ── Exports and type pins ────────────────────────────────────────────────────

describe('the exports', () => {
  it('lists the reasons in the contract §7.2 order, frozen', () => {
    expect([...R1_PUBLIC_SLOT_REASONS]).toEqual([
      'open',
      'slot_full',
      'day_full',
      'notice',
      'closed_date',
      'not_offered',
      'fully_booked',
    ]);
    expect(Object.isFrozen(R1_PUBLIC_SLOT_REASONS)).toBe(true);
  });

  it('pins the constants', () => {
    expect(R1_PUBLIC_EARLIEST_START_MINUTE_IST).toBe(9 * 60);
    expect(R1_PUBLIC_EXPIRY_GRACE_SEC).toBe(7200);
    expect(R1_PUBLIC_MAX_EXPIRY_AHEAD_MS).toBe(14 * DAY);
    expect(R1_PUBLIC_GRID_MAX_HORIZON_DAYS).toBe(15);
  });

  it('declares R1MeetPublicSlotRules with exactly the eleven §2 fields, in order', () => {
    // A Record over keyof fails to compile on a missing field and on an extra one.
    const exact: Record<keyof R1MeetPublicSlotRules, true> = {
      slotMinutes: true,
      stepMinutes: true,
      firstStartMinuteIst: true,
      lastStartMinuteIst: true,
      isoWeekdays: true,
      closedDates: true,
      minNoticeMinutes: true,
      horizonDays: true,
      slotCapacity: true,
      browserHeadroom: true,
      publicDailyCap: true,
    };
    expect(Object.keys(exact)).toEqual(SECTION_2_FIELDS);
    expect(Object.keys(DEFAULT_RULES)).toEqual(SECTION_2_FIELDS);
    const literal = {
      slotMinutes: 45,
      stepMinutes: 30,
      firstStartMinuteIst: 540,
      lastStartMinuteIst: 1230,
      isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
      closedDates: ['2026-12-25'],
      minNoticeMinutes: 60,
      horizonDays: 7,
      slotCapacity: 2,
      browserHeadroom: 0,
      publicDailyCap: 20,
    } satisfies R1MeetPublicSlotRules;
    expect(Object.keys(literal)).toEqual(SECTION_2_FIELDS);
  });
});

// ── The defaults ─────────────────────────────────────────────────────────────

describe('the default grid', () => {
  it('at 08:00 IST: 7 days of 24 starts 09:00..20:30, 45 minutes each, all open', () => {
    const g = grid();
    expect(g.days.map((d) => d.date)).toEqual([
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
    ]);
    for (const day of g.days) {
      expect(day.slots).toHaveLength(24);
      day.slots.forEach((slot, index) => {
        const startMs = ist(day.date, '09:00') + index * 30 * MIN;
        expect(slot.startAt).toBe(new Date(startMs).toISOString());
        expect(slot.startAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
        expect(slot.endAt).toBe(new Date(startMs + 45 * MIN).toISOString());
        expect(slot.istDate).toBe(day.date);
        expect(slot.reason).toBe('open');
        expect(slot.available).toBe(true);
      });
      expect(day.slots[0]!.startAt).toBe(isoAt(day.date, '09:00'));
      expect(day.slots[23]!.startAt).toBe(isoAt(day.date, '20:30'));
      expect(day.slots[23]!.endAt).toBe(isoAt(day.date, '21:15'));
    }
    expect(g.seats).toBe(2);
    expect(g.publicDayLimit).toBe(20);
    expect(g.botDayLimit).toBe(20);
    expect(g.fullyBooked).toBe(false);
  });

  it('reports the input caps, not the defaults', () => {
    const g = grid({ rules: rules({ publicDailyCap: 7, slotCapacity: 15 }), dailyBotCap: 33, effectiveConcurrency: 4 });
    expect(g.publicDayLimit).toBe(7);
    expect(g.botDayLimit).toBe(33);
    expect(g.seats).toBe(4);
  });

  it('freezes the grid, every day, every slot list and every slot', () => {
    const g = grid();
    expect(Object.isFrozen(g)).toBe(true);
    expect(Object.isFrozen(g.days)).toBe(true);
    for (const day of g.days) {
      expect(Object.isFrozen(day)).toBe(true);
      expect(Object.isFrozen(day.slots)).toBe(true);
      for (const slot of day.slots) {
        expect(Object.isFrozen(slot)).toBe(true);
        expect(Object.keys(slot)).toEqual(['startAt', 'endAt', 'istDate', 'available', 'reason']);
      }
    }
    expect(Object.keys(g)).toEqual(['days', 'seats', 'publicDayLimit', 'botDayLimit', 'fullyBooked']);
  });

  it('is deterministic: the same input gives the same grid', () => {
    expect(grid()).toEqual(grid());
  });
});

// ── Notice ───────────────────────────────────────────────────────────────────

describe('notice (strict: start < now + minNotice)', () => {
  it.each<[string, number, string, string]>([
    ['08:00 exactly: 09:00 is exactly one hour away and open', ist('2026-11-26', '08:00'), '09:00', 'open'],
    ['08:00:00.001: 09:00 is 1 ms inside the notice', ist('2026-11-26', '08:00', 1), '09:00', 'notice'],
    ['07:59:59.999: 09:00 is open', ist('2026-11-26', '08:00', -1), '09:00', 'open'],
    ['08:30: 09:00 is inside the notice', ist('2026-11-26', '08:30'), '09:00', 'notice'],
    ['08:30: 09:30 is exactly one hour away and open', ist('2026-11-26', '08:30'), '09:30', 'open'],
    ['08:30:00.001: 09:30 is inside the notice', ist('2026-11-26', '08:30', 1), '09:30', 'notice'],
  ])('%s', (_name, nowMs, hhmm, reason) => {
    const slot = slotAt(grid({ nowMs }), '2026-11-26', hhmm);
    expect(slot.reason).toBe(reason);
    expect(slot.available).toBe(reason === 'open');
  });

  it('notice only touches today: tomorrow 09:00 stays open at 20:00 IST', () => {
    const g = grid({ nowMs: ist('2026-11-26', '20:00') });
    for (const slot of dayOf(g, '2026-11-26').slots) expect(slot.reason).toBe('notice');
    expect(slotAt(g, '2026-11-27', '09:00').reason).toBe('open');
  });

  it('a longer notice pushes the edge: 1440 minutes at 08:00 refuses everything until tomorrow 08:00', () => {
    const g = grid({ rules: rules({ minNoticeMinutes: 1440 }) });
    for (const slot of dayOf(g, '2026-11-26').slots) expect(slot.reason).toBe('notice');
    expect(slotAt(g, '2026-11-27', '09:00').reason).toBe('open');
  });

  it('a zero notice offers a slot starting exactly now', () => {
    const g = grid({ nowMs: ist('2026-11-26', '09:00'), rules: rules({ minNoticeMinutes: 0 }) });
    expect(slotAt(g, '2026-11-26', '09:00').reason).toBe('open');
  });
});

// ── IST days ─────────────────────────────────────────────────────────────────

describe('IST midnight boundaries, horizon and weekdays', () => {
  it('23:59:59.999 IST: today is still that date, and every slot of today is inside the notice', () => {
    const g = grid({ nowMs: ist('2026-11-26', '00:00', DAY - 1) });
    expect(g.days[0]!.date).toBe('2026-11-26');
    for (const slot of g.days[0]!.slots) expect(slot.reason).toBe('notice');
    expect(g.days[1]!.date).toBe('2026-11-27');
    expect(slotAt(g, '2026-11-27', '09:00').reason).toBe('open');
    expect(g.days).toHaveLength(7);
  });

  it('00:00:00.000 IST: the new date is today', () => {
    const g = grid({ nowMs: ist('2026-11-27', '00:00') });
    expect(g.days[0]!.date).toBe('2026-11-27');
    expect(g.days.at(-1)!.date).toBe('2026-12-03');
    expect(slotAt(g, '2026-11-27', '09:00').reason).toBe('open');
  });

  it('18:30Z is IST midnight: 1 ms before it is the previous IST date', () => {
    expect(grid({ nowMs: Date.UTC(2026, 10, 26, 18, 30) - 1 }).days[0]!.date).toBe('2026-11-26');
    expect(grid({ nowMs: Date.UTC(2026, 10, 26, 18, 30) }).days[0]!.date).toBe('2026-11-27');
  });

  it('horizon 1 is today only; horizon includes today', () => {
    expect(grid({ rules: rules({ horizonDays: 1 }) }).days.map((d) => d.date)).toEqual(['2026-11-26']);
    expect(grid({ rules: rules({ horizonDays: 2 }) }).days.map((d) => d.date)).toEqual(['2026-11-26', '2026-11-27']);
  });

  it('weekdays 1..5 drop Saturday and Sunday (a Friday-to-Thursday sweep)', () => {
    const g = grid({ nowMs: ist('2026-11-27', '08:00'), rules: rules({ isoWeekdays: [1, 2, 3, 4, 5] }) });
    expect(isoWeekday('2026-11-27')).toBe(5);
    expect(g.days.map((d) => d.date)).toEqual(['2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03']);
    for (const day of g.days) expect(isoWeekday(day.date)).toBeLessThanOrEqual(5);
  });

  it('weekends only from a Thursday: Saturday and Sunday', () => {
    const g = grid({ rules: rules({ isoWeekdays: [6, 7] }) });
    expect(g.days.map((d) => d.date)).toEqual(['2026-11-28', '2026-11-29']);
  });

  it('an excluded today is omitted, and the first offered day comes first', () => {
    const g = grid({ rules: rules({ isoWeekdays: [5] }) });
    expect(g.days.map((d) => d.date)).toEqual(['2026-11-27']);
  });

  it('unsorted and repeated weekdays read as a set', () => {
    const g = grid({ rules: rules({ isoWeekdays: [7, 1, 1, 6] }) });
    expect(g.days.map((d) => d.date)).toEqual(['2026-11-28', '2026-11-29', '2026-11-30']);
  });

  it('an empty weekday set offers no days and is fully booked', () => {
    const g = grid({ rules: rules({ isoWeekdays: [] }) });
    expect(g.days).toEqual([]);
    expect(g.fullyBooked).toBe(true);
  });

  it('a slot may end exactly at IST midnight, and stays on its date', () => {
    const g = grid({ rules: rules({ firstStartMinuteIst: 1380, lastStartMinuteIst: 1395, stepMinutes: 15 }) });
    const last = slotAt(g, '2026-11-26', '23:15');
    expect(last.endAt).toBe(isoAt('2026-11-27', '00:00'));
    expect(last.istDate).toBe('2026-11-26');
    expect(dayOf(g, '2026-11-26').slots.map((s) => s.startAt)).toEqual([
      isoAt('2026-11-26', '23:00'),
      isoAt('2026-11-26', '23:15'),
    ]);
  });

  it('a last start off the step grid stops at the last on-grid start before it', () => {
    const g = grid({ rules: rules({ lastStartMinuteIst: 1250 }) });
    expect(dayOf(g, '2026-11-26').slots.at(-1)!.startAt).toBe(isoAt('2026-11-26', '20:30'));
  });
});

// ── The 14-day bound ─────────────────────────────────────────────────────────

describe('the 14-day expiry bound (end + 7200 s > now + 14 d is not_offered)', () => {
  // now = 11:45 IST on 2026-11-26, so now + 14 d = 11:45 IST on 2026-12-10 (day 14 of a 15-day
  // horizon). The 09:00 slot there ends 09:45; + 2 h = 11:45: exactly the bound, so it is offered.
  const edgeNow = ist('2026-11-26', '11:45');
  const wide = rules({ horizonDays: 15 });

  it('the exact edge is offered; the next start is not', () => {
    const g = grid({ nowMs: edgeNow, rules: wide });
    expect(g.days.at(-1)!.date).toBe('2026-12-10');
    expect(slotAt(g, '2026-12-10', '09:00').reason).toBe('open');
    expect(slotAt(g, '2026-12-10', '09:30').reason).toBe('not_offered');
    expect(slotAt(g, '2026-12-10', '20:30').reason).toBe('not_offered');
    expect(slotAt(g, '2026-12-09', '20:30').reason).toBe('open');
    const refused = allSlots(g).filter((s) => s.reason === 'not_offered');
    expect(refused).toHaveLength(23);
    for (const slot of refused) expect(slot.istDate).toBe('2026-12-10');
  });

  it('1 ms over the edge is not offered', () => {
    const g = grid({ nowMs: edgeNow - 1, rules: wide });
    expect(slotAt(g, '2026-12-10', '09:00').reason).toBe('not_offered');
  });

  it('matches the arithmetic of 0142 step 6 slot by slot', () => {
    const g = grid({ nowMs: edgeNow, rules: wide });
    for (const slot of allSlots(g)) {
      const tooFar = Date.parse(slot.endAt) + R1_PUBLIC_EXPIRY_GRACE_SEC * 1000 > edgeNow + 14 * DAY;
      expect(slot.reason === 'not_offered', slot.startAt).toBe(tooFar);
    }
  });

  it('never appears at the largest configurable horizon (13 days), even at 00:00 IST', () => {
    const g = grid({ nowMs: ist('2026-11-26', '00:00'), rules: rules({ horizonDays: 13 }) });
    expect(allSlots(g).some((s) => s.reason === 'not_offered')).toBe(false);
  });
});

// ── Overlap and seats ────────────────────────────────────────────────────────

describe('overlap counting is half-open, and seats bound it', () => {
  const date = '2026-11-27';
  const oneSeat = { effectiveConcurrency: 1 };

  it.each<[string, { startAt: string; endAt: string }, string]>([
    ['ends exactly at the slot start: does not count', booking(date, '09:15', '10:00'), 'open'],
    ['starts exactly at the slot end: does not count', booking(date, '10:45', '11:30'), 'open'],
    ['ends 1 ms after the slot start: counts', { startAt: isoAt(date, '09:15'), endAt: isoAt(date, '10:00', 1) }, 'slot_full'],
    ['starts 1 ms before the slot end: counts', { startAt: isoAt(date, '10:45', -1), endAt: isoAt(date, '11:30') }, 'slot_full'],
    ['inside the slot: counts', booking(date, '10:10', '10:20'), 'slot_full'],
    ['covers the slot: counts', booking(date, '09:00', '12:00'), 'slot_full'],
    [
      'the IST offset form of the same instants counts the same',
      { startAt: offsetForm(ist(date, '09:15')), endAt: offsetForm(ist(date, '10:00', 1)) },
      'slot_full',
    ],
    [
      'the IST offset form at the exact edge does not count',
      { startAt: offsetForm(ist(date, '09:15')), endAt: offsetForm(ist(date, '10:00')) },
      'open',
    ],
  ])('one seat, a booking that %s', (_name, interval, reason) => {
    const g = grid({ ...oneSeat, intervals: [interval] });
    expect(g.seats).toBe(1);
    expect(slotAt(g, date, '10:00').reason).toBe(reason);
  });

  it('two bookings at 09:00 and 09:30 fill the 09:00 and 09:30 slots at seats 2; 10:00 stays open', () => {
    const g = grid({ intervals: [booking(date, '09:00', '09:45'), booking(date, '09:30', '10:15')] });
    expect(g.seats).toBe(2);
    expect(slotAt(g, date, '09:00').reason).toBe('slot_full');
    expect(slotAt(g, date, '09:30').reason).toBe('slot_full');
    expect(slotAt(g, date, '10:00').reason).toBe('open');
    expect(slotAt(g, date, '10:30').reason).toBe('open');
  });

  it('back-to-back bookings both overlapping one slot count as two (conservative, as the RPC)', () => {
    const g = grid({ intervals: [booking(date, '09:00', '10:15'), booking(date, '10:15', '11:00')] });
    // The 10:00 slot [10:00, 10:45) overlaps both, although they never run at the same time.
    expect(slotAt(g, date, '10:00').reason).toBe('slot_full');
  });

  it('one booking: full at seats 1, open at seats 2', () => {
    const interval = booking(date, '09:00', '09:45');
    const one = grid({ ...oneSeat, intervals: [interval] });
    expect(slotAt(one, date, '09:00').reason).toBe('slot_full');
    expect(slotAt(one, date, '09:30').reason).toBe('slot_full');
    expect(slotAt(one, date, '10:00').reason).toBe('open');
    const two = grid({ intervals: [interval] });
    for (const hhmm of ['09:00', '09:30', '10:00']) expect(slotAt(two, date, hhmm).reason).toBe('open');
  });

  it.each<[string, Partial<R1PublicSlotGridInput>]>([
    ['headroom equal to the concurrency', { rules: rules({ browserHeadroom: 2 }) }],
    ['headroom above the concurrency', { rules: rules({ browserHeadroom: 5 }) }],
    ['concurrency 0', { effectiveConcurrency: 0 }],
    ['capacity 0', { rules: rules({ slotCapacity: 0 }) }],
  ])('seats 0 (%s): every slot is slot_full and the grid is fully booked', (_name, o) => {
    const g = grid(o);
    expect(g.seats).toBe(0);
    for (const slot of allSlots(g)) expect(slot.reason).toBe('slot_full');
    expect(g.fullyBooked).toBe(true);
  });

  it('bookings outside the grid days count nowhere', () => {
    const g = grid({ ...oneSeat, intervals: [booking('2026-12-20', '09:00', '21:00'), booking('2026-11-20', '09:00', '21:00')] });
    expect(allSlots(g).every((s) => s.reason === 'open')).toBe(true);
  });
});

describe('r1PublicSlotSeats', () => {
  it.each<[string, Partial<R1MeetPublicSlotRules>, number, number]>([
    ['defaults: capacity 2, headroom 0, concurrency 2', {}, 2, 2],
    ['concurrency 1', {}, 1, 1],
    ['capacity 15, concurrency 3, headroom 1', { slotCapacity: 15, browserHeadroom: 1 }, 3, 2],
    ['capacity caps a large concurrency', { slotCapacity: 1 }, 10, 1],
    ['headroom equal to the concurrency', { browserHeadroom: 2 }, 2, 0],
    ['headroom above the concurrency', { browserHeadroom: 3 }, 2, 0],
    ['concurrency 0', {}, 0, 0],
    ['negative concurrency', {}, -3, 0],
    ['concurrency NaN', {}, Number.NaN, 0],
    ['concurrency 1.5', {}, 1.5, 0],
    ['concurrency Infinity', {}, Number.POSITIVE_INFINITY, 0],
    ['capacity 1.5', { slotCapacity: 1.5 }, 2, 0],
    ['headroom 0.5', { browserHeadroom: 0.5 }, 2, 0],
    ['capacity negative', { slotCapacity: -1 }, 2, 0],
  ])('%s', (_name, o, concurrency, seats) => {
    expect(r1PublicSlotSeats(rules(o), concurrency)).toBe(seats);
  });

  it('answers 0 for a rules value that is not an object', () => {
    expect(r1PublicSlotSeats(null as unknown as R1MeetPublicSlotRules, 2)).toBe(0);
    expect(r1PublicSlotSeats('rules' as unknown as R1MeetPublicSlotRules, 2)).toBe(0);
  });
});

// ── Day caps and closed dates ────────────────────────────────────────────────

describe('day caps', () => {
  const date = '2026-11-27';
  it.each<[string, { total: number; public: number }, number, string]>([
    ['public 19 of 20: open', { total: 19, public: 19 }, 20, 'open'],
    ['public 20 of 20: day_full', { total: 20, public: 20 }, 50, 'day_full'],
    ['public 21 (over): day_full', { total: 21, public: 21 }, 50, 'day_full'],
    ['total at the bot cap with public 0: day_full', { total: 20, public: 0 }, 20, 'day_full'],
    ['total 19 under a bot cap of 20, public 0: open', { total: 19, public: 0 }, 20, 'open'],
    ['bot cap 0 is always full', { total: 0, public: 0 }, 0, 'day_full'],
  ])('%s', (_name, count, dailyBotCap, reason) => {
    const g = grid({ dailyBotCap, dayCounts: { [date]: count } });
    for (const slot of dayOf(g, date).slots) expect(slot.reason).toBe(reason);
    // Other days have no count entry: they count zero.
    expect(slotAt(g, '2026-11-28', '09:00').reason).toBe(dailyBotCap === 0 ? 'day_full' : 'open');
  });

  it('a count for a date outside the grid changes nothing', () => {
    const g = grid({ dayCounts: { '2026-12-25': { total: 999, public: 999 } } });
    expect(allSlots(g).every((s) => s.reason === 'open')).toBe(true);
  });

  it('every day full: fully booked with the real reasons', () => {
    const dayCounts = Object.fromEntries(
      Array.from({ length: 7 }, (_v, i) => [addDays('2026-11-26', i), { total: 0, public: 20 }]),
    );
    const g = grid({ dayCounts });
    expect(g.fullyBooked).toBe(true);
    expect(new Set(allSlots(g).map((s) => s.reason))).toEqual(new Set(['day_full']));
  });
});

describe('closed dates', () => {
  it('are listed with every slot closed_date; other days are unaffected', () => {
    const g = grid({ rules: rules({ closedDates: ['2026-11-28', '2026-12-25'] }) });
    expect(g.days.map((d) => d.date)).toContain('2026-11-28');
    const closed = dayOf(g, '2026-11-28');
    expect(closed.slots).toHaveLength(24);
    for (const slot of closed.slots) {
      expect(slot.reason).toBe('closed_date');
      expect(slot.available).toBe(false);
    }
    expect(slotAt(g, '2026-11-27', '09:00').reason).toBe('open');
    expect(g.fullyBooked).toBe(false);
  });

  it('a closed date on an excluded weekday stays omitted', () => {
    const g = grid({ rules: rules({ isoWeekdays: [1, 2, 3, 4, 5], closedDates: ['2026-11-28'] }) });
    expect(g.days.map((d) => d.date)).not.toContain('2026-11-28');
  });
});

// ── Precedence ───────────────────────────────────────────────────────────────

describe('one reason per slot, first match wins', () => {
  const far = ist('2026-11-26', '11:45');
  const fullDay = (date: string) => ({ [date]: { total: 0, public: 20 } });

  it.each<[string, Partial<R1PublicSlotGridInput>, string, string, string]>([
    [
      'fully_booked over closed_date',
      { admits: false, rules: rules({ closedDates: ['2026-11-27'] }) },
      '2026-11-27',
      '09:00',
      'fully_booked',
    ],
    [
      'closed_date over notice',
      { nowMs: ist('2026-11-26', '08:30'), rules: rules({ closedDates: ['2026-11-26'] }) },
      '2026-11-26',
      '09:00',
      'closed_date',
    ],
    [
      'notice over not_offered',
      { nowMs: far, rules: rules({ horizonDays: 15, minNoticeMinutes: 14 * 24 * 60 }) },
      '2026-12-10',
      '09:30',
      'notice',
    ],
    [
      'not_offered over day_full',
      { nowMs: far, rules: rules({ horizonDays: 15 }), dayCounts: fullDay('2026-12-10') },
      '2026-12-10',
      '09:30',
      'not_offered',
    ],
    [
      'day_full over slot_full',
      { dayCounts: fullDay('2026-11-27'), effectiveConcurrency: 1, intervals: [booking('2026-11-27', '09:00', '09:45')] },
      '2026-11-27',
      '09:00',
      'day_full',
    ],
    [
      'slot_full over open',
      { effectiveConcurrency: 1, intervals: [booking('2026-11-27', '09:00', '09:45')] },
      '2026-11-27',
      '09:00',
      'slot_full',
    ],
    [
      'notice over day_full',
      { nowMs: ist('2026-11-26', '08:30'), dayCounts: fullDay('2026-11-26') },
      '2026-11-26',
      '09:00',
      'notice',
    ],
    ['notice over slot_full (seats 0)', { nowMs: ist('2026-11-26', '08:30'), effectiveConcurrency: 0 }, '2026-11-26', '09:00', 'notice'],
    [
      'closed_date over day_full',
      { rules: rules({ closedDates: ['2026-11-27'] }), dayCounts: fullDay('2026-11-27') },
      '2026-11-27',
      '09:00',
      'closed_date',
    ],
    ['fully_booked over notice', { admits: false, nowMs: ist('2026-11-26', '08:30') }, '2026-11-26', '09:00', 'fully_booked'],
  ])('%s', (_name, o, date, hhmm, reason) => {
    expect(slotAt(grid(o), date, hhmm).reason).toBe(reason);
  });

  it('admits false: every slot is fully_booked and the grid is fully booked', () => {
    const g = grid({ admits: false, rules: rules({ closedDates: ['2026-11-28'] }), dayCounts: fullDay('2026-11-29') });
    expect(g.days).toHaveLength(7);
    for (const slot of allSlots(g)) {
      expect(slot.reason).toBe('fully_booked');
      expect(slot.available).toBe(false);
    }
    expect(g.fullyBooked).toBe(true);
  });

  it('admits true but nothing available: fully booked, each slot keeping its real reason', () => {
    const g = grid({ rules: rules({ horizonDays: 2, closedDates: ['2026-11-27'] }), nowMs: ist('2026-11-26', '20:00') });
    expect(g.fullyBooked).toBe(true);
    expect(new Set(dayOf(g, '2026-11-26').slots.map((s) => s.reason))).toEqual(new Set(['notice']));
    expect(new Set(dayOf(g, '2026-11-27').slots.map((s) => s.reason))).toEqual(new Set(['closed_date']));
  });
});

// ── findR1PublicSlot ─────────────────────────────────────────────────────────

describe('findR1PublicSlot', () => {
  const g = grid({ effectiveConcurrency: 1, intervals: [booking('2026-11-27', '09:00', '09:45')] });

  it('finds every slot by its own startAt and by the IST offset form of the same instant', () => {
    for (const slot of allSlots(g)) {
      expect(findR1PublicSlot(g, slot.startAt)).toBe(slot);
      expect(findR1PublicSlot(g, offsetForm(Date.parse(slot.startAt)))).toBe(slot);
    }
  });

  it('finds unavailable slots too (the caller checks `available`)', () => {
    const full = findR1PublicSlot(g, isoAt('2026-11-27', '09:00'));
    expect(full?.reason).toBe('slot_full');
    expect(full?.available).toBe(false);
  });

  it('accepts other zoned spellings of the instant', () => {
    expect(findR1PublicSlot(g, '2026-11-27T03:30Z')).toBe(slotAt(g, '2026-11-27', '09:00'));
    expect(findR1PublicSlot(g, '2026-11-27T09:00+05:30')).toBe(slotAt(g, '2026-11-27', '09:00'));
    expect(findR1PublicSlot(g, '2026-11-26T22:00:00-05:30')).toBe(slotAt(g, '2026-11-27', '09:00'));
  });

  it.each<[string, unknown]>([
    ['an off-grid minute', '2026-11-27T09:15:00+05:30'],
    ['one ms off the start', isoAt('2026-11-27', '09:00', 1)],
    ['a zoneless string', '2026-11-27T09:00:00'],
    ['a date only', '2026-11-27'],
    ['garbage', 'tomorrow at nine'],
    ['an empty string', ''],
    ['a date outside the grid', isoAt('2026-12-20', '09:00')],
    ['a start before 09:00', isoAt('2026-11-27', '08:30')],
    ['a number', Date.parse(isoAt('2026-11-27', '09:00'))],
    ['null', null],
  ])('answers null for %s', (_name, value) => {
    expect(findR1PublicSlot(g, value as string)).toBeNull();
  });

  it('answers null for a weekday-excluded date', () => {
    const weekdays = grid({ rules: rules({ isoWeekdays: [1, 2, 3, 4, 5] }) });
    expect(findR1PublicSlot(weekdays, isoAt('2026-11-28', '09:00'))).toBeNull();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an empty object', {}],
    ['days not an array', { days: 'x' }],
    ['a null day', { days: [null] }],
    ['slots not an array', { days: [{ date: '2026-11-27', slots: 'x' }] }],
    ['a null slot', { days: [{ date: '2026-11-27', slots: [null] }] }],
  ])('never throws on a malformed grid (%s)', (_name, value) => {
    expect(findR1PublicSlot(value as R1PublicSlotGrid, isoAt('2026-11-27', '09:00'))).toBeNull();
  });
});

// ── The capacity window ──────────────────────────────────────────────────────

describe('r1PublicSlotWindow', () => {
  it('is IST midnight today .. IST midnight today + horizon, as istDayInstantRange bounds it', () => {
    const window = r1PublicSlotWindow(NOW, DEFAULT_RULES);
    expect(window.fromIso).toBe(istDayInstantRange({ year: 2026, month: 11, day: 26 }).fromIso);
    expect(window.toIso).toBe(istDayInstantRange({ year: 2026, month: 12, day: 2 }).toIso);
    expect(Date.parse(window.toIso) - Date.parse(window.fromIso)).toBe(7 * DAY);
    expect(Object.isFrozen(window)).toBe(true);
  });

  it('covers 15 days at the widest horizon (the capacity RPC window cap)', () => {
    const window = r1PublicSlotWindow(NOW, rules({ horizonDays: 15 }));
    expect(window.toIso).toBe(istDayInstantRange({ year: 2026, month: 12, day: 10 }).toIso);
    expect(Date.parse(window.toIso) - Date.parse(window.fromIso)).toBe(15 * DAY);
  });

  it('starts at now exactly when now is IST midnight, and contains every slot of the grid', () => {
    const midnight = ist('2026-11-27', '00:00');
    expect(r1PublicSlotWindow(midnight, DEFAULT_RULES).fromIso).toBe(new Date(midnight).toISOString());
    const window = r1PublicSlotWindow(NOW, DEFAULT_RULES);
    for (const slot of allSlots(grid())) {
      expect(Date.parse(slot.startAt)).toBeGreaterThanOrEqual(Date.parse(window.fromIso));
      expect(Date.parse(slot.endAt)).toBeLessThanOrEqual(Date.parse(window.toIso));
    }
  });

  it('refuses what the grid refuses', () => {
    expectInvalid(() => r1PublicSlotWindow(Number.NaN, DEFAULT_RULES));
    expectInvalid(() => r1PublicSlotWindow(NOW, rules({ horizonDays: 16 })));
    expectInvalid(() => r1PublicSlotWindow(NOW, rules({ firstStartMinuteIst: 539 })));
    expectInvalid(() => r1PublicSlotWindow(NOW, null as unknown as R1MeetPublicSlotRules));
  });
});

// ── Invalid input ────────────────────────────────────────────────────────────

describe('invalid input throws r1_public_slot_input_invalid, never a value', () => {
  const r = (o: Record<string, unknown>) => ({ rules: { ...DEFAULT_RULES, ...o } as unknown as R1MeetPublicSlotRules });
  const cases: [string, Partial<Record<keyof R1PublicSlotGridInput, unknown>>][] = [
    ['nowMs NaN', { nowMs: Number.NaN }],
    ['nowMs Infinity', { nowMs: Number.POSITIVE_INFINITY }],
    ['nowMs a string', { nowMs: String(NOW) }],
    ['nowMs before 1970', { nowMs: -1 }],
    ['nowMs past year 9998', { nowMs: Date.UTC(9999, 0, 1) }],
    ['rules null', { rules: null }],
    ['rules an array', { rules: [] }],
    ['slotMinutes 0', r({ slotMinutes: 0 })],
    ['slotMinutes 1.5', r({ slotMinutes: 1.5 })],
    ['slotMinutes a string', r({ slotMinutes: '45' })],
    ['slotMinutes missing', r({ slotMinutes: undefined })],
    ['stepMinutes 0', r({ stepMinutes: 0 })],
    ['stepMinutes negative', r({ stepMinutes: -30 })],
    ['first start 08:59 (before the 09:00 floor)', r({ firstStartMinuteIst: 539 })],
    ['first start 07:00 (the deploy window)', r({ firstStartMinuteIst: 420 })],
    ['last start before the first', r({ firstStartMinuteIst: 600, lastStartMinuteIst: 570 })],
    ['last start + slot past 24:00', r({ lastStartMinuteIst: 1396, slotMinutes: 45 })],
    ['last start 23:30 with 45-minute slots', r({ lastStartMinuteIst: 1410 })],
    ['horizon 0', r({ horizonDays: 0 })],
    ['horizon 16', r({ horizonDays: 16 })],
    ['horizon 2.5', r({ horizonDays: 2.5 })],
    ['notice negative', r({ minNoticeMinutes: -1 })],
    ['notice NaN', r({ minNoticeMinutes: Number.NaN })],
    ['capacity negative', r({ slotCapacity: -1 })],
    ['capacity 1.5', r({ slotCapacity: 1.5 })],
    ['headroom negative', r({ browserHeadroom: -1 })],
    ['public cap negative', r({ publicDailyCap: -1 })],
    ['public cap 2.5', r({ publicDailyCap: 2.5 })],
    ['weekday 0', r({ isoWeekdays: [0] })],
    ['weekday 8', r({ isoWeekdays: [1, 8] })],
    ['weekday 1.5', r({ isoWeekdays: [1.5] })],
    ['weekday a string', r({ isoWeekdays: ['mon'] })],
    ['weekdays not an array', r({ isoWeekdays: 'mon-sun' })],
    ['closed date 2026-02-30', r({ closedDates: ['2026-02-30'] })],
    ['closed date without padding', r({ closedDates: ['2026-1-01'] })],
    ['closed date with a time', r({ closedDates: ['2026-11-27T00:00'] })],
    ['closed date month 13', r({ closedDates: ['2026-13-01'] })],
    ['closed date empty', r({ closedDates: [''] })],
    ['closed date a number', r({ closedDates: [20261127] })],
    ['closed dates not an array', r({ closedDates: '2026-11-27' })],
    ['daily bot cap negative', { dailyBotCap: -1 }],
    ['daily bot cap 2.5', { dailyBotCap: 2.5 }],
    ['daily bot cap missing', { dailyBotCap: undefined }],
    ['effective concurrency negative', { effectiveConcurrency: -1 }],
    ['effective concurrency 1.5', { effectiveConcurrency: 1.5 }],
    ['effective concurrency NaN', { effectiveConcurrency: Number.NaN }],
    ['admits a string', { admits: 'true' }],
    ['admits missing', { admits: undefined }],
    ['intervals not an array', { intervals: {} }],
    ['an interval null', { intervals: [null] }],
    ['an interval zoneless start', { intervals: [{ startAt: '2026-11-27T09:00:00', endAt: isoAt('2026-11-27', '09:45') }] }],
    ['an interval zoneless end', { intervals: [{ startAt: isoAt('2026-11-27', '09:00'), endAt: '2026-11-27T09:45:00' }] }],
    ['an interval ending at its start', { intervals: [booking('2026-11-27', '09:00', '09:00')] }],
    ['an interval ending before its start', { intervals: [booking('2026-11-27', '09:45', '09:00')] }],
    ['an interval of garbage', { intervals: [{ startAt: 'soon', endAt: 'later' }] }],
    ['an interval missing its end', { intervals: [{ startAt: isoAt('2026-11-27', '09:00') }] }],
    ['an interval as epoch numbers', { intervals: [{ startAt: NOW, endAt: NOW + MIN }] }],
    ['day counts null', { dayCounts: null }],
    ['day counts an array', { dayCounts: [] }],
    ['day counts a Map', { dayCounts: new Map([['2026-11-27', { total: 20, public: 20 }]]) }],
    ['a day count key that is not a date', { dayCounts: { tomorrow: { total: 1, public: 1 } } }],
    ['a day count key 2026-02-30', { dayCounts: { '2026-02-30': { total: 1, public: 1 } } }],
    ['a day count total negative', { dayCounts: { '2026-11-27': { total: -1, public: 0 } } }],
    ['a day count public 1.5', { dayCounts: { '2026-11-27': { total: 2, public: 1.5 } } }],
    ['a day count public missing', { dayCounts: { '2026-11-27': { total: 2 } } }],
    ['a day count value null', { dayCounts: { '2026-11-27': null } }],
    ['a day count value a number', { dayCounts: { '2026-11-27': 3 } }],
  ];

  it.each(cases)('%s', (_name, o) => {
    expectInvalid(() => grid(o as Partial<R1PublicSlotGridInput>));
  });

  it('refuses an input that is not an object', () => {
    expectInvalid(() => buildR1PublicSlotGrid(null as unknown as R1PublicSlotGridInput));
    expectInvalid(() => buildR1PublicSlotGrid('grid' as unknown as R1PublicSlotGridInput));
  });

  it('accepts the edges: first start exactly 09:00, a slot ending exactly 24:00, horizon 1 and 15, an empty weekday set', () => {
    expect(() => grid({ rules: rules({ firstStartMinuteIst: 540, lastStartMinuteIst: 540 }) })).not.toThrow();
    expect(() => grid({ rules: rules({ lastStartMinuteIst: 1395 }) })).not.toThrow();
    expect(() => grid({ rules: rules({ horizonDays: 1 }) })).not.toThrow();
    expect(() => grid({ rules: rules({ horizonDays: 15 }) })).not.toThrow();
    expect(() => grid({ rules: rules({ isoWeekdays: [] }) })).not.toThrow();
    expect(() => grid({ rules: rules({ minNoticeMinutes: 0, slotCapacity: 0, publicDailyCap: 0 }), dailyBotCap: 0 })).not.toThrow();
  });
});

// ── Properties ───────────────────────────────────────────────────────────────

const YEAR_START = Date.UTC(2026, 0, 1);
const YEAR_END = Date.UTC(2027, 0, 1);

/** Valid rules, intervals and counts around a random "now" across a year (config-valid horizons). */
const inputArb = fc
  .record({
    nowMs: fc.integer({ min: YEAR_START, max: YEAR_END }),
    step: fc.constantFrom(15, 30, 60),
    slot: fc.integer({ min: 30, max: 60 }),
    firstPick: fc.nat({ max: 1000 }),
    lastPick: fc.nat({ max: 1000 }),
    horizon: fc.integer({ min: 1, max: 13 }),
    notice: fc.integer({ min: 30, max: 1440 }),
    weekdays: fc.subarray([1, 2, 3, 4, 5, 6, 7]),
    closedOffsets: fc.subarray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
    capacity: fc.integer({ min: 1, max: 15 }),
    headroom: fc.integer({ min: 0, max: 14 }),
    publicCap: fc.integer({ min: 1, max: 200 }),
    dailyBotCap: fc.integer({ min: 0, max: 300 }),
    concurrency: fc.integer({ min: 0, max: 20 }),
    admits: fc.boolean(),
    intervals: fc.array(
      fc.record({
        startOffsetMin: fc.integer({ min: -1440, max: 15 * 1440 }),
        durationMin: fc.integer({ min: 1, max: 120 }),
        offsetSpelling: fc.boolean(),
      }),
      { maxLength: 30 },
    ),
    counts: fc.array(
      fc.record({
        dayOffset: fc.integer({ min: 0, max: 14 }),
        total: fc.integer({ min: 0, max: 300 }),
        public: fc.integer({ min: 0, max: 200 }),
      }),
      { maxLength: 6 },
    ),
  })
  .map((p): R1PublicSlotGridInput => {
    const firstChoices = Math.floor((1230 - 540) / p.step) + 1;
    const first = 540 + (p.firstPick % firstChoices) * p.step;
    const last = first + (p.lastPick % (1440 - p.slot - first + 1));
    const today = istDate(new Date(p.nowMs));
    return {
      nowMs: p.nowMs,
      rules: {
        slotMinutes: p.slot,
        stepMinutes: p.step,
        firstStartMinuteIst: first,
        lastStartMinuteIst: last,
        isoWeekdays: p.weekdays,
        closedDates: p.closedOffsets.map((offset) => addDays(today, offset)),
        minNoticeMinutes: p.notice,
        horizonDays: p.horizon,
        slotCapacity: p.capacity,
        browserHeadroom: p.headroom,
        publicDailyCap: p.publicCap,
      },
      dailyBotCap: p.dailyBotCap,
      effectiveConcurrency: p.concurrency,
      admits: p.admits,
      intervals: p.intervals.map((i) => {
        const startMs = p.nowMs + i.startOffsetMin * MIN;
        const endMs = startMs + i.durationMin * MIN;
        const spell = i.offsetSpelling ? offsetForm : (ms: number) => new Date(ms).toISOString();
        return { startAt: spell(startMs), endAt: spell(endMs) };
      }),
      dayCounts: Object.fromEntries(
        p.counts.map((c) => [addDays(today, c.dayOffset), { total: c.total, public: c.public }]),
      ),
    };
  });

describe('properties over valid rules', () => {
  it('(a) every start is in [first, last], on the step from first, and never before 09:00 IST', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const g = buildR1PublicSlotGrid(input);
        const { firstStartMinuteIst: first, lastStartMinuteIst: last, stepMinutes: step } = input.rules;
        for (const day of g.days) {
          expect(day.slots).toHaveLength(Math.floor((last - first) / step) + 1);
          // IST midnight of the day, through Intl: a minute in [first, last] (< 1440) is on that date.
          const midnightMs = istWallClockToInstant(...ymd(day.date), 0).getTime();
          for (const slot of day.slots) {
            const minute = (Date.parse(slot.startAt) - midnightMs) / MIN;
            expect(minute).toBeGreaterThanOrEqual(first);
            expect(minute).toBeLessThanOrEqual(last);
            expect((minute - first) % step).toBe(0);
            expect(minute).toBeGreaterThanOrEqual(R1_PUBLIC_EARLIEST_START_MINUTE_IST);
          }
        }
      }),
    );
  });

  it('(b) every slot is slotMinutes long and both ends sit on its istDate (half-open)', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const g = buildR1PublicSlotGrid(input);
        for (const day of g.days) {
          for (const slot of day.slots) {
            const startMs = Date.parse(slot.startAt);
            const endMs = Date.parse(slot.endAt);
            expect(endMs - startMs).toBe(input.rules.slotMinutes * MIN);
            expect(slot.istDate).toBe(day.date);
            expect(istDate(new Date(startMs))).toBe(day.date);
            expect(istDate(new Date(endMs - 1))).toBe(day.date);
          }
        }
      }),
    );
  });

  it('(c) the days are the horizon dates whose weekday is offered, ascending, today first when offered', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const g = buildR1PublicSlotGrid(input);
        const expected: string[] = [];
        for (let offset = 0; offset < input.rules.horizonDays; offset += 1) {
          const date = istDate(new Date(input.nowMs + offset * DAY));
          if (input.rules.isoWeekdays.includes(isoWeekday(date))) expected.push(date);
        }
        expect(g.days.map((d) => d.date)).toEqual(expected);
      }),
    );
  });

  it('(d) available iff open; every reason is a known code; not_offered never appears; fullyBooked is consistent', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const g = buildR1PublicSlotGrid(input);
        const slots = allSlots(g);
        for (const slot of slots) {
          expect(R1_PUBLIC_SLOT_REASONS).toContain(slot.reason);
          expect(slot.available).toBe(slot.reason === 'open');
          expect(slot.reason).not.toBe('not_offered');
        }
        expect(g.fullyBooked).toBe(!input.admits || !slots.some((s) => s.available));
        expect(g.seats).toBe(r1PublicSlotSeats(input.rules, input.effectiveConcurrency));
      }),
    );
  });

  it('(e) admits false: every reason is fully_booked', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const g = buildR1PublicSlotGrid({ ...input, admits: false });
        for (const slot of allSlots(g)) expect(slot.reason).toBe('fully_booked');
        expect(g.fullyBooked).toBe(true);
      }),
    );
  });

  it('(f) adding an interval never turns an unavailable slot available, and moves only open to slot_full', () => {
    fc.assert(
      fc.property(
        inputArb,
        fc.integer({ min: -60, max: 14 * 1440 }),
        fc.integer({ min: 1, max: 180 }),
        (input, startOffsetMin, durationMin) => {
          const startMs = input.nowMs + startOffsetMin * MIN;
          const extra = { startAt: new Date(startMs).toISOString(), endAt: new Date(startMs + durationMin * MIN).toISOString() };
          const before = allSlots(buildR1PublicSlotGrid(input));
          const after = allSlots(buildR1PublicSlotGrid({ ...input, intervals: [...input.intervals, extra] }));
          expect(after).toHaveLength(before.length);
          before.forEach((slot, i) => {
            const next = after[i]!;
            expect(next.startAt).toBe(slot.startAt);
            if (!slot.available) expect(next.available).toBe(false);
            if (slot.reason !== 'open') expect(next.reason).toBe(slot.reason);
            else expect(['open', 'slot_full']).toContain(next.reason);
          });
        },
      ),
    );
  });

  it('(g) findR1PublicSlot finds every slot by its startAt and by its IST offset spelling', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const g = buildR1PublicSlotGrid(input);
        for (const slot of allSlots(g)) {
          expect(findR1PublicSlot(g, slot.startAt)).toBe(slot);
          expect(findR1PublicSlot(g, offsetForm(Date.parse(slot.startAt)))).toBe(slot);
        }
      }),
    );
  });
});

// ── Parity ───────────────────────────────────────────────────────────────────

describe('parity with the database and the Intl calendar', () => {
  it('the expiry grace is the Meet round grace the runtime sends', () => {
    expect(R1_PUBLIC_EXPIRY_GRACE_SEC).toBe(R1_MEET_ROUND_EXPIRY_GRACE_SEC);
  });

  it('the 14-day bound is 0142 step 6, text for text', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../../supabase/migrations/0142_r1_meet_bookings.sql', import.meta.url)),
      'utf8',
    );
    expect(sql).toContain('v_expires := p_end_at + make_interval(secs => p_expiry_grace_sec);');
    expect(sql).toContain("if v_expires > p_now + interval '14 days' then");
    expect(sql).toContain("v_reason := 'slot_too_far';");
    expect(R1_PUBLIC_MAX_EXPIRY_AHEAD_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  /** 180 instants at and around 60 consecutive IST midnights, plus 1,820 spread over two years. */
  const sampledInstants = (): number[] => {
    const out: number[] = [];
    for (let d = 0; d < 60; d += 1) {
      const midnight = istWallClockToInstant(2026, 11, 1 + d, 0).getTime();
      out.push(midnight - 1, midnight, midnight + 1);
    }
    // Seeded, so the sample is the same on every run and every machine.
    out.push(...fc.sample(fc.integer({ min: YEAR_START, max: Date.UTC(2028, 0, 1) - 1 }), { numRuns: 1820, seed: 20261126 }));
    return out;
  };

  it('over 2,000 sampled instants: today, every slot start and the window equal the Intl helpers and r1MeetIstDay', () => {
    const instants = sampledInstants();
    expect(instants).toHaveLength(2000);
    const oneDay = rules({ horizonDays: 1, minNoticeMinutes: 0 });
    for (const nowMs of instants) {
      const today = istDate(new Date(nowMs));
      const [y, m, d] = ymd(today);
      const g = buildR1PublicSlotGrid({
        nowMs,
        rules: oneDay,
        dailyBotCap: 20,
        effectiveConcurrency: 2,
        admits: true,
        intervals: [],
        dayCounts: {},
      });
      expect(g.days.map((day) => day.date)).toEqual([today]);
      const slots = g.days[0]!.slots;
      for (const index of [0, slots.length - 1]) {
        const minute = 540 + index * 30;
        expect(slots[index]!.startAt).toBe(istWallClockToInstant(y, m, d, minute * 60).toISOString());
      }
      const window = r1PublicSlotWindow(nowMs, oneDay);
      expect(window.fromIso).toBe(istWallClockToInstant(y, m, d, 0).toISOString());
      expect(window).toEqual(istDayInstantRange({ year: y, month: m, day: d }));
      expect(r1MeetIstDay(slots[0]!.startAt)).toEqual({ from: window.fromIso, to: window.toIso });
      expect(r1MeetIstDay(new Date(nowMs).toISOString())).toEqual({ from: window.fromIso, to: window.toIso });
    }
  });

  it('every slot of a 60-day sweep starts where the Intl wall clock puts it', () => {
    for (let d = 0; d < 60; d += 1) {
      const nowMs = istWallClockToInstant(2026, 11, 1 + d, 7 * 3600).getTime();
      const g = buildR1PublicSlotGrid({
        nowMs,
        rules: rules({ horizonDays: 1 }),
        dailyBotCap: 20,
        effectiveConcurrency: 2,
        admits: true,
        intervals: [],
        dayCounts: {},
      });
      const [y, m, day] = ymd(g.days[0]!.date);
      expect(g.days[0]!.date).toBe(istDate(new Date(nowMs)));
      g.days[0]!.slots.forEach((slot, index) => {
        expect(slot.startAt).toBe(istWallClockToInstant(y, m, day, (540 + index * 30) * 60).toISOString());
        expect(r1MeetIstDay(slot.startAt)!.from).toBe(istWallClockToInstant(y, m, day, 0).toISOString());
      });
    }
  });
});
