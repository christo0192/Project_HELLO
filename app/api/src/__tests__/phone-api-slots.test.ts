/**
 * The IST slot grid — boundaries, all seven days, and the capacity projection.
 *
 * Everything here is pure: the grid takes an injected instant and an explicit
 * occupancy list, so no assertion depends on the host clock or the host time
 * zone. The grid must be IDENTICAL on all seven days, because 0042 has no
 * weekend rule, no holiday table and no per-weekday window — a fact worth
 * pinning rather than trusting, since "every day is a calling day" is exactly
 * the kind of sentence a later edit quietly stops honouring.
 */

import { describe, it, expect } from 'vitest';
import {
  PHONE_APPOINTMENT_MAX_SECONDS,
  PHONE_APPOINTMENT_MIN_SECONDS,
  PHONE_IST_WINDOW_CLOSE_AT,
  PHONE_IST_WINDOW_OPEN_AT,
  PHONE_MAX_CONCURRENT,
  buildPhoneSlotGrid,
  istDayInstantRange,
  parseIstCalendarDate,
  type PhoneSlotOccupancy,
} from '../lib/phone-screening/index.js';

/** A post-cutoff IST day (after the 0085-extended 2026-09-13 override), where
 * the original 09:00–21:00 gate is active. */
const DAY = { year: 2026, month: 9, day: 14 };
/** Well before the window on that IST day, so nothing is in the past. */
const BEFORE_WINDOW = new Date('2026-09-13T18:31:00Z');

function grid(over: Partial<Parameters<typeof buildPhoneSlotGrid>[0]> = {}) {
  return buildPhoneSlotGrid({
    date: DAY,
    slotSeconds: 1_800,
    now: BEFORE_WINDOW,
    occupancy: [],
    ...over,
  });
}

describe('parseIstCalendarDate', () => {
  it('accepts a real date', () => {
    expect(parseIstCalendarDate('2026-08-24')).toEqual({ year: 2026, month: 8, day: 24 });
  });

  it('rejects a date the calendar does not have, rather than rolling it over', () => {
    // `new Date(Date.UTC(2026, 1, 30))` is 2026-03-02. Rolling would answer a
    // question the caller did not ask, on a surface where the answer is a day's
    // worth of slots.
    expect(() => parseIstCalendarDate('2026-02-30')).toThrow('phone_ist_date_invalid');
    expect(() => parseIstCalendarDate('2026-13-01')).toThrow('phone_ist_date_invalid');
    expect(() => parseIstCalendarDate('2026-00-10')).toThrow('phone_ist_date_invalid');
    expect(() => parseIstCalendarDate('2026-08-32')).toThrow('phone_ist_date_invalid');
  });

  it('rejects anything that is not exactly YYYY-MM-DD', () => {
    for (const bad of ['2026-8-24', '26-08-24', '2026-08-24T00:00:00Z', '', '2026/08/24']) {
      expect(() => parseIstCalendarDate(bad)).toThrow('phone_ist_date_invalid');
    }
  });

  it('accepts a leap day in a leap year and refuses it otherwise', () => {
    expect(parseIstCalendarDate('2028-02-29').day).toBe(29);
    expect(() => parseIstCalendarDate('2026-02-29')).toThrow('phone_ist_date_invalid');
  });
});

