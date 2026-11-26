/**
 * The public booking page's IST slot grid (M035 S04, dark; D-S04-2, D-S04-3, D-S04-19..D-S04-22).
 *
 * ── WHAT THE GRID IS ──────────────────────────────────────────────────
 * A PROJECTION of the R1 caps onto the public page. Its facts are what `r1_meet_public_capacity`
 * (migration 0143) answers: `admits`, `effective_concurrency`, the live booking intervals of both
 * sources and the per-IST-day counts, plus the configured `R1MeetPublicSlotRules` and the Meet daily
 * bot cap. Every field it returns is one of those facts or arithmetic over them; it invents nothing,
 * and each slot carries ONE stable reason code rather than a bare boolean a caller would have to
 * guess the meaning of.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────
 * Not a reservation. Two candidates can both see a slot `open`; the create RPC
 * (`r1_meet_create_round_from_public`) re-checks slot and day capacity under its advisory locks, and
 * that lock is the truth. The grid applies the SAME rules one step earlier, so an `open` slot is one
 * the RPC would accept unless somebody else books it first:
 *   - overlap is half-open, `start < slotEnd && end > slotStart` (the `overlaps` rule of
 *     lib/phone-screening/slots.ts), and EVERY overlapping live interval counts: two back-to-back
 *     bookings that both overlap one slot count as two, exactly as the RPC counts them;
 *   - the notice is strict: a slot starting before now + minNotice is `notice`;
 *   - the expiry bound is 0142 step 6 verbatim: end + 7200 s > now + 14 days is `not_offered`.
 * `seats` and the two day limits are returned so S06 sends the SAME numbers to the create and move
 * RPCs. Seats never leave the server: the page is told reasons, never capacities.
 *
 * ── THE REASONS, FIRST MATCH WINS ─────────────────────────────────────
 *   fully_booked  `admits` is false: no further R1 round fits anywhere, so every slot is refused
 *   closed_date   the IST date is in `closedDates` (closed dates are LISTED with every slot refused;
 *                 dates whose ISO weekday is not in `isoWeekdays` are OMITTED)
 *   notice        start < now + minNoticeMinutes
 *   not_offered   end + R1_PUBLIC_EXPIRY_GRACE_SEC > now + 14 days
 *   day_full      the day's `public` count >= publicDailyCap, or its `total` >= dailyBotCap (a day
 *                 with no count entry counts 0 and 0)
 *   slot_full     seats is 0, or overlapping live intervals >= seats
 *   open          everything else; `available` is true for `open` and only for `open`
 * `fullyBooked` is true when `admits` is false or no slot of the grid is available.
 *
 * ── IST DAYS ──────────────────────────────────────────────────────────
 * India has one zone and no daylight saving, so an IST day is the fixed-offset window of
 * `r1MeetIstDay` (runtime-store.ts): 18:30Z to 18:30Z. Files under lib/r1 may not import
 * lib/phone-screening (r1-scorer-isolation), so the day arithmetic is local and its test pins it
 * against the Intl helpers (`istDate`, `istWallClockToInstant`) and against `r1MeetIstDay`. No start
 * is ever before 09:00 IST (R1_PUBLIC_EARLIEST_START_MINUTE_IST; the deploy window is 07:00-08:30
 * IST), and no slot crosses IST midnight (one ending exactly at 24:00 is allowed).
 *
 * ── INPUTS ────────────────────────────────────────────────────────────
 * Anything malformed throws `Error('r1_public_slot_input_invalid')`: the message is the code and
 * never a value (S06 maps it to its own unavailable answer). The refusals are listed at
 * `readRules`, `readIntervals` and `readDayCounts`. `findR1PublicSlot` never throws.
 *
 * Pure. No clock, no client, no configuration read, no logging: every input is a parameter, and
 * every returned object and array is frozen.
 */

import { parseR1MeetInstant } from '../ticket.js';

// ── The rules (the contract's §2 shape) ─────────────────────────────────────

/**
 * The public slot rules, field for field the contract's §2 `R1MeetPublicSlotRules` (S03 declares
 * it in config.ts). Structurally identical copy until S03 merges; the later of S03 and S04 replaces
 * it with a type re-export from config.ts (D-S04-2).
 */
