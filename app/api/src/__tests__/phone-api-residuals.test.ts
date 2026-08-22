/**
 * The P1 residuals the phone API reports — checked against migration 0042
 * itself, not against the sentence that describes it.
 *
 * `lib/phone-screening/residuals.ts` is a hand-written list of claims about
 * another file. On its own that is a decoration, and this lane has already paid
 * once for an assertion that could not fail. Every claim is therefore EXTRACTED
 * from the 0042 text here, in both directions: the list is wrong if a writer for
 * `confirmed_at` ever appears, if `admit_phone_attempt` stops writing
 * `fulfilled`, if `expire_phone_appointments` stops writing `missed`, or if the
 * provider-error branch stops deferring to the next IST day.
 *
 * No database, no network, no clock. The migration is read as text.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PHONE_APPOINTMENT_STATUSES,
  PHONE_BUDGET_CEILINGS,
  PHONE_RESIDUAL_CODES,
  PHONE_SUBSTRATE_RESIDUALS,
} from '../lib/phone-screening/index.js';
import { MIGRATION_0042, functionBody } from './support/phone-migration.js';

/** 0042 with SQL line comments removed. Every prose mention of `confirmed`
 *  lives in a comment, so a check over raw text would be answered by the
 *  documentation rather than by the code. */
const SQL = MIGRATION_0042.replace(/--.*$/gm, '');

/** The five functions that write to `phone_appointments` at all. */
const APPOINTMENT_WRITERS = [
  'admit_phone_attempt',
  'apply_phone_event',
  'schedule_phone_appointment',
  'cancel_phone_appointment',
  'expire_phone_appointments',
] as const;

/** Bodies of every function 0042 declares that could touch an appointment. */
function appointmentWriterBodies(): Array<{ name: string; body: string }> {
  return APPOINTMENT_WRITERS.map((name) => ({
    name,
    body: functionBody(name).replace(/--.*$/gm, ''),
  }));
}

describe('the residual list is well formed', () => {
  it('carries exactly the four declared codes, each once', () => {
    expect(PHONE_SUBSTRATE_RESIDUALS).toHaveLength(4);
    const codes = PHONE_SUBSTRATE_RESIDUALS.map((r) => r.code);
    expect(new Set(codes).size).toBe(4);
    expect([...codes].sort()).toEqual([...PHONE_RESIDUAL_CODES].sort());
  });

  it('every appointment status named is a member of the 0042 vocabulary', () => {
    const named = PHONE_SUBSTRATE_RESIDUALS.map((r) => r.appointmentStatus).filter(
      (s): s is (typeof PHONE_APPOINTMENT_STATUSES)[number] => s !== null,
    );
    // Fail closed: a list of only nulls would make the loop vacuous.
    expect(named.length).toBe(3);
    for (const status of named) {
      expect(PHONE_APPOINTMENT_STATUSES).toContain(status);
    }
  });

  it('every non-null writer names a function 0042 actually declares', () => {
    const writers = PHONE_SUBSTRATE_RESIDUALS.map((r) => r.writer).filter(
      (w): w is string => w !== null,
    );
    expect(writers.length).toBe(3);
    for (const writer of writers) {
      // Throws if 0042 does not declare it, or if the body over-captures.
      expect(functionBody(writer).length).toBeGreaterThan(0);
    }
  });
});

describe('R-a: `confirmed` has no writer in 0042', () => {
  it('`confirmed_at` appears exactly once — as the column declaration', () => {
    const hits = [...SQL.matchAll(/confirmed_at/g)];
    expect(hits).toHaveLength(1);
    expect(SQL).toMatch(/^\s*confirmed_at\s+timestamptz,\s*$/m);
  });

  it('no function that writes an appointment mentions `confirmed_at` at all', () => {
    const bodies = appointmentWriterBodies();
    expect(bodies).toHaveLength(5);
    for (const { name, body } of bodies) {
      expect(body, `${name} touches confirmed_at`).not.toContain('confirmed_at');
    }
  });

  it('no function assigns the status `confirmed`', () => {
    // Every surviving `'confirmed'` in the migration is a MEMBERSHIP test —
    // the status CHECK, the two partial indexes, and the `in (...)` predicates
    // that select the live rows. None is an assignment.
    for (const { name, body } of appointmentWriterBodies()) {
      expect(body, `${name} assigns 'confirmed'`).not.toMatch(/=\s*'confirmed'/);
    }
    expect(SQL, '0042 assigns the confirmed status somewhere').not.toMatch(/=\s*'confirmed'/);
    // Non-vacuity: the literal IS present, so the assertion above is discriminating
    // rather than matching an absent string.
    expect(SQL).toContain("'confirmed'");
  });

  it('the residual entry records that absence', () => {
    const entry = PHONE_SUBSTRATE_RESIDUALS.find(
      (r) => r.code === 'appointment_confirmed_has_no_writer',
    );
    expect(entry).toBeDefined();
    expect(entry!.writer).toBeNull();
    expect(entry!.appointmentStatus).toBe('confirmed');
  });
});

