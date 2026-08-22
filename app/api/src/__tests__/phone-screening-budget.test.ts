/**
 * The outcome→budget/state map, against `apply_phone_event` itself.
 *
 * Three kinds of assertion, and all three are needed:
 *   1. EXHAUSTIVENESS — every one of the eleven outcome classes has a case,
 *      and adding a twelfth without a decision cannot compile. The compile-time
 *      half is `assertNever`; the half a test can see is asserted here by
 *      reading `budget.ts`'s own source for a `case` per member.
 *   2. THE EXACT ORDINALS — the 3rd no-answer charge, the 5th provider charge
 *      and the 4th drop are terminal. A map built to "4th and 6th" would
 *      diverge from the database while every loosely-phrased test still passed,
 *      so each assertion pins the ordinal AND the resulting state.
 *   3. WAITS NEVER CHARGE — property-based over every outcome and every
 *      reachable counter triple.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import {
  decidePhoneOutcome,
  decisionIsTerminal,
  resetsReconnectBudget,
  PHONE_OUTCOME_MIGRATION_REASONS,
  type PhoneBudgetCounters,
  type PhoneOutcomeDecision,
} from '../lib/phone-screening/budget.js';
import {
  PHONE_OUTCOME_CLASSES,
  PHONE_ATTEMPT_KINDS,
  PHONE_BUDGET_CEILINGS,
  type PhoneOutcomeClass,
} from '../lib/phone-screening/vocabulary.js';
import { MIGRATION_0042, functionBody } from './support/phone-migration.js';

const SEED = 0x0b0dae7;
const NUM_RUNS = 500;

const BUDGET_SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/phone-screening/budget.ts', import.meta.url)),
  'utf8',
);

const zero: PhoneBudgetCounters = {
  noAnswerAttempts: 0,
  reconnectsUsed: 0,
  providerFailures: 0,
};

const at = (c: Partial<PhoneBudgetCounters>): PhoneBudgetCounters => ({ ...zero, ...c });

const decide = (
  outcome: PhoneOutcomeClass,
  counters: PhoneBudgetCounters,
  windowOpen = true,
  disconnectCause?: 'drop' | 'assessment_aborted',
): PhoneOutcomeDecision => decidePhoneOutcome(outcome, { counters, windowOpen, disconnectCause });

describe('outcome map — exhaustiveness', () => {
  it('every one of the eleven outcome classes has a case in the map', () => {
    for (const outcome of PHONE_OUTCOME_CLASSES) {
      expect(BUDGET_SOURCE).toContain(`case '${outcome}':`);
    }
  });

  it('a vocabulary addition without a decision cannot compile, and throws at runtime', () => {
    // The compile-time control is the `assertNever` default arm: a twelfth
    // member of PHONE_OUTCOME_CLASSES with no `case` fails `tsc`. Its runtime
    // shadow — reachable only by a caller bypassing the types — must also
    // refuse rather than silently returning a benign-looking decision.
    expect(BUDGET_SOURCE).toContain('return assertNever(outcome)');
    expect(() =>
      decidePhoneOutcome('cold_start' as unknown as PhoneOutcomeClass, {
        counters: zero,
        windowOpen: true,
      }),
    ).toThrow(/phone_outcome_undecided/);
  });

  it('decides something for every outcome, at every counter triple', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PHONE_OUTCOME_CLASSES),
        fc.integer({ min: 0, max: PHONE_BUDGET_CEILINGS.noAnswer }),
        fc.integer({ min: 0, max: PHONE_BUDGET_CEILINGS.reconnect }),
        fc.integer({ min: 0, max: PHONE_BUDGET_CEILINGS.providerFailure }),
        fc.boolean(),
        (outcome, na, rc, pf, windowOpen) => {
          const d = decide(outcome, at({
            noAnswerAttempts: na, reconnectsUsed: rc, providerFailures: pf,
          }), windowOpen);
          expect(['none', 'no_answer', 'reconnect', 'provider']).toContain(d.charge);
          // Counters never move backwards and never move by more than one.
          expect(d.counters.noAnswerAttempts - na).toBeGreaterThanOrEqual(0);
          expect(d.counters.noAnswerAttempts - na).toBeLessThanOrEqual(1);
          expect(d.counters.reconnectsUsed - rc).toBeGreaterThanOrEqual(0);
          expect(d.counters.reconnectsUsed - rc).toBeLessThanOrEqual(1);
          expect(d.counters.providerFailures - pf).toBeGreaterThanOrEqual(0);
          expect(d.counters.providerFailures - pf).toBeLessThanOrEqual(1);
          // Exactly one budget moves, or none.
          const moved = [
            d.counters.noAnswerAttempts - na,
            d.counters.reconnectsUsed - rc,
            d.counters.providerFailures - pf,
          ].filter((x) => x === 1).length;
          expect(moved).toBe(d.charge === 'none' ? 0 : 1);
          // No counter may exceed the CHECK ceiling the database enforces.
          expect(d.counters.noAnswerAttempts).toBeLessThanOrEqual(PHONE_BUDGET_CEILINGS.noAnswer);
          expect(d.counters.reconnectsUsed).toBeLessThanOrEqual(PHONE_BUDGET_CEILINGS.reconnect);
          expect(d.counters.providerFailures).toBeLessThanOrEqual(
            PHONE_BUDGET_CEILINGS.providerFailure,
          );
          // Terminal and state agree.
          expect(d.terminal).toBe(decisionIsTerminal(d));
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('outcome map — the exact ordinals', () => {
  for (const outcome of ['no_answer', 'busy', 'voicemail'] as const) {
    it(`${outcome}: the THIRD no-answer charge is terminal, not the fourth`, () => {
      const first = decide(outcome, at({ noAnswerAttempts: 0 }));
      expect(first.charge).toBe('no_answer');
      expect(first.counters.noAnswerAttempts).toBe(1);
      expect(first.engagementState).toBe('awaiting_retry');
      expect(first.terminal).toBe(false);

      const second = decide(outcome, at({ noAnswerAttempts: 1 }));
      expect(second.counters.noAnswerAttempts).toBe(2);
      expect(second.engagementState).toBe('awaiting_retry');
      expect(second.terminal).toBe(false);

      const third = decide(outcome, at({ noAnswerAttempts: 2 }));
      expect(third.charge).toBe('no_answer');
      expect(third.counters.noAnswerAttempts).toBe(3);
      expect(third.engagementState).toBe('abandoned_no_answer');
      expect(third.terminal).toBe(true);
      expect(third.stateReason).toBe('no_answer_budget_exhausted');
    });
  }

  it('the FIFTH provider charge is terminal, not the sixth', () => {
    for (const before of [0, 1, 2, 3]) {
      const d = decide('provider_error', at({ providerFailures: before }));
      expect(d.charge).toBe('provider');
      expect(d.counters.providerFailures).toBe(before + 1);
      expect(d.engagementState).toBe('eligible');
      expect(d.terminal).toBe(false);
      // A survivable provider failure costs the engagement its IST DAY.
      expect(d.deferral).toBe('next_ist_day');
    }
    const fifth = decide('provider_error', at({ providerFailures: 4 }));
    expect(fifth.charge).toBe('provider');
    expect(fifth.counters.providerFailures).toBe(5);
    expect(fifth.engagementState).toBe('failed');
    expect(fifth.terminal).toBe(true);
    expect(fifth.stateReason).toBe('provider_budget_exhausted');
    expect(fifth.deferral).toBe('none');
  });

  it('the FOURTH drop is terminal and charges NOTHING', () => {
    for (const before of [0, 1, 2]) {
      const d = decide('disconnected', at({ reconnectsUsed: before }), true);
      expect(d.charge).toBe('reconnect');
      expect(d.counters.reconnectsUsed).toBe(before + 1);
      expect(d.engagementState).toBe('reconnecting');
      expect(d.terminal).toBe(false);
    }
    const fourth = decide('disconnected', at({ reconnectsUsed: 3 }), true);
    expect(fourth.charge).toBe('none');
    expect(fourth.counters.reconnectsUsed).toBe(3);
    expect(fourth.engagementState).toBe('failed');
    expect(fourth.terminal).toBe(true);
    expect(fourth.stateReason).toBe('reconnect_budget_exhausted');
  });

  it('a counter already AT its ceiling charges nothing and stays terminal', () => {
    // 0042 reaches this by terminality — the engagement is already
    // `abandoned_no_answer` / `failed`, so the event is ignored. The map
    // reaches it by refusing to overflow, and must never emit a value the
    // CHECK would reject.
    const na = decide('no_answer', at({ noAnswerAttempts: 3 }));
    expect(na.charge).toBe('none');
    expect(na.counters.noAnswerAttempts).toBe(3);
    expect(na.engagementState).toBe('abandoned_no_answer');
    expect(na.terminal).toBe(true);

    const pf = decide('provider_error', at({ providerFailures: 5 }));
    expect(pf.charge).toBe('none');
    expect(pf.counters.providerFailures).toBe(5);
    expect(pf.engagementState).toBe('failed');
    expect(pf.terminal).toBe(true);
  });

  it('the ordinals are the migration\'s, read from apply_phone_event', () => {
    const body = functionBody('apply_phone_event');
    expect(body).toContain('if v_eng.no_answer_attempts + 1 >= 3 then');
    expect(body).toContain('if v_eng.provider_failures + 1 >= 5 then');
    expect(body).toContain('if v_eng.reconnects_used >= 3 then');
  });
});

describe('outcome map — waits and cancels spend nothing', () => {
  it('a window-closed drop defers, charges nothing, and is not terminal', () => {
    const d = decide('disconnected', at({ reconnectsUsed: 1 }), false);
    expect(d.charge).toBe('none');
    expect(d.counters).toEqual(at({ reconnectsUsed: 1 }));
    expect(d.engagementState).toBe('scheduled');
    expect(d.deferral).toBe('next_window');
    expect(d.terminal).toBe(false);
    expect(d.stateReason).toBe('window_closed');
  });

  it('cancellation is terminal and free', () => {
    const d = decide('cancelled', at({ noAnswerAttempts: 2, reconnectsUsed: 2, providerFailures: 4 }));
    expect(d.charge).toBe('none');
    expect(d.counters).toEqual(at({ noAnswerAttempts: 2, reconnectsUsed: 2, providerFailures: 4 }));
    expect(d.engagementState).toBe('cancelled');
    expect(d.terminal).toBe(true);
  });

  it('completed, wrong_number and opt_out are terminal and free', () => {
    for (const [outcome, state] of [
      ['completed', 'completed'],
      ['wrong_number', 'wrong_number'],
      ['opt_out', 'opted_out'],
    ] as const) {
      const d = decide(outcome, at({ noAnswerAttempts: 1, reconnectsUsed: 1, providerFailures: 1 }));
      expect(d.charge).toBe('none');
      expect(d.counters).toEqual(at({ noAnswerAttempts: 1, reconnectsUsed: 1, providerFailures: 1 }));
      expect(d.engagementState).toBe(state);
      expect(d.terminal).toBe(true);
    }
  });

  it('opt_out and wrong_number write the suppression; nothing else does', () => {
    for (const outcome of PHONE_OUTCOME_CLASSES) {
      const d = decide(outcome, zero);
      expect(d.writesSuppression).toBe(outcome === 'opt_out' || outcome === 'wrong_number');
    }
    // The obligation follows the LINE, not the application.
    expect(functionBody('apply_phone_event')).toContain(
      "if v_new_state in ('opted_out','wrong_number') then",
    );
  });

  it('an aborted assessment is a free terminal failure, not a reconnect', () => {
    const d = decide('disconnected', at({ reconnectsUsed: 0 }), true, 'assessment_aborted');
    expect(d.charge).toBe('none');
    expect(d.engagementState).toBe('failed');
    expect(d.terminal).toBe(true);
    expect(d.stateReason).toBe('assessment_aborted');
  });

  it('no wait, in any configuration, charges any budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 0, max: 4 }),
        (na, rc, pf) => {
          const counters = at({ noAnswerAttempts: na, reconnectsUsed: rc, providerFailures: pf });
          // Out of window: a wait.
          expect(decide('disconnected', counters, false).charge).toBe('none');
          // Cancelled: a stop, never a failure.
          expect(decide('cancelled', counters).charge).toBe('none');
          // The two declared-but-unwritten classes.
          expect(decide('window_closed', counters).charge).toBe('none');
          expect(decide('declined', counters).charge).toBe('none');
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('outcome map — the classes 0042 declares but never writes', () => {
  for (const outcome of ['declined', 'window_closed'] as const) {
    it(`${outcome} has no writer in 0042 and no invented transition`, () => {
      const d = decide(outcome, at({ noAnswerAttempts: 1 }));
      expect(d.hasMigrationWriter).toBe(false);
      expect(d.engagementState).toBeNull();
      expect(d.charge).toBe('none');
      expect(d.terminal).toBe(false);
      // Proof rather than assertion: `apply_phone_event` never assigns this
      // value to `v_outcome`. If a writer ever appears, this fails and the
      // decision above must be revisited instead of silently going stale.
      expect(functionBody('apply_phone_event')).not.toContain(`v_outcome := '${outcome}'`);
    });
  }

  it('every other outcome DOES have a writer in apply_phone_event', () => {
    const body = functionBody('apply_phone_event');
    for (const outcome of PHONE_OUTCOME_CLASSES) {
      const d = decide(outcome, zero);
      if (!d.hasMigrationWriter) continue;
      expect(body).toContain(`v_outcome := '${outcome}'`);
    }
  });
});

describe('outcome map — reasons and the reconnect reset', () => {
  it('every documented reason exists in the migration', () => {
    for (const [outcome, reasons] of Object.entries(PHONE_OUTCOME_MIGRATION_REASONS)) {
      for (const reason of reasons) {
        if (outcome === 'cancelled') {
          // The four cancellation reasons are DERIVED, not written down:
          // `v_reason := replace(p_event_type, '.', '_')`. So the literal to
          // look for is the EVENT TYPE, and the derivation itself.
          expect(MIGRATION_0042).toContain(`'${reason.replace('_', '.')}'`);
          continue;
        }
        expect(MIGRATION_0042).toContain(`'${reason}'`);
      }
    }
    expect(MIGRATION_0042).toContain("v_reason    := replace(p_event_type, '.', '_')");
  });

  it('an outcome-determined reason is returned; an event-determined one is null', () => {
    expect(decide('no_answer', at({ noAnswerAttempts: 2 })).stateReason)
      .toBe('no_answer_budget_exhausted');
    // Several edges agree on the state and differ on the reason, so the map
    // reports null rather than picking one of them.
    expect(decide('opt_out', zero).stateReason).toBeNull();
    expect(decide('cancelled', zero).stateReason).toBeNull();
    expect(PHONE_OUTCOME_MIGRATION_REASONS.opt_out).toEqual([
      'disclosure_refused', 'candidate_opt_out',
    ]);
  });

  it('the reconnect budget resets only for a genuinely new conversation', () => {
    for (const kind of PHONE_ATTEMPT_KINDS) {
      expect(resetsReconnectBudget(kind)).toBe(kind !== 'reconnect');
    }
    // Resetting on a RECONNECT's disclosure would make "max 3 reconnects"
    // unenforceable — the counter could never exceed 1.
    expect(functionBody('apply_phone_event')).toContain(
      "and coalesce(v_att.kind, 'initial') <> 'reconnect'",
    );
  });
});
