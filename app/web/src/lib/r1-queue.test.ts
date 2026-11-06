import { describe, expect, it } from 'vitest';
import { queuePageFrom, queueRecordingWords, queueSortFrom, queueSummary, queueViewFrom, r1ResultWords } from './r1-queue';
import { R1_SCORE_WAIT_MS } from './r1-review';
import type { R1ListedAttempt, R1QueueRound, R1RecordingState } from './r1-types';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function attempt(over: Partial<R1ListedAttempt> = {}): R1ListedAttempt {
  return {
    session_id: 's1', attempt_number: 1, counted: true, outcome: 'complete', in_progress: false, session_status: 'completed', started_at: null,
    ended_at: ago(60_000), consent_withdrawn: false, recording: { state: 'ready' }, ...over,
  };
}

function row(over: Partial<R1QueueRound> = {}): R1QueueRound {
  return {
    id: 'round-1', candidate_id: 'c1', candidate_name: 'Ava Example', status: 'completed', expires_at: null, attempts_allowed: 2, attempts_counted: 1,
    recommendation: 'hold', overall: 58, status_write: 'hold_flag', pending_reject_until: null, scores_withheld: false, is_staff_dry_run: false,
    created_at: '2026-11-01T00:00:00Z', attempts: [], ...over,
  };
}

describe('the address', () => {
  it('opens on To review, and an unknown view is not an error', () => {
    expect(queueViewFrom(null)).toBe('to-review');
    expect(queueViewFrom('nonsense')).toBe('to-review');
    expect(queueViewFrom('reviewed')).toBe('reviewed');
  });

  it('sorts To review oldest first and the rest newest first, unless the address says', () => {
    expect(queueSortFrom(null, 'to-review')).toBe('oldest');
    expect(queueSortFrom(null, 'all')).toBe('newest');
    expect(queueSortFrom('newest', 'to-review')).toBe('newest');
    expect(queueSortFrom('score', 'to-review')).toBe('oldest');
  });

  it.each([[null, 1], ['2', 2], ['0', 1], ['-3', 1], ['1.5', 1], ['x', 1]])('reads page %s as %s', (param, page) => {
    expect(queuePageFrom(param)).toBe(page);
  });
});

describe('queueSummary', () => {
  it('says how many and in what order, in the singular too', () => {
    expect(queueSummary('to-review', 'oldest', 12)).toBe('interviews to review, oldest first');
    expect(queueSummary('to-review', 'oldest', 1)).toBe('interview to review');
    expect(queueSummary('in-progress', 'newest', 3)).toBe('interviews in progress, newest first');
    expect(queueSummary('reviewed', 'newest', 2)).toBe('interviews with a settled outcome, newest first');
    expect(queueSummary('all', 'oldest', 2)).toBe('interviews, oldest first');
  });
});

describe('r1ResultWords', () => {
  it('gives a verdict for a scored round', () => {
    expect(r1ResultWords(row(), NOW)).toEqual({ kind: 'verdict', verdict: { word: 'Borderline', mark: 'half', overall: 58 } });
  });

  it('says it is withheld before anything else, and never a score', () => {
    expect(r1ResultWords(row({ scores_withheld: true }), NOW)).toEqual({ kind: 'text', text: 'Scorecards are suppressed while an appeal is under review.' });
  });

  it('says a round the scorer would not score was not scored', () => {
    expect(r1ResultWords(row({ recommendation: null, overall: null, status_write: 'human_review' }), NOW)).toEqual({ kind: 'text', text: 'Not scored' });
  });

  it('prints no figure the checks refused', () => {
    expect(r1ResultWords(row({ recommendation: null, overall: 42, status_write: 'human_review' }), NOW)).toEqual({ kind: 'text', text: 'Not scored' });
  });

  describe('a finished round with no result', () => {
    const unscored = (attempts: R1ListedAttempt[]) => row({ recommendation: null, overall: null, status_write: null, attempts });

    it('is waiting for its score while one can still arrive', () => {
      expect(r1ResultWords(unscored([attempt()]), NOW)).toEqual({ kind: 'text', text: 'Not scored yet' });
      expect(r1ResultWords(unscored([attempt({ ended_at: ago(R1_SCORE_WAIT_MS - 1) })]), NOW)).toEqual({ kind: 'text', text: 'Not scored yet' });
    });

    it('stops waiting when the review page does', () => {
      expect(r1ResultWords(unscored([attempt({ ended_at: ago(R1_SCORE_WAIT_MS) })]), NOW)).toEqual({ kind: 'text', text: 'Not scored' });
    });

    it('never promises a score once consent is withdrawn, which stops the scoring', () => {
      expect(r1ResultWords(unscored([attempt({ consent_withdrawn: true })]), NOW)).toEqual({ kind: 'text', text: 'Not scored' });
    });

    it('has no job for an attempt that failed uncounted', () => {
      expect(r1ResultWords(unscored([attempt({ session_status: 'failed', counted: false })]), NOW)).toEqual({ kind: 'text', text: 'Not scored' });
    });

    it('is not waiting on nothing', () => {
      expect(r1ResultWords(unscored([]), NOW)).toEqual({ kind: 'text', text: 'Not scored' });
    });
  });

  it.each(['invited', 'in_progress', 'cancelled', 'expired'] as const)('has nothing to say for a %s round with no result', (status) => {
    expect(r1ResultWords(row({ status, recommendation: null, overall: null, status_write: null }), NOW)).toEqual({ kind: 'text', text: 'No result' });
  });
});

describe('queueRecordingWords', () => {
  const states = (...list: R1RecordingState[]) => ({
    attempts: list.map((state, index) => attempt({ session_id: `s${index}`, recording: { state } })),
  });

  it('has nothing to say before an attempt', () => {
    expect(queueRecordingWords({ attempts: [] })).toBeNull();
  });

  it('does not let a retake that left nothing hide the recording that exists', () => {
    expect(queueRecordingWords(states('ready', 'none'))).toBe('Ready');
  });

  it('names a recording to watch over a later one that cannot be', () => {
    expect(queueRecordingWords(states('ready', 'failed'))).toBe('Ready');
    expect(queueRecordingWords(states('partial', 'deleted'))).toBe('Partial');
  });

  it('takes the latest of two to watch', () => {
    expect(queueRecordingWords(states('ready', 'partial'))).toBe('Partial');
  });

  it('says what became of a recording when none can be watched', () => {
    expect(queueRecordingWords(states('failed', 'none'))).toBe('Unavailable');
  });

  it('says there is none when no attempt left one', () => {
    expect(queueRecordingWords(states('none', 'none'))).toBe('No recording');
  });
});
