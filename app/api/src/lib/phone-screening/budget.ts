/**
 * phone-screening/budget.ts — the ONE outcome→budget/state decision.
 *
 * ── WHY ONE FUNCTION ──────────────────────────────────────────────────
 * `apply_phone_event` decides three things together — which budget moves,
 * which engagement state results, and whether that state is terminal. Writing
 * them apart in TypeScript is how the two halves drift. `decidePhoneOutcome`
 * is exhaustive over the ELEVEN `outcome_class` members (`assertNever` at the
 * end of the switch), so ADDING a twelfth member to `PHONE_OUTCOME_CLASSES`
 * without also deciding its budget is a COMPILE ERROR, not a review comment.
 *
 * ── THE THREE BUDGETS, AND THE ORDINAL THAT ENDS EACH ─────────────────
 * Read straight off `apply_phone_event`:
 *   * no-answer  — `if v_eng.no_answer_attempts + 1 >= 3` ⇒ the THIRD charge
 *     is terminal (`abandoned_no_answer`). There is no fourth:
 *     `chk_phone_engagements_no_answer` caps at 3.
 *   * provider   — `if v_eng.provider_failures + 1 >= 5` ⇒ the FIFTH charge is
 *     terminal (`failed`). There is no sixth:
 *     `chk_phone_engagements_failures` caps at 5.
 *   * reconnect  — three drops are GRANTED a reconnect and charge one each;
 *     the FOURTH drop earns no fourth grant and is terminal (`failed`,
 *     `reconnect_budget_exhausted`) while charging NOTHING.
 *
 * ── A WAIT NEVER CHARGES A FAILURE BUDGET ─────────────────────────────
 * The phone path has five distinct waits — reconnect backoff, next-IST-day
 * retry, out-of-window hold, capacity backpressure and provider cold start.
 * None consumes a no-answer attempt, a reconnect grant or a provider failure.
 * Cancellation likewise charges nothing. Admission charges nothing at all:
 * every refusal is free.
 *
 * ── COLD START IS NOT AN OUTCOME ──────────────────────────────────────
 * A runtime that is not ready has placed no call. It is a PRE-CLAIM deferral
 * (`PhoneDeferralCode` in `admission.ts`), never an `outcome_class`, because
 * the twelfth member the database would reject on write is exactly how such a
 * value gets invented.
 *
 * Pure: no clock, no client, no configuration, no I/O.
 */

import {
  PHONE_BUDGET_CEILINGS,
  isTerminalEngagementState,
  type PhoneAttemptKind,
  type PhoneEngagementState,
  type PhoneOutcomeClass,
} from './vocabulary.js';

/** The three budgets, plus the explicit "this outcome spends nothing". */
export type PhoneChargeClass = 'none' | 'no_answer' | 'reconnect' | 'provider';

/** The three counters carried on `phone_engagements`. */
export interface PhoneBudgetCounters {
  readonly noAnswerAttempts: number;
  readonly reconnectsUsed: number;
  readonly providerFailures: number;
}

/**
 * The ONE place 0042 writes a single `outcome_class` from two edges that
 * disagree about the engagement verdict:
 *   * `drop` — `sip.participant_left` / `sip.connection_aborted` from
 *     `in_call`, which consults the reconnect budget and the window.
 *   * `assessment_aborted` — `assessment.aborted` from `in_call`, which is
 *     terminal `failed` and charges nothing. It carries `outcome_class =
 *     'disconnected'` deliberately, so an operator filtering on outcome does
 *     not lose the row.
 * Ignored for every other outcome.
 */
export type PhoneDisconnectCause = 'drop' | 'assessment_aborted';

/** How the engagement waits, when it waits. Never a charge. */
export type PhoneDeferral = 'none' | 'next_window' | 'next_ist_day';

export interface PhoneOutcomeContext {
  readonly counters: PhoneBudgetCounters;
  /**
   * Whether the IST calling window is open AT THE MOMENT THE RECONNECT WOULD
   * BE ACTED ON — not when the drop happened. A reconnect decided at 20:59
   * with a 120-second backoff would land at 21:01.
   */
  readonly windowOpen: boolean;
  readonly disconnectCause?: PhoneDisconnectCause;
}

export interface PhoneOutcomeDecision {
  readonly outcome: PhoneOutcomeClass;
  readonly charge: PhoneChargeClass;
  /** The counters AFTER the charge. Unchanged when `charge` is `none`. */
  readonly counters: PhoneBudgetCounters;
  /**
   * The resulting engagement state, or `null` when 0042 moves the engagement
   * nowhere for this outcome. `null` is only ever returned for the two
   * outcome classes the migration declares but never writes — see
   * `hasMigrationWriter`.
   */
  readonly engagementState: PhoneEngagementState | null;
  readonly terminal: boolean;
  /**
   * `phone_engagements.state_reason`, when the OUTCOME determines it.
   * `null` where the reason is decided by the triggering EVENT rather than
   * the outcome class (`opt_out` and `cancelled` each have several edges that
   * agree on the state and differ on the reason); those reasons are listed in
   * `PHONE_OUTCOME_MIGRATION_REASONS` and asserted against the migration.
   */
  readonly stateReason: string | null;
  readonly deferral: PhoneDeferral;
  /** True for `opted_out` / `wrong_number`: the suppression is written in the same transaction. */
  readonly writesSuppression: boolean;
  /**
   * False for the two outcome classes 0042 declares in
   * `chk_phone_call_attempts_outcome` but never writes: `declined` and
   * `window_closed`. Reporting a decision for them would be inventing one.
   * A structural test asserts the migration still has no writer for either.
   */
  readonly hasMigrationWriter: boolean;
}

