/**
 * IST date/time formatting for the internal phone calendar.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────
 * The phone screening substrate (migration 0042) approves ONE calling
 * window, and it is expressed in India Standard Time: 09:00 inclusive to
 * 21:00 exclusive, on all seven days. The API speaks UTC on the wire and
 * refuses anything else — `2026-08-22T14:30:00Z` is accepted,
 * `2026-08-22T20:00:00+05:30` and `2026-08-22T14:30:00` are not.
 *
 * An operator in Bengaluru, a browser in Frankfurt and a server in UTC
 * must all agree on which hour a call happens in. The only way to get
 * that is to name the zone EXPLICITLY at every conversion, so this module
 * is the single place the phone calendar is allowed to turn an instant
 * into something a human reads. No component may call `toLocaleString`,
 * `getHours()`, `getDate()` or any other host-local accessor — those
 * silently answer in whatever zone the browser happens to be in, which is
 * the exact ambiguity the UTC-only wire format was chosen to prevent. A
 * structural test in the phone-calendar suite pins that.
 *
 * ── TWO KINDS OF VALUE, NEVER MIXED ───────────────────────────────────
 * `IstDate`    — a bare IST calendar date, `YYYY-MM-DD`. What the slots
 *                endpoint takes, and what the week grid is keyed by.
 * UTC instant  — a full ISO-8601 string ending in `Z`. What every
 *                appointment bound is, on the wire and in the database.
 *
 * Display strings are produced with `Intl.DateTimeFormat` under an
 * explicit `timeZone: 'Asia/Kolkata'`. Wire values are produced by fixed
 * arithmetic against the IST offset rather than by re-parsing a formatted
 * string: India has a single, permanent UTC+05:30 offset with no daylight
 * saving, so the arithmetic is exact, and it stays exact regardless of the
 * host zone the tests or the browser run in.
 */

/** The one zone this calendar is expressed in. */
export const IST_TIME_ZONE = 'Asia/Kolkata';

/**
 * IST is UTC+05:30 permanently — no daylight saving, no historical
 * transition inside any range this calendar can address (the API caps a
 * request at 31 days). This constant is therefore safe for arithmetic in
 * a way a generic zone offset would not be.
 */
export const IST_OFFSET_MINUTES = 330;

const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

/** A bare IST calendar date, `YYYY-MM-DD`. */
export type IstDate = string;

/** Shape of an IST calendar date. Not a claim that the date is real. */
export const IST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True iff `value` is a well-formed IST calendar date naming a real day. */
export function isIstDate(value: unknown): value is IstDate {
  if (typeof value !== 'string' || !IST_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() + 1 === month &&
    probe.getUTCDate() === day
  );
}

/**
 * Milliseconds for a UTC ISO instant, or null when it does not name a real
 * one. Returning null rather than NaN forces every caller to decide what an
 * unreadable instant renders as, instead of propagating a silent NaN into a
 * formatter that would print "Invalid Date" to an operator.
 */
