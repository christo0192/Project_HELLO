/**
 * schemas/phone-api.ts — request validation for the internal phone calendar,
 * engagement, health and control API.
 *
 * ── SHAPE HERE, SEMANTICS IN THE RPC ──────────────────────────────────
 * These schemas validate SHAPE and nothing else: that an instant is UTC
 * ISO-8601, that an id is a uuid, that a version is a positive integer, that a
 * reason is a member of a 0042 vocabulary, and that no unexpected key was sent.
 *
 * They deliberately do NOT re-check the slot rules. Whether a slot is long
 * enough, in the future, inside the 09:00-21:00 IST window, or free of an
 * IST-midnight straddle is decided by `schedule_phone_appointment` under the
 * engagement row lock, and it answers with `slot_duration_invalid`,
 * `slot_in_past`, `window_closed` and `slot_straddles_ist_midnight`. Restating
 * those rules here would create a second copy that can drift from the CHECK
 * constraints and the trigger enforcing them — and the copy would be the one
 * users hit first, so drift would look like a validation bug rather than a
 * schema disagreement. One definition, in the database.
 *
 * ── UTC ONLY, ON EVERY INSTANT ────────────────────────────────────────
 * `2026-08-22T14:30:00Z` is accepted. `2026-08-22T20:00:00+05:30`,
 * `2026-08-22T14:30:00` and `2026-08-22 14:30:00Z` are not. A naive local
 * datetime on a wire shared by an IST operator, a UTC database and a UTC server
 * is an ambiguity nobody can resolve after the fact, so it is refused at the
 * edge rather than interpreted.
 */

import { z } from 'zod';
import { uuidSchema } from './common.js';
import {
  PHONE_APPOINTMENT_CANCEL_REASONS,
  PHONE_HALT_REASONS,
  PHONE_SUPPRESSION_REASONS,
  PHONE_SUPPRESSION_SOURCES,
} from '../lib/phone-screening/index.js';

// ═══════════════════════════════════════════════════════════════════════
// Primitives
// ═══════════════════════════════════════════════════════════════════════

/** UTC ISO-8601 with a literal `Z`. Offsets and naive datetimes are refused. */
export const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** An IST calendar date on the wire. */
export const IST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The widest calendar range one request may ask for. */
export const PHONE_CALENDAR_MAX_RANGE_DAYS = 31;

const MAX_RANGE_MS = PHONE_CALENDAR_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * True iff the string names an instant that really exists.
 *
 * The ROUND TRIP is the control here, not the NaN guard. The regex accepts
 * `2026-02-30T00:00:00Z`, and V8 does not reject it either — `Date.parse`
 * silently ROLLS it into `2026-03-02T00:00:00Z`. Re-serializing and comparing
 * is what catches that, so this check must not be simplified away on the
 * assumption that ES date parsing validates the day of month. The NaN guard is
 * kept for engines that refuse instead of rolling.
 */
function isRealUtcInstant(value: string): boolean {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 19) === value.slice(0, 19);
}

/** True iff `YYYY-MM-DD` names a real Gregorian date. */
function isRealCalendarDate(value: string): boolean {
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

export const utcInstantSchema = z
  .string()
  .regex(UTC_INSTANT_PATTERN, 'must_be_utc_iso_8601')
  .refine(isRealUtcInstant, 'must_be_a_real_instant')
  .describe('UTC ISO-8601 instant, e.g. 2026-08-22T14:30:00Z');

export const istDateSchema = z
  .string()
  .regex(IST_DATE_PATTERN, 'must_be_an_ist_calendar_date')
  .refine(isRealCalendarDate, 'must_be_a_real_calendar_date')
  .describe('IST calendar date, YYYY-MM-DD');

/**
 * The optimistic-concurrency token. `phone_appointments.version` starts at 1
 * and a CHECK keeps it there, so zero and negatives are refused before the
 * round trip rather than becoming a `version_conflict` that misdescribes what
 * went wrong.
 */
export const appointmentVersionSchema = z
  .number()
  .int('must_be_an_integer')
  .min(1, 'must_be_at_least_one')
  .describe('Optimistic-concurrency version of the live appointment');

// ═══════════════════════════════════════════════════════════════════════
// Reads
// ═══════════════════════════════════════════════════════════════════════

export const phoneCalendarQuerySchema = z
  .object({ from: utcInstantSchema, to: utcInstantSchema })
  .strict()
  .refine((v) => Date.parse(v.to) > Date.parse(v.from), {
    message: 'to_must_be_after_from',
    path: ['to'],
  })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= MAX_RANGE_MS, {
    message: 'range_exceeds_max_days',
    path: ['to'],
  });

export type PhoneCalendarQuery = z.infer<typeof phoneCalendarQuerySchema>;

export const phoneSlotsQuerySchema = z.object({ date: istDateSchema }).strict();

export type PhoneSlotsQuery = z.infer<typeof phoneSlotsQuerySchema>;

