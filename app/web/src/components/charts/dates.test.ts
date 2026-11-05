/**
 * formatDay / formatDayTime run once per row on the Dashboard's Recent, intent
 * and appointment lists, and each call reads two or three instants. The
 * formatter behind them is shared; the labels must not change.
 */
import { describe, expect, it, vi } from 'vitest';
import { formatDay, formatDayTime } from './dates';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The parts read before the cache, verbatim: a new formatter per read. */
function uncachedParts(date: Date, timeZone?: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { ...out, hour: out.hour === 24 ? 0 : out.hour };
}

function uncachedDay(date: Date, now: Date, timeZone?: string): string {
  const p = uncachedParts(date, timeZone);
  const label = `${p.day} ${MONTHS[p.month - 1]}`;
  return p.year === uncachedParts(now, timeZone).year ? label : `${label} ${p.year}`;
}

function uncachedDayTime(date: Date, now: Date, timeZone?: string): string {
  const p = uncachedParts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${uncachedDay(date, now, timeZone)}, ${pad(p.hour)}:${pad(p.minute)}`;
}

const NOW = new Date('2026-11-05T09:00:00Z');
const INSTANTS = [
  '2026-09-03T14:05:00Z',
  '2026-01-01T00:00:00Z',
  '2025-12-31T18:30:00Z',
  '2025-12-31T18:29:00Z',
  '2024-02-29T23:59:00Z',
  '2026-11-05T18:45:00Z',
].map((iso) => new Date(iso));
const ZONES = [undefined, 'UTC', 'Asia/Kolkata', 'America/Los_Angeles'];

describe('chart date labels with a shared formatter', () => {
  it('match the per-call formatter byte for byte in every zone', () => {
    for (const timeZone of ZONES) {
      for (const date of INSTANTS) {
        expect(formatDay(date, { now: NOW, timeZone })).toBe(uncachedDay(date, NOW, timeZone));
        expect(formatDayTime(date, { now: NOW, timeZone })).toBe(uncachedDayTime(date, NOW, timeZone));
      }
    }
  });

  it('still returns null for an unreadable value', () => {
    for (const value of [null, undefined, '', 'not-a-date']) {
      expect(formatDay(value)).toBeNull();
      expect(formatDayTime(value)).toBeNull();
    }
  });

  it('builds one formatter per time zone, however many rows it labels', async () => {
    const Real = Intl.DateTimeFormat;
    const constructed = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        return new Real(locales, options);
      } as unknown as typeof Intl.DateTimeFormat);
    vi.resetModules();
    const fresh = await import('./dates');

    for (let row = 0; row < 200; row += 1) {
      fresh.formatDay(INSTANTS[row % INSTANTS.length], { now: NOW });
      fresh.formatDayTime(INSTANTS[row % INSTANTS.length], { now: NOW });
    }
    expect(constructed).toHaveBeenCalledTimes(1);

    for (let row = 0; row < 200; row += 1) {
      fresh.formatDayTime(INSTANTS[row % INSTANTS.length], { now: NOW, timeZone: 'Asia/Kolkata' });
    }
    expect(constructed).toHaveBeenCalledTimes(2);
  });
});
