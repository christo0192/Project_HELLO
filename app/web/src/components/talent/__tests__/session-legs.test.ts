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
  legRecordingShown,
  legUnobservedNote,
  legUnseekableReason,
  legNoAudioLabel,
  legPlayable,
  legRecordingAnchor,
  legTitle,
  sessionLengthLabel,
  sortLegs,
  turnStartMs,
  unknownLengthWords,
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

  it('production case: turns on a leg whose recording failed keep their call time and name the reason', () => {
    const failed = {
      ...A,
      recording: { state: 'unavailable' as const, reason: 'recording_failed' as const },
    };
    // Turns only on leg 1; leg 2 (reconnect) is the only playable recording.
    const [g, ...rest] = groupTurnsByLeg(
      [turn('Hello?', T0 + 12_000), turn('Hi', T0 + 75_000)],
      [failed, B],
      null,
      'leg',
    );
    expect(rest).toEqual([]);
    expect(g.legIndex).toBe(0);
    // Not seekable (wrong file would be worse than none)...
    expect(g.turns.map((t) => t.turn.start_offset_sec)).toEqual([null, null]);
    // ...but the time is known: seconds into the call (answered at +10 s).
    expect(g.turns.map((t) => t.callSec)).toEqual([2, 65]);
    expect(g.turns.every((t) => t.atMs !== null)).toBe(true);
    expect(g.unseekableReason).toMatch(/Recording failed for this call/);
    expect(legUnseekableReason(failed)).toBe(g.unseekableReason);
  });

  it('a playable leg has no unseekable reason', () => {
    const [g] = groupTurnsByLeg([turn('x', T0 + 320_000)], [A, B], null, 'leg');
    expect(g.unseekableReason).toBeNull();
    expect(g.turns[0].turn.start_offset_sec).toBe(9);
  });

  it('session mode with a null API offset derives it from the turn clock and the session anchor', () => {
    const dead = { ...A, recording: { state: 'unavailable' as const, reason: 'no_recording' as const } };
    const groups = groupTurnsByLeg([turn('x', T0 + 20_000, null)], [dead], T0, 'session');
    expect(groups[0].turns[0].turn.start_offset_sec).toBe(20);
    expect(groups[0].approximate).toBe(false);
  });

  it('session mode with no session anchor falls back to the first leg anchor and is approximate', () => {
    const dead = { ...A, recording: { state: 'unavailable' as const, reason: 'no_recording' as const } };
    const groups = groupTurnsByLeg([turn('x', T0 + 20_000, null), turn('y', null, null)], [dead], null, 'session');
    // answered_at (T0+10 s) + 1 s lag => 9 s into the recording.
    expect(groups[0].turns[0].turn.start_offset_sec).toBe(9);
    expect(groups[0].approximate).toBe(true);
    // A turn with no clock at all stays untimed.
    expect(groups[1].legIndex).toBeNull();
    expect(groups[1].turns[0].turn.start_offset_sec).toBeNull();
  });

  it('session mode: a call whose recording failed is not seekable and keeps its reason', () => {
    const failed = { ...A, recording: { state: 'unavailable' as const, reason: 'recording_failed' as const } };
    const groups = groupTurnsByLeg([turn('x', T0 + 20_000, null), turn('y', T0 + 30_000, null)], [failed], null, 'session');
    expect(groups[0].turns.every((t) => t.turn.start_offset_sec === null)).toBe(true);
    expect(groups[0].unseekableReason).toBe('Recording failed for this call, so its turns cannot start playback.');
    expect(groups[0].approximate).toBe(false);
  });

  it('session mode: a call the viewer cannot access (access_unavailable) is not seekable and says why', () => {
    const noAccess = { ...A, recording: { state: 'unavailable' as const, reason: 'access_unavailable' as const } };
    const groups = groupTurnsByLeg([turn('x', T0 + 20_000, null)], [noAccess], null, 'session');
    expect(groups[0].turns[0].turn.start_offset_sec).toBeNull();
    expect(groups[0].unseekableReason).not.toBeNull();
    expect(groups[0].approximate).toBe(false);
  });

  it('session mode: no fallback offset for a turn before the recording started', () => {
    const dead = { ...A, recording: { state: 'unavailable' as const, reason: 'no_recording' as const } };
    // answered_at + 1 s = T0 + 11 s; a turn at T0 + 2 s is outside the coverage.
    const groups = groupTurnsByLeg([turn('early', T0 + 2_000, null)], [dead], null, 'session');
    expect(groups[0].turns[0].turn.start_offset_sec).toBeNull();
  });

  it('session mode keeps an exact API offset over a derived one', () => {
    const [g] = groupTurnsByLeg([turn('x', T0 + 20_000, 4)], [A], null, 'session');
    expect(g.turns[0].turn.start_offset_sec).toBe(4);
    expect(g.approximate).toBe(false);
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
    // Audio of unknown length is never silently left out of the total.
    expect(sessionLengthLabel({ ...base, mode: 'live', recorded_total_sec: 17.6, recorded_legs: 1, recorded_unknown_legs: 1 }))
      .toBe('Recorded 18s + 1 call of unknown length');
    expect(sessionLengthLabel({ ...base, mode: 'live', recorded_total_sec: null, recorded_legs: 0, recorded_unknown_legs: 2 }))
      .toBe('Recorded, length unknown');
    expect(unknownLengthWords(2)).toBe(' + 2 calls of unknown length');
    expect(unknownLengthWords(0)).toBe('');
    expect(unknownLengthWords(null)).toBe('');
    expect(sessionLengthLabel({ ...base, mode: 'browser', duration_sec: 125 })).toBe('2m 5s');
    expect(sessionLengthLabel({ ...base, mode: 'browser', duration_sec: null })).toBeNull();
  });

  it('words a leg the same everywhere: connected, recorded, unobserved', () => {
    // A ledger-ended leg with an estimated recording (leg A), and a leg only
    // the lease reclaim ended ~6 min on (leg B). Anonymised timings; the real
    // 9f60523d leg A was reconciler-DETECTED, which the next case covers.
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

  it('a reconciler-detected end is approximate: "from", and a note naming our check, never a length', () => {
    // 9f60523d leg A: the sweep saw the empty room ~14 s after the SIP leave.
    const detected = leg({
      id: 'a', attempt_seq: 1, admitted_at: iso(T0), answered_at: iso(T0 + 10_000),
      connected_from: iso(T0 + 10_000), connected_to: iso(T0 + 85_000), connected_to_source: 'detected',
      connected_sec: null, recorded_sec: 53.2, recorded_sec_estimated: true,
    });
    expect(legConnectedWords(detected)).toMatch(/^Connected from \d\d:\d\d IST$/);
    expect(legConnectedWords(detected)).not.toMatch(/1m 15s/);
    expect(legUnobservedNote(detected)).toMatch(/^End time approximate: our check found the call over by \d\d:\d\d IST\.$/);
    expect(legUnobservedNote({ ...detected, connected_to: null })).toBe('End time approximate.');
  });

  it('shows recording facts only for a recording that can be played', () => {
    const base = leg({ id: 'a', attempt_seq: 1, admitted_at: iso(T0) });
    expect(legRecordingShown(base)).toBe(true);
    expect(legRecordingShown({ ...base, recording: { state: 'processing' } })).toBe(true);
    expect(legRecordingShown({ ...base, recording: { state: 'unavailable', reason: 'deleted' } })).toBe(false);
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
      // 0125 stored duration_sec 75 for the 9f60523d shape; it must not show.
      const facts = headlineCallFacts([
        { ...base, mode: 'live', duration_sec: 75, recorded_total_sec: 70.8, recorded_legs: 2,
          connected_complete: false, connected_total_sec: null, candidate_words: 4 },
      ]);
      expect(facts).toEqual({
        sessionId: 's', callSeconds: null, recordedSeconds: 70.8, recordedCalls: 2, recordedUnknownCalls: null, candidateWords: 4,
      });
    });

    it('a phone session whose every end is known also gets its connected total', () => {
      const facts = headlineCallFacts([
        { ...base, mode: 'live', duration_sec: 999, recorded_total_sec: 32.7, recorded_legs: 1,
          connected_complete: true, connected_total_sec: 34.6 },
      ]);
      expect(facts).toMatchObject({ callSeconds: 34.6, recordedSeconds: 32.7, recordedCalls: 1 });
    });

    it('carries the calls of unknown length with the recorded total', () => {
      const facts = headlineCallFacts([
        { ...base, mode: 'live', recorded_total_sec: 17.6, recorded_legs: 1, recorded_unknown_legs: 1 },
      ]);
      expect(facts).toMatchObject({ recordedSeconds: 17.6, recordedCalls: 1, recordedUnknownCalls: 1 });
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
      expect(facts).toEqual({
        sessionId: 'web', callSeconds: 434, recordedSeconds: null, recordedCalls: null, recordedUnknownCalls: null, candidateWords: 450,
      });
      expect(headlineCallFacts([])).toBeNull();
    });
  });
});
