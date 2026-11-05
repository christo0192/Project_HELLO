import { describe, expect, it } from 'vitest';
import { queuePageFrom, queueSortFrom, queueSummary, queueViewFrom, r1ResultWords } from './r1-queue';
import type { R1QueueRound } from './r1-types';

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
    expect(r1ResultWords(row())).toEqual({ kind: 'verdict', verdict: { word: 'Borderline', mark: 'half', overall: 58 } });
  });

  it('says it is withheld before anything else, and never a score', () => {
    expect(r1ResultWords(row({ scores_withheld: true }))).toEqual({ kind: 'text', text: 'Scorecards are suppressed while an appeal is under review.' });
  });

  it('says a round the scorer would not score was not scored', () => {
    expect(r1ResultWords(row({ recommendation: null, overall: null, status_write: 'human_review' }))).toEqual({ kind: 'text', text: 'Not scored' });
  });

  it('says scoring has not finished on a finished round with no result yet', () => {
    expect(r1ResultWords(row({ recommendation: null, overall: null, status_write: null }))).toEqual({ kind: 'text', text: 'Not scored yet' });
  });

  it.each(['invited', 'in_progress', 'cancelled', 'expired'] as const)('has nothing to say for a %s round with no result', (status) => {
    expect(r1ResultWords(row({ status, recommendation: null, overall: null, status_write: null }))).toEqual({ kind: 'text', text: 'No result' });
  });
});
