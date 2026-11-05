import { describe, expect, it } from 'vitest';
import {
  R1_INTERVIEWER_LABEL,
  cueSecFrom,
  cuedRow,
  eventMarks,
  evidenceMarks,
  highlightRanges,
  learnerLabel,
  neededReveals,
  notScoredSentence,
  phaseSegments,
  phoneResultWords,
  placeTurns,
  R1_SCORE_WAIT_MS,
  recordingBands,
  reviewAttemptFrom,
  reviewDurationSec,
  reviewStage,
  reviewTabFrom,
  rolePlayMarks,
  trustChecks,
  verdictOf,
} from './r1-review';
import type { PlacedTurn } from './r1-review';
import type {
  R1RecordingSummary,
  R1ReviewAssessment,
  R1ReviewAttempt,
  R1ReviewResponse,
  R1ReviewTurn,
  R1TurnPhase,
} from './r1-types';

const START = 1_800_000_000_000;
const NOW = Date.parse('2026-11-02T12:00:00Z');
const AN_HOUR_AGO = '2026-11-02T11:00:00Z';

const recording = (over: Partial<R1RecordingSummary> = {}): R1RecordingSummary => ({
  state: 'ready', reason: null, mode: 'single', has_video: true, started_at_ms: START, duration_ms: 600_000,
  camera_off_ms: 0, degraded_at_ms: null, retention_until: '2027-02-01T00:00:00Z', deleted_at: null, ...over,
});

const turn = (index: number, sec: number | null, speaker: 'bot' | 'candidate', phase: R1TurnPhase | null, text = `Turn ${index}`): R1ReviewTurn => ({
  turn_index: index, speaker, text, turn_started_at_ms: sec === null ? null : START + sec * 1000, is_gate: false, phase, interrupted: false,
});

const attempt = (over: Partial<R1ReviewAttempt> = {}): R1ReviewAttempt => ({
  session_id: 's1', attempt_number: 1, counted: true, outcome: 'complete', recording: recording(), persona_id: 'p1_career_switcher',
  persona_label: 'Career switcher', learner_name: 'Priya Nair', session_status: 'completed', started_at: null, ended_at: null,
  consent_withdrawn: false, transcript_hidden: false, in_progress: false, turns: [], ...over,
});

const assessment = (over: Partial<R1ReviewAssessment> = {}): R1ReviewAssessment => ({
  id: 'a1', session_id: 's1', recommendation: 'hold', raw_recommendation: 'hold', overall_score: 58, scoring_status: 'complete',
  score_scale_max: 4, created_at: null,
  metric_results: [
    { metric_id: 'm1', name: 'Probing & discovery', weight_bps: 2500, score: 3, evidence_status: 'scored', rationale: 'Good.', evidence: [{ turn_index: 3, quote: 'late quote' }, { turn_index: 1, quote: 'early quote' }] },
    { metric_id: 'm2', name: 'Objection handling', weight_bps: 2500, score: 2, evidence_status: 'scored', rationale: 'Fair.', evidence: [{ turn_index: 1, quote: 'another quote' }] },
  ],
  r1: { outcome: 'scored', valid: true, code: null, gate: { passed: true, failures: [] }, administration_quality: { status: 'ok', failures: [] }, agreement: { runs_agree: true, disagreement: 0 }, thresholds: { advance: 65, hold: 45 } },
  ...over,
});

const review = (over: Partial<R1ReviewResponse> = {}): R1ReviewResponse => ({
  round: {
    id: 'r1', candidate_id: 'c1', status: 'completed', expires_at: '2026-11-06T00:00:00Z', attempts_allowed: 2, attempts_counted: 1,
    recommendation: 'hold', overall: 58, status_write: null, pending_reject_until: null, scores_withheld: false, is_staff_dry_run: false,
    created_at: '2026-11-01T00:00:00Z', created_by: 'u1',
  },
  candidate: { id: 'c1', name: 'Ava Example', role_title: 'Sales Program Advisor', skills: [], experience_years: null, resume: null },
  attempts: [attempt()], assessment: assessment(), events: [], phone_screening: null, rubric: [], ...over,
});

