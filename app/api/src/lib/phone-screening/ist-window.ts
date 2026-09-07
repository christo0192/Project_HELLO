/**
 * phone-screening/ist-window.ts — the IST calendar, in TypeScript, mirroring
 * the SQL helpers rather than re-deciding them.
 *
 * ── THE DATABASE OWNS THE WINDOW ──────────────────────────────────────
 * `screening_v2.phone_ist_window_open_at()`, `phone_ist_window_close_at()`
 * and `phone_max_concurrent()` are the SINGLE definitions of the permanent
 * bounds and fleet cap. Migration 0064 (cutoff re-asserted by 0085) owns the
 * reviewed, date-bounded temporary override; the predicate below mirrors it.
 * TypeScript may NARROW the permanent bounds — a caller can refuse to dial
 * before 10:00 — but `narrowIstWindow` refuses any bound that would widen it.
 *
 * ── TIME IS INJECTED, ALWAYS ──────────────────────────────────────────
 * No function here reads the machine clock. Every entry point takes the
 * instant as a parameter, exactly as every 0042 function takes
 * `p_now timestamptz`. A boundary test that reads the host clock passes in
 * Asia and fails in CI.
 *
 * ── THE OFFSET IS DERIVED, NEVER WRITTEN DOWN ─────────────────────────
 * IST's offset from UTC is read from `Intl.DateTimeFormat` with `Asia/Kolkata`
 * on the instant being converted. No offset literal appears anywhere in this
 * file — not as a time string, not as a second count, not as a fraction of an
 * hour — and a structural assertion enforces that. India has no DST today, but
 * a hardcoded offset is a fact about 2026 rather than a conversion, and the tz
 * database is what Postgres's own `at time zone` consults.
 */

/** The one time zone this module knows about. */
export const IST_TIME_ZONE = 'Asia/Kolkata';

/** Mirror of `screening_v2.phone_ist_window_open_at()` — 09:00 IST, INCLUSIVE. */
export const PHONE_IST_WINDOW_OPEN_AT = '09:00:00';

/** Mirror of `screening_v2.phone_ist_window_close_at()` — 21:00 IST, EXCLUSIVE. */
export const PHONE_IST_WINDOW_CLOSE_AT = '21:00:00';

/**
 * Inclusive final IST date of the reviewed temporary all-day window.
 *
 * 2026-09-07 reconciliation: the live DB's `phone_temporary_247_until()` was
 * extended out-of-band to 2026-09-13 while this constant still said
 * 2026-09-06, and because the due-loop preflight consults THIS mirror before
 * admission ever reaches SQL, the DB extension was inert after 21:00 IST —
 * TS/DB drift turned an approved extension into a silent after-hours block.
 * Migration 0085 re-asserts the same cutoff in repo SQL; a follow-up to make
 * one side authoritative (so a lone out-of-band change cannot go inert) is
 * tracked separately.
 */
export const PHONE_TEMPORARY_247_UNTIL_IST = '2026-09-13';

/** The temporary window's full-day bounds. The normal bounds remain above. */
export const PHONE_24X7_WINDOW: IstWindowBounds = Object.freeze({
  openSeconds: 0,
  closeSeconds: 86_400,
});

/** Mirror of `screening_v2.phone_max_concurrent()` — the fleet-wide cap. */
export const PHONE_MAX_CONCURRENT = 10;

const SECONDS_PER_DAY = 86_400;

/** An IST wall-clock window, as seconds from IST midnight. Open incl, close excl. */
export interface IstWindowBounds {
  readonly openSeconds: number;
  readonly closeSeconds: number;
}

/** Parse `HH:MM:SS` into seconds from midnight. Throws on anything else. */
export function parseIstClockTime(value: string): number {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error('phone_ist_clock_time_invalid');
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (h > 23 || min > 59 || s > 59) throw new Error('phone_ist_clock_time_invalid');
  return h * 3600 + min * 60 + s;
}

/**
 * The DATABASE-AUTHORITATIVE window, derived from the two mirrored constants.
 * Nothing may widen this; `narrowIstWindow` is the only sanctioned way to
 * produce a different pair.
 */
export const PHONE_IST_WINDOW: IstWindowBounds = Object.freeze({
  openSeconds: parseIstClockTime(PHONE_IST_WINDOW_OPEN_AT),
  closeSeconds: parseIstClockTime(PHONE_IST_WINDOW_CLOSE_AT),
});

/**
 * Produce a NARROWER window, or throw. A bound outside the database window in
 * the widening direction is refused rather than clamped: silently clamping
 * would let a configuration error look like it took effect.
 */
export function narrowIstWindow(bounds: {
  openSeconds?: number;
  closeSeconds?: number;
}): IstWindowBounds {
  const openSeconds = bounds.openSeconds ?? PHONE_IST_WINDOW.openSeconds;
  const closeSeconds = bounds.closeSeconds ?? PHONE_IST_WINDOW.closeSeconds;
  if (!Number.isInteger(openSeconds) || !Number.isInteger(closeSeconds)) {
    throw new Error('phone_ist_window_not_integer');
  }
  if (openSeconds < PHONE_IST_WINDOW.openSeconds) throw new Error('phone_ist_window_widened');
  if (closeSeconds > PHONE_IST_WINDOW.closeSeconds) throw new Error('phone_ist_window_widened');
  if (closeSeconds <= openSeconds) throw new Error('phone_ist_window_empty');
  return Object.freeze({ openSeconds, closeSeconds });
}

// ═══════════════════════════════════════════════════════════════════════
// Intl-derived IST arithmetic
// ═══════════════════════════════════════════════════════════════════════

