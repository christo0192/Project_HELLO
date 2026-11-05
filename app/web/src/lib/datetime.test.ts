import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  NOT_AVAILABLE,
  toValidDate,
  isValidDate,
  formatDateTime,
  formatDate,
  formatRelative,
  type DateInput,
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

describe('month spelling', () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes September as Sep, never the en-GB/en-IN Sept of current ICU", async () => {
    const parts: Intl.DateTimeFormatPart[] = [
      { type: 'day', value: '16' },
      { type: 'literal', value: ' ' },
      { type: 'month', value: 'Sept' },
      { type: 'literal', value: ' ' },
      { type: 'year', value: '2026' },
    ];
    // A regular function: the formatter is constructed with `new`.
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
      return { formatToParts: () => parts } as unknown as Intl.DateTimeFormat;
    });
    // A fresh module: an earlier test's cached formatter must not answer for the mock.
    vi.resetModules();
    const fresh = await import('./datetime');
    expect(fresh.formatDate('2026-09-16T10:00:00Z')).toBe('16 Sep 2026');
  });
});

describe('formatter cache (M026: 66% of Dashboard JS self time at 2,000 candidates)', () => {
  /**
   * The implementation before the cache, verbatim: a new formatter per call.
   * Every cached output must equal it byte for byte.
   */
  function uncached(value: DateInput, opts: Intl.DateTimeFormatOptions): string {
    const date = toValidDate(value);
    if (!date) return NOT_AVAILABLE;
    try {
      const clock: Intl.DateTimeFormatOptions = opts.hour ? { hourCycle: opts.hourCycle ?? 'h23' } : {};
      return new Intl.DateTimeFormat('en-GB', { ...opts, ...clock })
        .formatToParts(date)
        .map((part) => (part.type === 'month' && part.value === 'Sept' ? 'Sep' : part.value))
        .join('');
    } catch {
      return NOT_AVAILABLE;
    }
  }

  const INPUTS: DateInput[] = [
    '2026-09-16T15:44:00Z',
    '2026-09-30T23:59:59+05:30',
    '2026-01-01T00:00:00Z',
    '2025-12-31T18:30:00Z',
    '2024-02-29T12:00:00-08:00',
    '2026-03-08T10:00:00Z',
    '2026-11-01T08:30:00Z',
    1_792_000_000_000,
    0,
    new Date('2026-06-15T04:05:06Z'),
    new Date(Number.NaN),
    null,
    undefined,
    '',
    '   ',
    'not-a-date',
  ];

  const OPTIONS: Intl.DateTimeFormatOptions[] = [
    { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    { year: 'numeric', month: 'short', day: 'numeric' },
    { day: 'numeric', month: 'short' },
    { month: 'long', year: 'numeric' },
    { hour: '2-digit', minute: '2-digit' },
    { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' },
    { hour: 'numeric', minute: '2-digit', hour12: true },
    { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false },
    { weekday: 'short', day: '2-digit', month: 'short' },
    { dateStyle: 'medium' },
    { dateStyle: 'medium', timeStyle: 'short' },
    { timeZone: 'UTC', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
    { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
    { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'long' },
    // These throw: dateStyle cannot mix with a field, and the value is unknown.
    { dateStyle: 'medium', hour: 'numeric' },
    { month: 'bogus' as unknown as 'short' },
    { timeZone: 'Not/AZone' },
  ];

  it('returns byte-identical output for every input and option set, cold and warm', () => {
    for (const opts of OPTIONS) {
      for (const value of INPUTS) {
        const expected = uncached(value, opts);
        expect(formatDateTime(value, opts)).toBe(expected);
        expect(formatDateTime(value, opts)).toBe(expected);
      }
    }
  });

  it('keeps the defaults byte-identical too', () => {
    for (const value of INPUTS) {
      expect(formatDateTime(value)).toBe(
        uncached(value, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      );
      expect(formatDate(value)).toBe(uncached(value, { year: 'numeric', month: 'short', day: 'numeric' }));
    }
  });

  /** A fresh module (empty cache) and a count of the formatters it builds. */
  async function freshWithCounter() {
    const Real = Intl.DateTimeFormat;
    const constructed = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        return new Real(locales, options);
      } as unknown as typeof Intl.DateTimeFormat);
    vi.resetModules();
    const fresh = await import('./datetime');
    return { fresh, constructed };
  }

  it('builds one formatter per option set, however many rows it formats', async () => {
    const { fresh, constructed } = await freshWithCounter();
    for (let row = 0; row < 500; row += 1) fresh.formatDateTime(`2026-09-16T10:${String(row % 60).padStart(2, '0')}:00Z`);
    expect(constructed).toHaveBeenCalledTimes(1);

    for (let row = 0; row < 500; row += 1) fresh.formatDate('2026-09-16T10:00:00Z');
    expect(constructed).toHaveBeenCalledTimes(2);

    // Back to the first set: still two.
    fresh.formatDateTime('2026-09-16T10:00:00Z');
    expect(constructed).toHaveBeenCalledTimes(2);
  });

  it('treats the same options as one set whatever their key order, and an undefined option as absent', async () => {
    const { fresh, constructed } = await freshWithCounter();
    fresh.formatDateTime('2026-09-16T10:00:00Z', { day: 'numeric', month: 'short' });
    fresh.formatDateTime('2026-09-16T10:00:00Z', { month: 'short', day: 'numeric' });
    fresh.formatDateTime('2026-09-16T10:00:00Z', { month: 'short', day: 'numeric', timeZone: undefined });
    expect(constructed).toHaveBeenCalledTimes(1);
  });

  it('never shares a formatter across different values of one option', async () => {
    const { fresh, constructed } = await freshWithCounter();
    const utc = fresh.formatDateTime('2026-09-16T20:00:00Z', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
    const ist = fresh.formatDateTime('2026-09-16T20:00:00Z', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(constructed).toHaveBeenCalledTimes(2);
    expect(utc).toBe('20:00');
    expect(ist).toBe('01:30');
  });

  it('does not cache a failure: an invalid option set stays "Not available" and harms nothing else', async () => {
    const { fresh } = await freshWithCounter();
    const bad = { month: 'bogus' as unknown as 'short' };
    expect(fresh.formatDateTime('2026-09-16T10:00:00Z', bad)).toBe(NOT_AVAILABLE);
    expect(fresh.formatDateTime('2026-09-16T10:00:00Z', bad)).toBe(NOT_AVAILABLE);
    expect(fresh.formatDateTime('2026-09-16T10:00:00Z', { month: 'short' })).toBe('Sep');
  });

  it('builds again when the viewer\'s time zone changes, so no label keeps the old zone', async () => {
    // A formatter with no explicit timeZone pins the zone it was built in, and
    // a laptop can cross zones with the tab open. Date picks that up, so the
    // cache must too.
    const { fresh, constructed } = await freshWithCounter();
    fresh.formatDateTime('2026-09-16T10:00:00Z');
    fresh.formatDateTime('2026-09-16T10:00:00Z');
    expect(constructed).toHaveBeenCalledTimes(1);

    const moved = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(480);
    fresh.formatDateTime('2026-09-16T10:00:00Z');
    fresh.formatDateTime('2026-09-16T10:00:00Z');
    expect(constructed).toHaveBeenCalledTimes(2);
    moved.mockRestore();
  });
});

describe('one clock', () => {
  it('writes day-month order and a 24-hour time whatever the browser locale', () => {
    // 2026-09-16T15:44Z; the hour depends on the runner's zone, the shape does not.
    const out = formatDateTime('2026-09-16T15:44:00Z');
    expect(out).toMatch(/^\d{1,2} Sep 2026, \d{2}:\d{2}$/);
    expect(out).not.toMatch(/am|pm|AM|PM/);
  });
});