const placed = (sec: number, phase: R1TurnPhase | null, index = 0): PlacedTurn =>
  placeTurns(attempt({ turns: [turn(index, sec, 'bot', phase)] }), 'Ava Example', null)[0];

describe('reading the address', () => {
  it('opens Overview for no tab, an unknown tab, or a feedback tab that does not exist yet', () => {
    expect(reviewTabFrom(null)).toBe('overview');
    expect(reviewTabFrom('feedback')).toBe('overview');
    expect(reviewTabFrom('recording')).toBe('recording');
  });

  it('reads a position, and refuses anything that is not one', () => {
    expect(cueSecFrom('312.7')).toBe(312.7);
    expect(cueSecFrom('0')).toBe(0);
    for (const bad of [null, '', 'abc', '-3', 'Infinity', 'NaN']) expect(cueSecFrom(bad)).toBeNull();
  });

  it('opens the attempt named in the address, else the scored one, else the latest', () => {
    const attempts = [attempt({ session_id: 's1', attempt_number: 1 }), attempt({ session_id: 's2', attempt_number: 2 })];
    expect(reviewAttemptFrom('1', attempts, assessment({ session_id: 's2 ' }))?.session_id).toBe('s1');
    expect(reviewAttemptFrom(null, attempts, assessment({ session_id: 's1' }))?.session_id).toBe('s1');
    expect(reviewAttemptFrom(null, attempts, null)?.session_id).toBe('s2');
    expect(reviewAttemptFrom('9', attempts, null)?.session_id).toBe('s2');
    expect(reviewAttemptFrom(null, [], null)).toBeNull();
  });
});

describe('who is speaking', () => {
  it('names the two AI voices, and says neither is a person', () => {
    expect(R1_INTERVIEWER_LABEL).toBe('Christy (AI interviewer)');
    expect(learnerLabel('Priya Nair')).toBe('Priya Nair (AI learner)');
    expect(learnerLabel(null)).toBe('AI learner');
  });

  it('labels a bot turn by its phase, and the candidate by name', () => {
    const turns = placeTurns(
      attempt({ turns: [turn(0, 1, 'bot', 'opening'), turn(1, 2, 'bot', 'roleplay'), turn(2, 3, 'candidate', 'roleplay'), turn(3, 4, 'bot', 'aside'), turn(4, 5, 'bot', null)] }),
      'Ava Example',
      null,
    );
    expect(turns.map((t) => t.speakerLabel)).toEqual([
      'Christy (AI interviewer)', 'Priya Nair (AI learner)', 'Ava Example', 'Christy (AI interviewer)', 'Christy (AI interviewer)',
    ]);
    expect(turns.map((t) => t.speakerKind)).toEqual(['interviewer', 'learner', 'candidate', 'interviewer', 'interviewer']);
  });

  it('takes the stored voice over the phase: a learner line in an aside is the learner', () => {
    const turns = placeTurns(
      attempt({ turns: [{ ...turn(0, 1, 'bot', 'aside'), ai_voice: 'learner' }, { ...turn(1, 2, 'bot', 'roleplay'), ai_voice: 'interviewer' }] }),
      'Ava Example',
      null,
    );
    expect(turns.map((t) => t.speakerLabel)).toEqual(['Priya Nair (AI learner)', 'Christy (AI interviewer)']);
  });

  it('falls back to "AI learner" when the log does not name her', () => {
    const [row] = placeTurns(attempt({ learner_name: null, turns: [turn(0, 1, 'bot', 'roleplay')] }), 'Ava Example', null);
    expect(row.speakerLabel).toBe('AI learner');
  });
});

