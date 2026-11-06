/**
 * One clock for the Review screen. A phone session can be several files, and a turn's seek offset is
 * into its own file, so the strip, the margin and the consent line all read a position along the
 * whole call instead. These pin how that position is reached and what may be claimed from it.
 */
import { describe, expect, it } from 'vitest';
import {
  buildReviewRows,
  consentSummary,
  dropWords,
  legAxisStartSec,
  legGaps,
  legTalkLimits,
  timelineBaseMs,
  timelineEnds,
} from '../reviewTimeline';
import type { ReviewRow } from '../reviewTimeline';
import { groupTurnsByLeg } from '../sessionLegs';
import type { CandidatePhoneAttempt, TranscriptLine } from '../../../types';

const ANSWER_A = Date.parse('2026-10-05T03:30:00.000Z');
const ANSWER_B = ANSWER_A + 240_000;

function leg(over: Partial<CandidatePhoneAttempt> & Pick<CandidatePhoneAttempt, 'id' | 'attempt_seq'>): CandidatePhoneAttempt {
  return {
    admitted_at: new Date(ANSWER_A - 10_000).toISOString(),
    answered_at: null,
    ended_at: null,
    state: 'completed',
    abandon_reason: null,
    outcome_class: null,
    duration_sec: null,
    connected_from: null,
    connected_to: null,
    connected_to_source: null,
    connected_sec: null,
    recorded_sec: null,
    recorded_sec_estimated: false,
    recording_started_at_ms: null,
    tail_may_be_missing: false,
    session_ref: 's',
    recording: { state: 'ready' },
    consent_stage: 'after_consent',
    transcript: null,
    ...over,
  };
}

const LEG_A = leg({
  id: 'a',
  attempt_seq: 1,
  outcome_class: 'disconnected',
  answered_at: new Date(ANSWER_A).toISOString(),
  connected_from: new Date(ANSWER_A).toISOString(),
  connected_to: new Date(ANSWER_A + 200_000).toISOString(),
  connected_to_source: 'observed',
  recording_started_at_ms: ANSWER_A + 1000,
  recorded_sec: 199,
});

const LEG_B = leg({
  id: 'b',
  attempt_seq: 2,
  admitted_at: new Date(ANSWER_B - 10_000).toISOString(),
  answered_at: new Date(ANSWER_B).toISOString(),
  connected_from: new Date(ANSWER_B).toISOString(),
  connected_to: new Date(ANSWER_B + 60_000).toISOString(),
  connected_to_source: 'unobserved',
  recording_started_at_ms: ANSWER_B + 1000,
  recorded_sec: 30,
});

/** A voicemail 29 hours before the real call: it leaves the session reusable and the redial binds to it. */
const VOICEMAIL_AT = ANSWER_A - 29 * 3_600_000;
const VOICEMAIL = leg({
  id: 'vm',
  attempt_seq: 1,
  outcome_class: 'voicemail',
  consent_stage: 'before_consent',
  admitted_at: new Date(VOICEMAIL_AT - 10_000).toISOString(),
  answered_at: new Date(VOICEMAIL_AT).toISOString(),
  connected_from: new Date(VOICEMAIL_AT).toISOString(),
  connected_to: new Date(VOICEMAIL_AT + 500_000).toISOString(),
  connected_to_source: 'observed',
  recording_started_at_ms: VOICEMAIL_AT + 1000,
  // Longer than the interview, so a clamped end would stretch the strip.
  recorded_sec: 499,
});

const stamped = (speaker: TranscriptLine['speaker'], ms: number, text = 'Words.', is_gate = false): TranscriptLine => ({
  speaker,
  text,
  start_offset_sec: null,
  started_at_ms: ms,
  is_gate,
});

const TRANSCRIPT = [
  stamped('bot', ANSWER_A + 11_000),
  stamped('candidate', ANSWER_A + 41_000),
  stamped('bot', ANSWER_B + 4000),
];

