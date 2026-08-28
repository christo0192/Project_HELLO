/**
 * The IST calendar, its boundaries, and the proof that TypeScript does not own
 * the window.
 *
 * Every instant in this file is CONSTRUCTED. Nothing reads the host clock, so
 * the suite gives the same answer in Asia/Kolkata, in UTC and in CI — a
 * boundary test that reads the machine clock passes in one and fails in the
 * other, which is worse than no test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IST_TIME_ZONE,
  PHONE_24X7_WINDOW,
  PHONE_IST_WINDOW,
  PHONE_IST_WINDOW_CLOSE_AT,
  PHONE_TEMPORARY_247_UNTIL_IST,
  PHONE_IST_WINDOW_OPEN_AT,
  PHONE_MAX_CONCURRENT,
  istDate,
  istSecondsOfDay,
  istWallClock,
  istWallClockToInstant,
  istWindowForDate,
  istWindowOpen,
  narrowIstWindow,
  nextIstDayWindowOpen,
  nextIstWindowOpen,
  parseIstClockTime,
} from '../lib/phone-screening/ist-window.js';
import { helperLiteral, functionBody, MIGRATION_0042, MIGRATION_0064 } from './support/phone-migration.js';

const IST_SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/phone-screening/ist-window.ts', import.meta.url)),
  'utf8',
);

/** Build a UTC instant from an IST wall clock, independently of the module. */
function ist(y: number, m: number, d: number, hh: number, mm = 0, ss = 0): Date {
  // IST is UTC+5:30 with no DST. This test-local conversion is INDEPENDENT of
  // the module under test on purpose: if both used the same helper, a wrong
  // helper would agree with itself.
  return new Date(Date.UTC(y, m - 1, d, hh - 5, mm - 30, ss));
}

describe('the DATABASE owns the window and the cap', () => {
  it('the TS mirrors equal the three SQL helpers, exactly', () => {
    expect(helperLiteral('phone_ist_window_open_at')).toBe(PHONE_IST_WINDOW_OPEN_AT);
    expect(helperLiteral('phone_ist_window_close_at')).toBe(PHONE_IST_WINDOW_CLOSE_AT);
    expect(Number(helperLiteral('phone_max_concurrent'))).toBe(PHONE_MAX_CONCURRENT);
    expect(PHONE_IST_WINDOW_OPEN_AT).toBe('09:00:00');
    expect(PHONE_IST_WINDOW_CLOSE_AT).toBe('21:00:00');
    expect(PHONE_MAX_CONCURRENT).toBe(10);
  });

  it('the normal predicate remains 09:00 INCLUSIVE to 21:00 EXCLUSIVE after the cutoff', () => {
    const body = functionBody('phone_ist_window_open');
    expect(body).toContain('screening_v2.phone_temporary_247_until()');
    expect(body).toContain('>= screening_v2.phone_ist_window_open_at()');
    expect(body).toContain('< screening_v2.phone_ist_window_close_at()');
    expect(MIGRATION_0064).toContain("date '2026-09-06'");
    expect(PHONE_IST_WINDOW.openSeconds).toBe(9 * 3600);
    expect(PHONE_IST_WINDOW.closeSeconds).toBe(21 * 3600);
  });

  it('narrowing is allowed; widening is REFUSED, not clamped', () => {
    const narrowed = narrowIstWindow({ openSeconds: 10 * 3600, closeSeconds: 19 * 3600 });
    expect(narrowed).toEqual({ openSeconds: 10 * 3600, closeSeconds: 19 * 3600 });
    // A silent clamp would let a configuration error look like it took effect.
    expect(() => narrowIstWindow({ openSeconds: 8 * 3600 })).toThrow(/widened/);
    expect(() => narrowIstWindow({ closeSeconds: 22 * 3600 })).toThrow(/widened/);
    expect(() => narrowIstWindow({ openSeconds: 20 * 3600, closeSeconds: 10 * 3600 }))
      .toThrow(/empty/);
    // A non-integer bound is refused outright rather than rounded: rounding
    // could round OUTWARD and quietly widen the window.
    expect(() => narrowIstWindow({ openSeconds: 9.5 * 3600 + 0.5 })).toThrow(/not_integer/);
    expect(() => narrowIstWindow({ closeSeconds: Number.NaN })).toThrow(/not_integer/);
    // Omitting a bound keeps the database's.
    expect(narrowIstWindow({})).toEqual(PHONE_IST_WINDOW);
  });

  it('a narrowed window can only refuse EARLIER than the database, never later', () => {
    const narrowed = narrowIstWindow({ openSeconds: 10 * 3600, closeSeconds: 19 * 3600 });
    for (let hour = 0; hour < 24; hour += 1) {
      const at = ist(2026, 8, 22, hour, 30);
      if (istWindowOpen(at, narrowed)) {
        // Narrow-open implies DB-open. The converse is deliberately not true.
        expect(istWindowOpen(at)).toBe(true);
      }
    }
  });

  it('no second definition of the window or the cap exists in TypeScript', () => {
    // The literals may appear ONCE each, as the mirrored constants. Anything
    // else would be the drift 0042 was shaped to prevent.
    expect((IST_SOURCE.match(/'09:00:00'/g) ?? []).length).toBe(1);
    expect((IST_SOURCE.match(/'21:00:00'/g) ?? []).length).toBe(1);
    // And nothing anywhere hand-rolls the offset.
    expect(IST_SOURCE).not.toContain('+05:30');
    expect(IST_SOURCE).not.toContain('19800');
    expect(IST_SOURCE).not.toContain('5.5');
    expect(IST_SOURCE).toContain('Intl.DateTimeFormat');
    expect(IST_TIME_ZONE).toBe('Asia/Kolkata');
    expect(MIGRATION_0042).toContain("at time zone 'Asia/Kolkata'");
  });
});