const IST_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: IST_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The IST wall-clock fields of an instant. */
export interface IstWallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function assertFiniteInstant(at: Date): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new Error('phone_ist_instant_invalid');
  }
}

/** Read an instant's IST wall clock through `Intl`. Never touches the host clock. */
export function istWallClock(at: Date): IstWallClock {
  assertFiniteInstant(at);
  const parts = IST_FORMAT.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error('phone_ist_format_incomplete');
    return Number(found.value);
  };
  // `hourCycle: 'h23'` keeps midnight at 00; a runtime that still emits 24
  // would otherwise put IST midnight on the previous calendar day.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Mirror of `screening_v2.phone_ist_date` — the IST calendar date, `YYYY-MM-DD`. */
export function istDate(at: Date): string {
  const w = istWallClock(at);
  const mm = String(w.month).padStart(2, '0');
  const dd = String(w.day).padStart(2, '0');
  return `${String(w.year).padStart(4, '0')}-${mm}-${dd}`;
}

/** Seconds elapsed since IST midnight for an instant. */
export function istSecondsOfDay(at: Date): number {
  const w = istWallClock(at);
  return w.hour * 3600 + w.minute * 60 + w.second;
}

/**
 * How far IST is ahead of UTC AT THIS INSTANT, in milliseconds, derived from
 * `Intl` rather than written down. Used only to invert a wall clock back into
 * an instant.
 */
function istOffsetMs(at: Date): number {
  const w = istWallClock(at);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // `at` may carry sub-second precision that the formatter dropped; remove it
  // so the offset is a whole-second quantity and never absorbs milliseconds.
  const flooredAt = Math.floor(at.getTime() / 1000) * 1000;
  return asIfUtc - flooredAt;
}

/**
 * Invert an IST wall clock back into an instant.
 *
 * Two passes, not one: the offset is a function of the instant, so the first
 * guess is made with the offset in force at the naive reading and then
 * re-derived at the guess. India has no DST, so the second pass is a no-op
 * today — it is here so a future tz-database change degrades to "correct"
 * rather than "off by an hour twice a year".
 */
export function istWallClockToInstant(
  year: number,
  month: number,
  day: number,
  secondsOfDay: number,
): Date {
  if (!Number.isInteger(secondsOfDay) || secondsOfDay < 0 || secondsOfDay >= SECONDS_PER_DAY) {
    throw new Error('phone_ist_seconds_out_of_range');
  }
  const naive = Date.UTC(year, month - 1, day) + secondsOfDay * 1000;
  let guess = new Date(naive - istOffsetMs(new Date(naive)));
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Date(naive - istOffsetMs(guess));
    if (next.getTime() === guess.getTime()) break;
    guess = next;
  }
  return guess;
}

// ═══════════════════════════════════════════════════════════════════════
// The window predicate and the next legal instant
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mirror of `screening_v2.phone_ist_window_open` — 24/7 through the reviewed
 * cutoff, then 09:00 INCLUSIVE to 21:00 EXCLUSIVE, all seven days. This is an
 * ADMISSION / START-TIME predicate: it
 * says whether a call may BEGIN now, never how long one already begun may run.
 */
function effectiveWindowForInstant(at: Date, bounds?: IstWindowBounds): IstWindowBounds {
  if (bounds !== undefined) return bounds;
  return istDate(at) <= PHONE_TEMPORARY_247_UNTIL_IST
    ? PHONE_24X7_WINDOW
    : PHONE_IST_WINDOW;
}

/** The effective bounds for a validated IST calendar date. */
export function istWindowForDate(date: string): IstWindowBounds {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('phone_ist_date_invalid');
  return date <= PHONE_TEMPORARY_247_UNTIL_IST
    ? PHONE_24X7_WINDOW
    : PHONE_IST_WINDOW;
}

export function istWindowOpen(at: Date, bounds?: IstWindowBounds): boolean {
  const s = istSecondsOfDay(at);
  const effective = effectiveWindowForInstant(at, bounds);
  return s >= effective.openSeconds && s < effective.closeSeconds;
}

/**
 * Mirror of `screening_v2.phone_next_window_open` — the next instant at or
 * after `at` at which the window is open.
 *
 * During the temporary period every instant is already legal. Afterward the
 * normal three cases apply: before today's open is today's open; inside the
 * window is `at` itself; at or after today's close is tomorrow's open. Every
 * day is a calling day, so there is no weekend skip to get wrong.
 */
export function nextIstWindowOpen(at: Date, bounds?: IstWindowBounds): Date {
  const w = istWallClock(at);
  const effective = effectiveWindowForInstant(at, bounds);
  const s = w.hour * 3600 + w.minute * 60 + w.second;
  if (s < effective.openSeconds) {
    return istWallClockToInstant(w.year, w.month, w.day, effective.openSeconds);
  }
  if (s < effective.closeSeconds) return at;
  // Tomorrow's IST date, normalised by `Date.UTC` so month/year roll correctly.
  const tomorrow = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  const tomorrowMidnight = istWallClockToInstant(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    0,
  );
  const tomorrowBounds = effectiveWindowForInstant(tomorrowMidnight, bounds);
  return istWallClockToInstant(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    tomorrowBounds.openSeconds,
  );
}

/**
 * The next legal instant on the NEXT IST day — the shape `apply_phone_event`
 * uses when a provider failure costs the engagement its IST day.
 */
export function nextIstDayWindowOpen(at: Date, bounds?: IstWindowBounds): Date {
  const w = istWallClock(at);
  const tomorrow = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  const tomorrowMidnight = istWallClockToInstant(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    0,
  );
  const effective = effectiveWindowForInstant(tomorrowMidnight, bounds);
  return istWallClockToInstant(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    effective.openSeconds,
  );
}