describe('timelineBaseMs', () => {
  it('starts the clock at the first answered call recording, so call one reads as its own file', () => {
    expect(timelineBaseMs([LEG_A, LEG_B], null, TRANSCRIPT)).toBe(ANSWER_A + 1000);
  });

  it('skips a call nobody answered', () => {
    const unanswered = leg({ id: 'x', attempt_seq: 1 });
    expect(timelineBaseMs([unanswered, LEG_A], null, TRANSCRIPT)).toBe(ANSWER_A + 1000);
  });

  it('falls back to the first turn with no call to go on', () => {
    expect(timelineBaseMs([], null, TRANSCRIPT)).toBe(ANSWER_A + 11_000);
  });

  it('passes over a call that stopped before consent, so a voicemail shifts nothing', () => {
    expect(timelineBaseMs([VOICEMAIL, LEG_A, LEG_B], null, TRANSCRIPT)).toBe(ANSWER_A + 1000);
  });

  it('passes over only that: a stage it could not read still starts the clock', () => {
    const unread = { ...LEG_A, consent_stage: null };
    expect(timelineBaseMs([unread, LEG_B], null, TRANSCRIPT)).toBe(ANSWER_A + 1000);
  });

  it('falls back to the first answered call when no call got past consent', () => {
    const refused = { ...LEG_A, consent_stage: 'before_consent' as const };
    expect(timelineBaseMs([VOICEMAIL, refused], null, TRANSCRIPT)).toBe(VOICEMAIL_AT + 1000);
  });
});

describe('buildReviewRows', () => {
  it('a session with no calls reads the offsets it was given, and seeks the session recording', () => {
    const rows = buildReviewRows({
      transcript: [{ speaker: 'bot', text: 'Hello', start_offset_sec: 12 }],
      legs: [],
      groups: [],
      seekMode: 'session',
      baseMs: null,
    });
    expect(rows).toEqual([
      expect.objectContaining({ row: 0, atSec: 12, target: { legId: null, offsetSec: 12 }, legIndex: null, approximate: false }),
    ]);
  });

  it('a turn with no offset has no position and no target', () => {
    const rows = buildReviewRows({
      transcript: [{ speaker: 'bot', text: 'Hello', start_offset_sec: null }],
      legs: [],
      groups: [],
      seekMode: 'session',
      baseMs: null,
    });
    expect(rows[0]).toMatchObject({ atSec: null, target: null });
  });

  it('with no calls and no offsets the stamps place a turn for reading, as an estimate, and it plays nothing', () => {
    const rows = buildReviewRows({ transcript: TRANSCRIPT, legs: [], groups: [], seekMode: 'session', baseMs: ANSWER_A + 11_000 });
    expect(rows.map((r) => r.atSec)).toEqual([0, 30, 233]);
    expect(rows.every((r) => r.target === null && r.approximate)).toBe(true);
  });

  it('an offset stays the clock and the seek target when the turn has a stamp too', () => {
    const rows = buildReviewRows({
      transcript: [{ ...TRANSCRIPT[0], start_offset_sec: 12 }],
      legs: [],
      groups: [],
      seekMode: 'session',
      baseMs: ANSWER_A,
    });
    expect(rows[0]).toMatchObject({ atSec: 12, target: { legId: null, offsetSec: 12 }, approximate: false });
  });

  it('with two calls the clock runs on across the drop while each turn seeks its own file', () => {
    const groups = groupTurnsByLeg(TRANSCRIPT, [LEG_A, LEG_B], null, 'leg');
    const rows = buildReviewRows({
      transcript: TRANSCRIPT,
      legs: [LEG_A, LEG_B],
      groups,
      seekMode: 'leg',
      baseMs: ANSWER_A + 1000,
    });
    expect(rows.map((r) => r.atSec)).toEqual([10, 40, 243]);
    expect(rows[0].target).toEqual({ legId: 'a', offsetSec: 10 });
    expect(rows[2].target).toEqual({ legId: 'b', offsetSec: 3 });
    expect(rows.map((r) => r.legIndex)).toEqual([0, 0, 1]);
  });

  it('a call before t = 0 still plays on its own file, and takes no place on the clock', () => {
    const transcript = [stamped('bot', VOICEMAIL_AT + 6000, 'Please leave a message.', true), ...TRANSCRIPT];
    const legs = [VOICEMAIL, LEG_A, LEG_B];
    const groups = groupTurnsByLeg(transcript, legs, null, 'leg');
    const rows = buildReviewRows({ transcript, legs, groups, seekMode: 'leg', baseMs: ANSWER_A + 1000 });
    expect(rows[0]).toMatchObject({ atSec: null, target: { legId: 'vm', offsetSec: 5 }, legIndex: 0 });
    expect(rows.slice(1).map((r) => r.atSec)).toEqual([10, 40, 243]);
  });

  it('no call goes before t = 0 when none got past consent: the first is the clock', () => {
    const legs = [LEG_A, LEG_B].map((call) => ({ ...call, consent_stage: 'before_consent' as const }));
    const groups = groupTurnsByLeg(TRANSCRIPT, legs, null, 'leg');
    const rows = buildReviewRows({ transcript: TRANSCRIPT, legs, groups, seekMode: 'leg', baseMs: ANSWER_A + 1000 });
    expect(rows.map((r) => r.atSec)).toEqual([10, 40, 243]);
  });

  it('a call with no recording keeps its position on the clock and gets no target', () => {
    const failed = { ...LEG_A, recording: { state: 'unavailable' as const, reason: 'recording_failed' as const } };
    const groups = groupTurnsByLeg(TRANSCRIPT, [failed, LEG_B], null, 'leg');
    const rows = buildReviewRows({
      transcript: TRANSCRIPT,
      legs: [failed, LEG_B],
      groups,
      seekMode: 'leg',
      baseMs: ANSWER_A + 1000,
    });
    expect(rows[0]).toMatchObject({ atSec: 10, target: null });
    expect(rows[2].target).toEqual({ legId: 'b', offsetSec: 3 });
  });

  it('when only the session recording can play, its offsets are the clock', () => {
    const lost = { state: 'unavailable' as const, reason: 'no_recording' as const };
    const legs = [{ ...LEG_A, recording: lost }, { ...LEG_B, recording: lost }];
    const transcript = [{ speaker: 'bot' as const, text: 'One', start_offset_sec: 4 }];
    const anchor = ANSWER_A + 1000;
    const groups = groupTurnsByLeg(transcript, legs, anchor, 'session');
    const rows = buildReviewRows({ transcript, legs, groups, seekMode: 'session', baseMs: anchor });
    expect(rows[0]).toMatchObject({ atSec: 4, target: { legId: null, offsetSec: 4 } });
  });
});