describe('placing turns on the recording', () => {
  it('gives each turn its position from the attempt anchor', () => {
    const [row] = placeTurns(attempt({ turns: [turn(0, 12.5, 'bot', 'opening')] }), 'Ava Example', null);
    expect(row.startSec).toBe(12.5);
    expect(row.callSec).toBe(0);
    expect(row.row).toBe(0);
  });

  it('leaves a turn without a time untimed, rather than giving it a wrong one', () => {
    const rows = placeTurns(attempt({ turns: [turn(0, 1, 'bot', 'opening'), turn(1, null, 'candidate', 'opening')] }), 'Ava Example', null);
    expect(rows[1].startSec).toBeNull();
    expect(rows[1].callSec).toBeNull();
  });

  it('has no position with no recording, but keeps the time into the call for the label', () => {
    const rows = placeTurns(
      attempt({ recording: recording({ state: 'none', started_at_ms: null }), turns: [turn(0, 10, 'bot', 'opening'), turn(1, 75, 'candidate', 'opening')] }),
      'Ava Example',
      null,
    );
    expect(rows.map((t) => t.startSec)).toEqual([null, null]);
    expect(rows.map((t) => t.callSec)).toEqual([0, 65]);
  });

  it('places a stored end time, so a talk bar can only come from one', () => {
    const [withEnd, withoutEnd] = placeTurns(
      attempt({ turns: [{ ...turn(0, 10, 'bot', 'opening'), turn_ended_at_ms: START + 14_000 }, turn(1, 20, 'bot', 'opening')] }),
      'Ava Example',
      null,
    );
    expect(withEnd.endSec).toBe(14);
    expect(withoutEnd.endSec).toBeNull();
  });

  it('takes no end from a cut AI line: it can run late by the silence in that line', () => {
    const cut = { ...turn(0, 10, 'bot', 'roleplay'), turn_ended_at_ms: START + 30_000, interrupted: true };
    const [row] = placeTurns(attempt({ turns: [cut] }), 'Ava Example', null);
    expect(row.endSec).toBeNull();
  });

  it('keeps the end of a candidate turn marked interrupted: it is a voice-activity end', () => {
    const talking = { ...turn(0, 10, 'candidate', 'roleplay'), turn_ended_at_ms: START + 14_000, interrupted: true };
    const [row] = placeTurns(attempt({ turns: [talking] }), 'Ava Example', null);
    expect(row.endSec).toBe(14);
  });

  it('never works an end out from what played', () => {
    const played = { ...turn(0, 10, 'bot', 'roleplay'), ai_played_ms: 4000 };
    const [row] = placeTurns(attempt({ turns: [played] }), 'Ava Example', null);
    expect(row.endSec).toBeNull();
  });

  it('marks only the turns of the attempt that was scored as cited', () => {
    const turns = [turn(1, 5, 'candidate', 'roleplay'), turn(3, 9, 'candidate', 'roleplay')];
    const scored = placeTurns(attempt({ turns }), 'Ava Example', assessment());
    expect(scored[0].citations.map((c) => c.metric)).toEqual(['Probing & discovery', 'Objection handling']);
    expect(scored[1].citations).toEqual([expect.objectContaining({ metric: 'Probing & discovery', quote: 'late quote' })]);
    const other = placeTurns(attempt({ session_id: 's2', turns }), 'Ava Example', assessment());
    expect(other[0].citations).toEqual([]);
  });
});

describe('the length of a call', () => {
  it('is the recording, and stretches to a later turn rather than clip it', () => {
    expect(reviewDurationSec(attempt(), [placed(10, 'opening')])).toBe(600);
    expect(reviewDurationSec(attempt(), [placed(650, 'opening')])).toBe(650);
  });

  it('is nothing to draw when neither a length nor a timed turn exists', () => {
    expect(reviewDurationSec(attempt({ recording: recording({ duration_ms: null }) }), [])).toBe(0);
  });
});

