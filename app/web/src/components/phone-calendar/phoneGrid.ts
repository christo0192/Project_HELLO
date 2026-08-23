/**
 * Pure placement arithmetic for the two calendar views.
 *
 * Kept out of the component files so those stay fast-refresh clean (the same
 * reason `mission-control/buttonStyles.ts` exists), and so the placement rules
 * — which decide whether a scheduled call is visible at all — can be tested
 * directly rather than through a render.
 */

import type { PhoneCalendarAppointment, PhoneWindow } from '../../types';
import { istDateOf, istTimeOf, type IstDate } from '../../lib/ist-datetime';

/** Fallback bands, used only when the API's window cannot be parsed. */
export const FALLBACK_OPEN_HOUR = 9;
export const FALLBACK_CLOSE_HOUR = 21;

/**
 * The leading hour of an IST wall-clock string such as `09:00:00`.
 * Returns null rather than a guess so the caller decides what to do.
 */
export function parseIstHour(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 24 ? hour : null;
}

export interface PhoneTimeBand {
  startHour: number;
  endHour: number;
}

/**
 * The hourly bands of the calling window.
 *
 * One row per hour from the inclusive open to the exclusive close, so the
 * default window yields twelve rows, 09:00–10:00 through 20:00–21:00. The
 * bands come from the window the API REPORTS, not from a constant compiled
 * into the view — if the approved window ever moves, the grid moves with it
 * instead of quietly cropping the new hours.
 *
 * The final appointment of a day may END after the close; the substrate
 * bounds only the START, and such a row still belongs to the band its start
 * falls in.
 */
export function windowBands(window: PhoneWindow | null): PhoneTimeBand[] {
  const open = parseIstHour(window?.open_ist) ?? FALLBACK_OPEN_HOUR;
  const close = parseIstHour(window?.close_ist) ?? FALLBACK_CLOSE_HOUR;
  const to = close > open ? close : FALLBACK_CLOSE_HOUR;
  const bands: PhoneTimeBand[] = [];
  for (let hour = open; hour < to; hour += 1) {
    bands.push({ startHour: hour, endHour: hour + 1 });
  }
  return bands.length > 0
    ? bands
    : [{ startHour: FALLBACK_OPEN_HOUR, endHour: FALLBACK_OPEN_HOUR + 1 }];
}

export function cellKey(date: string, startHour: number): string {
  return `${date}#${startHour}`;
}

export interface PlacedAppointments {
  byCell: Map<string, PhoneCalendarAppointment[]>;
  /** Rows that belong to no cell of this grid — surfaced, never dropped. */
  outside: PhoneCalendarAppointment[];
}

const byStartThenId = (a: PhoneCalendarAppointment, b: PhoneCalendarAppointment) =>
  a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id);

/**
 * Place each appointment into the cell its IST start falls in.
 *
 * The IST date and hour are recomputed here from the UTC instant rather than
 * read from the row's `ist_date`/`ist_start` display fields. Those are derived
 * by a 0042 trigger and are authoritative — but they are also NULLABLE, and a
 * grid that skipped a row whose display field happened to be null would be
 * hiding a real scheduled call. The instant is never null, so deriving from it
 * means every row lands somewhere, and anything that cannot be placed goes to
 * `outside` where the view still shows it.
 */
export function placeAppointments(
  appointments: ReadonlyArray<PhoneCalendarAppointment>,
  weekDates: ReadonlyArray<IstDate>,
  bands: ReadonlyArray<PhoneTimeBand>,
): PlacedAppointments {
  const byCell = new Map<string, PhoneCalendarAppointment[]>();
  const outside: PhoneCalendarAppointment[] = [];
  const dates = new Set(weekDates);

  for (const appt of appointments) {
    const date = istDateOf(appt.starts_at);
    const time = istTimeOf(appt.starts_at);
    const hour = time === null ? null : Number(time.slice(0, 2));
    const band =
      hour === null
        ? undefined
        : bands.find((b) => hour >= b.startHour && hour < b.startHour + 1);

    if (date === null || band === undefined || !dates.has(date)) {
      outside.push(appt);
      continue;
    }
    const key = cellKey(date, band.startHour);
    const bucket = byCell.get(key);
    if (bucket) bucket.push(appt);
    else byCell.set(key, [appt]);
  }

  // Stable order inside a cell: earliest first, then by id, so a re-read never
  // reshuffles two calls that start in the same minute.
  for (const bucket of byCell.values()) bucket.sort(byStartThenId);
  outside.sort(byStartThenId);
  return { byCell, outside };
}

export interface QueueGroup {
  /** Null for the trailing "outside this week" group. */
  date: IstDate | null;
  items: PhoneCalendarAppointment[];
}

/**
 * Group by IST day, in week order, with anything unplaceable in a trailing
 * group. Same rule as the grid: nothing is dropped.
 */
export function groupByIstDay(
  appointments: ReadonlyArray<PhoneCalendarAppointment>,
  weekDates: ReadonlyArray<IstDate>,
): QueueGroup[] {
  const buckets = new Map<string, PhoneCalendarAppointment[]>();
  const outside: PhoneCalendarAppointment[] = [];
  const known = new Set(weekDates);

  for (const appt of appointments) {
    const date = istDateOf(appt.starts_at);
    if (date === null || !known.has(date)) {
      outside.push(appt);
      continue;
    }
    const bucket = buckets.get(date);
    if (bucket) bucket.push(appt);
    else buckets.set(date, [appt]);
  }

  const groups: QueueGroup[] = weekDates
    .filter((date) => buckets.has(date))
    .map((date) => ({ date, items: (buckets.get(date) ?? []).sort(byStartThenId) }));

  if (outside.length > 0) {
    groups.push({ date: null, items: outside.sort(byStartThenId) });
  }
  return groups;
}
