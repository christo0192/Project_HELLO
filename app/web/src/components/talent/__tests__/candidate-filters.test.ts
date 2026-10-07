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
  normalizeCandidateQuery,
  CANDIDATE_QUERY_MAX,
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
      query: '',
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
      query: '',
    });
    const back = parseCandidateFilters(new URLSearchParams(href.split('?')[1]));
    expect(back).toEqual({
      statuses: ['new', 'screening'],
      recommendations: ['advance', 'reject'],
      resumeReview: [],
      assessed: true,
      roleId: 'r9',
      query: '',
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

/**
 * The `q` (free-text search) dimension. Normalized on the way in AND on the
 * way out, emitted last so every pre-existing href is byte-identical, and
 * never consulted by `matchesCandidateFilters` (search is its own predicate).
 */
describe('search query dimension (q)', () => {
  it('parses q trimmed with inner whitespace collapsed', () => {
    expect(parseCandidateFilters(new URLSearchParams('q=%20%20jane%20%20%20doe%20')).query).toBe(
      'jane doe',
    );
  });

  it('treats a missing or whitespace-only q as no search', () => {
    expect(parseCandidateFilters(new URLSearchParams('')).query).toBe('');
    expect(parseCandidateFilters(new URLSearchParams('q=%20%20%20')).query).toBe('');
    expect(normalizeCandidateQuery(null)).toBe('');
    expect(normalizeCandidateQuery(undefined)).toBe('');
  });

  it(`caps q at ${CANDIDATE_QUERY_MAX} code points without splitting a surrogate pair`, () => {
    const long = 'a'.repeat(250);
    expect(parseCandidateFilters(new URLSearchParams({ q: long })).query).toHaveLength(
      CANDIDATE_QUERY_MAX,
    );
    // 99 ASCII + an astral emoji (2 UTF-16 units) + more: the emoji is the
    // 100th code point and must survive whole.
    const astral = `${'b'.repeat(99)}😀zzz`;
    const capped = normalizeCandidateQuery(astral);
    expect(Array.from(capped)).toHaveLength(CANDIDATE_QUERY_MAX);
    expect(capped.endsWith('😀')).toBe(true);
  });

  it('emits q only when non-empty, and LAST', () => {
    expect(buildCandidateSearch(f({ query: '' })).has('q')).toBe(false);
    expect(buildCandidateSearch(f({ query: '   ' })).has('q')).toBe(false);
    const params = buildCandidateSearch(
      f({ statuses: ['screened'], roleId: 'r1', assessed: true, query: 'sam' }),
    );
    expect([...params.keys()]).toEqual(['status', 'assessed', 'role', 'q']);
    expect(params.toString()).toBe('status=screened&assessed=1&role=r1&q=sam');
  });

  it('normalizes q on the way OUT as well (no stray whitespace in the URL)', () => {
    expect(candidatesHref({ query: '  jane   doe ' })).toBe('/candidates?q=jane+doe');
  });

  it('round-trips characters that are meaningful in a URL or an address', () => {
    for (const query of ['jane+doe@example.com', 'a&b', '#1 pick', 'José Ñúñez', '100%']) {
      const href = candidatesHref({ statuses: ['new'], query });
      const back = parseCandidateFilters(new URLSearchParams(href.split('?')[1]));
      expect(back.query).toBe(query);
      expect(back.statuses).toEqual(['new']);
    }
  });

  it('leaves every pre-existing href byte-identical when there is no search', () => {
    expect(candidatesHref({ statuses: ['screened'] })).toBe('/candidates?status=screened');
    expect(candidatesHref({ recommendations: ['advance'], roleId: 'r1' })).toBe(
      '/candidates?recommendation=advance&role=r1',
    );
  });

  it('is ignored by matchesCandidateFilters (search is its own predicate)', () => {
    expect(matchesCandidateFilters(cand({ name: 'Jane' }), f({ query: 'nobody' }))).toBe(true);
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
    expect(hasActiveFilters(f({ query: 'x' }))).toBe(true);
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
      query: '',
    });
    expect(href).toContain('resume=processing%2Ccancelled');
    const back = parseCandidateFilters(new URLSearchParams(href.split('?')[1]));
    expect(back).toEqual({
      statuses: ['queued'],
      recommendations: ['advance'],
      resumeReview: ['processing', 'cancelled'],
      assessed: true,
      roleId: 'r9',
      query: '',
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

/**
 * Feature: dial status. The status dimension is keyed by the DISPLAY status
 * (`candidateStatusKey`), so a phone cycle's terminal outcome is its own
 * filterable, countable bucket and stops hiding inside "Queued".
 */
describe('phone-outcome display keys', () => {
  it('parses and round-trips the new keys in canonical order', () => {
    const parsed = parseCandidateFilters(
      new URLSearchParams('status=wrong_number,abandoned_no_answer,queued,bogus'),
    );
    expect(parsed.statuses).toEqual(['queued', 'abandoned_no_answer', 'wrong_number']);
    expect(candidatesHref({ statuses: ['abandoned_no_answer'] })).toBe(
      '/candidates?status=abandoned_no_answer',
    );
    const back = parseCandidateFilters(new URLSearchParams('status=abandoned_no_answer'));
    expect(back.statuses).toEqual(['abandoned_no_answer']);
  });

  it('queued excludes an abandoned row and abandoned_no_answer matches it', () => {
    const abandoned = cand({ status: 'queued', dial_count: 5, phone_state: 'abandoned_no_answer' });
    const dialled = cand({ status: 'queued', dial_count: 3, phone_state: 'awaiting_retry' });
    expect(matchesCandidateStatus(abandoned, f({ statuses: ['queued'] }))).toBe(false);
    expect(matchesCandidateStatus(abandoned, f({ statuses: ['abandoned_no_answer'] }))).toBe(true);
    expect(matchesCandidateStatus(dialled, f({ statuses: ['queued'] }))).toBe(true);
    expect(matchesCandidateStatus(dialled, f({ statuses: ['abandoned_no_answer'] }))).toBe(false);
  });

  it('a decided status is never re-bucketed by a later phone cycle', () => {
    const screened = cand({ status: 'screened', phone_state: 'failed', dial_count: 2 });
    expect(matchesCandidateStatus(screened, f({ statuses: ['screened'] }))).toBe(true);
    expect(matchesCandidateStatus(screened, f({ statuses: ['phone_failed'] }))).toBe(false);
  });

  it('the funnel counts by display key, phone outcomes after the stored statuses', () => {
    expect(
      candidateFunnel([
        cand({ status: 'queued', phone_state: 'abandoned_no_answer', dial_count: 5 }),
        cand({ status: 'queued', dial_count: 3 }),
        cand({ status: 'queued', phone_state: 'failed' }),
        cand({ status: 'screened', phone_state: 'failed' }),
      ]),
    ).toEqual([
      { status: 'queued', label: 'Queued', value: 1 },
      { status: 'screened', label: 'Screened', value: 1 },
      { status: 'abandoned_no_answer', label: 'Abandoned: no answer', value: 1 },
      { status: 'phone_failed', label: 'Phone screen failed', value: 1 },
    ]);
  });

  it('gives each phone outcome a plain, un-emphasised next action', () => {
    expect(candidateNextAction('abandoned_no_answer')).toEqual({
      label: 'No answer after every attempt',
      emphasis: false,
    });
    for (const key of ['phone_failed', 'wrong_number', 'opted_out', 'phone_cancelled']) {
      const next = candidateNextAction(key);
      expect(next.emphasis, key).toBe(false);
      expect(next.label, key).not.toBe('Open profile');
    }
  });
});

describe('screening_abandoned display key (M013 S02, 0125)', () => {
  const abandoned = cand({ status: 'screening', dial_count: 2, phone_state: 'failed', phone_state_reason: 'screening_abandoned' });

  it('is a filter key with its own deep link, and Screening no longer includes it', () => {
    const parsed = parseCandidateFilters(new URLSearchParams('status=screening_abandoned'));
    expect(parsed.statuses).toEqual(['screening_abandoned']);
    expect(candidatesHref({ statuses: ['screening_abandoned'] })).toBe('/candidates?status=screening_abandoned');
    expect(matchesCandidateStatus(abandoned, f({ statuses: ['screening_abandoned'] }))).toBe(true);
    expect(matchesCandidateStatus(abandoned, f({ statuses: ['screening'] }))).toBe(false);
    expect(matchesCandidateStatus(abandoned, f({ statuses: ['phone_failed'] }))).toBe(false);
  });

  it('sits in the funnel after phone_failed, with a plain next action', () => {
    expect(
      candidateFunnel([
        abandoned,
        cand({ status: 'queued', phone_state: 'failed', phone_state_reason: 'assessment_aborted' }),
        cand({ status: 'queued', phone_state: 'wrong_number' }),
      ]),
    ).toEqual([
      { status: 'phone_failed', label: 'Phone screen failed', value: 1 },
      { status: 'screening_abandoned', label: 'Abandoned: dropped before screening', value: 1 },
      { status: 'wrong_number', label: 'Wrong number', value: 1 },
    ]);
    expect(candidateNextAction('screening_abandoned')).toEqual({ label: 'Dropped before screening', emphasis: false });
  });
});
