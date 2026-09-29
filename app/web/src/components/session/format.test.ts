import { describe, expect, it } from 'vitest';
import { formatSessionWhen } from './format';

// Local-clock Dates, so the assertions hold in any runner timezone.
const NOW = new Date(2026, 8, 30, 12, 0);

describe('formatSessionWhen', () => {
  it('drops the year within the current year and uses a 24-hour clock', () => {
    expect(formatSessionWhen(new Date(2026, 8, 15, 15, 51), NOW)).toBe('15 Sep, 15:51');
    expect(formatSessionWhen(new Date(2026, 0, 3, 9, 5), NOW)).toBe('3 Jan, 09:05');
  });

  it('adds the year outside the current year', () => {
    expect(formatSessionWhen(new Date(2025, 11, 31, 23, 59), NOW)).toBe('31 Dec 2025, 23:59');
  });

  it('prints "Sep", not the locale-dependent "Sept"', () => {
    expect(formatSessionWhen(new Date(2026, 8, 1, 0, 0), NOW)).toMatch(/^1 Sep,/);
  });

  it('accepts ISO strings and returns null for anything that is not an instant', () => {
    expect(formatSessionWhen(new Date(2026, 8, 15, 15, 51).toISOString(), NOW)).toBe('15 Sep, 15:51');
    expect(formatSessionWhen(null, NOW)).toBeNull();
    expect(formatSessionWhen(undefined, NOW)).toBeNull();
    expect(formatSessionWhen('', NOW)).toBeNull();
    expect(formatSessionWhen('not a date', NOW)).toBeNull();
  });
});