function instantMs(utcIso: string): number | null {
  const ms = Date.parse(utcIso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The IST wall-clock fields of an instant, as if read off a clock in
 * Kolkata. Implemented by shifting the instant by the fixed offset and
 * reading UTC fields — `toISOString` is defined in UTC, so this never
 * consults the host zone.
 */
function istFields(ms: number): { date: IstDate; time: string } {
  const shifted = new Date(ms + IST_OFFSET_MS).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

/** The IST calendar date an instant falls on, or null. */
export function istDateOf(utcIso: string): IstDate | null {
  const ms = instantMs(utcIso);
  return ms === null ? null : istFields(ms).date;
}

/** The IST wall-clock `HH:MM` of an instant, or null. */
export function istTimeOf(utcIso: string): string | null {
  const ms = instantMs(utcIso);
  return ms === null ? null : istFields(ms).time;
}

/**
 * The UTC instant at which an IST calendar day begins (00:00 IST).
 *
 * This is the value that goes on the wire. It is derived by arithmetic,
 * not by formatting and re-parsing, so it cannot pick up the host zone.
 */
export function istDayStartUtcIso(date: IstDate): string {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  return new Date(midnightUtc - IST_OFFSET_MS).toISOString();
}

/**
 * The UTC instant of an IST wall-clock time on an IST calendar day.
 * `hour`/`minute` are IST wall-clock fields, e.g. (9, 0) is the window open.
 */
export function istWallClockUtcIso(
  date: IstDate,
  hour: number,
  minute: number,
): string {
  const wall = Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60 * 1000;
  return new Date(wall - IST_OFFSET_MS).toISOString();
}

/** `date` advanced by `days` IST calendar days. */
export function addIstDays(date: IstDate, days: number): IstDate {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The IST calendar date it is *right now* in India.
 *
 * The clock is injected so tests never depend on the wall clock, and so a
 * browser whose system clock is wrong cannot silently shift the grid.
 */
export function istToday(now: Date = new Date()): IstDate {
  return istFields(now.getTime()).date;
}

/**
 * The Monday of the IST week containing `date`.
 *
 * Monday, not Sunday: the calling window covers all seven days, so the week
 * has no "weekend" to sit at either end, and an Indian operator's working
 * week starts on Monday. The choice is arbitrary only in the sense that it
 * must be made once — it is made here, and the grid and the deep link both
 * read it from this function.
 */
export function istWeekStart(date: IstDate): IstDate {
  const ms = Date.parse(`${date}T00:00:00Z`);
  // getUTCDay on a UTC-midnight instant is the calendar weekday: 0=Sunday.
  const weekday = new Date(ms).getUTCDay();
  const backToMonday = (weekday + 6) % 7;
  return addIstDays(date, -backToMonday);
}

/** The seven IST dates of the week beginning at `weekStart`. */
export function istWeekDates(weekStart: IstDate): IstDate[] {
  return Array.from({ length: 7 }, (_, i) => addIstDays(weekStart, i));
}

// ── Display formatters — every one names the zone explicitly ──────────

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST_TIME_ZONE, ...options });
}

/**
 * `hourCycle: 'h23'` is set explicitly rather than relying on `hour12:
 * false`, which in some ICU versions renders midnight as "24:00" — a time
 * that reads as belonging to the wrong day on a calendar whose whole
 * purpose is to say which day a call is on.
 */
const timeFormatter = formatter({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFormatter = formatter({ weekday: 'short', day: '2-digit', month: 'short' });
const longDayFormatter = formatter({
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** `14:30 IST`, or a truthful placeholder when the instant is unreadable. */
export function formatIstTime(utcIso: string): string {
  const ms = instantMs(utcIso);
  if (ms === null) return 'time unavailable';
  return `${timeFormatter.format(new Date(ms))} IST`;
}

/** A full, unambiguous confirmation timestamp in India time. */
export function formatIstDateTime(utcIso: string): string {
  const ms = instantMs(utcIso);
  if (ms === null) return 'time unavailable';
  return `${new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms))} IST`;
}

/** `14:30–15:00 IST` across two instants. */
export function formatIstTimeRange(startIso: string, endIso: string): string {
  const start = instantMs(startIso);
  const end = instantMs(endIso);
  if (start === null || end === null) return 'time unavailable';
  return `${timeFormatter.format(new Date(start))}–${timeFormatter.format(
    new Date(end),
  )} IST`;
}

/** `Mon 24 Aug` for an IST calendar date. */
export function formatIstDayLabel(date: IstDate): string {
  if (!isIstDate(date)) return 'date unavailable';
  return dayFormatter.format(new Date(istDayStartUtcIso(date)));
}

/** `Monday, 24 August 2026` — the unabbreviated name, for column headers. */
export function formatIstLongDayLabel(date: IstDate): string {
  if (!isIstDate(date)) return 'date unavailable';
  return longDayFormatter.format(new Date(istDayStartUtcIso(date)));
}

/**
 * The accessible label for a grid time band, e.g. `09:00 to 10:00 IST`.
 * Spelled "to" rather than an en dash because a screen reader announces the
 * dash as a pause or not at all, turning a range into two bare numbers.
 */
export function formatIstBandLabel(startHour: number, endHour: number): string {
  const pad = (h: number) => String(h).padStart(2, '0');
  return `${pad(startHour)}:00 to ${pad(endHour)}:00 IST`;
}