describe('the phase ribbon', () => {
  it('merges neighbouring turns, in time order, and runs to the end of the call', () => {
    const turns = [placed(0, 'opening'), placed(20, 'opening', 1), placed(40, 'roleplay', 2), placed(90, 'closing', 3)];
    expect(phaseSegments(turns, 120)).toEqual([
      { phase: 'opening', label: 'Opening', startSec: 0, endSec: 40 },
      { phase: 'roleplay', label: 'Role-play', startSec: 40, endSec: 90 },
      { phase: 'closing', label: 'Closing', startSec: 90, endSec: 120 },
    ]);
  });

  it('follows the times, not the turn order, and a turn with no phase stays in the last one', () => {
    const turns = [placed(50, 'closing', 1), placed(0, 'opening', 0), placed(10, null, 2)];
    expect(phaseSegments(turns, 60).map((s) => [s.phase, s.startSec, s.endSec])).toEqual([['opening', 0, 50], ['closing', 50, 60]]);
  });

  it('draws nothing for a call with no timed turn', () => {
    expect(phaseSegments([], 100)).toEqual([]);
  });
});

describe('the role-play clock', () => {
  it('places 14:00 and 20:00 from the start of the role-play, not of the call', () => {
    const segments = [
      { phase: 'opening' as const, label: 'Opening', startSec: 0, endSec: 300 },
      { phase: 'roleplay' as const, label: 'Role-play', startSec: 300, endSec: 1500 },
      { phase: 'closing' as const, label: 'Closing', startSec: 1500, endSec: 1600 },
    ];
    expect(rolePlayMarks(segments)).toEqual([
      { sec: 1140, label: '14:00', detail: 'Earliest offer to wrap up' },
      { sec: 1500, label: '20:00', detail: 'End of the role-play' },
    ]);
  });

  it('stops the clock through an aside', () => {
    const segments = [
      { phase: 'roleplay' as const, label: 'Role-play', startSec: 100, endSec: 700 },
      { phase: 'aside' as const, label: 'Aside', startSec: 700, endSec: 760 },
      { phase: 'roleplay' as const, label: 'Role-play', startSec: 760, endSec: 1600 },
    ];
    expect(rolePlayMarks(segments)[0].sec).toBe(1000);
  });

  it('draws no marker a role-play never reached', () => {
    expect(rolePlayMarks([{ phase: 'roleplay', label: 'Role-play', startSec: 0, endSec: 600 }])).toEqual([]);
  });
});

describe('evidence', () => {
  const turns = () => placeTurns(attempt({ turns: [turn(1, 5, 'candidate', 'roleplay'), turn(3, 9, 'candidate', 'roleplay')] }), 'Ava Example', null);

  it('numbers quotes in call order, however the metrics list them', () => {
    const marks = evidenceMarks(assessment(), turns());
    expect(marks.map((m) => [m.number, m.turnIndex, m.quote])).toEqual([[1, 1, 'early quote'], [2, 1, 'another quote'], [3, 3, 'late quote']]);
    expect(marks[2]).toMatchObject({ metric: 'Probing & discovery', row: 1, startSec: 9 });
  });

  it('keeps a quote whose turn is missing, unplaced, rather than dropping the evidence', () => {
    const marks = evidenceMarks(assessment({ metric_results: [{ metric_id: 'm', name: 'M', weight_bps: 1, score: 1, evidence_status: 'scored', rationale: null, evidence: [{ turn_index: 99, quote: 'q' }] }] }), turns());
    expect(marks[0]).toMatchObject({ row: null, startSec: null });
  });

  it('has none without an assessment', () => {
    expect(evidenceMarks(null, turns())).toEqual([]);
  });
});

describe('highlighting a cited quote', () => {
  it('finds it whatever the case, and ignores a trailing ellipsis', () => {
    expect(highlightRanges('I would ask about their budget first.', ['ASK ABOUT their budget…'])).toEqual([[8, 30]]);
  });

  it('finds several, in order, and merges an overlap', () => {
    expect(highlightRanges('one two three four', ['three', 'one', 'two three'])).toEqual([[0, 3], [4, 13]]);
  });

  it('draws nothing for a quote the words do not contain: the row still says it was cited', () => {
    expect(highlightRanges('one two', ['three'])).toEqual([]);
    expect(highlightRanges('one two', [''])).toEqual([]);
  });
});

