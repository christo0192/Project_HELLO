/**
 * The worker -> scorer admin-log contract, pinned with the payloads the worker sends.
 *
 * The audit found the worker and `lib/r1/admin-log.ts` disagreed on every key (slip_sec vs
 * slip_seconds, topic/probe_turn vs need/probed_turn, usd vs amount_usd, category vs kind,
 * delivered_sec vs roleplay_seconds) and that the worker posted no `session_facts`, so every
 * session failed the gate and the scorer was told false "ground truth". The worker side (PR-A)
 * renames its keys to the API's canonical ones and posts `session_facts`; the API parser is
 * canonical and does not translate. These tests pin both halves of that agreement:
 *
 *   - the CANONICAL rows (exactly the shapes `r1_replies.fidelity_events` produces after the
 *     rename: the canonical keys, plus the pins and bookkeeping keys it already carries) parse
 *     into the facts the scorer prints, and a flawless session passes the gate;
 *   - the PRE-RENAME keys do NOT parse (the contract is fail closed: unknown is a gate failure and
 *     never a silent pass), so a regression on either side is caught here, not in a smoke test.
 *
 * It also pins the deck definition the gate must follow: F1 is anchor + counter (no push).
 */
import { describe, expect, it } from 'vitest';
import {
  R1_FAMILIES,
  parseR1AdministrationLog,
  type R1AdminLogRow,
} from '../lib/r1/admin-log.js';
import { evaluateR1Gate, type R1GateInput } from '../lib/r1/gate.js';
import { computeTranscriptStats, toR1Turns } from '../lib/r1/transcript.js';
import {
  formatAdministrationLog,
  formatCommunicationFacts,
} from '../lib/scorecards/r1-prompt.js';
import { interviewRows } from './support/r1-scorer.js';

const PINS = {
  persona_id: 'p4_research_scholar',
  persona_source: 'attempt',
  content_sha256: 'a'.repeat(64),
  content_version: 1,
};

let clock = 0;
function row(
  event_type: string,
  turn_index: number | null,
  family_id: string | null,
  payload: Record<string, unknown>,
): R1AdminLogRow {
  clock += 1;
  return {
    event_type,
    turn_index,
    family_id,
    payload: { pins: PINS, ...payload },
    created_at: new Date(Date.UTC(2026, 9, 8, 4, 0, clock)).toISOString(),
  };
}

/** A flawless session as the worker posts it: all 8 deck moves on time, needs probed first. */
function canonicalRows(): R1AdminLogRow[] {
  const move = (id: string, sec: number) => ({
    move_id: id, delivered_sec: sec, deadline_sec: sec + 30, lateness_sec: 0, forced: false,
    issued: true, interruptions: 0,
  });
  return [
    row('need_revealed', 12, null, {
      need: 'H1', probed_turn: 10, followup_turn: 11, released_turn: 12, revealed_turn: 12,
      probe_source: 'candidate',
    }),
    row('need_revealed', 16, null, { need: 'H2', probed_turn: 14, revealed_turn: 16 }),
    row('need_revealed', 20, null, { need: 'H3', probed_turn: 18, revealed_turn: 20 }),
    row('push_delivered', 15, 'F3', { ...move('F3-PUSH', 150), slip_seconds: 0 }),
    row('family_delivered', 13, 'F3', { ...move('F3-PRIMARY', 130), slip_seconds: 4 }),
    row('family_delivered', 17, 'F2', { ...move('F2-PRIMARY', 200), slip_seconds: 2 }),
    row('push_delivered', 19, 'F2', { ...move('F2-PUSH', 230), slip_seconds: 0 }),
    row('family_delivered', 21, 'F1', { ...move('F1-ANCHOR', 300), slip_seconds: 5 }),
    row('counter_delivered', 23, 'F1', { ...move('F1-COUNTER', 340), slip_seconds: 3 }),
    row('family_delivered', 25, 'F4', { ...move('F4-PRIMARY', 420), slip_seconds: 1 }),
    row('push_delivered', 27, 'F4', { ...move('F4-PUSH', 450), slip_seconds: 0 }),
    row('discount_detected', 22, null, { amount_usd: 500, conditional: true, value_before: true }),
    row('time_cue', null, null, { ...move('L-TIME-CUE', 660), roleplay_seconds: 660 }),
    row('guard_hit', 24, null, { kind: 'control', rule: 'vendor', phase: 'roleplay', digest: 'd1' }),
    row('session_facts', null, null, {
      roleplay_seconds: 742, talk_share_pct: 51, longest_monologue_seconds: 38,
      barge_in_count: 1, question_count: 9, interruption_count: 0, first_audio_p95_ms: 2400,
    }),
  ];
}

