/**
 * The coverage and fidelity gate matrix (plan 6.4): every condition passes at its boundary,
 * fails just past it, and fails closed when the worker never reported the fact.
 */
import { describe, expect, it } from 'vitest';
import {
  R1_GATE_LIMITS,
  R1_SYSTEM_FAILURE_OUTCOMES,
  describeAdministrationQuality,
  evaluateR1Gate,
  type R1GateInput,
} from '../lib/r1/gate.js';
import {
  parseR1AdministrationLog,
  type R1AdministrationLog,
  type R1Delivery,
} from '../lib/r1/admin-log.js';
import {
  computeTranscriptStats,
  toR1Turns,
  type R1TranscriptStats,
} from '../lib/r1/transcript.js';
import { cleanLogRows, interviewRows } from './support/r1-scorer.js';

const stats = (): R1TranscriptStats => computeTranscriptStats(toR1Turns(interviewRows()));

function baseline(overrides: {
  transcript?: Partial<R1TranscriptStats>;
  log?: (log: R1AdministrationLog) => R1AdministrationLog;
  terminalReason?: string | null;
  attemptOutcome?: string | null;
  scoring?: Partial<R1GateInput['scoring']>;
} = {}): R1GateInput {
  const log = parseR1AdministrationLog(cleanLogRows());
  return {
    transcript: { ...stats(), ...overrides.transcript },
    log: overrides.log ? overrides.log(log) : log,
    terminalReason: overrides.terminalReason === undefined ? 'conversation_complete' : overrides.terminalReason,
    attemptOutcome: overrides.attemptOutcome === undefined ? 'complete' : overrides.attemptOutcome,
    scoring: { complete: true, runsAgree: true, evidenceValid: true, ...overrides.scoring },
  };
}

const withFacts = (log: R1AdministrationLog, patch: Partial<NonNullable<R1AdministrationLog['facts']>>) => ({
  ...log,
  facts: { ...(log.facts as NonNullable<R1AdministrationLog['facts']>), ...patch },
});

const withFamily = (
  log: R1AdministrationLog,
  family: 'F1' | 'F2' | 'F3' | 'F4',
  patch: Partial<{ primary: R1Delivery | null; push: R1Delivery | null }>,
): R1AdministrationLog => ({
  ...log,
  families: { ...log.families, [family]: { ...log.families[family], ...patch } },
});

