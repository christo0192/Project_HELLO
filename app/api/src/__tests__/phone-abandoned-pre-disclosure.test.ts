/**
 * phone-abandoned-pre-disclosure.test.ts — the outcome 0043 adds, and the one
 * property that makes it truthful: **it charges nothing.**
 *
 * P3 recorded this gap (P3-1). A candidate who ANSWERS and hangs up before the
 * recording disclosure had no legal edge in 0042, so the drop was recorded as
 * `unexpected_event` and the outcome was UNRECORDED rather than classified.
 *
 * Both easy answers were lies, and this suite exists to stop either creeping
 * back in:
 *
 *   * `no_answer` after somebody demonstrably picked up — the exact defect P3's
 *     independent review caught on the reconciliation sweep;
 *   * an "uncharged reconnect", which is not a thing, because a reconnect grant
 *     is precisely what `reconnects_used` records.
 *
 * So the assertions here are about ABSENCE: no budget moves, no terminal state
 * is reached, and the retry is bounded by an index that already exists rather
 * than by a new counter. Absence is the easiest property to assert vacuously,
 * so each one is paired with a positive control on a neighbouring outcome that
 * DOES charge — if the harness stopped observing charges at all, those controls
 * go red first.
 */

import { describe, it, expect } from 'vitest';
import {
  PHONE_BUDGET_CEILINGS,
  decidePhoneOutcome,
  decisionIsTerminal,
  type PhoneBudgetCounters,
} from '../lib/phone-screening/index.js';
import { functionBody, MIGRATION_0042 } from './support/phone-migration.js';

/** Mid-flight counters: every budget partly spent, none exhausted. */
const SPENT: PhoneBudgetCounters = {
  noAnswerAttempts: 2,
  reconnectsUsed: 2,
  providerFailures: 4,
};

const ZERO: PhoneBudgetCounters = {
  noAnswerAttempts: 0,
  reconnectsUsed: 0,
  providerFailures: 0,
};

/** A context that would otherwise be at its most dangerous. */
function context(counters: PhoneBudgetCounters) {
  return {
    counters,
    kind: 'initial' as const,
    windowOpen: true,
    disconnectCause: 'drop' as const,
  };
}

describe('abandoned_pre_disclosure charges NOTHING', () => {
  it('moves no budget from zero', () => {
    const d = decidePhoneOutcome('abandoned_pre_disclosure', context(ZERO));
    expect(d.charge).toBe('none');
    expect(d.counters).toEqual(ZERO);
  });

  it('moves no budget MID-FLIGHT, with every budget one step from its ceiling', () => {
    // The dangerous case. If this outcome charged anything at all, these
    // counters are exactly where a charge would tip the engagement into a
    // TERMINAL state — `abandoned_no_answer` at 3, `failed` at 3 reconnects or
    // 5 provider failures — and a candidate would be written off for hanging up
    // during our own identity line.
    const d = decidePhoneOutcome('abandoned_pre_disclosure', context(SPENT));
    expect(d.charge).toBe('none');
    expect(d.counters).toEqual(SPENT);
    expect(d.counters.noAnswerAttempts).toBe(SPENT.noAnswerAttempts);
    expect(d.counters.reconnectsUsed).toBe(SPENT.reconnectsUsed);
    expect(d.counters.providerFailures).toBe(SPENT.providerFailures);
  });

  it('is NOT terminal, and returns the engagement to `eligible`', () => {
    const d = decidePhoneOutcome('abandoned_pre_disclosure', context(SPENT));
    expect(d.terminal).toBe(false);
    expect(decisionIsTerminal(d)).toBe(false);
    // `eligible` is a legal edge out of `dialing` in 0042's transition table.
    expect(d.engagementState).toBe('eligible');
    expect(d.stateReason).toBe('abandoned_pre_disclosure');
  });

  it('defers to the NEXT IST DAY, so the row says when it may next be tried', () => {
    // The retry is bounded by `uq_phone_attempts_one_per_ist_day`, which already
    // exists. `next_eligible_at` is moved so the row does not look eligible now
    // and then get refused by an index — the same reason the provider-failure
    // path does it.
    const d = decidePhoneOutcome('abandoned_pre_disclosure', context(ZERO));
    expect(d.deferral).toBe('next_ist_day');
  });

  it('is bounded by an INDEX, not by a new counter', () => {
    // A gating counter with no reset lifecycle is the one-way latch this project
    // has already paid for twice. There must be no fourth budget: the three
    // ceilings are exactly the three 0042 declares.
    expect(Object.keys(PHONE_BUDGET_CEILINGS).sort()).toEqual([
      'noAnswer',
      'providerFailure',
      'reconnect',
    ]);
  });

  // ── POSITIVE CONTROLS ─────────────────────────────────────────────────
  // Every assertion above is about something NOT happening. These prove the
  // harness can still see a charge at all — without them, a `decidePhoneOutcome`
  // that stopped charging anything would make this whole file pass.
  it('CONTROL — voicemail from the same context DOES charge the no-answer budget', () => {
    const d = decidePhoneOutcome('voicemail', context(ZERO));
    expect(d.charge).toBe('no_answer');
    expect(d.counters.noAnswerAttempts).toBe(1);
  });

  it('CONTROL — a disconnect from the same context DOES charge a reconnect', () => {
    const d = decidePhoneOutcome('disconnected', context(ZERO));
    expect(d.charge).toBe('reconnect');
    expect(d.counters.reconnectsUsed).toBe(1);
  });

  it('CONTROL — a provider error from the same context DOES charge the provider budget', () => {
    const d = decidePhoneOutcome('provider_error', context(ZERO));
    expect(d.charge).toBe('provider');
    expect(d.counters.providerFailures).toBe(1);
  });
});

