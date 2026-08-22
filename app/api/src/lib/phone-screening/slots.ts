/**
 * phone-screening/slots.ts — the IST slot grid, and what the database can and
 * cannot tell an operator about it.
 *
 * ── WHAT 0042 ACTUALLY GUARANTEES ─────────────────────────────────────
 * Three facts, and only three:
 *   1. `phone_ist_window_open_at()` / `phone_ist_window_close_at()` — 09:00
 *      INCLUSIVE to 21:00 EXCLUSIVE IST, every one of the seven days. It is a
 *      START-TIME predicate; the appointment trigger applies it to `starts_at`
 *      and to nothing else, so a slot that BEGINS at 20:45 is legal even though
 *      it ends after the close.
 *   2. `phone_max_concurrent()` — the fleet-wide cap of ten simultaneous live
 *      attempts.
 *   3. The live appointments themselves: `status in ('scheduled','confirmed')`
 *      with trigger-derived `ist_date`, which a caller cannot falsify.
 *
 * ── WHAT IT DOES NOT ──────────────────────────────────────────────────
 * There is NO per-slot capacity model in 0042. No table, column, constraint,
 * index or function bounds how many appointments may start in the same slot,
 * on the same IST date, or fleet-wide per day; `uq_phone_appointments_one_live`
 * is scoped to a single `engagement_id`. And the ten-concurrent cap is consumed
 * at `admit_phone_attempt` — DIAL time — not at booking time. Overbooking a
 * slot therefore produces `at_capacity` refusals when the calls are placed, not
 * an error when the slot is booked.
 *
 * So `remaining` below is a PROJECTION of a dial-time cap onto booking time. It
 * is computed entirely from the three facts above and invents nothing, but it
 * is not a reservation and this module does not pretend otherwise: every field
 * it returns is either a database fact or an arithmetic combination of database
 * facts, and `bookable` carries the stable reason codes that produced it rather
 * than a bare boolean a caller would have to guess the meaning of.
 *
 * The one quantity that is NOT a database fact is the grid STEP. 0042 bounds an
 * appointment to 900..3600 seconds and uses a 30-minute literal in exactly one
 * deferral path, but exposes no slot length. The step is therefore supplied by
 * the caller from `PhoneScreeningConfig.slotSeconds`, which is clamped to the
 * same 900..3600 envelope the CHECK enforces, and it is reported back in the
 * response so the grid is never mistaken for a schema guarantee.
 *
 * Pure. No clock, no client, no configuration read — every input is a parameter.
 */

import {
  PHONE_APPOINTMENT_MAX_SECONDS,
  PHONE_APPOINTMENT_MIN_SECONDS,
} from './vocabulary.js';
import {
  PHONE_IST_WINDOW,
  PHONE_MAX_CONCURRENT,
  istWallClock,
  istWallClockToInstant,
  type IstWindowBounds,
} from './ist-window.js';

/** Why a slot is not bookable. Stable codes; never free text. */
export const PHONE_SLOT_REFUSALS = ['slot_in_past', 'at_projected_capacity'] as const;

export type PhoneSlotRefusal = (typeof PHONE_SLOT_REFUSALS)[number];

export interface PhoneSlot {
  /** Slot start, UTC ISO-8601. The instant a call would be placed. */
  readonly startsAt: string;
  /** Slot end, UTC ISO-8601. May fall after the IST close — see the header. */
  readonly endsAt: string;
  /** IST wall clock, `HH:MM`, so a client never re-derives the time zone. */
  readonly istStart: string;
  readonly istEnd: string;
  /** Live appointments overlapping this slot. A database fact. */
  readonly booked: number;
  /** `phone_max_concurrent()`, mirrored. A database fact. */
  readonly maxConcurrent: number;
  /** `max(0, maxConcurrent - booked)`. Arithmetic over two database facts. */
  readonly remaining: number;
  /** True iff `refusals` is empty. Advisory: booking reserves no capacity. */
  readonly bookable: boolean;
  readonly refusals: readonly PhoneSlotRefusal[];
}

/** A live appointment, reduced to the two instants that decide overlap. */
export interface PhoneSlotOccupancy {
  readonly startsAt: string;
  readonly endsAt: string;
}

