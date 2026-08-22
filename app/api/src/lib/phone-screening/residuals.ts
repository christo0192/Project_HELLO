/**
 * phone-screening/residuals.ts — the P1 residuals this API surface must not
 * paper over.
 *
 * Migration 0042 shipped an appointment status vocabulary of six members and a
 * deliberately conservative provider-error pacing rule. Three of those facts
 * are invisible from the outside and each one, left unstated, would make an
 * operator surface quietly untruthful:
 *
 *   1. `confirmed` HAS NO WRITER. Nothing in 0042 ever sets an appointment to
 *      `confirmed` or stamps `confirmed_at`. An appointment is confirmed when
 *      the bot reads the slot back to the candidate, which is a VOICE event and
 *      therefore P4's. A calendar that offered a "confirm" control, or that
 *      rendered `scheduled` as "confirmed", would be inventing a transition.
 *   2. `fulfilled` is written by `admit_phone_attempt`, when a `scheduled`
 *      attempt is admitted against a live slot — so it can only ever appear
 *      once a runtime is actually dialing.
 *   3. `missed` is written by `expire_phone_appointments`, a SWEEP. Nothing
 *      calls that sweep yet, so an overdue appointment sits at `scheduled`
 *      indefinitely. `phone_backlog.appointments.overdue` is the honest signal,
 *      and the health surface reports it rather than pretending the status
 *      column has caught up.
 *
 * And the pacing rule:
 *
 *   4. A provider error costs the engagement its whole IST DAY. The failed
 *      attempt keeps today's `ist_date`, so `uq_phone_attempts_one_per_ist_day`
 *      refuses the next admission until the day rolls; `apply_phone_event` sets
 *      `next_eligible_at` to the next legal instant on the NEXT IST day so the
 *      row says so out loud. Exhausting the five-failure budget therefore takes
 *      up to five IST days. That is an anti-harassment invariant failing closed
 *      on the fact that a transport rejection does not tell us whether the line
 *      rang — not a bug, and not something an operator should have to infer
 *      from a `next_eligible_at` that looks arbitrary.
 *
 * ── WHY THIS IS NOT A DECORATION ──────────────────────────────────────
 * A hand-written list of claims about another file is worth nothing on its own;
 * this lane has already been burned once by an assertion that could not fail.
 * `phone-api-residuals.test.ts` therefore EXTRACTS each claim from the 0042
 * text and fails in both directions: if a writer for `confirmed_at` ever
 * appears, if `admit_phone_attempt` stops writing `fulfilled`, if
 * `expire_phone_appointments` stops writing `missed`, or if the provider branch
 * stops deferring to the next IST day, the constant below is wrong and the
 * suite says so.
 *
 * Pure declarations. No I/O, no configuration, no clock.
 */

import type { PhoneAppointmentStatus } from './vocabulary.js';

/** The stable codes. A client may branch on these; they never change meaning. */
export const PHONE_RESIDUAL_CODES = [
  'appointment_confirmed_has_no_writer',
  'appointment_fulfilled_written_by_admission',
  'appointment_missed_written_by_expiry_sweep',
  'provider_error_costs_one_ist_day',
] as const;

export type PhoneResidualCode = (typeof PHONE_RESIDUAL_CODES)[number];

export interface PhoneSubstrateResidual {
  readonly code: PhoneResidualCode;
  /**
   * The 0042 object that writes the fact, or `null` when NOTHING writes it.
   * A null here is the whole point of the entry.
   */
  readonly writer: string | null;
  /**
   * The appointment status the entry is about, when it is about one. Typed
   * against the closed union, so removing a member from `vocabulary.ts`
   * breaks the build rather than leaving a stale string behind.
   */
  readonly appointmentStatus: PhoneAppointmentStatus | null;
  /** The phase that makes the fact observable in production. */
  readonly owner: string;
}

/**
 * The four residuals, exactly. Reported verbatim on the health surface so an
 * operator reading a calendar full of `scheduled` rows can see WHY nothing ever
 * becomes `confirmed`, and why an overdue slot has not become `missed`.
 */
export const PHONE_SUBSTRATE_RESIDUALS: readonly PhoneSubstrateResidual[] = Object.freeze([
  Object.freeze({
    code: 'appointment_confirmed_has_no_writer' as const,
    writer: null,
    appointmentStatus: 'confirmed' as PhoneAppointmentStatus,
    owner: 'P4',
  }),
  Object.freeze({
    code: 'appointment_fulfilled_written_by_admission' as const,
    writer: 'admit_phone_attempt',
    appointmentStatus: 'fulfilled' as PhoneAppointmentStatus,
    owner: 'P5',
  }),
  Object.freeze({
    code: 'appointment_missed_written_by_expiry_sweep' as const,
    writer: 'expire_phone_appointments',
    appointmentStatus: 'missed' as PhoneAppointmentStatus,
    owner: 'P5',
  }),
  Object.freeze({
    code: 'provider_error_costs_one_ist_day' as const,
    writer: 'apply_phone_event',
    appointmentStatus: null,
    owner: 'P1',
  }),
]);