export interface R1MeetPublicSlotRules {
  readonly slotMinutes: number;
  readonly stepMinutes: number;
  /** Minutes after IST midnight (09:00 = 540). */
  readonly firstStartMinuteIst: number;
  /** 20:30 = 1230. */
  readonly lastStartMinuteIst: number;
  /** 1 = Monday .. 7 = Sunday, sorted, unique. */
  readonly isoWeekdays: readonly number[];
  /** 'YYYY-MM-DD' (IST), sorted, unique. */
  readonly closedDates: readonly string[];
  readonly minNoticeMinutes: number;
  readonly horizonDays: number;
  readonly slotCapacity: number;
  readonly browserHeadroom: number;
  readonly publicDailyCap: number;
}

/** Why a slot is (or is not) bookable. Stable codes, never free text; the contract's §7.2 order. */
export const R1_PUBLIC_SLOT_REASONS = Object.freeze([
  'open',
  'slot_full',
  'day_full',
  'notice',
  'closed_date',
  'not_offered',
  'fully_booked',
] as const);

export type R1PublicSlotReason = (typeof R1_PUBLIC_SLOT_REASONS)[number];

/** 09:00 IST: no public start is ever earlier (the deploy window is 07:00-08:30 IST). */
export const R1_PUBLIC_EARLIEST_START_MINUTE_IST = 540;

/** The round expiry grace the create RPC adds to the slot end; equals `R1_MEET_ROUND_EXPIRY_GRACE_SEC`. */
export const R1_PUBLIC_EXPIRY_GRACE_SEC = 7200;

/** 0142 step 6: a round may not expire more than 14 days after now (`interval '14 days'`). */
export const R1_PUBLIC_MAX_EXPIRY_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The widest horizon the grid accepts: the capacity RPC's window cap (15 days). Configuration
 * allows 1..13; the wider grid range lets a test reach the 14-day bound.
 */
export const R1_PUBLIC_GRID_MAX_HORIZON_DAYS = 15;

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface R1PublicSlot {
  /** Slot start, UTC ISO-8601 (`toISOString`). The page posts this string back unchanged. */
  readonly startAt: string;
  /** Slot end, UTC ISO-8601: start + slotMinutes. */
  readonly endAt: string;
  /** The IST calendar date of the slot, `YYYY-MM-DD`. */
  readonly istDate: string;
  /** True exactly when `reason` is `open`. Advisory: the create RPC decides under its lock. */
  readonly available: boolean;
  readonly reason: R1PublicSlotReason;
}

export interface R1PublicSlotGridInput {
  /** The instant "now", epoch ms: injected, never read from the host clock. */
  readonly nowMs: number;
  readonly rules: R1MeetPublicSlotRules;
  /** The Meet daily bot cap (`R1_MEET_DAILY_BOT_CAP`), compared with a day's `total`. */
  readonly dailyBotCap: number;
  /** `effective_concurrency` of the capacity RPC. */
  readonly effectiveConcurrency: number;
  /** `admits` of the capacity RPC. */
  readonly admits: boolean;
  /** Live bookings of both sources (zoned ISO instants), as the capacity RPC lists them. */
  readonly intervals: readonly { readonly startAt: string; readonly endAt: string }[];
  /** Per IST date (`YYYY-MM-DD`): day counts of both sources (`total`) and of the public page (`public`). */
  readonly dayCounts: Readonly<Record<string, { readonly total: number; readonly public: number }>>;
}

export interface R1PublicSlotGrid {
  /** Offered IST dates, ascending, today first when its weekday is offered. */
  readonly days: readonly { readonly date: string; readonly slots: readonly R1PublicSlot[] }[];
  /** Per-slot capacity (`r1PublicSlotSeats`): the create and move RPCs' `p_slot_seats`. Server only. */
  readonly seats: number;
  /** `rules.publicDailyCap`: the RPCs' `p_public_day_limit`. */
  readonly publicDayLimit: number;
  /** `dailyBotCap`: the RPCs' `p_bot_day_limit`. */
  readonly botDayLimit: number;
  /** `admits` is false, or no slot is available. */
  readonly fullyBooked: boolean;
}

// ── IST day arithmetic (the r1MeetIstDay model) ─────────────────────────────