/** An IST calendar date, already split into its three fields. */
export interface IstCalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Parse `YYYY-MM-DD` into calendar fields. Throws on anything else. */
export function parseIstCalendarDate(value: string): IstCalendarDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error('phone_ist_date_invalid');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('phone_ist_date_invalid');
  // Reject a date the Gregorian calendar does not have (2026-02-30) rather
  // than silently rolling it into the next month, which would answer a
  // question the caller did not ask.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new Error('phone_ist_date_invalid');
  }
  return { year, month, day };
}

/** `HH:MM` in IST for an instant. */
function istHourMinute(at: Date): string {
  const w = istWallClock(at);
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
}

/** Two half-open intervals overlap iff each starts before the other ends. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export interface PhoneSlotGridInput {
  /** The IST calendar date the grid covers. */
  readonly date: IstCalendarDate;
  /** Grid step in seconds. Must lie in the 0042 duration envelope. */
  readonly slotSeconds: number;
  /** The instant "now" — injected, never read from the host clock. */
  readonly now: Date;
  /** Live (`scheduled`/`confirmed`) appointments of this IST day. */
  readonly occupancy: readonly PhoneSlotOccupancy[];
  /** Narrowed window bounds. Defaults to the database window. */
  readonly bounds?: IstWindowBounds;
}

/**
 * Build the slot grid for one IST calendar date.
 *
 * Every day is a calling day — 0042 has no weekend rule, no holiday table and
 * no per-weekday window — so this function is deliberately identical for all
 * seven, and a test pins that rather than trusting the sentence.
 */
export function buildPhoneSlotGrid(input: PhoneSlotGridInput): readonly PhoneSlot[] {
  const { slotSeconds } = input;
  if (
    !Number.isInteger(slotSeconds) ||
    slotSeconds < PHONE_APPOINTMENT_MIN_SECONDS ||
    slotSeconds > PHONE_APPOINTMENT_MAX_SECONDS
  ) {
    // The 0042 CHECK would refuse such an appointment on write; refusing to
    // OFFER it is the same rule applied one step earlier.
    throw new Error('phone_slot_seconds_out_of_range');
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error('phone_now_invalid');
  }
  const bounds = input.bounds ?? PHONE_IST_WINDOW;
  const nowMs = input.now.getTime();

  // Occupancy is reduced to numbers ONCE, so the inner loop is arithmetic
  // rather than a date parse per slot per appointment.
  const spans: Array<{ start: number; end: number }> = [];
  for (const o of input.occupancy) {
    const start = Date.parse(o.startsAt);
    const end = Date.parse(o.endsAt);
    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('phone_occupancy_invalid');
    spans.push({ start, end });
  }

  const slots: PhoneSlot[] = [];
  for (
    let offset = bounds.openSeconds;
    offset < bounds.closeSeconds;
    offset += slotSeconds
  ) {
    const startsAt = istWallClockToInstant(
      input.date.year,
      input.date.month,
      input.date.day,
      offset,
    );
    const startMs = startsAt.getTime();
    const endMs = startMs + slotSeconds * 1000;
    const endsAt = new Date(endMs);

    let booked = 0;
    for (const span of spans) {
      if (overlaps(span.start, span.end, startMs, endMs)) booked += 1;
    }
    const remaining = Math.max(0, PHONE_MAX_CONCURRENT - booked);

    const refusals: PhoneSlotRefusal[] = [];
    // A slot whose START has passed can never be booked: 0042 answers
    // `slot_in_past` for `p_starts_at < p_now`. Offering it would be offering
    // a refusal.
    if (startMs < nowMs) refusals.push('slot_in_past');
    if (remaining === 0) refusals.push('at_projected_capacity');

    slots.push({
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      istStart: istHourMinute(startsAt),
      istEnd: istHourMinute(endsAt),
      booked,
      maxConcurrent: PHONE_MAX_CONCURRENT,
      remaining,
      bookable: refusals.length === 0,
      refusals,
    });
  }
  return slots;
}

/**
 * The half-open UTC instant range covering one whole IST calendar day.
 *
 * Used to fetch occupancy. It spans the FULL day rather than only the window,
 * because an appointment that began at 20:45 legally runs past the close and
 * still occupies its slot.
 */
export function istDayInstantRange(date: IstCalendarDate): { fromIso: string; toIso: string } {
  const from = istWallClockToInstant(date.year, date.month, date.day, 0);
  // Normalised through `Date.UTC` so month and year roll correctly.
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  const to = istWallClockToInstant(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
  );
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}