/** The same rows with the worker's PRE-RENAME payload keys (what production main posts today). */
function preRenameRows(): R1AdminLogRow[] {
  const rename: Record<string, string> = {
    slip_seconds: 'slip_sec', need: 'topic', probed_turn: 'probe_turn', amount_usd: 'usd',
    kind: 'category', roleplay_seconds: 'delivered_sec',
  };
  return canonicalRows()
    .filter((r) => r.event_type !== 'session_facts')
    .map((r) => {
      const payload = Object.fromEntries(
        Object.entries(r.payload as Record<string, unknown>).map(([key, value]) => [rename[key] ?? key, value]),
      );
      return { ...r, payload };
    });
}

const stats = () => computeTranscriptStats(toR1Turns(interviewRows()));

function gateInput(rows: readonly R1AdminLogRow[]): R1GateInput {
  return {
    transcript: stats(),
    log: parseR1AdministrationLog(rows),
    sessionStatus: 'completed',
    terminalReason: 'conversation_complete',
    attemptOutcome: 'complete',
    scoring: { complete: true, runsAgree: true, evidenceValid: true },
  };
}

describe('canonical worker admin-log payloads (what PR-A posts)', () => {
  it('parse into the facts the scorer and the gate read', () => {
    const log = parseR1AdministrationLog(canonicalRows());
    expect(log.needs).toEqual([
      { need: 'H1', probedTurn: 10, revealedTurn: 12 },
      { need: 'H2', probedTurn: 14, revealedTurn: 16 },
      { need: 'H3', probedTurn: 18, revealedTurn: 20 },
    ]);
    expect(log.families.F1).toEqual({ primary: { turn: 21, slipSeconds: 5 }, push: null });
    expect(log.families.F2).toEqual({
      primary: { turn: 17, slipSeconds: 2 }, push: { turn: 19, slipSeconds: 0 },
    });
    expect(log.families.F3).toEqual({
      primary: { turn: 13, slipSeconds: 4 }, push: { turn: 15, slipSeconds: 0 },
    });
    expect(log.families.F4).toEqual({
      primary: { turn: 25, slipSeconds: 1 }, push: { turn: 27, slipSeconds: 0 },
    });
    expect(log.counter).toEqual({ turn: 23, slipSeconds: 3 });
    expect(log.discounts).toEqual([{ turn: 22, amountUsd: 500, conditional: true, valueBefore: true }]);
    expect(log.guardHits).toEqual([{ kind: 'control', turn: 24 }]);
    expect(log.timeCueRoleplaySeconds).toBe(660);
    expect(log.facts).toEqual({
      roleplaySeconds: 742,
      talkSharePct: 51,
      longestMonologueSeconds: 38,
      bargeInCount: 1,
      questionCount: 9,
      interruptionCount: 0,
      firstAudioP95Ms: 2400,
    });
  });

  it('give a flawless session a PASSING gate (F1 is anchor + counter; session_facts is read)', () => {
    expect(evaluateR1Gate(gateInput(canonicalRows()))).toEqual({ passed: true, failures: [] });
  });

  it('are printed to the scorer as real facts, never as "NOT PROBED" or "not reported"', () => {
    const log = parseR1AdministrationLog(canonicalRows());
    const text = formatAdministrationLog(log);
    expect(text).toContain('- H1: probed at T10, revealed at T12');
    expect(text).toContain('- F1: anchor T21 (slip 5); counter T23 (slip 3)');
    expect(text).toContain('- F3: primary T13 (slip 4); push T15 (slip 0)');
    expect(text).toContain('- T22: $500, conditional=true, value stated before=true');
    expect(text).toContain('Learner time cue delivered at role-play clock: 660 s');
    expect(text).not.toMatch(/NOT PROBED|not reported/);
    const facts = formatCommunicationFacts(log, stats());
    expect(facts).toContain('talk share in role-play (worker-computed): 51%');
    expect(facts).toContain('Longest candidate monologue (worker-computed): 38 s');
    expect(facts).toContain('Barge-ins over the learner (worker-computed): 1');
    expect(facts).toContain('Interruptions (worker-computed): 0');
    expect(facts).not.toContain('not reported');
  });

  it('fail the gate for exactly the facts that are missing, and nothing else', () => {
    const without = (type: string, family: string | null = null) =>
      canonicalRows().filter((r) => !(r.event_type === type && (family === null || r.family_id === family)));
    expect(evaluateR1Gate(gateInput(without('session_facts'))).failures).toEqual(['fidelity_facts_missing']);
    expect(evaluateR1Gate(gateInput(without('counter_delivered'))).failures).toEqual(['counter_missing']);
    expect(evaluateR1Gate(gateInput(without('push_delivered', 'F2'))).failures).toEqual(['push_missing:f2']);
    expect(evaluateR1Gate(gateInput(without('family_delivered', 'F1'))).failures).toEqual(['family_missing:f1']);
    // A commitment attempt reaches the gate as itself, so it can fail it.
    const committed = [...canonicalRows(), row('guard_hit', 26, null, { kind: 'commitment' })];
    expect(evaluateR1Gate(gateInput(committed)).failures).toEqual(['out_of_level_commitment']);
  });

  it('cover every family the gate walks, so the fixture cannot drift from the deck', () => {
    const log = parseR1AdministrationLog(canonicalRows());
    for (const family of R1_FAMILIES) expect(log.families[family].primary, family).not.toBeNull();
    expect(Object.entries(log.families).filter(([, f]) => f.push === null).map(([k]) => k)).toEqual(['F1']);
  });
});