function noCharge(counters: PhoneBudgetCounters): PhoneBudgetCounters {
  return counters;
}

/**
 * The compile-time exhaustiveness control. Its runtime shadow throws a BARE
 * code: interpolating the offending value would put caller-supplied text into
 * an error message, and on this path the caller is holding a phone call.
 */
function assertNever(_value: never): never {
  throw new Error('phone_outcome_undecided');
}

/**
 * The exhaustive outcome→budget/state map.
 *
 * Mirrors `apply_phone_event` branch for branch. `phone-screening-budget.test.ts`
 * proves every branch against the migration text and against the exact ordinals.
 */
export function decidePhoneOutcome(
  outcome: PhoneOutcomeClass,
  context: PhoneOutcomeContext,
): PhoneOutcomeDecision {
  const { counters, windowOpen } = context;
  const base = {
    outcome,
    deferral: 'none' as PhoneDeferral,
    writesSuppression: false,
    hasMigrationWriter: true,
  };

  switch (outcome) {
    // ── Terminal, no charge ────────────────────────────────────────────
    case 'completed':
      return {
        ...base,
        charge: 'none',
        counters: noCharge(counters),
        engagementState: 'completed',
        terminal: true,
        stateReason: null,
      };

    case 'wrong_number':
      return {
        ...base,
        charge: 'none',
        counters: noCharge(counters),
        engagementState: 'wrong_number',
        terminal: true,
        stateReason: 'wrong_number',
        // The obligation follows the LINE, not the application: an opt-out
        // recorded only on the engagement would let the same person be
        // dialled again through a second application.
        writesSuppression: true,
      };

    case 'opt_out':
      return {
        ...base,
        charge: 'none',
        counters: noCharge(counters),
        engagementState: 'opted_out',
        terminal: true,
        // `disclosure_refused` (from `dialing`) or `candidate_opt_out` (from
        // `in_call`) — decided by the event, not by the outcome class.
        stateReason: null,
        writesSuppression: true,
      };

    case 'cancelled':
      return {
        ...base,
        charge: 'none',
        counters: noCharge(counters),
        engagementState: 'cancelled',
        terminal: true,
        // `hr_cancelled` / `emergency_stop` / `ashby_stage_left` /
        // `prereq_lost` — the event type with its dot replaced.
        stateReason: null,
      };

    // ── The no-answer budget: the THIRD charge is terminal ──────────────
    case 'no_answer':
    case 'busy':
    case 'voicemail': {
      // Already AT the ceiling: the engagement is `abandoned_no_answer` and
      // therefore terminal, so 0042 answers `ignored`/`terminal` and never
      // reaches the charge. TypeScript reaches the same answer by refusing to
      // overflow — charging a fourth would write a 4 that
      // `chk_phone_engagements_no_answer` rejects, aborting the transaction.
      if (counters.noAnswerAttempts >= PHONE_BUDGET_CEILINGS.noAnswer) {
        return {
          ...base,
          charge: 'none',
          counters: noCharge(counters),
          engagementState: 'abandoned_no_answer',
          terminal: true,
          stateReason: 'no_answer_budget_exhausted',
        };
      }
      const next = counters.noAnswerAttempts + 1;
      const exhausted = next >= PHONE_BUDGET_CEILINGS.noAnswer;
      return {
        ...base,
        charge: 'no_answer',
        counters: { ...counters, noAnswerAttempts: next },
        engagementState: exhausted ? 'abandoned_no_answer' : 'awaiting_retry',
        terminal: exhausted,
        stateReason: exhausted ? 'no_answer_budget_exhausted' : null,
      };
    }

    // ── The provider budget: the FIFTH charge is terminal ───────────────
    case 'provider_error': {
      // Already AT the ceiling: `failed`, terminal, and unreachable in SQL for
      // the same reason as above. Refusing to overflow keeps this map from
      // ever producing a 6 that `chk_phone_engagements_failures` rejects.
      if (counters.providerFailures >= PHONE_BUDGET_CEILINGS.providerFailure) {
        return {
          ...base,
          charge: 'none',
          counters: noCharge(counters),
          engagementState: 'failed',
          terminal: true,
          stateReason: 'provider_budget_exhausted',
        };
      }
      const next = counters.providerFailures + 1;
      const exhausted = next >= PHONE_BUDGET_CEILINGS.providerFailure;
      return {
        ...base,
        charge: 'provider',
        counters: { ...counters, providerFailures: next },
        engagementState: exhausted ? 'failed' : 'eligible',
        terminal: exhausted,
        stateReason: exhausted ? 'provider_budget_exhausted' : null,
        // A survivable provider failure costs the engagement its IST DAY: the
        // failed attempt keeps today's `ist_date`, so
        // `uq_phone_attempts_one_per_ist_day` refuses the next admission until
        // the day rolls. `next_eligible_at` says so out loud rather than
        // letting the row look eligible and be refused by an index.
        deferral: exhausted ? 'none' : 'next_ist_day',
      };
    }

    // ── The reconnect budget: the FOURTH DROP is terminal, uncharged ────
    case 'disconnected': {
      if (context.disconnectCause === 'assessment_aborted') {
        return {
          ...base,
          charge: 'none',
          counters: noCharge(counters),
          engagementState: 'failed',
          terminal: true,
          stateReason: 'assessment_aborted',
        };
      }
      if (counters.reconnectsUsed >= PHONE_BUDGET_CEILINGS.reconnect) {
        // Three reconnects have already been granted and used; this drop earns
        // no fourth. Terminal, and NO further charge — `reconnecting` with an
        // unredeemable budget would be a state with no outgoing edge.
        return {
          ...base,
          charge: 'none',
          counters: noCharge(counters),
          engagementState: 'failed',
          terminal: true,
          stateReason: 'reconnect_budget_exhausted',
        };
      }
      if (!windowOpen) {
        // A wait outside the window charges NOTHING and is parked on a real,
        // legal slot rather than on a state that merely claims to be scheduled.
        return {
          ...base,
          charge: 'none',
          counters: noCharge(counters),
          engagementState: 'scheduled',
          terminal: false,
          stateReason: 'window_closed',
          deferral: 'next_window',
        };
      }
      // The charge happens at the GRANT, not at the dial: `reconnects_used`
      // counts drops that have been granted a reconnect.
      return {
        ...base,
        charge: 'reconnect',
        counters: { ...counters, reconnectsUsed: counters.reconnectsUsed + 1 },
        engagementState: 'reconnecting',
        terminal: false,
        stateReason: null,
      };
    }

    // ── Declared in the CHECK, written by nothing in 0042 ───────────────
    // Neither has an edge in `apply_phone_event`. Returning an invented
    // transition here would be a decision no migration has made; a null state
    // plus `hasMigrationWriter: false` says exactly what is true, and
    // `phone-screening-budget.test.ts` fails if a writer ever appears without
    // this entry being revisited.
    case 'declined':
    case 'window_closed':
      return {
        ...base,
        charge: 'none',
        counters: noCharge(counters),
        engagementState: null,
        terminal: false,
        stateReason: null,
        hasMigrationWriter: false,
      };

    default:
      // Adding a member to PHONE_OUTCOME_CLASSES without a case above fails
      // HERE, at compile time. This is the control that makes the map
      // exhaustive; a runtime throw alone would only find it in production.
      return assertNever(outcome);
  }
}