describe('the 0043 branch in apply_phone_event says the same thing in SQL', () => {
  // `functionBody` resolves NEWEST-FIRST, so this reads 0043's replacement
  // rather than 0042's superseded original.
  const body = functionBody('apply_phone_event');

  it('is reached only from `dialing`, and only for an ANSWERED attempt', () => {
    // `dialing` OUTLIVES the answer (0042 #14: join is not answer), so the
    // engagement state alone cannot tell a leg that rang out from one somebody
    // picked up. Deciding from it would be the mirror of the P3 HIGH that
    // reported an answered call as `no_answer`.
    expect(body).toContain("v_att.state in ('answered_unclassified','human')");
    expect(body).toContain("v_outcome := 'abandoned_pre_disclosure'");
  });

  it('covers the hangup AND the "call me later" case, as DISTINCT event types', () => {
    expect(body).toContain("'sip.participant_left','sip.connection_aborted'");
    expect(body).toContain("'candidate.deferred_pre_disclosure'");
  });

  it('sets NO charge anywhere in the branch', () => {
    // Read the branch text itself rather than the whole body — every other
    // charging edge in this function assigns `v_charge`, so scanning the file
    // would find one of theirs and pass regardless.
    const start = body.indexOf("v_outcome := 'abandoned_pre_disclosure'");
    expect(start).toBeGreaterThan(-1);
    const branch = body.slice(start, body.indexOf('when ', start + 1));
    expect(branch).not.toContain('v_charge');
    expect(branch).toContain("v_new_state := 'eligible'");
  });

  it('CONTROL — the branch extractor really does isolate ONE branch', () => {
    // Without this, `branch` could be an empty string and the `not.toContain`
    // above would pass vacuously. It must contain the assignment it was
    // anchored on, and must NOT contain a neighbouring branch's outcome.
    const start = body.indexOf("v_outcome := 'abandoned_pre_disclosure'");
    const branch = body.slice(start, body.indexOf('when ', start + 1));
    expect(branch.length).toBeGreaterThan(20);
    expect(branch).toContain('abandoned_pre_disclosure');
    expect(branch).not.toContain("v_outcome := 'disconnected'");
    // And the charging branches this file relies on as controls do exist.
    expect(body).toContain("v_charge := 'reconnect'");
    expect(body).toContain("v_charge := 'no_answer'");
  });

  it('0042 did NOT have this edge — the gap was real', () => {
    // Guards against the whole suite becoming a tautology if someone decides
    // 0043's branch "was always there". It was not: this is P3-1.
    expect(MIGRATION_0042).not.toContain('abandoned_pre_disclosure');
  });
});