describe('boundaries, on all seven days', () => {
  // 2026-09-07 is a Monday; the seven consecutive dates cover every weekday
  // after the temporary override has ended.
  const DAYS = [7, 8, 9, 10, 11, 12, 13];

  it('08:59:59 refused, 09:00:00 admitted, 20:59:59 admitted, 21:00:00 refused', () => {
    for (const day of DAYS) {
      expect(istWindowOpen(ist(2026, 9, day, 8, 59, 59))).toBe(false);
      expect(istWindowOpen(ist(2026, 9, day, 9, 0, 0))).toBe(true);
      expect(istWindowOpen(ist(2026, 9, day, 20, 59, 59))).toBe(true);
      expect(istWindowOpen(ist(2026, 9, day, 21, 0, 0))).toBe(false);
    }
  });

  it('every day is a calling day — there is no weekend skip', () => {
    for (const day of DAYS) {
      const noon = ist(2026, 9, day, 12, 0, 0);
      expect(istWindowOpen(noon)).toBe(true);
      // Saturday the 22nd and Sunday the 23rd included.
      expect(nextIstWindowOpen(noon).getTime()).toBe(noon.getTime());
    }
    expect(functionBody('phone_next_window_open')).toContain('After the override');
  });

  it('IST midnight, not UTC midnight, rolls the day', () => {
    // 2026-08-22T18:45:00Z is 2026-08-23T00:15 IST: a NEW IST day while UTC is
    // still on the 22nd. The per-day attempt budget rolls here.
    const justAfterIstMidnight = new Date('2026-08-22T18:45:00.000Z');
    expect(istDate(justAfterIstMidnight)).toBe('2026-08-23');
    expect(justAfterIstMidnight.toISOString().slice(0, 10)).toBe('2026-08-22');

    // And the mirror case after the temporary period: 2026-09-07T00:30Z is
    // 06:00 IST — before the restored window opens.
    const utcMidnightish = new Date('2026-09-07T00:30:00.000Z');
    expect(istDate(utcMidnightish)).toBe('2026-09-07');
    expect(istWindowOpen(utcMidnightish)).toBe(false);
  });

  it('istSecondsOfDay and istWallClock agree with the constructed instant', () => {
    const at = ist(2026, 9, 7, 20, 59, 59);
    expect(istWallClock(at)).toEqual({
      year: 2026, month: 9, day: 7, hour: 20, minute: 59, second: 59,
    });
    expect(istSecondsOfDay(at)).toBe(20 * 3600 + 59 * 60 + 59);
  });

  it('the wall-clock inversion round-trips across a month and a year boundary', () => {
    for (const [y, m, d] of [[2026, 8, 22], [2026, 8, 31], [2026, 12, 31], [2027, 1, 1]] as const) {
      const at = istWallClockToInstant(y, m, d, 9 * 3600);
      expect(istWallClock(at)).toEqual({
        year: y, month: m, day: d, hour: 9, minute: 0, second: 0,
      });
    }
  });
});

