/**
 * The IST helper is the only place the phone calendar turns an instant into
 * something a human reads, so these tests are about one property above all
 * others: the answer must not depend on where the browser is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  IST_OFFSET_MINUTES,
  IST_TIME_ZONE,
  addIstDays,
  formatIstBandLabel,
  formatIstDayLabel,
  formatIstLongDayLabel,
  formatIstTime,
  formatIstTimeRange,
  isIstDate,
  istDateOf,
  istDayStartUtcIso,
  istTimeOf,
  istToday,
  istWallClockUtcIso,
  istWeekDates,
  istWeekStart,
} from './ist-datetime';

describe('IST constants', () => {
  it('pins the zone and its permanent offset', () => {
    expect(IST_TIME_ZONE).toBe('Asia/Kolkata');
    expect(IST_OFFSET_MINUTES).toBe(330);
  });
});

describe('instant → IST wall clock', () => {
  it('reads 09:00 IST from the corresponding UTC instant', () => {
    // 09:00 IST == 03:30 UTC the same calendar day.
    expect(istTimeOf('2026-08-26T03:30:00Z')).toBe('09:00');
    expect(istDateOf('2026-08-26T03:30:00Z')).toBe('2026-08-26');
  });

  it('rolls the IST date forward when UTC is still on the previous day', () => {
    // 20:30 UTC on the 25th is 02:00 IST on the 26th. A calendar that read
    // the UTC date here would file the call under the wrong day.
    expect(istDateOf('2026-08-25T20:30:00Z')).toBe('2026-08-26');
    expect(istTimeOf('2026-08-25T20:30:00Z')).toBe('02:00');
  });

  it('returns null rather than NaN for an unreadable instant', () => {
    expect(istDateOf('not-an-instant')).toBeNull();
    expect(istTimeOf('not-an-instant')).toBeNull();
  });
});

describe('IST wall clock → UTC wire value', () => {
  it('converts the start of an IST day to the UTC instant before it', () => {
    // 00:00 IST on the 24th is 18:30 UTC on the 23rd.
    expect(istDayStartUtcIso('2026-08-24')).toBe('2026-08-23T18:30:00.000Z');
  });

  it('converts the window open and close to UTC', () => {
    expect(istWallClockUtcIso('2026-08-26', 9, 0)).toBe('2026-08-26T03:30:00.000Z');
    expect(istWallClockUtcIso('2026-08-26', 21, 0)).toBe('2026-08-26T15:30:00.000Z');
  });

  it('round-trips a wall clock through UTC and back', () => {
    for (let hour = 9; hour < 21; hour += 1) {
      const iso = istWallClockUtcIso('2026-08-26', hour, 30);
      expect(istTimeOf(iso)).toBe(`${String(hour).padStart(2, '0')}:30`);
      expect(istDateOf(iso)).toBe('2026-08-26');
    }
  });

  it('produces a week bound exactly seven days wide, inside the API 31-day cap', () => {
    const from = Date.parse(istDayStartUtcIso('2026-08-24'));
    const to = Date.parse(istDayStartUtcIso(addIstDays('2026-08-24', 7)));
    expect((to - from) / (24 * 60 * 60 * 1000)).toBe(7);
  });
});

describe('IST calendar arithmetic', () => {
  it('validates real dates and rejects impossible ones', () => {
    expect(isIstDate('2026-08-26')).toBe(true);
    expect(isIstDate('2026-02-30')).toBe(false);
    expect(isIstDate('2026-8-6')).toBe(false);
    expect(isIstDate('')).toBe(false);
    expect(isIstDate(null)).toBe(false);
  });

  it('crosses month and year boundaries', () => {
    expect(addIstDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addIstDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addIstDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('anchors a week on Monday from any day inside it', () => {
    // 2026-08-24 is a Monday; 08-30 is the Sunday that ends the same week.
    for (const date of istWeekDates('2026-08-24')) {
      expect(istWeekStart(date)).toBe('2026-08-24');
    }
    expect(istWeekStart('2026-08-31')).toBe('2026-08-31');
    expect(istWeekStart('2026-08-23')).toBe('2026-08-17');
  });

  it('yields seven consecutive dates for a week', () => {
    expect(istWeekDates('2026-08-24')).toEqual([
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
    ]);
  });

  it('reads today from an injected clock, never the ambient one', () => {
    // 19:00 UTC is already the NEXT day in IST.
    expect(istToday(new Date('2026-08-25T19:00:00Z'))).toBe('2026-08-26');
    expect(istToday(new Date('2026-08-25T17:00:00Z'))).toBe('2026-08-25');
  });
});

describe('display formatters', () => {
  it('always names the zone on a time', () => {
    expect(formatIstTime('2026-08-26T03:30:00Z')).toBe('09:00 IST');
    expect(formatIstTimeRange('2026-08-26T03:30:00Z', '2026-08-26T04:00:00Z')).toBe(
      '09:00–09:30 IST',
    );
  });

  it('renders midnight as 00:00, never 24:00', () => {
    // A 24:00 would read as belonging to the wrong calendar day.
    expect(formatIstTime('2026-08-25T18:30:00Z')).toBe('00:00 IST');
  });

  it('says so rather than printing "Invalid Date"', () => {
    expect(formatIstTime('nonsense')).toBe('time unavailable');
    expect(formatIstTimeRange('nonsense', 'nonsense')).toBe('time unavailable');
    expect(formatIstDayLabel('nonsense')).toBe('date unavailable');
    expect(formatIstLongDayLabel('2026-02-30')).toBe('date unavailable');
  });

  it('labels days and bands legibly', () => {
    expect(formatIstDayLabel('2026-08-26')).toBe('Wed 26 Aug');
    expect(formatIstLongDayLabel('2026-08-26')).toBe('Wednesday, 26 August 2026');
    // "to", not an en dash: a dash is announced as a pause or not at all.
    expect(formatIstBandLabel(9, 10)).toBe('09:00 to 10:00 IST');
  });
});

/**
 * ── THE POINT OF THE WHOLE MODULE ─────────────────────────────────────
 *
 * Every assertion above would also pass on a helper that quietly used the
 * host zone, because the test host happens to run in UTC. This block moves
 * the host zone and asserts the answers do not move with it.
 *
 * It carries its own CONTROL. Reassigning `process.env.TZ` does not take
 * effect in every runtime, and a suite that silently skipped the zone shift
 * would be a safety assertion that cannot fail — worse than no assertion,
 * because it reads as coverage. So the control asserts that a deliberately
 * host-local reading DID change; if the harness failed to move the zone, the
 * control fails and the file goes red rather than green-and-vacuous.
 */
