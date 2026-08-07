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

/** Localized date + time, or "Not available". Timezone-aware (viewer local). */
export function formatDateTime(
  value: DateInput,
  opts: Intl.DateTimeFormatOptions = DEFAULT_DATETIME_OPTS,
): string {
  const date = toValidDate(value);
  if (!date) return NOT_AVAILABLE;
  try {
    return new Intl.DateTimeFormat(undefined, opts).format(date);
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
