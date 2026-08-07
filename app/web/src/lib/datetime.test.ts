import { describe, it, expect } from 'vitest';
import {
  NOT_AVAILABLE,
  toValidDate,
  isValidDate,
  formatDateTime,
  formatDate,
  formatRelative,
} from './datetime';

describe('toValidDate / isValidDate', () => {
  it('returns null for null, undefined, empty and whitespace strings', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(toValidDate(v)).toBeNull();
      expect(isValidDate(v)).toBe(false);
    }
  });

  it('returns null for malformed strings (the "Invalid Date" trigger)', () => {
    expect(toValidDate('not-a-date')).toBeNull();
    expect(toValidDate('2026-13-45T99:99:99Z')).toBeNull();
    expect(isValidDate('banana')).toBe(false);
  });

  it('parses ISO-8601 strings with an offset as absolute instants', () => {
    const a = toValidDate('2026-08-07T10:00:00+00:00');
    const b = toValidDate('2026-08-07T12:00:00+02:00');
    expect(a).not.toBeNull();
    // Same absolute instant despite different wall-clock/offset.
    expect(a!.getTime()).toBe(b!.getTime());
  });

  it('accepts Date and epoch-number inputs', () => {
    const d = new Date('2026-08-07T10:00:00Z');
    expect(toValidDate(d)!.getTime()).toBe(d.getTime());
    expect(toValidDate(d.getTime())!.getTime()).toBe(d.getTime());
  });
});

describe('formatDateTime / formatDate', () => {
  it('degrades to "Not available" instead of "Invalid Date"', () => {
    for (const v of [null, undefined, '', 'garbage']) {
      expect(formatDateTime(v)).toBe(NOT_AVAILABLE);
      expect(formatDate(v)).toBe(NOT_AVAILABLE);
      expect(formatDateTime(v)).not.toMatch(/Invalid Date/);
    }
  });

  it('formats a valid instant to a non-empty human string', () => {
    const out = formatDateTime('2026-08-07T10:00:00Z');
    expect(out).not.toBe(NOT_AVAILABLE);
    expect(out).toMatch(/2026/);
  });

  it('respects an explicit timezone option (timezone correctness)', () => {
    const utc = formatDateTime('2026-08-07T10:00:00Z', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      hourCycle: 'h23',
    });
    const ist = formatDateTime('2026-08-07T10:00:00Z', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
      hourCycle: 'h23',
    });
    expect(utc).toMatch(/10:00/);
    expect(ist).toMatch(/15:30/);
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-08-07T12:00:00Z');

  it('returns "Not available" for invalid input', () => {
    expect(formatRelative(null, now)).toBe(NOT_AVAILABLE);
    expect(formatRelative('nope', now)).toBe(NOT_AVAILABLE);
  });

  it('summarizes past instants with an "ago" phrasing', () => {
    const thirteenHoursAgo = new Date(now.getTime() - 13 * 3600 * 1000);
    const out = formatRelative(thirteenHoursAgo, now);
    expect(out).toMatch(/13/);
    expect(out).toMatch(/hour/);
    expect(out).toMatch(/ago/);
  });

  it('summarizes near-now as "just now"', () => {
    expect(formatRelative(new Date(now.getTime() - 1000), now)).toBe('just now');
  });

  it('summarizes future instants without "ago"', () => {
    const inTwoDays = new Date(now.getTime() + 2 * 86400 * 1000);
    const out = formatRelative(inTwoDays, now);
    expect(out).not.toMatch(/ago/);
    expect(out).toMatch(/2/);
  });
});