describe('the log on the strip', () => {
  const turns = () => placeTurns(attempt({ turns: [turn(4, 30, 'candidate', 'roleplay')] }), 'Ava Example', null);
  const event = (over: object) => ({ session_id: 's1', event_type: 'guard_hit', turn_index: 4, family_id: null, need: null, kind: null, created_at: null, ...over });

  it('puts an event at its turn, in plain words', () => {
    expect(eventMarks([event({ event_type: 'need_revealed', need: 'H2' })], 's1', turns())).toEqual([
      { key: 'need_revealed-0', label: 'Need 2 revealed', turnIndex: 4, row: 0, startSec: 30 },
    ]);
  });

  it('leaves out another attempt, an event with no turn, and anything it has no words for', () => {
    const events = [
      event({ session_id: 's2' }),
      event({ turn_index: null }),
      event({ event_type: 'time_cue' }),
      event({ event_type: 'session_facts' }),
      event({ event_type: 'something_new' }),
    ];
    expect(eventMarks(events, 's1', turns())).toEqual([]);
  });
});

describe('the needs a learner held back', () => {
  it('lists each need, revealed or not, at its turn', () => {
    const turns = placeTurns(attempt({ turns: [turn(4, 30, 'candidate', 'roleplay')] }), 'Ava Example', null);
    const events = [{ session_id: 's1', event_type: 'need_revealed', turn_index: 4, family_id: null, need: 'H2', kind: null, created_at: null }];
    expect(neededReveals(events, 's1', turns)).toEqual([
      { need: 'H1', label: 'Need 1', revealed: false, turnIndex: null, row: null, startSec: null },
      { need: 'H2', label: 'Need 2', revealed: true, turnIndex: 4, row: 0, startSec: 30 },
      { need: 'H3', label: 'Need 3', revealed: false, turnIndex: null, row: null, startSec: null },
    ]);
  });

  it('counts a reveal the worker could not map to a turn: the event is the fact', () => {
    const events = [{ session_id: 's1', event_type: 'need_revealed', turn_index: null, family_id: null, need: 'H1', kind: null, created_at: null }];
    expect(neededReveals(events, 's1', [])[0]).toEqual({ need: 'H1', label: 'Need 1', revealed: true, turnIndex: null, row: null, startSec: null });
  });
});