describe('legAxisStartSec', () => {
  it('says where a call file starts on the clock', () => {
    expect(legAxisStartSec(LEG_A, null, ANSWER_A + 1000)).toBe(0);
    expect(legAxisStartSec(LEG_B, null, ANSWER_A + 1000)).toBe(240);
  });
});

describe('legGaps', () => {
  const BASE = ANSWER_A + 1000;
  const after = (first: Partial<CandidatePhoneAttempt>) => legGaps([{ ...LEG_A, ...first }, LEG_B], BASE);

  it('finds the gap between two answered calls, from an end somebody saw', () => {
    expect(legGaps([LEG_A, LEG_B], BASE)).toEqual([{ legIndex: 1, fromSec: 199, drawFromSec: 199, toSec: 239, dropped: true }]);
  });

  it('claims no drop time when the first call end was not observed, and gives the strip its start to draw from', () => {
    expect(after({ connected_to_source: 'unobserved' })).toEqual([{ legIndex: 1, fromSec: null, drawFromSec: 0, toSec: 239, dropped: true }]);
  });

  it('a call before t = 0 leaves no gap: the clock has not started', () => {
    expect(legGaps([VOICEMAIL, LEG_A, LEG_B], BASE)).toEqual([{ legIndex: 2, fromSec: 199, drawFromSec: 199, toSec: 239, dropped: true }]);
    expect(legGaps([VOICEMAIL, LEG_A], BASE)).toEqual([]);
  });

  describe('a voicemail between the drop and the call that carried it on', () => {
    // Line lost at 01:40, a voicemail answered at 02:30, the real continuation at 03:20.
    const at = (sec: number) => new Date(BASE + sec * 1000).toISOString();
    const lost = { ...LEG_A, connected_to: at(100) };
    const between = leg({
      id: 'v',
      attempt_seq: 2,
      outcome_class: 'voicemail',
      consent_stage: 'before_consent',
      answered_at: at(150),
      connected_from: at(150),
      connected_to: at(170),
      connected_to_source: 'observed',
    });
    const carriedOn = { ...LEG_B, id: 'c', attempt_seq: 3, answered_at: at(200), connected_from: at(200) };

    it('names the call that carried the interview, and the one in between stays a plain gap', () => {
      expect(legGaps([lost, between, carriedOn], BASE)).toEqual([
        { legIndex: 1, fromSec: 100, drawFromSec: 100, toSec: 150, dropped: false },
        { legIndex: 2, fromSec: 100, drawFromSec: 170, toSec: 200, dropped: true },
      ]);
      expect(dropWords(legGaps([lost, between, carriedOn], BASE)[1])).toBe('Line dropped at 01:40; the call continued at 03:20');
    });

    it('looks past every such call, and past one nobody answered', () => {
      const silent = leg({ id: 'x', attempt_seq: 3 });
      const again = { ...between, id: 'v2', attempt_seq: 4, answered_at: at(180), connected_from: at(180), connected_to: at(190) };
      const gaps = legGaps([lost, between, silent, again, { ...carriedOn, attempt_seq: 5 }], BASE);
      expect(gaps.map((gap) => [gap.legIndex, gap.dropped, gap.toSec])).toEqual([
        [1, false, 150],
        [3, false, 180],
        [4, true, 200],
      ]);
      expect(gaps[2].fromSec).toBe(100);
    });

    it('with nothing to carry it on, no call is said to have continued', () => {
      expect(legGaps([lost, between], BASE)).toEqual([{ legIndex: 1, fromSec: 100, drawFromSec: 100, toSec: 150, dropped: false }]);
    });

    it('carries an end nobody saw past it too, still claiming no time', () => {
      const unseen = { ...lost, connected_to_source: 'unobserved' as const };
      expect(legGaps([unseen, between, carriedOn], BASE)[1]).toMatchObject({ fromSec: null, drawFromSec: 170, toSec: 200, dropped: true });
    });
  });

  it('one call has no gap, and a call nobody answered is no reconnect', () => {
    expect(legGaps([LEG_A], BASE)).toEqual([]);
    expect(legGaps([LEG_A, leg({ id: 'x', attempt_seq: 2 })], BASE)).toEqual([]);
  });

  it('names the later call by its place among every call, answered or not', () => {
    expect(legGaps([LEG_A, leg({ id: 'x', attempt_seq: 2 }), LEG_B], BASE)[0].legIndex).toBe(2);
  });

  it('a consented call our side lost is a drop', () => {
    expect(after({ outcome_class: null, state: 'abandoned', abandon_reason: null })[0].dropped).toBe(true);
  });

  it.each<[string, Partial<CandidatePhoneAttempt>]>([
    ['a voicemail before consent', { outcome_class: 'voicemail', consent_stage: 'before_consent' }],
    ['a refusal', { outcome_class: 'declined', consent_stage: 'before_consent' }],
    ['a hang-up before the notice', { outcome_class: 'abandoned_pre_disclosure', consent_stage: 'before_consent' }],
    ['a failed consent check', { outcome_class: 'consent_failed', consent_stage: 'before_consent' }],
    ['a line lost before consent', { outcome_class: 'disconnected', consent_stage: 'before_consent' }],
    ['a call the candidate put off', { outcome_class: 'callback_deferred', consent_stage: 'deferred_after_consent' }],
    ['a booked callback, which ends disconnected', { outcome_class: 'disconnected', consent_stage: 'deferred_after_consent' }],
    ['a withdrawal that lost the race to the drop', { outcome_class: 'disconnected', consent_stage: 'consent_withdrawn' }],
    ['a stage that could not be read', { outcome_class: 'disconnected', consent_stage: null }],
    ['a call that finished', { outcome_class: 'completed' }],
    ['a call we never placed', { outcome_class: null, state: 'abandoned', abandon_reason: 'infra_deferred' }],
  ])('%s is a plain gap, not a drop', (_what, earlier) => {
    // Behind a call that finished, so a stage before consent is on the clock and has a gap to judge.
    const finished = { ...LEG_A, id: 'f', outcome_class: 'completed' };
    expect(legGaps([finished, { ...LEG_A, ...earlier }, LEG_B], BASE).at(-1)).toMatchObject({ toSec: 239, dropped: false });
  });
});