describe('istDayInstantRange', () => {
  it('spans IST midnight to IST midnight, not UTC midnight', () => {
    expect(istDayInstantRange(DAY)).toEqual({
      fromIso: '2026-09-13T18:30:00.000Z',
      toIso: '2026-09-14T18:30:00.000Z',
    });
  });

  it('rolls the month and the year correctly', () => {
    expect(istDayInstantRange({ year: 2026, month: 12, day: 31 }).toIso)
      .toBe('2026-12-31T18:30:00.000Z');
    expect(istDayInstantRange({ year: 2026, month: 1, day: 31 }).toIso)
      .toBe('2026-01-31T18:30:00.000Z');
  });

  it('covers the whole day, so a slot that runs past the close is still fetched', () => {
    // The range is the DAY, not the window: an appointment legally beginning at
    // 20:45 ends after 21:00 and still occupies its slot.
    const { fromIso, toIso } = istDayInstantRange(DAY);
    expect(Date.parse(toIso) - Date.parse(fromIso)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('the grid honours the window boundaries', () => {
  it('opens at 09:00 IST inclusive and never starts a slot at 21:00', () => {
    const slots = grid();
    expect(slots[0].istStart).toBe(PHONE_IST_WINDOW_OPEN_AT.slice(0, 5));
    expect(slots[0].startsAt).toBe('2026-09-14T03:30:00.000Z');
    const closeHm = PHONE_IST_WINDOW_CLOSE_AT.slice(0, 5);
    for (const slot of slots) {
      expect(slot.istStart < closeHm, `${slot.istStart} starts at or after the close`).toBe(true);
    }
  });

  it('produces 24 half-hour slots, the last of which starts at 20:30 IST', () => {
    const slots = grid();
    expect(slots).toHaveLength(24);
    expect(slots.at(-1)!.istStart).toBe('20:30');
    expect(slots.at(-1)!.istEnd).toBe('21:00');
    expect(slots.at(-1)!.endsAt).toBe('2026-09-14T15:30:00.000Z');
  });

  it('uses the full temporary day through September 13, without offering a cross-midnight slot', () => {
    const slots = buildPhoneSlotGrid({
      date: { year: 2026, month: 9, day: 13 },
      slotSeconds: 1_800,
      now: new Date('2026-09-12T18:30:00Z'),
      occupancy: [],
    });
    expect(slots[0].istStart).toBe('00:00');
    expect(slots).toHaveLength(47);
    expect(slots.at(-1)?.istStart).toBe('23:00');
    expect(slots.at(-1)?.istEnd).toBe('23:30');
  });

  it('is contiguous — each slot begins where the last ended', () => {
    const slots = grid();
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i].startsAt).toBe(slots[i - 1].endsAt);
    }
  });

  it('honours other legal step lengths', () => {
    expect(grid({ slotSeconds: PHONE_APPOINTMENT_MIN_SECONDS })).toHaveLength(48);
    expect(grid({ slotSeconds: PHONE_APPOINTMENT_MAX_SECONDS })).toHaveLength(12);
  });

  it('lets a final slot end after the close, exactly as 0042 allows', () => {
    // The window is a START-TIME predicate. A step that does not divide the
    // twelve hours leaves a last slot beginning inside the window and ending
    // outside it — legal, because the appointment trigger checks `starts_at`
    // and nothing else.
    const slots = grid({ slotSeconds: 2_100 });
    const last = slots.at(-1)!;
    expect(last.istStart < '21:00').toBe(true);
    expect(last.istEnd > '21:00').toBe(true);
  });

  it('refuses a step outside the 0042 duration envelope', () => {
    for (const bad of [
      PHONE_APPOINTMENT_MIN_SECONDS - 1,
      PHONE_APPOINTMENT_MAX_SECONDS + 1,
      0,
      -1_800,
      1_800.5,
    ]) {
      expect(() => grid({ slotSeconds: bad })).toThrow('phone_slot_seconds_out_of_range');
    }
  });

  it('refuses an unusable clock or occupancy rather than guessing', () => {
    expect(() => grid({ now: new Date('nope') })).toThrow('phone_now_invalid');
    expect(() =>
      grid({ occupancy: [{ startsAt: 'not-an-instant', endsAt: '2026-08-24T04:00:00.000Z' }] }),
    ).toThrow('phone_occupancy_invalid');
  });
});

describe('the grid is identical on all seven days', () => {
  it('offers the same slot count and the same IST wall times, Monday to Sunday', () => {
    // 2026-09-14 is a Monday; seven consecutive dates therefore cover every
    // weekday exactly once after the temporary override.
    const weekdaysSeen = new Set<number>();
    const reference = grid().map((s) => `${s.istStart}-${s.istEnd}`);
    for (let offset = 0; offset < 7; offset += 1) {
      const d = new Date(Date.UTC(2026, 8, 14 + offset));
      weekdaysSeen.add(d.getUTCDay());
      const slots = buildPhoneSlotGrid({
        date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
        slotSeconds: 1_800,
        now: BEFORE_WINDOW,
        occupancy: [],
      });
      expect(slots.map((s) => `${s.istStart}-${s.istEnd}`), `day offset ${offset}`)
        .toEqual(reference);
    }
    // Fail closed: seven distinct weekdays, so no day was silently skipped.
    expect(weekdaysSeen.size).toBe(7);
  });
});

describe('capacity comes from database facts, never from a guess', () => {
  const at = (istHm: string): string => {
    const [h, m] = istHm.split(':').map(Number);
    return new Date(Date.UTC(2026, 8, 14, h - 5, m - 30)).toISOString();
  };
  const booking = (from: string, to: string): PhoneSlotOccupancy => ({
    startsAt: at(from),
    endsAt: at(to),
  });

  it('mirrors phone_max_concurrent() and never invents a per-slot cap', () => {
    const slots = grid();
    for (const slot of slots) {
      expect(slot.maxConcurrent).toBe(PHONE_MAX_CONCURRENT);
      expect(slot.remaining).toBe(PHONE_MAX_CONCURRENT - slot.booked);
    }
  });

  it('counts a live appointment against every slot it overlaps', () => {
    // 09:45-10:45 overlaps the 09:30, 10:00 and 10:30 slots — three of them.
    const slots = grid({ occupancy: [booking('09:45', '10:45')] });
    const byStart = new Map(slots.map((s) => [s.istStart, s]));
    expect(byStart.get('09:00')!.booked).toBe(0);
    expect(byStart.get('09:30')!.booked).toBe(1);
    expect(byStart.get('10:00')!.booked).toBe(1);
    expect(byStart.get('10:30')!.booked).toBe(1);
    expect(byStart.get('11:00')!.booked).toBe(0);
  });

  it('treats touching intervals as NOT overlapping', () => {
    // A call ending exactly when the next slot begins occupies no part of it.
    // Half-open intervals are what make the count add up across a day.
    const slots = grid({ occupancy: [booking('09:00', '09:30')] });
    const byStart = new Map(slots.map((s) => [s.istStart, s]));
    expect(byStart.get('09:00')!.booked).toBe(1);
    expect(byStart.get('09:30')!.booked).toBe(0);
  });

  it('marks a slot unbookable once the fleet cap is projected to be consumed', () => {
    const full = Array.from({ length: PHONE_MAX_CONCURRENT }, () => booking('09:00', '09:30'));
    const slots = grid({ occupancy: full });
    const first = slots[0];
    expect(first.booked).toBe(PHONE_MAX_CONCURRENT);
    expect(first.remaining).toBe(0);
    expect(first.bookable).toBe(false);
    expect(first.refusals).toEqual(['at_projected_capacity']);
    // The next slot is untouched — the cap is per-instant, not per-day.
    expect(slots[1].bookable).toBe(true);
    expect(slots[1].refusals).toEqual([]);
  });

  it('never reports a negative remaining, even if the cap is somehow exceeded', () => {
    const over = Array.from({ length: PHONE_MAX_CONCURRENT + 4 }, () => booking('09:00', '09:30'));
    const slots = grid({ occupancy: over });
    expect(slots[0].booked).toBe(PHONE_MAX_CONCURRENT + 4);
    expect(slots[0].remaining).toBe(0);
    expect(slots[0].bookable).toBe(false);
  });

  it('refuses a slot whose start has already passed', () => {
    // 0042 answers `slot_in_past` for `p_starts_at < p_now`; offering such a
    // slot would be offering a refusal.
    const slots = grid({ now: new Date(at('12:15')) });
    const byStart = new Map(slots.map((s) => [s.istStart, s]));
    expect(byStart.get('11:30')!.refusals).toEqual(['slot_in_past']);
    expect(byStart.get('12:00')!.refusals).toEqual(['slot_in_past']);
    // The slot starting exactly at `now` is NOT in the past: the RPC's
    // comparison is strict.
    expect(byStart.get('12:30')!.refusals).toEqual([]);
    expect(byStart.get('12:30')!.bookable).toBe(true);
  });

  it('reports both refusals when both apply, and bookable is their conjunction', () => {
    const full = Array.from({ length: PHONE_MAX_CONCURRENT }, () => booking('09:00', '09:30'));
    const slots = grid({ occupancy: full, now: new Date(at('12:15')) });
    expect(slots[0].refusals).toEqual(['slot_in_past', 'at_projected_capacity']);
    expect(slots[0].bookable).toBe(false);
    for (const slot of slots) {
      expect(slot.bookable).toBe(slot.refusals.length === 0);
    }
  });
});