describe('where the round stands', () => {
  it('is withheld first: an appeal outranks everything', () => {
    expect(reviewStage(review({ round: { ...review().round, scores_withheld: true }, assessment: null }), NOW)).toBe('withheld');
  });

  it('is scored with a usable result, and not scored without one', () => {
    expect(reviewStage(review(), NOW)).toBe('scored');
    expect(reviewStage(review({ assessment: assessment({ raw_recommendation: 'human_review', recommendation: null }) }), NOW)).toBe('not_scored');
  });

  it('is not scored when the round carries no recommendation, whatever the assessment says', () => {
    expect(reviewStage(review({ round: { ...review().round, recommendation: null } }), NOW)).toBe('not_scored');
  });

  it('is scoring once an attempt finished and nothing is attached yet', () => {
    const attempts = [attempt({ ended_at: AN_HOUR_AGO })];
    expect(reviewStage(review({ assessment: null, attempts }), NOW)).toBe('scoring');
    expect(reviewStage(review({ assessment: null, attempts, round: { ...review().round, status: 'in_progress' } }), NOW)).toBe('scoring');
  });

  it('is scoring for a counted attempt that ended failed: that one is queued too (0126)', () => {
    const attempts = [attempt({ session_status: 'failed', outcome: 'candidate_left', ended_at: AN_HOUR_AGO })];
    expect(reviewStage(review({ assessment: null, attempts }), NOW)).toBe('scoring');
  });

  it('never promises a score that cannot come: a withdrawal stops the scoring', () => {
    const left = attempt({ session_status: 'failed', outcome: 'candidate_left', ended_at: AN_HOUR_AGO, consent_withdrawn: true, transcript_hidden: true });
    expect(reviewStage(review({ assessment: null, attempts: [left] }), NOW)).toBe('closed');
    expect(reviewStage(review({ assessment: null, attempts: [{ ...left, session_status: 'completed' }] }), NOW)).toBe('closed');
  });

  it('has no job for an attempt that failed uncounted, so nothing is on its way', () => {
    const attempts = [attempt({ session_status: 'failed', counted: false, ended_at: AN_HOUR_AGO })];
    expect(reviewStage(review({ assessment: null, attempts }), NOW)).toBe('closed');
  });

  it('stops waiting after a day: a row from before 0126 has no job at all', () => {
    const ended = (msAgo: number) => [attempt({ session_status: 'failed', ended_at: new Date(NOW - msAgo).toISOString() })];
    expect(reviewStage(review({ assessment: null, attempts: ended(R1_SCORE_WAIT_MS - 1) }), NOW)).toBe('scoring');
    expect(reviewStage(review({ assessment: null, attempts: ended(R1_SCORE_WAIT_MS) }), NOW)).toBe('closed');
  });

  it('measures from the session start, then the round, when the end was not stored', () => {
    const old = { ...review().round, created_at: new Date(NOW - 2 * R1_SCORE_WAIT_MS).toISOString() };
    expect(reviewStage(review({ assessment: null, attempts: [attempt({ started_at: AN_HOUR_AGO })], round: old }), NOW)).toBe('scoring');
    expect(reviewStage(review({ assessment: null, attempts: [attempt()], round: old }), NOW)).toBe('closed');
  });

  it('is invited or in progress before that', () => {
    expect(reviewStage(review({ assessment: null, attempts: [], round: { ...review().round, status: 'invited' } }), NOW)).toBe('invited');
    expect(reviewStage(review({ assessment: null, attempts: [attempt({ session_status: 'in_progress' })], round: { ...review().round, status: 'in_progress' } }), NOW)).toBe('in_progress');
  });

  it('has ended unscored when the round closed with nothing to score', () => {
    expect(reviewStage(review({ assessment: null, attempts: [], round: { ...review().round, status: 'expired' } }), NOW)).toBe('closed');
    expect(reviewStage(review({ assessment: null, attempts: [attempt({ session_status: 'failed', counted: false })], round: { ...review().round, status: 'cancelled' } }), NOW)).toBe('closed');
    expect(reviewStage(review({ assessment: null, attempts: [] }), NOW)).toBe('closed');
  });
});

describe('why a round was not scored', () => {
  it('says so in plain words for each outcome', () => {
    const of = (r1: Partial<R1ReviewAssessment['r1']>) => notScoredSentence(assessment({ raw_recommendation: 'human_review', r1: { ...assessment().r1, ...r1 } }));
    expect(of({ outcome: 'no_candidate_speech' })).toBe('Not scored: the candidate said too little in the scored phases.');
    expect(of({ outcome: 'scored', valid: false })).toBe('Not scored: the interview did not pass its checks.');
    expect(of({ outcome: 'scoring_failed', code: 'deepseek_auth' })).toBe('Not scored: scoring could not be completed.');
  });
});

describe('the verdict', () => {
  it('uses the words Select, Borderline and Reject, each with its mark', () => {
    const of = (recommendation: 'advance' | 'hold' | 'reject') => verdictOf({ ...review().round, recommendation });
    expect(of('advance')).toEqual({ word: 'Select', mark: 'full', overall: 58 });
    expect(of('hold')).toEqual({ word: 'Borderline', mark: 'half', overall: 58 });
    expect(of('reject')).toEqual({ word: 'Reject', mark: 'empty', overall: 58 });
  });

  it('is nothing without a recommendation', () => {
    expect(verdictOf({ ...review().round, recommendation: null })).toBeNull();
  });
});