describe('R-b: `fulfilled` is written by admit_phone_attempt, and only there', () => {
  it('admit_phone_attempt sets the status', () => {
    expect(functionBody('admit_phone_attempt')).toMatch(/status\s*=\s*'fulfilled'/);
  });

  it('no other appointment writer sets it', () => {
    for (const { name, body } of appointmentWriterBodies()) {
      if (name === 'admit_phone_attempt') continue;
      expect(body, `${name} also writes 'fulfilled'`).not.toMatch(/=\s*'fulfilled'/);
    }
  });

  it('the residual entry names that writer', () => {
    const entry = PHONE_SUBSTRATE_RESIDUALS.find(
      (r) => r.code === 'appointment_fulfilled_written_by_admission',
    );
    expect(entry).toBeDefined();
    expect(entry!.writer).toBe('admit_phone_attempt');
    expect(entry!.appointmentStatus).toBe('fulfilled');
  });
});

describe('R-c: `missed` is written by the expiry sweep, and only there', () => {
  it('expire_phone_appointments sets the status', () => {
    expect(functionBody('expire_phone_appointments')).toMatch(/status\s*=\s*'missed'/);
  });

  it('no other appointment writer sets it', () => {
    for (const { name, body } of appointmentWriterBodies()) {
      if (name === 'expire_phone_appointments') continue;
      expect(body, `${name} also writes 'missed'`).not.toMatch(/=\s*'missed'/);
    }
  });

  it('nothing in this API calls that sweep — the overdue count is the signal', () => {
    // `expire_phone_appointments` is a bounded sweep with no caller in this
    // phase, which is exactly why the health surface reports
    // `appointments.overdue` and raises `appointments_overdue` instead of
    // waiting for the status column to catch up on its own.
    const route = readFileSync(
      fileURLToPath(new URL('../routes/phone.ts', import.meta.url)),
      'utf8',
    );
    expect(route).not.toContain('expireAppointments');
    expect(route).toContain('appointments_overdue');
  });

  it('the residual entry names that writer', () => {
    const entry = PHONE_SUBSTRATE_RESIDUALS.find(
      (r) => r.code === 'appointment_missed_written_by_expiry_sweep',
    );
    expect(entry).toBeDefined();
    expect(entry!.writer).toBe('expire_phone_appointments');
    expect(entry!.appointmentStatus).toBe('missed');
  });
});

describe('R-d: a provider error costs the engagement its whole IST day', () => {
  const APPLY = functionBody('apply_phone_event').replace(/--.*$/gm, '');

  it('the provider branch defers to the next IST day, not to the next window', () => {
    // The distinction is the whole residual. `phone_next_window_open(p_now)`
    // would return TODAY's window while it is open, freeing the day the
    // per-IST-day index is there to spend. The provider branch instead advances
    // the IST DATE first and asks for the window on that day.
    expect(APPLY).toMatch(/phone_ist_date\(p_now\)\s*\+\s*1/);
    expect(APPLY).toMatch(/phone_next_window_open\(\s*\n?\s*\(?screening_v2\.phone_ist_date\(p_now\)/);
  });

  it('the branch is guarded by the provider-failure ceiling this API mirrors', () => {
    // The ceiling in `PHONE_BUDGET_CEILINGS` is what the engagement projection
    // reports as `provider_failure.ceiling`. If 0042 ever changed the number,
    // the budget block would be lying about when the engagement dies.
    expect(PHONE_BUDGET_CEILINGS.providerFailure).toBe(5);
    expect(APPLY).toMatch(
      new RegExp(String.raw`provider_failures\s*\+\s*1\s*>=\s*${PHONE_BUDGET_CEILINGS.providerFailure}`),
    );
    // And the CHECK constraint agrees, so five is the same five in both places.
    expect(SQL).toMatch(
      new RegExp(
        String.raw`chk_phone_engagements_failures[\s\S]{0,120}provider_failures between 0 and ${PHONE_BUDGET_CEILINGS.providerFailure}`,
      ),
    );
  });

  it('the residual entry names that writer and no appointment status', () => {
    const entry = PHONE_SUBSTRATE_RESIDUALS.find(
      (r) => r.code === 'provider_error_costs_one_ist_day',
    );
    expect(entry).toBeDefined();
    expect(entry!.writer).toBe('apply_phone_event');
    expect(entry!.appointmentStatus).toBeNull();
  });
});