// ═══════════════════════════════════════════════════════════════════════
// Writes
// ═══════════════════════════════════════════════════════════════════════

/**
 * `source` is deliberately absent. Every appointment this API books is
 * `hr_manual` by definition — the route supplies it — and `candidate_voice`
 * and `system_deferral` describe things that did not happen here. Because the
 * schema is `.strict()`, a client that sends `source` is refused rather than
 * silently overridden, which is the difference between a contract and a
 * courtesy.
 */
export const phoneAppointmentCreateSchema = z
  .object({
    engagement_id: uuidSchema,
    starts_at: utcInstantSchema,
    ends_at: utcInstantSchema,
  })
  .strict();

export type PhoneAppointmentCreateInput = z.infer<typeof phoneAppointmentCreateSchema>;

/**
 * Reschedule. `version` is REQUIRED: `schedule_phone_appointment` treats a null
 * `p_expected_version` as "there must be no live appointment" and answers
 * `appointment_exists`, so an optional version would turn every reschedule into
 * a refusal — and a version-free supersede is exactly the lost-update this
 * column exists to prevent.
 */
export const phoneAppointmentPatchSchema = z
  .object({
    starts_at: utcInstantSchema,
    ends_at: utcInstantSchema,
    version: appointmentVersionSchema,
  })
  .strict();

export type PhoneAppointmentPatchInput = z.infer<typeof phoneAppointmentPatchSchema>;

/**
 * The cancel reasons an OPERATOR may give.
 *
 * `superseded` is written only by `schedule_phone_appointment` when it replaces
 * a slot, and `system_deferral_expired` only by `expire_phone_appointments`.
 * Letting an operator send either would put a reason on the row that
 * misdescribes what happened — the audit trail would say a sweep expired a slot
 * an admin cancelled by hand. The vocabulary is imported and NARROWED, never
 * re-declared, so a member added to 0042 shows up here as a type error rather
 * than as a silent omission.
 */
const OPERATOR_CANCEL_REASONS: ReadonlySet<string> = new Set(
  PHONE_APPOINTMENT_CANCEL_REASONS.filter(
    (r) => r !== 'superseded' && r !== 'system_deferral_expired',
  ),
);

export const phoneAppointmentCancelSchema = z
  .object({
    reason: z
      .enum(PHONE_APPOINTMENT_CANCEL_REASONS)
      .refine((r) => OPERATOR_CANCEL_REASONS.has(r), 'reason_not_operator_initiated'),
    version: appointmentVersionSchema,
  })
  .strict();

export type PhoneAppointmentCancelInput = z.infer<typeof phoneAppointmentCancelSchema>;

/** The kill switch. The reason vocabulary is 0042's, enforced again by a CHECK. */
export const phoneHaltSchema = z
  .object({ reason: z.enum(PHONE_HALT_REASONS) })
  .strict();

export type PhoneHaltInput = z.infer<typeof phoneHaltSchema>;

/**
 * Clearing the kill switch.
 *
 * `reason` is required and must name the halt CURRENTLY in force. 0042 defines
 * no separate "why I am resuming" vocabulary, and inventing one would be a
 * second vocabulary with nothing to keep it honest. Requiring the existing one
 * instead turns the field into a genuine interlock: an admin who does not know
 * what they are clearing cannot clear it, and a halt raised by one operator
 * cannot be lifted by another who never looked at why.
 */
export const phoneHaltClearSchema = z
  .object({ reason: z.enum(PHONE_HALT_REASONS) })
  .strict();

export type PhoneHaltClearInput = z.infer<typeof phoneHaltClearSchema>;

/**
 * Adding a candidate's line to the do-not-call list (0094).
 *
 * THE BODY CARRIES NO NUMBER, and there is deliberately no field in which one
 * could be sent. The candidate is named by id in the PATH; the RPC reads
 * `phone_e164` from the candidate row and digests it inside the database, so
 * the number never enters this process — the same property `admit_phone_attempt`
 * maintains and the reason this route cannot be given a "suppress this number"
 * convenience form later without breaking it.
 *
 * Both vocabularies are the schema's own CHECK allowlists, mirrored in
 * `phone-screening/vocabulary.ts` and drift-tested against the migration.
 * `source` defaults to `operator` because this route IS the operator surface;
 * a candidate-initiated opt-out arriving through some future self-service path
 * would send `candidate` explicitly rather than inheriting a wrong default.
 */
export const phoneSuppressionCreateSchema = z
  .object({
    reason: z.enum(PHONE_SUPPRESSION_REASONS),
    source: z.enum(PHONE_SUPPRESSION_SOURCES).default('operator'),
  })
  .strict();

export type PhoneSuppressionCreateInput = z.infer<typeof phoneSuppressionCreateSchema>;

/** `/suppressions/:candidateId` — the candidate whose line is addressed. */
export const phoneCandidateIdParamSchema = z
  .object({ candidateId: uuidSchema })
  .strict();