describe('the phone screening line', () => {
  const phone = (over: Partial<NonNullable<R1ReviewResponse['phone_screening']>> = {}) => ({
    recommendation: 'reject', overall_score: 30, created_at: null, evidence_grade: 'decision', scoring_status: 'complete', ...over,
  });

  it('gives the verdict and the figure of a firm result', () => {
    expect(phoneResultWords(phone())).toBe('Reject 30');
  });

  it('gives neither for a held score, which is no result', () => {
    expect(phoneResultWords(phone({ evidence_grade: 'insufficient' }))).toBe('Held: not enough evidence');
  });

  it('says a provisional score is one', () => {
    expect(phoneResultWords(phone({ scoring_status: 'incomplete_evidence' }))).toBe('Reject 30, provisional');
  });

  it('says nothing when there is nothing to say', () => {
    expect(phoneResultWords(phone({ recommendation: null, overall_score: null }))).toBeNull();
  });
});

describe('check before trusting it', () => {
  it('is empty when every check passed', () => {
    expect(trustChecks(assessment(), attempt())).toEqual([]);
  });

  it('names gate failures in plain words, once each, and never prints a code', () => {
    const checks = trustChecks(
      assessment({ r1: { ...assessment().r1, gate: { passed: false, failures: ['roleplay_too_short', 'family_missing:f2', 'brand_new_code'] }, administration_quality: { status: 'review', failures: ['roleplay_too_short'] } } }),
      attempt(),
    );
    expect(checks.map((c) => c.text)).toEqual([
      'The role-play was too short to score reliably.',
      'The learner did not raise every planned objection.',
      'Another check did not pass.',
    ]);
    expect(JSON.stringify(checks)).not.toMatch(/_|f2/);
  });

  it('says when the two scoring runs disagreed, once, however it is reported', () => {
    const checks = trustChecks(assessment({ r1: { ...assessment().r1, agreement: { runs_agree: false, disagreement: 1 }, gate: { passed: false, failures: ['runs_disagree'] } } }), attempt());
    expect(checks.map((c) => c.text)).toEqual(['The two scoring runs disagreed.']);
  });

  it('warns of a partial or audio-only recording, in the recording\'s own words', () => {
    expect(trustChecks(assessment(), attempt({ recording: recording({ state: 'partial', reason: 'crash_recovered' }) })).map((c) => c.text))
      .toEqual(['Recovered after an interruption; it may end early.']);
    expect(trustChecks(assessment(), attempt({ recording: recording({ has_video: false, reason: 'video_unavailable' }) })).map((c) => c.text))
      .toEqual(['The camera was not available, so this is an audio-only recording.']);
  });

  it('warns of an audio-only recording that gives no reason', () => {
    expect(trustChecks(assessment(), attempt({ recording: recording({ has_video: false }) })).map((c) => c.text)).toEqual(['This is an audio-only recording.']);
  });

  it('still warns about the recording before there is an assessment', () => {
    expect(trustChecks(null, attempt({ recording: recording({ has_video: false }) }))).toHaveLength(1);
  });
});

describe('the band on the strip', () => {
  it('covers a whole audio-only recording', () => {
    expect(recordingBands(recording({ has_video: false }), 600)).toEqual([{ startSec: 0, endSec: 600, label: 'Audio only' }]);
  });

  it('starts where the video stopped', () => {
    expect(recordingBands(recording({ degraded_at_ms: 120_000 }), 600)).toEqual([{ startSec: 120, endSec: 600, label: 'Audio only' }]);
  });

  it('covers a partial recording it cannot place, and says so', () => {
    expect(recordingBands(recording({ state: 'partial' }), 600)).toEqual([{ startSec: 0, endSec: 600, label: 'Partial recording' }]);
  });

  it('has none for a full recording', () => {
    expect(recordingBands(recording(), 600)).toEqual([]);
  });
});

describe('a position that lands on a row', () => {
  it('finds the row at that moment', () => {
    const turns = placeTurns(attempt({ turns: [turn(0, 10, 'bot', 'opening'), turn(1, 20, 'candidate', 'opening')] }), 'Ava Example', null);
    expect(cuedRow(turns, 20)).toBe(1);
    expect(cuedRow(turns, 15)).toBe(0);
    expect(cuedRow(turns, 5)).toBeNull();
  });
});