describe('the effective temporary window', () => {
  it('is 24/7 through September 6 inclusive and restores the normal bounds', () => {
    expect(PHONE_TEMPORARY_247_UNTIL_IST).toBe('2026-09-06');
    expect(PHONE_24X7_WINDOW).toEqual({ openSeconds: 0, closeSeconds: 86_400 });
    expect(istWindowForDate('2026-09-06')).toBe(PHONE_24X7_WINDOW);
    expect(istWindowForDate('2026-09-07')).toBe(PHONE_IST_WINDOW);
    expect(istWindowOpen(new Date('2026-09-06T18:29:59.000Z'))).toBe(true);
    expect(istWindowOpen(new Date('2026-09-07T00:00:00.000Z'))).toBe(false);
  });

  it('the next legal instant is now during the override, then 09:00 IST after it', () => {
    const during = new Date('2026-09-06T18:29:59.000Z');
    expect(nextIstWindowOpen(during).getTime()).toBe(during.getTime());
    expect(nextIstWindowOpen(new Date('2026-09-07T00:00:00.000Z')).getTime())
      .toBe(ist(2026, 9, 7, 9, 0, 0).getTime());
  });

  it('before today\'s open returns today\'s open after the cutoff', () => {
    const early = ist(2026, 9, 7, 6, 0, 0);
    expect(nextIstWindowOpen(early).getTime()).toBe(ist(2026, 9, 7, 9, 0, 0).getTime());
  });

  it('inside the window returns the instant itself', () => {
    const inside = ist(2026, 9, 7, 14, 3, 7);
    expect(nextIstWindowOpen(inside).getTime()).toBe(inside.getTime());
  });

  it('at or after close returns TOMORROW\'S open', () => {
    expect(nextIstWindowOpen(ist(2026, 9, 7, 21, 0, 0)).getTime())
      .toBe(ist(2026, 9, 8, 9, 0, 0).getTime());
    expect(nextIstWindowOpen(ist(2026, 9, 30, 23, 30, 0)).getTime())
      .toBe(ist(2026, 10, 1, 9, 0, 0).getTime());
  });

  it('20:59 plus a 120-second reconnect backoff lands OUTSIDE the window', () => {
    // This is the reason the window is evaluated when the reconnect is ACTED
    // ON rather than when the drop happened: the wait is legal, the moment it
    // ends is not, and the deferral must go to the next real slot.
    const drop = ist(2026, 9, 7, 20, 59, 0);
    expect(istWindowOpen(drop)).toBe(true);

    const afterBackoff = new Date(drop.getTime() + 120_000);
    expect(istWallClock(afterBackoff).hour).toBe(21);
    expect(istWindowOpen(afterBackoff)).toBe(false);

    expect(nextIstWindowOpen(afterBackoff).getTime()).toBe(ist(2026, 9, 8, 9, 0, 0).getTime());
  });

  it('the next-IST-DAY helper always skips to tomorrow, even mid-window', () => {
    // The provider-failure deferral: today's attempt already holds today's
    // ist_date, so the per-day index refuses until the day rolls.
    const midday = ist(2026, 9, 7, 12, 0, 0);
    expect(nextIstDayWindowOpen(midday).getTime()).toBe(ist(2026, 9, 8, 9, 0, 0).getTime());
    expect(functionBody('apply_phone_event')).toContain(
      'screening_v2.phone_ist_date(p_now) + 1',
    );
  });

  it('rejects an invalid instant and an out-of-range second', () => {
    expect(() => istWallClock(new Date(Number.NaN))).toThrow(/instant_invalid/);
    expect(() => istWallClockToInstant(2026, 8, 22, 86_400)).toThrow(/out_of_range/);
    expect(() => istWallClockToInstant(2026, 8, 22, -1)).toThrow(/out_of_range/);
    expect(() => parseIstClockTime('9:00')).toThrow();
    expect(() => parseIstClockTime('25:00:00')).toThrow();
  });
});
