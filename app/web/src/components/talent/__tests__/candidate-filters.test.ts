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
  DEFAULT_CANDIDATE_VIEW,
  applyCandidateListView,
  formatWaiting,
  isInFlightShell,
  orderCandidates,
  parseCandidateListView,
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
      intakeType: [],
      arriving: false,
      assessed: true,
      roleId: 'r1',
      jobState: null,
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
      intakeType: [],
      arriving: false,
      assessed: true,
      roleId: 'r9',
      jobState: null,
      query: '',
    });
  });

  it('round-trips the Ashby job state (ashby=active|paused) before q, and drops unknowns', () => {
    const href = candidatesHref({ roleId: 'r1', jobState: 'active', query: 'sam' });
    expect(href).toBe('/candidates?role=r1&ashby=active&q=sam');
    expect(parseCandidateFilters(new URLSearchParams('ashby=paused')).jobState).toBe('paused');
    expect(parseCandidateFilters(new URLSearchParams('ashby=drift')).jobState).toBeNull();
    expect(buildCandidateSearch(f({ jobState: null })).has('ashby')).toBe(false);
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
    expect(hasActiveFilters(f({ jobState: 'paused' }))).toBe(true);
    expect(hasActiveFilters(f({ query: 'x' }))).toBe(true);
  });

  it('normalizes blank status to new and labels recommendations', () => {
    expect(normalizeStatus('   ')).toBe('new');
    expect(recommendationLabel('advance')).toBe('Select');
    expect(recommendationLabel('hold')).toBe('Borderline');
    expect(recommendationLabel('reject')).toBe('Reject');
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
    expect(candidateNextAction('screened')).toEqual({ label: 'Review', emphasis: true });
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
      intakeType: [],
      arriving: false,
      assessed: true,
      roleId: 'r9',
      jobState: null,
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
 * M017 (Addendum A): the intake facet mirrors the resume-review one exactly —
 * parse, serialize, predicate, active check — and a row with no intake type
 * (an older API, or a candidate with neither a link nor an upload) never
 * matches an active intake filter.
 */
describe('intake facet', () => {
  it('parses the intake param in canonical order, dropping unknowns', () => {
    const parsed = parseCandidateFilters(
      new URLSearchParams('intake=phone_parsing,bogus,resume_parsing,PHONE_PARSING'),
    );
    expect(parsed.intakeType).toEqual(['resume_parsing', 'phone_parsing']);
    expect(parseCandidateFilters(new URLSearchParams('intake=bogus')).intakeType).toEqual([]);
    expect(parseCandidateFilters(new URLSearchParams('intake=')).intakeType).toEqual([]);
  });

  it('round-trips alongside every other dimension, right after resume and before q', () => {
    const href = candidatesHref({
      statuses: ['queued'],
      resumeReview: ['processing'],
      intakeType: ['phone_parsing', 'resume_parsing'],
      roleId: 'r9',
      query: 'sam',
    });
    expect(href).toBe(
      '/candidates?status=queued&resume=processing&intake=resume_parsing%2Cphone_parsing&role=r9&q=sam',
    );
    const back = parseCandidateFilters(new URLSearchParams(href.split('?')[1]));
    expect(back).toEqual({
      ...EMPTY_CANDIDATE_FILTERS,
      statuses: ['queued'],
      resumeReview: ['processing'],
      intakeType: ['resume_parsing', 'phone_parsing'],
      roleId: 'r9',
      query: 'sam',
    });
  });

  it('emits no intake param when unselected, so every existing href is unchanged', () => {
    expect(buildCandidateSearch(f({ statuses: ['queued'] })).has('intake')).toBe(false);
    expect(candidatesHref({ resumeReview: ['cancelled'] })).toBe('/candidates?resume=cancelled');
    expect(candidatesHref({ intakeType: ['phone_parsing'] })).toBe('/candidates?intake=phone_parsing');
  });

  it('narrows to the selected types and excludes a row with no intake type', () => {
    const filters = f({ intakeType: ['phone_parsing'] });
    expect(matchesCandidateFilters(cand({ intake_type: 'phone_parsing' }), filters)).toBe(true);
    expect(matchesCandidateFilters(cand({ intake_type: 'resume_parsing' }), filters)).toBe(false);
    expect(matchesCandidateFilters(cand({ intake_type: null }), filters)).toBe(false);
    expect(matchesCandidateFilters(cand({}), filters)).toBe(false);
    // Both selected is "has an intake type at all", never "every row".
    const both = f({ intakeType: ['resume_parsing', 'phone_parsing'] });
    expect(matchesCandidateFilters(cand({ intake_type: 'resume_parsing' }), both)).toBe(true);
    expect(matchesCandidateFilters(cand({}), both)).toBe(false);
    // Unselected, the field is ignored entirely.
    expect(matchesCandidateFilters(cand({}), EMPTY_CANDIDATE_FILTERS)).toBe(true);
  });

  it('combines with status and resume review rather than replacing them', () => {
    const filters = f({ statuses: ['queued'], intakeType: ['resume_parsing'], resumeReview: ['processing'] });
    const match = cand({ status: 'queued', intake_type: 'resume_parsing', resume_review: 'processing' });
    expect(matchesCandidateFilters(match, filters)).toBe(true);
    expect(matchesCandidateFilters({ ...match, status: 'new' }, filters)).toBe(false);
    expect(matchesCandidateFilters({ ...match, intake_type: 'phone_parsing' }, filters)).toBe(false);
    expect(matchesCandidateFilters({ ...match, resume_review: 'cancelled' }, filters)).toBe(false);
  });

  it('counts as an active filter and clears with the rest', () => {
    expect(hasActiveFilters(f({ intakeType: ['phone_parsing'] }))).toBe(true);
    expect(EMPTY_CANDIDATE_FILTERS.intakeType).toEqual([]);
    expect(hasActiveFilters(EMPTY_CANDIDATE_FILTERS)).toBe(false);
  });

  it('leaves the status funnel untouched', () => {
    expect(
      candidateFunnel([
        cand({ status: 'queued', intake_type: 'phone_parsing' }),
        cand({ status: 'queued', intake_type: 'resume_parsing' }),
        cand({ status: 'new' }),
      ]),
    ).toEqual([
      { status: 'new', label: 'New', value: 1 },
      { status: 'queued', label: 'Queued', value: 2 },
    ]);
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

describe('the list view in the URL', () => {
  const view = (qs: string) => parseCandidateListView(new URLSearchParams(qs));

  it('prints nothing for the defaults, so an existing href is unchanged', () => {
    const filters = new URLSearchParams('status=screened');
    expect(applyCandidateListView(filters, DEFAULT_CANDIDATE_VIEW).toString()).toBe('status=screened');
  });

  it('reads back what it wrote', () => {
    const written = applyCandidateListView(new URLSearchParams(), { page: 3, size: 25, sort: 'score', dir: 'asc' });
    expect(view(written.toString())).toEqual({ page: 3, size: 25, sort: 'score', dir: 'asc' });
  });

  it.each(['page=0', 'page=-1', 'page=1.5', 'page=x', 'size=7', 'sort=name', 'dir=asc'])('drops %s', (qs) => {
    expect(view(qs)).toEqual(DEFAULT_CANDIDATE_VIEW);
  });
});

describe('orderCandidates', () => {
  const row = (id: string, over: Partial<Candidate> = {}) =>
    ({ id, name: id, status: 'screened', created_at: '2026-10-01T00:00:00.000Z', ...over }) as Candidate;
  const ids = (rows: Candidate[]) => rows.map((r) => r.id);

  it('leaves the API order alone, with shells being read after the named', () => {
    const shell = row('shell', { name: null, resume_review: 'processing' });
    expect(ids(orderCandidates([shell, row('a'), row('b')], DEFAULT_CANDIDATE_VIEW))).toEqual(['a', 'b', 'shell']);
  });

  it('keeps a shell that has stopped being read where the API put it', () => {
    const stuck = row('stuck', { name: null, resume_review: 'needs_review' });
    expect(ids(orderCandidates([stuck, row('a')], DEFAULT_CANDIDATE_VIEW))).toEqual(['stuck', 'a']);
  });

  it('puts a row with nothing to sort by last, in either direction', () => {
    const rows = [row('none'), row('low', { latest_score: 10 }), row('high', { latest_score: 90 })];
    expect(ids(orderCandidates(rows, { sort: 'score', dir: 'desc' }))).toEqual(['high', 'low', 'none']);
    expect(ids(orderCandidates(rows, { sort: 'score', dir: 'asc' }))).toEqual(['low', 'high', 'none']);
  });

  it('counts a settled candidate as not waiting', () => {
    const rows = [row('done', { status: 'rejected' }), row('old', { created_at: '2026-09-01T00:00:00.000Z' }), row('new')];
    expect(ids(orderCandidates(rows, { sort: 'waiting', dir: 'desc' }))).toEqual(['old', 'new', 'done']);
  });
});

describe('shells still being read', () => {
  const named = cand({ name: 'Asha' });
  const resumeShell = cand({ name: null, resume_review: 'processing' });
  // The API forces a phone intake's resume review to null, so it can never be
  // reached through `resume_review`.
  const phoneShell = cand({ name: null, resume_review: null, intake_type: 'phone_parsing' });

  it('counts a nameless phone intake as well as a resume being read', () => {
    expect(isInFlightShell(resumeShell)).toBe(true);
    expect(isInFlightShell(phoneShell)).toBe(true);
    expect(isInFlightShell({ ...phoneShell, name: '   ' })).toBe(true);
  });

  it('counts nobody with a name, and no quiet nameless row', () => {
    expect(isInFlightShell(named)).toBe(false);
    expect(isInFlightShell({ ...phoneShell, name: 'Asha' })).toBe(false);
    expect(isInFlightShell(cand({ name: null, resume_review: 'ready' }))).toBe(false);
    expect(isInFlightShell(cand({ name: null, resume_review: null, intake_type: 'resume_parsing' }))).toBe(false);
  });

  it('puts both kinds after the named rows', () => {
    const rows = [phoneShell, resumeShell, named];
    expect(orderCandidates(rows, DEFAULT_CANDIDATE_VIEW)).toEqual([named, phoneShell, resumeShell]);
  });

  it('round-trips through the URL, and adds nothing when off', () => {
    expect(parseCandidateFilters(new URLSearchParams('arriving=1')).arriving).toBe(true);
    expect(parseCandidateFilters(new URLSearchParams('arriving=0')).arriving).toBe(false);
    expect(candidatesHref({ arriving: true })).toBe('/candidates?arriving=1');
    expect(candidatesHref()).toBe('/candidates');
    expect(hasActiveFilters(f({ arriving: true }))).toBe(true);
  });

  it('selects both kinds and nobody else', () => {
    const arriving = f({ arriving: true });
    expect(matchesCandidateFilters(resumeShell, arriving)).toBe(true);
    expect(matchesCandidateFilters(phoneShell, arriving)).toBe(true);
    expect(matchesCandidateFilters(named, arriving)).toBe(false);
  });
});

describe('formatWaiting', () => {
  const at = Date.parse('2026-11-05T12:00:00.000Z');
  it.each([
    ['2026-11-05T11:59:40.000Z', 'Just now'],
    ['2026-11-05T11:38:00.000Z', '22 min'],
    ['2026-11-05T07:00:00.000Z', '5 h'],
    ['2026-10-30T12:00:00.000Z', '6 d'],
  ])('reads %s as %s', (since, words) => {
    expect(formatWaiting(since, at)).toBe(words);
  });
});