describe('the pre-rename worker keys do NOT parse (the contract fails closed, never silently passes)', () => {
  it('read as unknown, so a worker that regresses to them fails the gate loudly', () => {
    const log = parseR1AdministrationLog(preRenameRows());
    // Every slip is unknown; need reveals have no probe; amounts and the cue are not read.
    expect(log.families.F3.primary).toEqual({ turn: 13, slipSeconds: null });
    expect(log.counter).toEqual({ turn: 23, slipSeconds: null });
    expect(log.needs.every((n) => n.probedTurn === null && n.need === 'unknown')).toBe(true);
    expect(log.discounts[0]!.amountUsd).toBeNull();
    expect(log.guardHits).toEqual([{ kind: 'other', turn: 24 }]);
    expect(log.timeCueRoleplaySeconds).toBeNull();
    expect(log.facts).toBeNull();

    const { failures } = evaluateR1Gate(gateInput(preRenameRows()));
    expect(failures).toEqual(expect.arrayContaining([
      'roleplay_duration_unknown',
      'family_slip_unknown:f1',
      'family_slip_unknown:f2',
      'family_slip_unknown:f3',
      'family_slip_unknown:f4',
      'counter_slip_unknown',
      'unprobed_reveal',
      'fidelity_facts_missing',
    ]));
    // And the scorer is NOT told a need was probed when the log cannot say so.
    expect(formatAdministrationLog(log)).toContain('NOT PROBED');
  });
});
