import { describe, expect, it } from 'vitest';
import { queueFigureTone, queuePageFrom, queueRecording, queueSortFrom, queueSummary, queueViewFrom, r1ResultWords } from './r1-queue';
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

  // Attach and apply are separate writes, so a figure can be on the row before its status write.
  it.each(['completed', 'cancelled', 'expired'] as const)('says a figure with no verdict on a %s round was not scored, as the R1 tab and the review do', (status) => {
    const attached = row({ status, recommendation: null, overall: 42, status_write: null, attempts: [attempt()] });
    expect(r1ResultWords(attached, NOW)).toEqual({ kind: 'text', text: 'Not scored' });
  });

  describe('a round that stopped, or re-opened, before its score came', () => {
    const early = (status: 'cancelled' | 'expired' | 'invited' | 'in_progress', ended: number) =>
      row({ status, recommendation: null, overall: null, status_write: null, attempts: [attempt({ ended_at: ago(ended) })] });

    it.each(['cancelled', 'expired', 'invited', 'in_progress'] as const)('waits on a %s round while a score can arrive, as the review does', (status) => {
      expect(r1ResultWords(early(status, 60_000), NOW)).toEqual({ kind: 'text', text: 'Not scored yet' });
    });

    it.each(['cancelled', 'expired', 'invited', 'in_progress'] as const)('has nothing to say on a %s round once the wait is over', (status) => {
      expect(r1ResultWords(early(status, R1_SCORE_WAIT_MS), NOW)).toEqual({ kind: 'text', text: 'No result' });
    });
  });
});

describe('queueRecording', () => {
  const states = (...list: R1RecordingState[]) => ({
    attempts: list.map((state, index) => attempt({ session_id: `s${index}`, recording: { state } })),
  });
  const words = (...list: R1RecordingState[]) => queueRecording(states(...list))?.tag;

  it('has nothing to say before an attempt', () => {
    expect(queueRecording({ attempts: [] })).toBeNull();
  });

  it('does not let a retake that left nothing hide the recording that exists', () => {
    expect(words('ready', 'none')).toBe('Ready');
  });

  it('names a recording to watch over a later one that cannot be', () => {
    expect(words('ready', 'failed')).toBe('Ready');
    expect(words('partial', 'deleted')).toBe('Partial');
  });

  it('takes the latest of two to watch', () => {
    expect(words('ready', 'partial')).toBe('Partial');
  });

  it('says what became of a recording when none can be watched', () => {
    expect(words('failed', 'none')).toBe('Unavailable');
  });

  it('says there is none when no attempt left one', () => {
    expect(words('none', 'none')).toBe('No recording');
  });

  it('takes its family from the attempt it names, not the latest', () => {
    expect(queueRecording(states('ready', 'failed'))).toMatchObject({ tag: 'Ready', tone: 'ready' });
    expect(queueRecording(states('partial', 'deleted'))).toMatchObject({ tag: 'Partial', tone: 'unresolved' });
    expect(queueRecording(states('none', 'none'))).toMatchObject({ tag: 'No recording', tone: 'neutral' });
  });
});

describe('queueFigureTone', () => {
  it('colours a figure that counts a state, and leaves the plain total in ink', () => {
    expect(queueFigureTone('to-review')).toBe('success');
    expect(queueFigureTone('in-progress')).toBe('info');
    expect(queueFigureTone('reviewed')).toBe('closed');
    expect(queueFigureTone('all')).toBeUndefined();
  });
});
