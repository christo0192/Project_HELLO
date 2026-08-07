import { describe, it, expect } from 'vitest';
import type { Candidate } from '../../../types';
import {
  parseCandidateFilters,
  buildCandidateSearch,
  candidatesHref,
  matchesCandidateStatus,
  hasActiveFilters,
  candidateFunnel,
  candidateNextAction,
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

describe('parseCandidateFilters', () => {
  it('parses a comma-separated status list, dropping unknown values', () => {
    const f = parseCandidateFilters(
      new URLSearchParams('status=new,screening,bogus&role=r1'),
    );
    expect(f.statuses).toEqual(['new', 'screening']);
    expect(f.roleId).toBe('r1');
  });

  it('returns empty filters for an empty query', () => {
    expect(parseCandidateFilters(new URLSearchParams(''))).toEqual(
      EMPTY_CANDIDATE_FILTERS,
    );
  });

  it('canonicalizes status order regardless of URL order', () => {
    const f = parseCandidateFilters(new URLSearchParams('status=screened,new'));
    expect(f.statuses).toEqual(['new', 'screened']);
  });
});

describe('buildCandidateSearch / candidatesHref', () => {
  it('round-trips through parse in canonical order', () => {
    const href = candidatesHref({ statuses: ['screening', 'new'], roleId: 'r9' });
    expect(href).toBe('/candidates?status=new%2Cscreening&role=r9');
    const back = parseCandidateFilters(new URLSearchParams(href.split('?')[1]));
    expect(back).toEqual({ statuses: ['new', 'screening'], roleId: 'r9' });
  });

  it('produces a bare path with no filters', () => {
    expect(candidatesHref()).toBe('/candidates');
    expect(buildCandidateSearch(EMPTY_CANDIDATE_FILTERS).toString()).toBe('');
  });
});

describe('matchesCandidateStatus', () => {
  it('matches all when no statuses selected', () => {
    expect(
      matchesCandidateStatus(cand({ status: 'advanced' }), EMPTY_CANDIDATE_FILTERS),
    ).toBe(true);
  });

  it('filters by selected status and treats missing as "new"', () => {
    const f = { statuses: ['new'], roleId: null };
    expect(matchesCandidateStatus(cand({ status: undefined as never }), f)).toBe(true);
    expect(matchesCandidateStatus(cand({ status: 'screening' }), f)).toBe(false);
  });
});

describe('hasActiveFilters / normalizeStatus', () => {
  it('detects active filters', () => {
    expect(hasActiveFilters(EMPTY_CANDIDATE_FILTERS)).toBe(false);
    expect(hasActiveFilters({ statuses: ['new'], roleId: null })).toBe(true);
    expect(hasActiveFilters({ statuses: [], roleId: 'r' })).toBe(true);
  });

  it('normalizes blank/nullish status to new', () => {
    expect(normalizeStatus(null)).toBe('new');
    expect(normalizeStatus('   ')).toBe('new');
    expect(normalizeStatus('screened')).toBe('screened');
  });
});

describe('candidateFunnel', () => {
  it('counts by status in canonical funnel order, only present statuses', () => {
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

  it('appends unknown statuses last', () => {
    const funnel = candidateFunnel([cand({ status: 'zzz' }), cand({ status: 'new' })]);
    expect(funnel[0].status).toBe('new');
    expect(funnel[funnel.length - 1].status).toBe('zzz');
  });
});

describe('candidateNextAction', () => {
  it('maps statuses to an actionable next step', () => {
    expect(candidateNextAction('new')).toEqual({ label: 'Start screening', emphasis: true });
    expect(candidateNextAction('screened')).toEqual({ label: 'Review & decide', emphasis: true });
    expect(candidateNextAction('advanced').emphasis).toBe(false);
    expect(candidateNextAction('anything-else').label).toBe('Open profile');
  });
});