describe('dropWords', () => {
  it('reads the moment, or only the reconnect when the moment is unknown', () => {
    expect(dropWords({ fromSec: 378, toSec: 392 })).toBe('Line dropped at 06:18; the call continued at 06:32');
    expect(dropWords({ fromSec: null, toSec: 392 })).toBe('Line dropped; the call continued at 06:32');
  });
});

describe('timelineEnds', () => {
  it('takes the ends somebody saw and what was recorded, never a timed-out end', () => {
    expect(timelineEnds([LEG_A, LEG_B], null, ANSWER_A + 1000)).toEqual([199, 199, 270]);
  });

  it('takes nothing from a call before t = 0, however long it ran', () => {
    expect(timelineEnds([VOICEMAIL, LEG_A, LEG_B], null, ANSWER_A + 1000)).toEqual([199, 199, 270]);
  });
});

describe('legTalkLimits', () => {
  it('is the end somebody saw, else where the recording stops, by call', () => {
    expect(legTalkLimits([LEG_A, LEG_B], null, ANSWER_A + 1000)).toEqual([199, 270]);
  });

  it('gives a call before t = 0 no limit: it has no place to be limited on', () => {
    expect(legTalkLimits([VOICEMAIL, LEG_A], null, ANSWER_A + 1000)).toEqual([null, 199]);
  });

  it('knows nothing of a call with neither, and nothing at all with no clock', () => {
    const silent = { ...LEG_B, connected_to_source: 'unobserved' as const, recorded_sec: null };
    expect(legTalkLimits([silent], null, ANSWER_A + 1000)).toEqual([null]);
    expect(legTalkLimits([LEG_A, LEG_B], null, null)).toEqual([null, null]);
  });
});

