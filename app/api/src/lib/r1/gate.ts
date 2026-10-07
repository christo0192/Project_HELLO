/**
 * The R1 coverage and fidelity gate (plan 6.4).
 *
 * ALL of the following must hold before a score may have any status effect; otherwise the
 * recommendation is `human_review`. The gate never blocks scoring: HR still sees the
 * scorecard and an "administration quality" line for every session.
 *
 *   - the role-play clock reached 10:00 and the candidate gave at least 8 role-play turns
 *     of 3 or more words;
 *   - all four objection families were delivered (primary AND push), plus the F1 counter,
 *     and every delivery slipped by at most 60 seconds;
 *   - no deep need was revealed without a logged probe before it (a reveal with no turn
 *     index fails too);
 *   - no commitment or concession outside the permitted level reached the guard, and fewer
 *     than 3 guard hits in total;
 *   - learner end-of-speech to first audio p95 is at most 3.0 seconds;
 *   - speech-to-text sanity: fewer than 10% of candidate role-play turns are at most two
 *     words or non-lexical;
 *   - scoring is complete, the three runs agree, and the evidence references validated;
 *   - no system-failure outcome, and the session ended cleanly. The round is final (D1) by
 *     construction: a valid gated score is what makes a round final.
 *
 * FAIL CLOSED. A fact the worker never reported is unknown, and unknown fails. Until the
 * worker posts `session_facts` (PR-4b) no session can pass, which is the safe state while
 * auto-status is off.
 *
 * Pure: no I/O, no clock, no randomness. Every failure is a stable lowercase code.
 */

import { R1_FAMILIES, type R1AdministrationLog } from './admin-log.js';
import type { R1TranscriptStats } from './transcript.js';

export const R1_GATE_LIMITS = {
  MIN_ROLEPLAY_SECONDS: 600,
  MIN_QUALIFYING_TURNS: 8,
  MAX_FAMILY_SLIP_SECONDS: 60,
  /** Fewer than this many guard hits; three or more fail. */
  GUARD_HITS_FAIL_AT: 3,
  MAX_FIRST_AUDIO_P95_MS: 3000,
  /** The suspect-turn share must stay strictly below this. */
  STT_SUSPECT_SHARE_FAIL_AT: 0.1,
} as const;

/** Attempt outcomes (interview_round_attempts.outcome) that mean OUR side failed. */
export const R1_SYSTEM_FAILURE_OUTCOMES: ReadonlySet<string> = new Set([
  'provider_error',
  'shutdown_forced',
  'worker_crash',
  'residency_timeout',
  'configuration_failed',
  'context_failed',
]);

export interface R1GateInput {
  readonly transcript: R1TranscriptStats;
  readonly log: R1AdministrationLog;
  /** `call_sessions.terminal_reason`; null when unknown. */
  readonly terminalReason: string | null;
  /** `interview_round_attempts.outcome`; null until the worker settles it. */
  readonly attemptOutcome: string | null;
  readonly scoring: {
    /** Every metric scored (none `insufficient_evidence`). */
    readonly complete: boolean;
    readonly runsAgree: boolean;
    readonly evidenceValid: boolean;
  };
}

export interface R1GateResult {
  readonly passed: boolean;
  /** Stable codes, in a fixed order; empty when passed. */
  readonly failures: readonly string[];
}

