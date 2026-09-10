/**
 * Vocabulary drift — every closed union in `lib/phone-screening/vocabulary.ts`
 * against the CHECK allowlists of `0042_phone_screening.sql`.
 *
 * Both directions matter. A union that OMITS a member turns a legal database
 * value into an unhandled case; a union that ADDS one produces a value the
 * database rejects on write. So each assertion compares SETS, never
 * "contains".
 */

import { describe, it, expect } from 'vitest';
import {
  PHONE_ENGAGEMENT_STATES,
  PHONE_TERMINAL_ENGAGEMENT_STATES,
  PHONE_ATTEMPT_STATES,
  PHONE_LIVE_ATTEMPT_STATES,
  PHONE_ATTEMPT_KINDS,
  PHONE_ADMISSIBLE_PRIOR_STATES,
  PHONE_OUTCOME_CLASSES,
  PHONE_APPOINTMENT_STATUSES,
  PHONE_APPOINTMENT_SOURCES,
  PHONE_SUPPRESSION_REASONS,
  PHONE_SUPPRESSION_SOURCES,
  PHONE_APPOINTMENT_CANCEL_REASONS,
  PHONE_EVENT_SOURCES,
  PHONE_EVENT_IGNORED_REASONS,
  PHONE_HALT_REASONS,
  PHONE_BUDGET_CEILINGS,
  PHONE_DIAL_QUEUE_NAME,
  phoneDialDedupKey,
  isTerminalEngagementState,
  isLiveAttemptState,
  isPhoneOutcomeClass,
  CONSENT_RECORD_STATUSES,
  CONSENT_TYPES,
} from '../lib/phone-screening/vocabulary.js';
import {
  MIGRATION_0042,
  checkMembers,
  consentStatusMembers,
  consentTypeEnumMembers,
  functionBody,
} from './support/phone-migration.js';

const set = (xs: readonly string[]): Set<string> => new Set(xs);