const INVALID = 'r1_public_slot_input_invalid';
const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * MINUTE_MS;
/** India has one zone and no daylight saving: five and a half hours ahead of UTC (`r1MeetIstDay`). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
/**
 * `nowMs` must lie in [1970, 9999) so every date this module prints has four year digits; the
 * horizon (at most 15 days) cannot push past it.
 */
const MAX_NOW_MS = Date.UTC(9998, 11, 1);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalid(): never {
  throw new Error(INVALID);
}

/** The instant of IST midnight that starts the IST day containing `ms`. */
function istDayStartMs(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** The IST calendar date (`YYYY-MM-DD`) of the IST day starting at `dayStartMs`. */
function istDateOf(dayStartMs: number): string {
  return new Date(dayStartMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The ISO weekday (1 = Monday .. 7 = Sunday) of the IST day starting at `dayStartMs`. */
function isoWeekdayOf(dayStartMs: number): number {
  const day = new Date(dayStartMs + IST_OFFSET_MS).getUTCDay();
  return day === 0 ? 7 : day;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ── Reading the inputs (every refusal throws INVALID) ────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A safe integer >= min, else INVALID. */
function int(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid();
  return value;
}

/** A real Gregorian `YYYY-MM-DD` (2026-02-30 is not one). */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function readNow(nowMs: unknown): number {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0 || nowMs >= MAX_NOW_MS) invalid();
  return nowMs;
}

interface ReadRules {
  readonly slotMinutes: number;
  readonly stepMinutes: number;
  readonly firstStartMinuteIst: number;
  readonly lastStartMinuteIst: number;
  readonly isoWeekdays: ReadonlySet<number>;
  readonly closedDates: ReadonlySet<string>;
  readonly minNoticeMinutes: number;
  readonly horizonDays: number;
  readonly publicDailyCap: number;
}

/**
 * Refuses: a rules value that is not a plain object; any numeric rule that is not a safe integer;
 * slotMinutes or stepMinutes below 1; firstStartMinuteIst before 540 (09:00); lastStartMinuteIst
 * before firstStartMinuteIst; lastStartMinuteIst + slotMinutes past 1440 (a slot crossing IST
 * midnight); horizonDays outside 1..15; a negative notice, capacity, headroom or public cap;
 * isoWeekdays not an array or holding anything but 1..7 (an empty list is allowed); closedDates not
 * an array or holding anything but a real `YYYY-MM-DD`.
 */
function readRules(rules: unknown): ReadRules {
  if (!isPlainObject(rules)) invalid();
  const slotMinutes = int(rules.slotMinutes, 1);
  const stepMinutes = int(rules.stepMinutes, 1);
  const firstStartMinuteIst = int(rules.firstStartMinuteIst, R1_PUBLIC_EARLIEST_START_MINUTE_IST);
  const lastStartMinuteIst = int(rules.lastStartMinuteIst, firstStartMinuteIst);
  if (lastStartMinuteIst + slotMinutes > DAY_MINUTES) invalid();
  const horizonDays = int(rules.horizonDays, 1);
  if (horizonDays > R1_PUBLIC_GRID_MAX_HORIZON_DAYS) invalid();
  const minNoticeMinutes = int(rules.minNoticeMinutes, 0);
  int(rules.slotCapacity, 0);
  int(rules.browserHeadroom, 0);
  const publicDailyCap = int(rules.publicDailyCap, 0);

  if (!Array.isArray(rules.isoWeekdays)) invalid();
  const isoWeekdays = new Set<number>();
  for (const weekday of rules.isoWeekdays as readonly unknown[]) {
    const n = int(weekday, 1);
    if (n > 7) invalid();
    isoWeekdays.add(n);
  }
  if (!Array.isArray(rules.closedDates)) invalid();
  const closedDates = new Set<string>();
  for (const date of rules.closedDates as readonly unknown[]) {
    if (!isCalendarDate(date)) invalid();
    closedDates.add(date);
  }
  return {
    slotMinutes,
    stepMinutes,
    firstStartMinuteIst,
    lastStartMinuteIst,
    isoWeekdays,
    closedDates,
    minNoticeMinutes,
    horizonDays,
    publicDailyCap,
  };
}

/**
 * Pre-parses the live intervals ONCE into number pairs, so the slot loop is arithmetic rather than
 * a parse per slot per booking (the lib/phone-screening/slots.ts pattern). Refuses: not an array; an
 * entry that is not a plain object; an instant that is not zoned ISO 8601 (`parseR1MeetInstant`);
 * an end at or before its start.
 */
function readIntervals(intervals: unknown): { readonly starts: number[]; readonly ends: number[] } {
  if (!Array.isArray(intervals)) invalid();
  const starts: number[] = [];
  const ends: number[] = [];
  for (const interval of intervals as readonly unknown[]) {
    if (!isPlainObject(interval)) invalid();
    const start = parseR1MeetInstant(interval.startAt);
    const end = parseR1MeetInstant(interval.endAt);
    if (start === null || end === null || end <= start) invalid();
    starts.push(start);
    ends.push(end);
  }
  return { starts, ends };
}

/**
 * Refuses: dayCounts that is not a plain object (a Map would read as "no counts", which fails open);
 * a key that is not a real `YYYY-MM-DD`; a value that is not a plain object with non-negative safe
 * integer `total` and `public`.
 */
function readDayCounts(dayCounts: unknown): ReadonlyMap<string, { readonly total: number; readonly public: number }> {
  if (!isPlainObject(dayCounts)) invalid();
  const counts = new Map<string, { readonly total: number; readonly public: number }>();
  for (const date of Object.keys(dayCounts)) {
    if (!isCalendarDate(date)) invalid();
    const value = dayCounts[date];
    if (!isPlainObject(value)) invalid();
    counts.set(date, { total: int(value.total, 0), public: int(value.public, 0) });
  }
  return counts;
}

// ── The grid ────────────────────────────────────────────────────────────────

/**
 * Per-slot capacity: `max(0, min(slotCapacity, effectiveConcurrency - browserHeadroom))`. Zero for
 * any input that is not a safe integer (and for a rules value that is not an object). Never throws.
 */
export function r1PublicSlotSeats(rules: R1MeetPublicSlotRules, effectiveConcurrency: number): number {
  if (typeof rules !== 'object' || rules === null) return 0;
  const { slotCapacity, browserHeadroom } = rules;
  if (
    !Number.isSafeInteger(slotCapacity) ||
    !Number.isSafeInteger(browserHeadroom) ||
    !Number.isSafeInteger(effectiveConcurrency)
  ) {
    return 0;
  }
  return Math.max(0, Math.min(slotCapacity, effectiveConcurrency - browserHeadroom));
}

/**
 * Build the grid: IST today .. today + horizonDays - 1, offered weekdays only, starts from
 * firstStartMinuteIst to lastStartMinuteIst every stepMinutes, each slotMinutes long, one reason per
 * slot (the header's order). Throws `r1_public_slot_input_invalid` on malformed input (also when
 * `dailyBotCap` or `effectiveConcurrency` is not a non-negative safe integer or `admits` is not a
 * boolean, or `nowMs` is not a finite instant in [1970, 9999)).
 */
export function buildR1PublicSlotGrid(input: R1PublicSlotGridInput): R1PublicSlotGrid {
  if (!isPlainObject(input)) invalid();
  const nowMs = readNow(input.nowMs);
  const rules = readRules(input.rules);
  const dailyBotCap = int(input.dailyBotCap, 0);
  const effectiveConcurrency = int(input.effectiveConcurrency, 0);
  if (typeof input.admits !== 'boolean') invalid();
  const admits = input.admits;
  const { starts, ends } = readIntervals(input.intervals);
  const counts = readDayCounts(input.dayCounts);
  const seats = r1PublicSlotSeats(input.rules, effectiveConcurrency);

  const todayStartMs = istDayStartMs(nowMs);
  const noticeEdgeMs = nowMs + rules.minNoticeMinutes * MINUTE_MS;
  const expiryEdgeMs = nowMs + R1_PUBLIC_MAX_EXPIRY_AHEAD_MS;
  const graceMs = R1_PUBLIC_EXPIRY_GRACE_SEC * 1000;
  const slotMs = rules.slotMinutes * MINUTE_MS;

  /** Half-open overlap count, stopping as soon as it reaches the seats. */
  const isFull = (startMs: number, endMs: number): boolean => {
    let overlapping = 0;
    for (let i = 0; i < starts.length; i += 1) {
      if (starts[i]! < endMs && ends[i]! > startMs) {
        overlapping += 1;
        if (overlapping >= seats) return true;
      }
    }
    return false;
  };

  const days: { readonly date: string; readonly slots: readonly R1PublicSlot[] }[] = [];
  let anyAvailable = false;
  for (let offset = 0; offset < rules.horizonDays; offset += 1) {
    const dayStartMs = todayStartMs + offset * DAY_MS;
    if (!rules.isoWeekdays.has(isoWeekdayOf(dayStartMs))) continue;
    const date = istDateOf(dayStartMs);
    const closed = rules.closedDates.has(date);
    const count = counts.get(date);
    const dayFull = (count?.public ?? 0) >= rules.publicDailyCap || (count?.total ?? 0) >= dailyBotCap;

    const slots: R1PublicSlot[] = [];
    for (
      let minute = rules.firstStartMinuteIst;
      minute <= rules.lastStartMinuteIst;
      minute += rules.stepMinutes
    ) {
      const startMs = dayStartMs + minute * MINUTE_MS;
      const endMs = startMs + slotMs;
      let reason: R1PublicSlotReason;
      if (!admits) reason = 'fully_booked';
      else if (closed) reason = 'closed_date';
      else if (startMs < noticeEdgeMs) reason = 'notice';
      else if (endMs + graceMs > expiryEdgeMs) reason = 'not_offered';
      else if (dayFull) reason = 'day_full';
      else if (seats === 0 || isFull(startMs, endMs)) reason = 'slot_full';
      else reason = 'open';
      const available = reason === 'open';
      if (available) anyAvailable = true;
      slots.push(Object.freeze({ startAt: iso(startMs), endAt: iso(endMs), istDate: date, available, reason }));
    }
    days.push(Object.freeze({ date, slots: Object.freeze(slots) }));
  }

  return Object.freeze({
    days: Object.freeze(days),
    seats,
    publicDayLimit: rules.publicDailyCap,
    botDayLimit: dailyBotCap,
    fullyBooked: !admits || !anyAvailable,
  });
}

/**
 * The grid slot that starts at the instant `startAt` names (zoned ISO 8601, the `Z` and offset forms
 * of one instant both match), or null: unparseable, zoneless, off the grid, or on a date the grid
 * does not offer. Callers use the RETURNED slot's `startAt` and `endAt`, never the typed string.
 * Never throws.
 */
export function findR1PublicSlot(grid: R1PublicSlotGrid, startAt: string): R1PublicSlot | null {
  const ms = parseR1MeetInstant(startAt);
  if (ms === null) return null;
  if (typeof grid !== 'object' || grid === null || !Array.isArray(grid.days)) return null;
  const date = istDateOf(istDayStartMs(ms));
  for (const day of grid.days as readonly unknown[]) {
    if (typeof day !== 'object' || day === null) continue;
    const { date: dayDate, slots } = day as { date?: unknown; slots?: unknown };
    if (dayDate !== date || !Array.isArray(slots)) continue;
    for (const slot of slots as readonly unknown[]) {
      if (typeof slot !== 'object' || slot === null) continue;
      if (parseR1MeetInstant((slot as { startAt?: unknown }).startAt) === ms) return slot as R1PublicSlot;
    }
  }
  return null;
}

/**
 * The capacity window of the grid: IST midnight of today .. IST midnight of today + horizonDays,
 * half-open, as the `p_from` / `p_to` S06 passes to `r1_meet_public_capacity`, so the RPC and the
 * grid see the same days. Throws `r1_public_slot_input_invalid` on the grid's own input refusals.
 */
export function r1PublicSlotWindow(
  nowMs: number,
  rules: R1MeetPublicSlotRules,
): { readonly fromIso: string; readonly toIso: string } {
  const now = readNow(nowMs);
  const { horizonDays } = readRules(rules);
  const fromMs = istDayStartMs(now);
  return Object.freeze({ fromIso: iso(fromMs), toIso: iso(fromMs + horizonDays * DAY_MS) });
}