export function evaluateR1Gate(input: R1GateInput): R1GateResult {
  const failures: string[] = [];
  const { transcript, log, scoring } = input;

  // Role-play reached 10:00. The worker's R clock is authoritative. When the session facts
  // never reported it, the role-play clock REPORTED with the learner time cue is the evidence
  // (a cue logged at R = 120 s proves only 120 s). Never a constant assumed on its behalf.
  const roleplaySeconds = log.facts?.roleplaySeconds ?? log.timeCueRoleplaySeconds;
  if (roleplaySeconds === null) {
    failures.push('roleplay_duration_unknown');
  } else if (roleplaySeconds < R1_GATE_LIMITS.MIN_ROLEPLAY_SECONDS) {
    failures.push('roleplay_too_short');
  }
  if (transcript.candidateRoleplayQualifyingTurns < R1_GATE_LIMITS.MIN_QUALIFYING_TURNS) {
    failures.push('too_few_candidate_turns');
  }

  // Every family delivered (primary and push), the F1 counter, and no delivery slipped.
  for (const family of R1_FAMILIES) {
    const entry = log.families[family];
    if (entry.primary === null) failures.push(`family_missing:${family.toLowerCase()}`);
    if (entry.push === null) failures.push(`push_missing:${family.toLowerCase()}`);
    for (const delivery of [entry.primary, entry.push]) {
      if (delivery === null) continue;
      if (delivery.slipSeconds === null) {
        failures.push(`family_slip_unknown:${family.toLowerCase()}`);
      } else if (delivery.slipSeconds > R1_GATE_LIMITS.MAX_FAMILY_SLIP_SECONDS) {
        failures.push(`family_slip:${family.toLowerCase()}`);
      }
    }
  }
  if (log.counter === null) {
    failures.push('counter_missing');
  } else if (log.counter.slipSeconds === null) {
    failures.push('counter_slip_unknown');
  } else if (log.counter.slipSeconds > R1_GATE_LIMITS.MAX_FAMILY_SLIP_SECONDS) {
    failures.push('counter_slip');
  }

  // A deep need must be probed BEFORE it is revealed. A reveal row without a turn index is
  // malformed: unknown fails, so it can never be skipped as "not yet revealed".
  if (log.needs.some((need) => need.revealedTurn === null)) {
    failures.push('need_reveal_turn_unknown');
  }
  const unprobed = log.needs.some((need) =>
    need.revealedTurn !== null
    && (need.probedTurn === null || need.probedTurn > need.revealedTurn));
  if (unprobed) failures.push('unprobed_reveal');

  // Guard: any attempted commitment or concession outside the level, and a hit budget.
  if (log.guardHits.some((hit) => hit.kind === 'commitment')) {
    failures.push('out_of_level_commitment');
  }
  if (log.guardHits.some((hit) => hit.kind === 'concession')) {
    failures.push('out_of_level_concession');
  }
  if (log.guardHits.length >= R1_GATE_LIMITS.GUARD_HITS_FAIL_AT) failures.push('guard_hits');

  // Fidelity facts the worker reports; unknown fails.
  if (log.facts === null) {
    failures.push('fidelity_facts_missing');
  } else if (log.facts.firstAudioP95Ms === null) {
    failures.push('latency_unknown');
  } else if (log.facts.firstAudioP95Ms > R1_GATE_LIMITS.MAX_FIRST_AUDIO_P95_MS) {
    failures.push('latency_p95_exceeded');
  }

  if (transcript.suspectShare >= R1_GATE_LIMITS.STT_SUSPECT_SHARE_FAIL_AT) {
    failures.push('stt_sanity');
  }

  if (!scoring.complete) failures.push('scoring_incomplete');
  if (!scoring.runsAgree) failures.push('runs_disagree');
  if (!scoring.evidenceValid) failures.push('evidence_invalid');

  if (input.attemptOutcome !== null && R1_SYSTEM_FAILURE_OUTCOMES.has(input.attemptOutcome)) {
    failures.push('system_failure_outcome');
  }
  if (input.terminalReason !== null
      && input.terminalReason !== 'conversation_complete'
      && input.terminalReason !== 'assessment_done') {
    failures.push('session_not_clean');
  }

  return { passed: failures.length === 0, failures };
}

export interface R1AdministrationQuality {
  readonly status: 'ok' | 'review';
  readonly failures: readonly string[];
  /** Counts only; no candidate text. */
  readonly counts: {
    readonly candidateRoleplayTurns: number;
    readonly qualifyingTurns: number;
    readonly guardHits: number;
    readonly familiesDelivered: number;
    readonly roleplaySeconds: number | null;
    readonly firstAudioP95Ms: number | null;
  };
}

/** The "administration quality" line HR sees for each session. */
export function describeAdministrationQuality(
  input: R1GateInput,
  result: R1GateResult,
): R1AdministrationQuality {
  const delivered = R1_FAMILIES.filter((family) => {
    const entry = input.log.families[family];
    return entry.primary !== null && entry.push !== null;
  }).length;
  return {
    status: result.passed ? 'ok' : 'review',
    failures: result.failures,
    counts: {
      candidateRoleplayTurns: input.transcript.candidateRoleplayTurns,
      qualifyingTurns: input.transcript.candidateRoleplayQualifyingTurns,
      guardHits: input.log.guardHits.length,
      familiesDelivered: delivered,
      roleplaySeconds: input.log.facts?.roleplaySeconds ?? input.log.timeCueRoleplaySeconds,
      firstAudioP95Ms: input.log.facts?.firstAudioP95Ms ?? null,
    },
  };
}