describe('phone-screening vocabulary mirrors 0042 exactly', () => {
  it('engagement states match chk_phone_engagements_state', () => {
    expect(set(PHONE_ENGAGEMENT_STATES)).toEqual(set(checkMembers('chk_phone_engagements_state')));
    expect(PHONE_ENGAGEMENT_STATES).toHaveLength(13);
  });

  it('terminal engagement states match the terminal CHECK', () => {
    // `chk_phone_engagements_terminal` is an equivalence, not an IN list, so
    // its members are read from the state list inside it.
    const anchor = MIGRATION_0042.indexOf('constraint chk_phone_engagements_terminal');
    expect(anchor).toBeGreaterThan(-1);
    const block = MIGRATION_0042.slice(anchor, anchor + 400);
    const open = block.indexOf('state in (');
    const close = block.indexOf(')', open);
    const members = [...block.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(set(PHONE_TERMINAL_ENGAGEMENT_STATES)).toEqual(set(members));
    expect(PHONE_TERMINAL_ENGAGEMENT_STATES).toHaveLength(6);
  });

  it('terminal predicate is exactly the six terminal states', () => {
    for (const s of PHONE_ENGAGEMENT_STATES) {
      expect(isTerminalEngagementState(s)).toBe(
        (PHONE_TERMINAL_ENGAGEMENT_STATES as readonly string[]).includes(s),
      );
    }
    expect(isTerminalEngagementState('not_a_state')).toBe(false);
  });

  it('attempt states match chk_phone_call_attempts_state', () => {
    expect(set(PHONE_ATTEMPT_STATES)).toEqual(set(checkMembers('chk_phone_call_attempts_state')));
  });

  it('live attempt states are the five the reclaim sweeper scans for', () => {
    // Read from the sweeper's own candidate scan, which is the definition
    // every other "live" read in 0042 repeats.
    const body = functionBody('reclaim_phone_attempt_leases');
    const anchor = body.indexOf('where state in (');
    const close = body.indexOf(')', anchor);
    const members = [...body.slice(anchor, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(set(PHONE_LIVE_ATTEMPT_STATES)).toEqual(set(members));
    for (const s of PHONE_ATTEMPT_STATES) {
      expect(isLiveAttemptState(s)).toBe(
        (PHONE_LIVE_ATTEMPT_STATES as readonly string[]).includes(s),
      );
    }
  });

  it('attempt kinds match chk_phone_call_attempts_kind', () => {
    expect(set(PHONE_ATTEMPT_KINDS)).toEqual(set(checkMembers('chk_phone_call_attempts_kind')));
  });

  it('admissible prior states match chk_phone_call_attempts_prior_state', () => {
    expect(set(PHONE_ADMISSIBLE_PRIOR_STATES)).toEqual(
      set(checkMembers('chk_phone_call_attempts_prior_state')),
    );
  });

  it('EXACTLY twelve outcome classes, matching chk_phone_call_attempts_outcome', () => {
    // TWELVE since 0043, which re-declares this CHECK in full to add
    // `abandoned_pre_disclosure`. `checkMembers` reads the NEWEST declaration,
    // so this compares against what the database actually enforces rather than
    // against 0042's superseded inline list.
    const members = checkMembers('chk_phone_call_attempts_outcome');
    expect(set(PHONE_OUTCOME_CLASSES)).toEqual(set(members));
    expect(PHONE_OUTCOME_CLASSES).toHaveLength(12);
    expect(members).toHaveLength(12);
    // The 0043 member specifically, so a re-declaration that silently dropped
    // it back to eleven would fail on the value and not only on the count.
    expect(members).toContain('abandoned_pre_disclosure');
  });

  it('cold start is NOT an outcome class', () => {
    // A twelfth member would be a value the database rejects on write. Cold
    // start is a pre-claim deferral; see `admission.ts`.
    expect(isPhoneOutcomeClass('cold_start')).toBe(false);
    expect(MIGRATION_0042).not.toContain("'cold_start'");
  });

  it('suppression reasons and sources match their CHECKs (0042 tables, 0094 writer)', () => {
    // Both CHECKs have existed since 0042. Until 0094 gave the table a write
    // path they constrained rows nothing could create, so these two unions are
    // new to TypeScript while the vocabulary they mirror is not — which is
    // exactly the case where a hand-typed list drifts unnoticed, because no
    // running code would have exercised a wrong member.
    expect(set(PHONE_SUPPRESSION_REASONS)).toEqual(
      set(checkMembers('chk_phone_suppressions_reason')),
    );
    expect(set(PHONE_SUPPRESSION_SOURCES)).toEqual(
      set(checkMembers('chk_phone_suppressions_source')),
    );
  });

  it('appointment statuses, sources and cancel reasons match their CHECKs', () => {
    expect(set(PHONE_APPOINTMENT_STATUSES)).toEqual(
      set(checkMembers('chk_phone_appointments_status')),
    );
    expect(set(PHONE_APPOINTMENT_SOURCES)).toEqual(
      set(checkMembers('chk_phone_appointments_source')),
    );
    // The cancel vocabulary is enforced in the RPC body, not a CHECK.
    const body = functionBody('cancel_phone_appointment');
    const anchor = body.indexOf('p_reason not in (');
    const close = body.indexOf(')', anchor);
    const members = [...body.slice(anchor, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(set(PHONE_APPOINTMENT_CANCEL_REASONS)).toEqual(set(members));
  });

  it('event sources and ignored reasons match their CHECKs', () => {
    expect(set(PHONE_EVENT_SOURCES)).toEqual(set(checkMembers('chk_phone_call_events_source')));
    expect(set(PHONE_EVENT_IGNORED_REASONS)).toEqual(
      set(checkMembers('chk_phone_call_events_ignored_reason')),
    );
    // `duplicate` is deliberately absent: a duplicate delivery writes no
    // second row, so a row claiming to be one could never exist.
    expect(PHONE_EVENT_IGNORED_REASONS).not.toContain('duplicate');
  });

  it('halt reasons match the set_phone_halt allowlist', () => {
    const body = functionBody('set_phone_halt');
    const anchor = body.indexOf('p_reason not in (');
    const close = body.indexOf(')', anchor);
    const members = [...body.slice(anchor, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(set(PHONE_HALT_REASONS)).toEqual(set(members));
  });

  it('budget ceilings mirror the three CHECK bounds', () => {
    expect(MIGRATION_0042).toContain('check (no_answer_attempts between 0 and 3)');
    expect(MIGRATION_0042).toContain('check (reconnects_used between 0 and 3)');
    expect(MIGRATION_0042).toContain('check (provider_failures between 0 and 5)');
    expect(PHONE_BUDGET_CEILINGS).toEqual({ noAnswer: 3, reconnect: 3, providerFailure: 5 });
  });

  it('the dial queue name and dedup key match admission and reclaim', () => {
    expect(PHONE_DIAL_QUEUE_NAME).toBe('phone.dial');
    expect(MIGRATION_0042).toContain("v_queue_name     constant text    := 'phone.dial'");
    expect(MIGRATION_0042).toContain("dedup_key = 'phone.dial:' || v_att.id::text");
    expect(phoneDialDedupKey('abc')).toBe('phone.dial:abc');
    // `phone.dial` is a queue NAME, never an ashby_operations type — that
    // CHECK is deliberately not widened, so dialing cannot live inside the
    // machinery that performs stage moves and scorecard writes.
    expect(MIGRATION_0042).not.toMatch(/add constraint chk_ashby_operations_type/);
  });

  it('consent mirrors are EXTRACTED from 0013, not restated', () => {
    // Every other union in this file is compared against the migration text.
    // Restating the constant here would be the one place the file abandons its
    // own method, and it would pass for the wrong reason.
    expect(set(CONSENT_RECORD_STATUSES)).toEqual(set(consentStatusMembers()));
    expect(set(CONSENT_TYPES)).toEqual(set(consentTypeEnumMembers()));
    // `job_application` alone cannot unlock AI screening or recording; it is a
    // member of the enum and never sufficient on its own.
    expect(CONSENT_TYPES).toContain('job_application');
  });
});