describe('consentSummary', () => {
  const row = (index: number, over: Partial<ReviewRow> & { speaker?: TranscriptLine['speaker']; gate?: boolean } = {}): ReviewRow => ({
    row: index,
    turn: { speaker: over.speaker ?? 'bot', text: 'Words', is_gate: over.gate ?? false },
    atSec: index * 5,
    target: null,
    approximate: false,
    legIndex: over.legIndex ?? 0,
    ...('atSec' in over ? { atSec: over.atSec! } : {}),
  });

  const GATE = [
    row(0, { gate: true }),
    row(1, { gate: true, speaker: 'candidate' }),
    row(2, { gate: true }),
    row(3, { gate: true, speaker: 'candidate' }),
    row(4),
    row(5, { speaker: 'candidate' }),
  ];

  it('dates consent at the candidate reply and counts the turns of the gate', () => {
    expect(consentSummary(GATE, [])).toEqual({ firstRow: 0, lastRow: 3, count: 4, atSec: 15, approximate: false });
  });

  it('claims nothing about a call that never left the gate', () => {
    expect(consentSummary(GATE.slice(0, 4), [])).toBeNull();
  });

  it('claims nothing when there is no gate to fold', () => {
    expect(consentSummary([row(0), row(1, { speaker: 'candidate' })], [])).toBeNull();
  });

  it('claims nothing when the candidate never answered at the gate', () => {
    expect(consentSummary([row(0, { gate: true }), row(1)], [])).toBeNull();
  });

  it('claims nothing it cannot date', () => {
    const undated = GATE.map((r) => ({ ...r, atSec: null }));
    expect(consentSummary(undated, [])).toBeNull();
  });

  it('leaves the turns in full when the gate crossed a dropped call', () => {
    const crossing = GATE.map((r) => (r.row === 3 ? { ...r, legIndex: 1 } : r));
    expect(consentSummary(crossing, [LEG_A, LEG_B])).toBeNull();
  });

  it('leaves the turns in full on a call recorded before consent', () => {
    expect(consentSummary(GATE, [{ ...LEG_A, consent_stage: 'before_consent' }])).toBeNull();
  });

  it('a notice read to a voicemail before t = 0 does not cost the real call its line', () => {
    const rows = [
      row(0, { gate: true, legIndex: 0, atSec: null }),
      ...GATE.map((r) => ({ ...r, row: r.row + 1, legIndex: 1 })),
    ];
    expect(consentSummary(rows, [VOICEMAIL, LEG_A])).toEqual({ firstRow: 1, lastRow: 4, count: 4, atSec: 15, approximate: false });
  });
});
