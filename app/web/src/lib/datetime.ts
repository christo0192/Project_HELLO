/**
 * Defensive date/time formatting contract for the recruiter UI.
 *
 * Every timestamp the app renders flows through here so a null, undefined,
 * empty, or malformed value degrades to a graceful "Not available" instead of
 * the literal string "Invalid Date". Formatting is timezone-aware: values are
 * parsed as absolute instants (ISO-8601 strings carry their own offset) and
 * rendered in the viewer's local timezone via `Intl.DateTimeFormat`.
 *
 * The API contract for `*_at` fields is ISO-8601 strings; durations and
 * transcript offsets are seconds (formatted separately via
 * `formatDurationSec`). This module therefore never divides/multiplies by
 * 1000 and never guesses seconds-vs-milliseconds — it only formats instants.
 */

/** Displayed when a timestamp is missing or unparseable. Never "Invalid Date". */
export const NOT_AVAILABLE = 'Not available';

export type DateInput = string | number | Date | null | undefined;

/**
 * Parse an ISO string / epoch-ms number / Date into a valid Date, or null.
 * Returns null for null/undefined/empty-string/whitespace and any value that
 * produces an invalid Date (NaN time). Timezone information present in an ISO
 * string is preserved (the resulting Date is an absolute instant).
 */
export function toValidDate(value: DateInput): Date | null {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True when the value parses to a real instant. */
export function isValidDate(value: DateInput): boolean {
  return toValidDate(value) !== null;
}

const DEFAULT_DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

const DEFAULT_DATE_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
};

/**
 * Building an Intl formatter costs far more than using one, and these run per
 * row and per counting pass: one new formatter per call was 66% of Dashboard JS
 * self time at 2,000 candidates (M026 RCA). So there is one per option set.
 * Option sets are literals in the code, so this stays a handful of entries.
 */
const enGbFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A formatter with no explicit `timeZone` pins the zone it was built in, and a
 * laptop can cross zones with the tab open. A cheap signal for that move: the
 * zone's offset in January and in July. Asking Intl for the zone name would
 * build the very formatter this cache avoids. Two zones that agree on both
 * offsets are treated as one, so only a move between them keeps the old rules,
 * and those differ only in the weeks around a daylight-saving change.
 */
const ZONE_PROBES = [new Date(Date.UTC(2026, 0, 15)), new Date(Date.UTC(2026, 6, 15))];
const readZone = (): string => ZONE_PROBES.map((probe) => probe.getTimezoneOffset()).join('/');
let enGbFormattersZone = readZone();

/** The same options in any key order are one set; an undefined option is an absent one. */
function optionsKey(options: Intl.DateTimeFormatOptions): string {
  return JSON.stringify(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** The shared en-GB formatter for these options. Throws as the constructor does on bad options. */
export function enGbDateTimeFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const zone = readZone();
  if (zone !== enGbFormattersZone) {
    enGbFormatters.clear();
    enGbFormattersZone = zone;
  }
  const key = optionsKey(options);
  let formatter = enGbFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', options);
    enGbFormatters.set(key, formatter);
  }
  return formatter;
}

/** Localized date + time, or "Not available". Timezone-aware (viewer local). */
export function formatDateTime(
  value: DateInput,
  opts: Intl.DateTimeFormatOptions = DEFAULT_DATETIME_OPTS,
): string {
  const date = toValidDate(value);
  if (!date) return NOT_AVAILABLE;
  try {
    // ONE CLOCK: en-GB day-month order and a 24-hour clock for every viewer,
    // matching the session pages, the charts and the phone calendar. Left to
    // the browser locale, an en-IN viewer got "10:44 am" here and "10:44" on
    // the next page. The time zone is still the viewer's own.
    //
    // Current ICU writes September as "Sept" in en-GB/en-IN; every other
    // short month is three letters, and the charts' fixed month table says
    // "Sep". One spelling per page, whichever formatter drew it.
    const clock: Intl.DateTimeFormatOptions = opts.hour ? { hourCycle: opts.hourCycle ?? 'h23' } : {};
    return enGbDateTimeFormat({ ...opts, ...clock })
      .formatToParts(date)
      .map((part) => (part.type === 'month' && part.value === 'Sept' ? 'Sep' : part.value))
      .join('');
  } catch {
    // Extremely defensive: Intl should not throw for a valid Date.
    return NOT_AVAILABLE;
  }
}

/** Localized date only (no time), or "Not available". */
export function formatDate(
  value: DateInput,
  opts: Intl.DateTimeFormatOptions = DEFAULT_DATE_OPTS,
): string {
  return formatDateTime(value, opts);
}

const RELATIVE_UNITS: Array<{ limit: number; div: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { limit: 60, div: 1, unit: 'second' },
  { limit: 3600, div: 60, unit: 'minute' },
  { limit: 86400, div: 3600, unit: 'hour' },
  { limit: 604800, div: 86400, unit: 'day' },
  { limit: 2629800, div: 604800, unit: 'week' },
  { limit: 31557600, div: 2629800, unit: 'month' },
  { limit: Infinity, div: 31557600, unit: 'year' },
];

/**
 * Compact relative time such as "13 hours ago" / "in 2 days", or
 * "Not available". `now` is injectable for deterministic tests.
 */
export function formatRelative(value: DateInput, now: Date = new Date()): string {
  const date = toValidDate(value);
  if (!date) return NOT_AVAILABLE;
  const deltaSec = (date.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(deltaSec);
  if (abs < 5) return 'just now';
  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const { limit, div, unit } of RELATIVE_UNITS) {
      if (abs < limit) {
        return rtf.format(Math.round(deltaSec / div), unit);
      }
    }
    return NOT_AVAILABLE;
  } catch {
    return NOT_AVAILABLE;
  }
}
