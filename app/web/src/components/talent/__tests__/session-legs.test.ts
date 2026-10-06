/**
 * sessionLegs — the pure rules the Review tab uses to place a phone
 * session's turns on its legs and seek within each leg's own file (M013 S02).
 * Synthetic timings only.
 */
import { describe, it, expect } from 'vitest';
import type { CandidatePhoneAttempt, Session, TranscriptLine } from '../../../types';
import {
  LEGACY_RECORDING_LAG_MS,
  LEG_TAIL_NOTE,
  activeTurnIn,
  groupTurnsByLeg,
  headlineCallFacts,
  legConnectedWords,
  legConsentTag,
  legRecordedWords,
  legUnobservedNote,
  legNoAudioLabel,
  legPlayable,
  legRecordingAnchor,
  legTitle,
  sessionLengthLabel,
  sortLegs,
  turnStartMs,
} from '../sessionLegs';

const T0 = Date.parse('2026-10-05T03:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function leg(over: Partial<CandidatePhoneAttempt> & Pick<CandidatePhoneAttempt, 'id' | 'attempt_seq' | 'admitted_at'>): CandidatePhoneAttempt {
  return {
    answered_at: null,
    ended_at: null,
    state: 'completed',
    abandon_reason: null,
    outcome_class: null,
    duration_sec: null,
    recording: { state: 'ready' },
    transcript: null,
    ...over,
  };
}

const A = leg({ id: 'a', attempt_seq: 1, admitted_at: iso(T0), answered_at: iso(T0 + 10_000) });
const B = leg({
  id: 'b',
  attempt_seq: 2,
  admitted_at: iso(T0 + 300_000),
  answered_at: iso(T0 + 310_000),
  recording_started_at_ms: T0 + 311_000,
});

const turn = (text: string, startedAt: number | null, offset: number | null = null): TranscriptLine => ({
  speaker: 'bot',
  text,
  start_offset_sec: offset,
  started_at_ms: startedAt,
});