describe('R1 coverage and fidelity gate', () => {
  it('passes a clean, complete, fully-reported session', () => {
    expect(evaluateR1Gate(baseline())).toEqual({ passed: true, failures: [] });
  });

  describe('role-play reached 10:00 and enough candidate turns', () => {
    it('enforces the 600 s boundary', () => {
      const run = (seconds: number) =>
        evaluateR1Gate(baseline({ log: (l) => withFacts(l, { roleplaySeconds: seconds }) })).failures;
      expect(run(R1_GATE_LIMITS.MIN_ROLEPLAY_SECONDS)).toEqual([]);
      expect(run(599.9)).toEqual(['roleplay_too_short']);
      expect(run(0)).toEqual(['roleplay_too_short']);
    });

    it('treats the learner time cue as proof of at least 660 s when facts are missing', () => {
      const noFacts = (l: R1AdministrationLog): R1AdministrationLog => ({ ...l, facts: null });
      expect(evaluateR1Gate(baseline({ log: noFacts })).failures).toEqual(['fidelity_facts_missing']);
      expect(evaluateR1Gate(baseline({ log: (l) => ({ ...noFacts(l), timeCueRoleplaySeconds: null }) })).failures)
        .toEqual(['roleplay_duration_unknown', 'fidelity_facts_missing']);
    });

    it('uses the REPORTED time-cue clock, never an assumed constant, when the facts omit the role-play time', () => {
      const noRoleplayTime = (cue: number | null) => (l: R1AdministrationLog): R1AdministrationLog => ({
        ...withFacts(l, { roleplaySeconds: null }),
        timeCueRoleplaySeconds: cue,
      });
      const run = (cue: number | null) => evaluateR1Gate(baseline({ log: noRoleplayTime(cue) })).failures;
      // A cue logged at R = 120 s proves 120 s, not the 660 s the cue is scheduled for.
      expect(run(120)).toEqual(['roleplay_too_short']);
      expect(run(599)).toEqual(['roleplay_too_short']);
      expect(run(R1_GATE_LIMITS.MIN_ROLEPLAY_SECONDS)).toEqual([]);
      expect(run(660)).toEqual([]);
      expect(run(null)).toEqual(['roleplay_duration_unknown']);
      // The same holds when the whole session_facts row is missing.
      const noFacts = (cue: number) => (l: R1AdministrationLog): R1AdministrationLog => ({
        ...l, facts: null, timeCueRoleplaySeconds: cue,
      });
      expect(evaluateR1Gate(baseline({ log: noFacts(120) })).failures)
        .toEqual(['roleplay_too_short', 'fidelity_facts_missing']);
    });

    it('prefers the role-play clock the worker reported over the cue', () => {
      const both = (facts: number, cue: number) => (l: R1AdministrationLog): R1AdministrationLog => ({
        ...withFacts(l, { roleplaySeconds: facts }),
        timeCueRoleplaySeconds: cue,
      });
      expect(evaluateR1Gate(baseline({ log: both(700, 120) })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ log: both(300, 660) })).failures).toEqual(['roleplay_too_short']);
    });

    it('needs 8 role-play turns of 3 or more words', () => {
      const run = (n: number) =>
        evaluateR1Gate(baseline({ transcript: { candidateRoleplayQualifyingTurns: n } })).failures;
      expect(run(8)).toEqual([]);
      expect(run(7)).toEqual(['too_few_candidate_turns']);
    });
  });

  describe('all four objection families, the F1 counter, and slip', () => {
    it('fails each missing primary and each missing push by family', () => {
      for (const family of ['F1', 'F2', 'F3', 'F4'] as const) {
        const lower = family.toLowerCase();
        expect(evaluateR1Gate(baseline({ log: (l) => withFamily(l, family, { primary: null }) })).failures)
          .toEqual([`family_missing:${lower}`]);
        expect(evaluateR1Gate(baseline({ log: (l) => withFamily(l, family, { push: null }) })).failures)
          .toEqual([`push_missing:${lower}`]);
      }
    });

    it('allows a 60 s slip and fails 61 s, for primaries, pushes and the counter', () => {
      const slip = (seconds: number | null): R1Delivery => ({ turn: 3, slipSeconds: seconds });
      expect(evaluateR1Gate(baseline({ log: (l) => withFamily(l, 'F3', { primary: slip(60) }) })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ log: (l) => withFamily(l, 'F3', { primary: slip(61) }) })).failures)
        .toEqual(['family_slip:f3']);
      expect(evaluateR1Gate(baseline({ log: (l) => withFamily(l, 'F2', { push: slip(75) }) })).failures)
        .toEqual(['family_slip:f2']);
      expect(evaluateR1Gate(baseline({ log: (l) => withFamily(l, 'F4', { primary: slip(null) }) })).failures)
        .toEqual(['family_slip_unknown:f4']);
      expect(evaluateR1Gate(baseline({ log: (l) => ({ ...l, counter: slip(61) }) })).failures).toEqual(['counter_slip']);
      expect(evaluateR1Gate(baseline({ log: (l) => ({ ...l, counter: slip(null) }) })).failures)
        .toEqual(['counter_slip_unknown']);
      expect(evaluateR1Gate(baseline({ log: (l) => ({ ...l, counter: null }) })).failures).toEqual(['counter_missing']);
    });
  });

  describe('deep needs are revealed only after a probe', () => {
    it('fails a reveal with no probe, or a probe logged after the reveal', () => {
      const need = (probedTurn: number | null, revealedTurn: number | null) => (l: R1AdministrationLog) => ({
        ...l,
        needs: [{ need: 'H2', probedTurn, revealedTurn }],
      });
      expect(evaluateR1Gate(baseline({ log: need(10, 12) })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ log: need(12, 12) })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ log: need(null, 12) })).failures).toEqual(['unprobed_reveal']);
      expect(evaluateR1Gate(baseline({ log: need(13, 12) })).failures).toEqual(['unprobed_reveal']);
      expect(evaluateR1Gate(baseline({ log: () => ({ ...parseR1AdministrationLog(cleanLogRows()), needs: [] }) })).failures)
        .toEqual([]);
    });
  });

  describe('a malformed need reveal fails closed', () => {
    it('fails a reveal with no turn index instead of skipping it', () => {
      const need = (probedTurn: number | null, revealedTurn: number | null) => (l: R1AdministrationLog) => ({
        ...l,
        needs: [{ need: 'H2', probedTurn, revealedTurn }],
      });
      expect(evaluateR1Gate(baseline({ log: need(10, null) })).failures).toEqual(['need_reveal_turn_unknown']);
      expect(evaluateR1Gate(baseline({ log: need(null, null) })).failures).toEqual(['need_reveal_turn_unknown']);
      // One malformed row fails the session even when the other reveals are fine.
      const mixed = (l: R1AdministrationLog): R1AdministrationLog => ({
        ...l,
        needs: [...l.needs, { need: 'H4', probedTurn: 3, revealedTurn: null }],
      });
      expect(evaluateR1Gate(baseline({ log: mixed })).failures).toEqual(['need_reveal_turn_unknown']);
    });

    it('fails end to end when a worker posts need_revealed without a turn_index', () => {
      const rows = cleanLogRows().map((row) => (row.event_type === 'need_revealed' && row.payload && (row.payload as { need?: string }).need === 'H1'
        ? { ...row, turn_index: null }
        : row));
      const log = parseR1AdministrationLog(rows);
      expect(log.needs.some((need) => need.revealedTurn === null)).toBe(true);
      expect(evaluateR1Gate({ ...baseline(), log }).failures).toEqual(['need_reveal_turn_unknown']);
    });
  });

  describe('guard hits', () => {
    const hits = (...kinds: string[]) => (l: R1AdministrationLog): R1AdministrationLog => ({
      ...l,
      guardHits: kinds.map((kind) => ({ kind, turn: 1 })),
    });
    it('fails an out-of-level commitment or concession, and 3 or more hits', () => {
      expect(evaluateR1Gate(baseline({ log: hits('control', 'persona') })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ log: hits('commitment') })).failures).toEqual(['out_of_level_commitment']);
      expect(evaluateR1Gate(baseline({ log: hits('concession') })).failures).toEqual(['out_of_level_concession']);
      expect(evaluateR1Gate(baseline({ log: hits('control', 'control', 'feedback') })).failures).toEqual(['guard_hits']);
      expect(evaluateR1Gate(baseline({ log: hits('commitment', 'concession', 'other') })).failures)
        .toEqual(['out_of_level_commitment', 'out_of_level_concession', 'guard_hits']);
    });
  });

  describe('latency and speech-to-text sanity', () => {
    it('allows p95 first audio of 3.0 s and fails past it or when unreported', () => {
      const run = (ms: number | null) =>
        evaluateR1Gate(baseline({ log: (l) => withFacts(l, { firstAudioP95Ms: ms }) })).failures;
      expect(run(R1_GATE_LIMITS.MAX_FIRST_AUDIO_P95_MS)).toEqual([]);
      expect(run(3001)).toEqual(['latency_p95_exceeded']);
      expect(run(null)).toEqual(['latency_unknown']);
    });

    it('fails when 10% or more of role-play turns are at most 2 words or non-lexical', () => {
      const run = (share: number) => evaluateR1Gate(baseline({ transcript: { suspectShare: share } })).failures;
      expect(run(0.0999)).toEqual([]);
      expect(run(0.1)).toEqual(['stt_sanity']);
      expect(run(1)).toEqual(['stt_sanity']);
    });
  });

  describe('scoring completeness, agreement and evidence', () => {
    it('maps each scoring flag to its own code', () => {
      expect(evaluateR1Gate(baseline({ scoring: { complete: false } })).failures).toEqual(['scoring_incomplete']);
      expect(evaluateR1Gate(baseline({ scoring: { runsAgree: false } })).failures).toEqual(['runs_disagree']);
      expect(evaluateR1Gate(baseline({ scoring: { evidenceValid: false } })).failures).toEqual(['evidence_invalid']);
    });
  });

  describe('system failures and the session end', () => {
    it('fails every system-failure attempt outcome and an unclean terminal reason', () => {
      for (const outcome of R1_SYSTEM_FAILURE_OUTCOMES) {
        expect(evaluateR1Gate(baseline({ attemptOutcome: outcome })).failures, outcome).toEqual(['system_failure_outcome']);
      }
      expect(evaluateR1Gate(baseline({ attemptOutcome: null })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ attemptOutcome: 'complete' })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ terminalReason: 'assessment_done' })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ terminalReason: null })).failures).toEqual([]);
      expect(evaluateR1Gate(baseline({ terminalReason: 'worker_crash' })).failures).toEqual(['session_not_clean']);
    });
  });

  it('reports every failure at once, in a fixed order, so HR sees the whole picture', () => {
    const result = evaluateR1Gate(baseline({
      transcript: { candidateRoleplayQualifyingTurns: 2, suspectShare: 0.5 },
      log: (l) => ({ ...withFamily(l, 'F1', { primary: null }), counter: null, facts: null, timeCueRoleplaySeconds: null }),
      scoring: { complete: false, runsAgree: false, evidenceValid: false },
      attemptOutcome: 'provider_error',
      terminalReason: 'worker_crash',
    }));
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      'roleplay_duration_unknown',
      'too_few_candidate_turns',
      'family_missing:f1',
      'counter_missing',
      'fidelity_facts_missing',
      'stt_sanity',
      'scoring_incomplete',
      'runs_disagree',
      'evidence_invalid',
      'system_failure_outcome',
      'session_not_clean',
    ]);
  });

  it('is pure: the same input always yields the same verdict', () => {
    const input = baseline({ log: (l) => withFacts(l, { firstAudioP95Ms: 4000 }) });
    expect(evaluateR1Gate(input)).toEqual(evaluateR1Gate(input));
  });
});

describe('administration quality line', () => {
  it('summarises a pass with counts only and no text', () => {
    const input = baseline();
    const quality = describeAdministrationQuality(input, evaluateR1Gate(input));
    expect(quality).toEqual({
      status: 'ok',
      failures: [],
      counts: {
        candidateRoleplayTurns: 11,
        qualifyingTurns: 11,
        guardHits: 0,
        familiesDelivered: 4,
        roleplaySeconds: 740,
        firstAudioP95Ms: 2100,
      },
    });
  });

  it('summarises a review with the failure codes', () => {
    const input = baseline({ log: (l) => withFamily(l, 'F2', { push: null }) });
    const quality = describeAdministrationQuality(input, evaluateR1Gate(input));
    expect(quality.status).toBe('review');
    expect(quality.failures).toEqual(['push_missing:f2']);
    expect(quality.counts.familiesDelivered).toBe(3);
  });
});
