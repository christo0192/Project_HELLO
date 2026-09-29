/**
 * The one date format for charts and figure-adjacent dates: `d MMM` within
 * the year, `d MMM yyyy` otherwise, times `HH:mm`. Month names are fixed so
 * no locale can turn "Sep" into "Sept".
 */
import { describe, it, expect } from 'vitest';
import { countPerDay, formatDay, formatDayLabel, formatDayTime } from '../dates';

describe('formatDayLabel', () => {
  it('reads a calendar day as "d MMM", with no zero padding', () => {
    expect(formatDayLabel('2026-09-03')).toBe('3 Sep');
    expect(formatDayLabel('2026-12-31')).toBe('31 Dec');
  });

  it('returns an unreadable value unchanged rather than "NaN undefined"', () => {
    expect(formatDayLabel('09/03')).toBe('09/03');
    expect(formatDayLabel('2026-13-01')).toBe('2026-13-01');
  });
});

describe('formatDay / formatDayTime', () => {
  const now = new Date('2026-09-16T06:30:00Z');

  it('drops the year within the current year and keeps it otherwise', () => {
    expect(formatDay('2026-09-03T10:00:00Z', { now, timeZone: 'UTC' })).toBe('3 Sep');
    expect(formatDay('2025-09-03T10:00:00Z', { now, timeZone: 'UTC' })).toBe('3 Sep 2025');
  });

  it('formats a time as 24-hour HH:mm in the requested zone', () => {
    // 08:30 UTC is 14:00 in India.
    expect(formatDayTime('2026-09-16T08:30:00Z', { now, timeZone: 'Asia/Kolkata' })).toBe('16 Sep, 14:00');
    expect(formatDayTime('2026-09-16T00:05:00Z', { now, timeZone: 'UTC' })).toBe('16 Sep, 00:05');
  });

  it('is null, never "Invalid Date", for a missing or broken value', () => {
    expect(formatDay(null)).toBeNull();
    expect(formatDay('not a date')).toBeNull();
    expect(formatDayTime('')).toBeNull();
  });
});

describe('countPerDay', () => {
  it('zero-fills every day in the window and labels it "d MMM"', () => {
    const now = new Date('2026-09-16T12:00:00Z');
    const series = countPerDay(
      [
        { created_at: '2026-09-16T01:00:00Z' },
        { created_at: '2026-09-16T09:00:00Z' },
        { created_at: '2026-09-14T09:00:00Z' },
        // Outside the window and unreadable: neither counted nor thrown on.
        { created_at: '2026-08-01T09:00:00Z' },
        { created_at: 'garbage' },
      ],
      3,
      now,
    );
    expect(series).toEqual([
      { label: '14 Sep', value: 1 },
      { label: '15 Sep', value: 0 },
      { label: '16 Sep', value: 2 },
    ]);
  });
});
