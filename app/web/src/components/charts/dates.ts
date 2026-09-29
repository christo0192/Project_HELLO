/**
 * One date format for every chart axis and every figure-adjacent date.
 *
 * The dashboard's sibling charts used to disagree: the screening charts said
 * "18 Aug" (a locale-dependent `toLocaleDateString`, which also renders
 * "Sept" in en-GB/en-IN), the intake chart said "09/03". Two formats side by
 * side make a reader stop and work out whether 09/03 is 9 March. The rule
 * (docs/design, PRODUCT.md) is `d MMM` within the year and `d MMM yyyy`
 * otherwise, times `HH:mm`.
 *
 * Month names come from a fixed table rather than `Intl`, so "Sep" is "Sep"
 * in every locale and every ICU version, and a screenshot taken on one
 * machine matches the next.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` calendar day → "3 Sep". Days are the server's buckets, so the
 * string is read as a calendar date, never shifted through a timezone. An
 * unreadable value comes back unchanged (still honest, never "NaN undefined").
 */
export function formatDayLabel(ymd: string): string {
  const match = YMD.exec(ymd);
  if (!match) return ymd;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return ymd;
  return `${Number(match[3])} ${month}`;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function partsOf(date: Date, timeZone?: string): Parts {
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
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
  };
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface DayFormatOptions {
  /** "Now", for the within-this-year rule. Injectable for tests. */
  now?: Date;
  /** IANA zone; the viewer's own when omitted. */
  timeZone?: string;
}

/** An instant → "3 Sep", or "3 Sep 2025" outside the current year. `null` when unreadable. */
export function formatDay(
  value: string | number | Date | null | undefined,
  { now = new Date(), timeZone }: DayFormatOptions = {},
): string | null {
  const date = toDate(value);
  if (!date) return null;
  const p = partsOf(date, timeZone);
  const label = `${p.day} ${MONTHS[p.month - 1]}`;
  return p.year === partsOf(now, timeZone).year ? label : `${label} ${p.year}`;
}

/** An instant → "3 Sep, 14:05" (or "3 Sep 2025, 14:05"). `null` when unreadable. */
export function formatDayTime(
  value: string | number | Date | null | undefined,
  options: DayFormatOptions = {},
): string | null {
  const date = toDate(value);
  if (!date) return null;
  const p = partsOf(date, options.timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatDay(date, options)}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Items created per UTC day over the last `days` days, zero-filled and
 * labelled "d MMM". Zero-fill is truthful here: every day in the window was
 * observed, and a day with no rows had none. (A RATE series is different:
 * a day with no denominator is unknown and must be dropped, not zeroed; see
 * `buildRateSeries` in the screening scoreboard.)
 */
export function countPerDay(
  items: ReadonlyArray<{ created_at: string }>,
  days = 14,
  now: Date = new Date(),
): Array<{ label: string; value: number }> {
  const buckets = new Map<string, number>();
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - offset);
    buckets.set(day.toISOString().slice(0, 10), 0);
  }
  for (const item of items) {
    const created = new Date(item.created_at);
    if (Number.isNaN(created.getTime())) continue;
    const key = created.toISOString().slice(0, 10);
    const current = buckets.get(key);
    if (current !== undefined) buckets.set(key, current + 1);
  }
  return [...buckets.entries()].map(([ymd, value]) => ({ label: formatDayLabel(ymd), value }));
}
