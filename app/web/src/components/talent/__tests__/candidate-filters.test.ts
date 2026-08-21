import { describe, it, expect } from 'vitest';
import type { Candidate } from '../../../types';
import {
  parseCandidateFilters,
  buildCandidateSearch,
  candidatesHref,
  matchesCandidateStatus,
  matchesCandidateFilters,
  hasActiveFilters,
  candidateFunnel,
  candidateNextAction,
  recommendationLabel,
  normalizeStatus,
  EMPTY_CANDIDATE_FILTERS,
} from '../candidateFilters';

function cand(partial: Partial<Candidate>): Candidate {
  return {
    id: 'c',
    name: 'Test',
    email: null,
    phone_e164: null,
    phone_valid: false,
    skills: [],
    experience_years: null,
    status: 'new',
    role_id: null,
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

const f = (partial: Partial<typeof EMPTY_CANDIDATE_FILTERS>) => ({
  ...EMPTY_CANDIDATE_FILTERS,
  ...partial,
});

describe('parseCandidateFilters', () => {
  it('parses status, recommendation, assessed and role, dropping unknowns', () => {
    const parsed = parseCandidateFilters(
      new URLSearchParams('status=new,screening,bogus&recommendation=advance,zzz&assessed=1&role=r1'),
    );
    expect(parsed).toEqual({
      statuses: ['new', 'screening'],
      recommendations: ['advance'],
      resumeReview: [],
      assessed: true,
      roleId: 'r1',
    });
  });

  it('returns empty filters for an empty query', () => {
    expect(parseCandidateFilters(new URLSearchParams(''))).toEqual(EMPTY_CANDIDATE_FILTERS);
  });

  it('canonicalizes status + recommendation order regardless of URL order', () => {
    const parsed = parseCandidateFilters(
      new URLSearchParams('status=screened,new&recommendation=reject,advance'),
    );
    expect(parsed.statuses).toEqual(['new', 'screened']);
    expect(parsed.recommendations).toEqual(['advance', 'reject']);
  });
});

describe('buildCandidateSearch / candidatesHref', () => {
  it('round-trips through parse in canonical order', () => {
    const href = candidatesHref({
      statuses: ['screening', 'new'],
      recommendations: ['reject', 'advance'],
      assessed: true,
      roleId: 'r9',
    });
    const back = parseCandidateFilters(new URLSearchParams(href.split('?')[1]));
    expect(back).toEqual({
      statuses: ['new', 'screening'],
      recommendations: ['advance', 'reject'],
      resumeReview: [],
      assessed: true,
      roleId: 'r9',
    });
  });

  it('produces a bare path with no filters', () => {
    expect(candidatesHref()).toBe('/candidates');
    expect(buildCandidateSearch(EMPTY_CANDIDATE_FILTERS).toString()).toBe('');
  });

  it('builds a single-recommendation drill-down href', () => {
    expect(candidatesHref({ recommendations: ['advance'] })).toBe(
      '/candidates?recommendation=advance',
    );
    expect(candidatesHref({ assessed: true })).toBe('/candidates?assessed=1');
  });
});

describe('matchesCandidateStatus / matchesCandidateFilters', () => {
  it('matches all when no filters', () => {
    expect(matchesCandidateFilters(cand({ status: 'advanced' }), EMPTY_CANDIDATE_FILTERS)).toBe(true);
    expect(matchesCandidateStatus(cand({ status: 'advanced' }), EMPTY_CANDIDATE_FILTERS)).toBe(true);
  });

  it('filters by status (missing = new)', () => {
    const filters = f({ statuses: ['new'] });
    expect(matchesCandidateFilters(cand({ status: undefined as never }), filters)).toBe(true);
    expect(matchesCandidateFilters(cand({ status: 'screening' }), filters)).toBe(false);
  });

  it('filters by recommendation using latest_recommendation', () => {
    const filters = f({ recommendations: ['advance'] });
    expect(matchesCandidateFilters(cand({ latest_recommendation: 'advance' }), filters)).toBe(true);
    expect(matchesCandidateFilters(cand({ latest_recommendation: 'reject' }), filters)).toBe(false);
    expect(matchesCandidateFilters(cand({ latest_recommendation: null }), filters)).toBe(false);
  });

  it('filters the assessed cohort by latest_score presence', () => {
    const filters = f({ assessed: true });
    expect(matchesCandidateFilters(cand({ latest_score: 72 }), filters)).toBe(true);
    expect(matchesCandidateFilters(cand({ latest_score: null }), filters)).toBe(false);
    expect(matchesCandidateFilters(cand({}), filters)).toBe(false);
  });
});

describe('hasActiveFilters / normalizeStatus / recommendationLabel', () => {
  it('detects active filters across every dimension', () => {
    expect(hasActiveFilters(EMPTY_CANDIDATE_FILTERS)).toBe(false);
    expect(hasActiveFilters(f({ statuses: ['new'] }))).toBe(true);
    expect(hasActiveFilters(f({ recommendations: ['hold'] }))).toBe(true);
    expect(hasActiveFilters(f({ assessed: true }))).toBe(true);
    expect(hasActiveFilters(f({ roleId: 'r' }))).toBe(true);
  });

  it('normalizes blank status to new and labels recommendations', () => {
    expect(normalizeStatus('   ')).toBe('new');
    expect(recommendationLabel('advance')).toBe('Advance');
    expect(recommendationLabel(null)).toBe('Unassessed');
  });
});

describe('candidateFunnel / candidateNextAction', () => {
  it('counts by status in canonical order', () => {
    const funnel = candidateFunnel([
      cand({ status: 'screened' }),
      cand({ status: 'new' }),
      cand({ status: 'new' }),
      cand({ status: 'advanced' }),
    ]);
    expect(funnel).toEqual([
      { status: 'new', label: 'New', value: 2 },
      { status: 'screened', label: 'Screened', value: 1 },
      { status: 'advanced', label: 'Advanced', value: 1 },
    ]);
  });

  it('maps statuses to an actionable next step', () => {
    expect(candidateNextAction('new')).toEqual({ label: 'Start screening', emphasis: true });
    expect(candidateNextAction('screened')).toEqual({ label: 'Review & decide', emphasis: true });
    expect(candidateNextAction('anything-else').label).toBe('Open profile');
  });
});

/**
 * The resume-review facet is ADDITIVE. These tests are the guard on that
 * claim: it round-trips through the URL, narrows the visible rows, combines
 * with every other dimension, and does not touch the status vocabulary, its
 * canonical order or its counts.
 */
describe('resume-review facet', () => {
  it('parses the resume param, dropping unknown and quiet values', () => {
    const parsed = parseCandidateFilters(
      new URLSearchParams('resume=needs_review,ready,bogus,processing'),
    );
    // `ready` is deliberately not a facet — it is the quiet majority.
    expect(parsed.resumeReview).toEqual(['processing', 'needs_review']);
  });

  it('round-trips in canonical order alongside every other dimension', () => {
    const href = candidatesHref({
      statuses: ['queued'],
      recommendations: ['advance'],
      resumeReview: ['cancelled', 'processing'],
      assessed: true,
      roleId: 'r9',
    });
    expect(href).toContain('resume=processing%2Ccancelled');
    const back = parseCandidateFilters(new URLSearchParams(href.split('?')[1]));
    expect(back).toEqual({
      statuses: ['queued'],
      recommendations: ['advance'],
      resumeReview: ['processing', 'cancelled'],
      assessed: true,
      roleId: 'r9',
    });
  });

  it('emits no resume param when unselected', () => {
    expect(buildCandidateSearch(f({ statuses: ['queued'] })).has('resume')).toBe(false);
  });

  it('narrows to the selected states and treats null as excluded', () => {
    const filters = f({ resumeReview: ['needs_review'] });
    expect(matchesCandidateFilters(cand({ resume_review: 'needs_review' }), filters)).toBe(true);
    expect(matchesCandidateFilters(cand({ resume_review: 'processing' }), filters)).toBe(false);
    expect(matchesCandidateFilters(cand({ resume_review: null }), filters)).toBe(false);
    expect(matchesCandidateFilters(cand({}), filters)).toBe(false);
  });

  it('combines with status and recommendation rather than replacing them', () => {
    const filters = f({
      statuses: ['queued'],
      recommendations: ['advance'],
      resumeReview: ['needs_review'],
    });
    const match = cand({
      status: 'queued',
      latest_recommendation: 'advance',
      resume_review: 'needs_review',
    });
    expect(matchesCandidateFilters(match, filters)).toBe(true);
    // Each dimension can independently veto.
    expect(matchesCandidateFilters({ ...match, status: 'new' }, filters)).toBe(false);
    expect(matchesCandidateFilters({ ...match, latest_recommendation: 'hold' }, filters)).toBe(false);
    expect(matchesCandidateFilters({ ...match, resume_review: 'processing' }, filters)).toBe(false);
  });

  /**
   * Type-level contract check: `Candidate` must accept the row the API
   * actually returns for a PII-minimal shell. If `name` were typed
   * non-nullable again, this literal would stop compiling.
   */
  it('accepts a truthfully nullable shell row', () => {
    const shell: Candidate = cand({
      name: null,
      email: null,
      phone_e164: null,
      status: 'queued',
      resume_review: 'needs_review',
    });
    expect(shell.name).toBeNull();
    expect(shell.email).toBeNull();
    expect(matchesCandidateFilters(shell, f({ statuses: ['queued'] }))).toBe(true);
  });

  it('counts as an active filter and clears with the rest', () => {
    expect(hasActiveFilters(f({ resumeReview: ['cancelled'] }))).toBe(true);
    expect(hasActiveFilters(EMPTY_CANDIDATE_FILTERS)).toBe(false);
  });

  it('leaves the status vocabulary, order and counts untouched', () => {
    const rows = [
      cand({ id: 'a', status: 'queued', resume_review: 'needs_review' }),
      cand({ id: 'b', status: 'queued', resume_review: 'ready' }),
      cand({ id: 'c', status: 'new', resume_review: null }),
    ];
    // The status funnel is derived from status alone — resume review is
    // nowhere in its vocabulary or its counts.
    expect(candidateFunnel(rows)).toEqual([
      { status: 'new', label: 'New', value: 1 },
      { status: 'queued', label: 'Queued', value: 2 },
    ]);
    // A queued shell stays queued, and its next action is unchanged.
    expect(normalizeStatus(rows[0].status)).toBe('queued');
    expect(candidateNextAction(rows[0].status)).toEqual({
      label: 'Queued for screening',
      emphasis: false,
    });
  });
});