describe('sessionLegs', () => {
  it('orders legs by admission, then attempt number', () => {
    const tie = leg({ id: 'c', attempt_seq: 3, admitted_at: iso(T0 + 300_000) });
    expect(sortLegs([tie, B, A]).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('titles a leg by position: first call, then reconnect', () => {
    expect(legTitle(0, 2)).toBe('Call 1 of 2 · first call');
    expect(legTitle(1, 2)).toBe('Call 2 of 2 · reconnect');
  });

  it('anchors a leg on its recording start, else answered + 1 s (approximate), else nothing', () => {
    expect(legRecordingAnchor(B)).toEqual({ ms: T0 + 311_000, approximate: false });
    expect(legRecordingAnchor(A)).toEqual({ ms: T0 + 10_000 + LEGACY_RECORDING_LAG_MS, approximate: true });
    // connected_from wins over answered_at when both are present.
    expect(legRecordingAnchor({ ...A, connected_from: iso(T0 + 12_000) })).toEqual({ ms: T0 + 13_000, approximate: true });
    expect(legRecordingAnchor(leg({ id: 'n', attempt_seq: 1, admitted_at: iso(T0) }))).toBeNull();
    expect(legRecordingAnchor({ ...B, recording_started_at_ms: 0 })?.approximate).toBe(true);
  });

  it('an egress-era leg uses the session anchor when it falls inside that leg, exactly', () => {
    const ended = { ...A, connected_to: iso(T0 + 120_000) };
    expect(legRecordingAnchor(ended, T0 + 9_000)).toEqual({ ms: T0 + 9_000, approximate: false });
    // Outside the leg (it belongs to another leg): the legacy estimate stays.
    expect(legRecordingAnchor(ended, T0 + 200_000)).toEqual({ ms: T0 + 11_000, approximate: true });
    // The worker's own stamp always wins.
    expect(legRecordingAnchor(B, T0 + 305_000)).toEqual({ ms: T0 + 311_000, approximate: false });
  });

  it('a turn starts at its own stamp, else the session anchor plus its offset', () => {
    expect(turnStartMs(turn('x', T0 + 5000), null)).toBe(T0 + 5000);
    expect(turnStartMs(turn('x', null, 2.5), T0)).toBe(T0 + 2500);
    expect(turnStartMs(turn('x', null, 2.5), null)).toBeNull();
    expect(turnStartMs(turn('x', null, null), T0)).toBeNull();
  });

  it('places each turn on the latest leg admitted before it, re-based on that leg file', () => {
    const groups = groupTurnsByLeg(
      [
        turn('before the first leg (clock skew)', T0 - 500),
        turn('leg A', T0 + 13_000),
        turn('just before B was admitted (slack)', T0 + 299_000),
        turn('leg B', T0 + 314_500),
        turn('no timing', null),
      ],
      [A, B],
      null,
      'leg',
    );
    expect(groups.map((g) => g.legIndex)).toEqual([0, 1, null]);
    expect(groups[0].turns.map((t) => t.turn.text)).toEqual(['before the first leg (clock skew)', 'leg A']);
    // Leg A: approximate anchor at answered + 1 s = T0 + 11 s; a turn before it clamps to 0.
    expect(groups[0].turns.map((t) => t.turn.start_offset_sec)).toEqual([0, 2]);
    expect(groups[0].approximate).toBe(true);
    // Within 2 s of B's admission belongs to B; B's exact anchor.
    expect(groups[1].turns.map((t) => [t.index, t.turn.start_offset_sec])).toEqual([[2, 0], [3, 3.5]]);
    expect(groups[1].approximate).toBe(false);
    expect(groups[2].turns.map((t) => t.turn.start_offset_sec)).toEqual([null]);
  });

  it('a leg that cannot be played gets no seek offsets (and is not marked approximate)', () => {
    const dead = { ...A, recording: { state: 'unavailable' as const, reason: 'no_recording' as const } };
    const [g] = groupTurnsByLeg([turn('x', T0 + 20_000)], [dead, B], null, 'leg');
    expect(legPlayable(dead)).toBe(false);
    expect(g.turns[0].turn.start_offset_sec).toBeNull();
    expect(g.approximate).toBe(false);
  });

  it('session seek mode keeps the session offsets', () => {
    const groups = groupTurnsByLeg([turn('x', null, 4), turn('y', null, 320)], [A, B], T0, 'session');
    expect(groups.map((g) => [g.legIndex, g.turns[0].turn.start_offset_sec])).toEqual([[0, 4], [1, 320]]);
    expect(groups.every((g) => !g.approximate)).toBe(true);
  });

  it('drops empty groups but keeps the legs list intact', () => {
    const groups = groupTurnsByLeg([turn('only B', T0 + 320_000)], [A, B], null, 'leg');
    expect(groups.map((g) => g.legIndex)).toEqual([1]);
  });

  it('finds the playing turn within a group', () => {
    const groups = groupTurnsByLeg([turn('a', T0 + 312_000), turn('b', T0 + 320_000)], [A, B], null, 'leg');
    expect(activeTurnIn(groups[0].turns, 0.5)).toBeNull();
    expect(activeTurnIn(groups[0].turns, 1)).toBe(0);
    expect(activeTurnIn(groups[0].turns, 9)).toBe(1);
  });

  it('labels a leg without audio in the call-list words', () => {
    expect(legNoAudioLabel('recording_failed')).toBe('Recording unavailable (capture failed)');
    expect(legNoAudioLabel(undefined)).toBe('No recording available');
  });

  it('the picker length: recorded total for a phone session, duration for the rest', () => {
    const base: Session = { id: 's', candidate_id: 'c', role_id: null, status: 'completed', created_at: null };
    expect(sessionLengthLabel({ ...base, mode: 'live', duration_sec: 75, recorded_total_sec: 70.8, recorded_legs: 2 })).toBe(
      'Recorded 1m 11s across 2 calls',
    );
    expect(sessionLengthLabel({ ...base, mode: 'live', duration_sec: 75, recorded_total_sec: 32.7, recorded_legs: 1 })).toBe('Recorded 33s');
    expect(sessionLengthLabel({ ...base, mode: 'live', duration_sec: 443, recorded_total_sec: null })).toBeNull();
    expect(sessionLengthLabel({ ...base, mode: 'browser', duration_sec: 125 })).toBe('2m 5s');
    expect(sessionLengthLabel({ ...base, mode: 'browser', duration_sec: null })).toBeNull();
  });

  it('words a leg the same everywhere: connected, recorded, unobserved', () => {
    // The 9f60523d shape, anonymised: leg A ended by the ledger with an
    // estimated recording; leg B only ended by the lease reclaim ~6 min on.
    const legA = leg({
      id: 'a', attempt_seq: 1, admitted_at: iso(T0), answered_at: iso(T0 + 10_000),
      connected_from: iso(T0 + 10_000), connected_to: iso(T0 + 85_000), connected_to_source: 'ledger',
      connected_sec: 75, recorded_sec: 53.2, recorded_sec_estimated: true, tail_may_be_missing: true,
    });
    const legB = leg({
      id: 'b', attempt_seq: 2, admitted_at: iso(T0 + 240_000), answered_at: iso(T0 + 250_000),
      connected_from: iso(T0 + 250_000), connected_to: iso(T0 + 618_000), connected_to_source: 'unobserved',
      connected_sec: null, recorded_sec: 17.6,
    });
    expect(legConnectedWords(legA)).toMatch(/^Connected \d\d:\d\d.*IST \(1m 15s\)$/);
    expect(legRecordedWords(legA)).toBe('Recorded ≈53s (estimated)');
    expect(legUnobservedNote(legA)).toBeNull();
    // The reclaim span is never a length: "from", and a note naming the timeout.
    expect(legConnectedWords(legB)).toMatch(/^Connected from \d\d:\d\d IST$/);
    expect(legConnectedWords(legB)).not.toMatch(/6m/);
    expect(legRecordedWords(legB)).toBe('Recorded 18s');
    expect(legUnobservedNote(legB)).toMatch(/^Line dropped; end not observed \(detected \d\d:\d\d IST by timeout\)\.$/);
    expect(legUnobservedNote({ ...legB, connected_to: null })).toBe('Line dropped; end not observed.');
    expect(legRecordedWords({ ...legB, recorded_sec: null })).toBeNull();
    expect(legConnectedWords({ ...legB, answered_at: null, connected_from: null })).toBe('Not answered');
    expect(LEG_TAIL_NOTE).toBe('This recording may end a few seconds before the call did.');
  });

  it('tags every kept recording by its consent, and an ordinary consented leg not at all', () => {
    expect(legConsentTag('before_consent')?.label).toBe('Recorded before consent');
    expect(legConsentTag('consent_withdrawn')?.label).toBe('Consent withdrawn – recording kept');
    expect(legConsentTag('deferred_after_consent')?.label).toBe('Callback requested after consent – recording kept');
    for (const stage of ['before_consent', 'consent_withdrawn', 'deferred_after_consent'] as const) {
      // The 2026-09-26 retention note, reused: kept, and every playback logged.
      expect(legConsentTag(stage)?.note, stage).toMatch(/2026-09-26 retention decision\. Every playback is logged\.$/);
    }
    // A deferral is not a withdrawal: its words never say "withdr".
    expect(legConsentTag('deferred_after_consent')?.note).not.toMatch(/withdr/i);
    expect(legConsentTag('after_consent')).toBeNull();
    expect(legConsentTag(null)).toBeNull();
    expect(legConsentTag(undefined)).toBeNull();
  });

  describe('headlineCallFacts', () => {
    const base: Session = { id: 's', candidate_id: 'c', role_id: null, status: 'completed', created_at: null };

    it('a phone session with an unobserved leg: recorded across its calls, no call length', () => {
      // 0115 stored duration_sec 75 for the 9f60523d shape; it must not show.
      const facts = headlineCallFacts([
        { ...base, mode: 'live', duration_sec: 75, recorded_total_sec: 70.8, recorded_legs: 2,
          connected_complete: false, connected_total_sec: null, candidate_words: 4 },
      ]);
      expect(facts).toEqual({ sessionId: 's', callSeconds: null, recordedSeconds: 70.8, recordedCalls: 2, candidateWords: 4 });
    });

    it('a phone session whose every end is known also gets its connected total', () => {
      const facts = headlineCallFacts([
        { ...base, mode: 'live', duration_sec: 999, recorded_total_sec: 32.7, recorded_legs: 1,
          connected_complete: true, connected_total_sec: 34.6 },
      ]);
      expect(facts).toMatchObject({ callSeconds: 34.6, recordedSeconds: 32.7, recordedCalls: 1 });
    });

    it('never uses a phone session duration_sec, even when nothing else is known', () => {
      expect(headlineCallFacts([{ ...base, mode: 'live', duration_sec: 443, recorded_total_sec: null }])).toBeNull();
    });

    it('a browser session keeps duration_sec; the longest session wins, words from the same one', () => {
      const facts = headlineCallFacts([
        { ...base, id: 'gate', mode: 'live', recorded_total_sec: 9, recorded_legs: 1, candidate_words: 3 },
        { ...base, id: 'web', mode: 'browser', duration_sec: 434, candidate_words: 450 },
        { ...base, id: 'zero', mode: 'browser', duration_sec: 0, candidate_words: 0 },
      ]);
      expect(facts).toEqual({ sessionId: 'web', callSeconds: 434, recordedSeconds: null, recordedCalls: null, candidateWords: 450 });
      expect(headlineCallFacts([])).toBeNull();
    });
  });
});