describe('host time zone independence', () => {
  const originalTz = process.env.TZ;
  // 03:30 UTC is 09:00 in IST and 20:30 the previous day in Los Angeles, so a
  // host-local reading and an IST reading disagree on BOTH the hour and the
  // calendar date.
  const instant = '2026-08-26T03:30:00Z';

  function hostLocalHour(): number {
    return new Date(instant).getHours();
  }

  let hourInUtcHost = 0;

  beforeAll(() => {
    process.env.TZ = 'UTC';
    hourInUtcHost = hostLocalHour();
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  it('control: the harness really does move the host zone', () => {
    process.env.TZ = 'America/Los_Angeles';
    const hourInLaHost = hostLocalHour();
    process.env.TZ = 'UTC';

    // If this fails, the runtime ignored the TZ change and the two
    // assertions below prove nothing — which is exactly why this exists.
    expect(hourInLaHost).not.toBe(hourInUtcHost);
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati'])(
    'answers identically with the host in %s',
    (zone) => {
      process.env.TZ = zone;

      expect(istTimeOf(instant)).toBe('09:00');
      expect(istDateOf(instant)).toBe('2026-08-26');
      expect(formatIstTime(instant)).toBe('09:00 IST');
      expect(formatIstDayLabel('2026-08-26')).toBe('Wed 26 Aug');
      expect(istDayStartUtcIso('2026-08-24')).toBe('2026-08-23T18:30:00.000Z');
      expect(istWeekStart('2026-08-26')).toBe('2026-08-24');
      expect(istToday(new Date('2026-08-25T19:00:00Z'))).toBe('2026-08-26');
    },
  );
});