/**
 * The `state_reason` values 0042 can write for each outcome class, including
 * the event-determined ones `decidePhoneOutcome` deliberately returns as
 * `null`. Asserted against the migration text so this list cannot rot.
 */
export const PHONE_OUTCOME_MIGRATION_REASONS: Readonly<
  Record<PhoneOutcomeClass, readonly string[]>
> = Object.freeze({
  completed: [],
  disconnected: ['reconnect_budget_exhausted', 'window_closed', 'assessment_aborted'],
  no_answer: ['no_answer_budget_exhausted'],
  busy: ['no_answer_budget_exhausted'],
  voicemail: ['no_answer_budget_exhausted'],
  declined: [],
  wrong_number: ['wrong_number'],
  opt_out: ['disclosure_refused', 'candidate_opt_out'],
  provider_error: ['provider_budget_exhausted'],
  window_closed: [],
  cancelled: ['hr_cancelled', 'emergency_stop', 'ashby_stage_left', 'prereq_lost'],
});

/**
 * The reconnect budget's RESET rule, kept beside the charge it undoes.
 *
 * `disclosure.delivered` begins a conversation and resets `reconnects_used` —
 * but ONLY when the attempt that reached it is a genuinely new conversation.
 * Resetting on a RECONNECT's disclosure would make "max 3 reconnects"
 * unenforceable: every reconnect that reached `in_call` would zero the
 * counter, so it could never exceed 1 and the terminal edge would be dead code.
 */
export function resetsReconnectBudget(kind: PhoneAttemptKind): boolean {
  return kind !== 'reconnect';
}

/** Convenience: does this decision leave the engagement terminal and immutable? */
export function decisionIsTerminal(decision: PhoneOutcomeDecision): boolean {
  return decision.engagementState !== null && isTerminalEngagementState(decision.engagementState);
}
