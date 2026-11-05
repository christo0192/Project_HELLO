/**
 * URL-addressable candidate filter contract.
 *
 * The recruiter dashboard drills into the Candidates list by linking to
 * `/candidates?status=…&role=…`. This module is the single source of truth
 * for parsing and building those params so the dashboard and the Candidates
 * page always agree, and so deep links / browser back-forward behave.
 *
 * - `status` is a comma-separated subset of the candidate DISPLAY status
 *   vocabulary: the stored statuses (DB CHECK 0001/0006/notes) new | queued |
 *   screening | screened | advanced | rejected | consent_declined, then the
 *   six keys `candidateDisplayStatus` derives from a finished phone cycle:
 *   abandoned_no_answer | phone_failed | screening_abandoned | wrong_number |
 *   opted_out | phone_cancelled. Applied client-side (the list API only filters by role)
 *   against `candidateStatusKey`, so a filter, its count and the row badge
 *   always agree.
 * - `resume` is a comma-separated subset of the sanitized resume-review enum
 *   the list API returns (processing | needs_review | cancelled). Applied
 *   client-side over the already-loaded page: additive, adds no request, and
 *   changes nothing about the status vocabulary.
 * - `intake` is a comma-separated subset of the intake types the list API
 *   returns (resume_parsing | phone_parsing). Mirrors `resume` exactly:
 *   client-side, additive, and a row with no intake type never matches it.
 * - `role` is a role id, applied server-side via `listCandidates(roleId)`.
 * - `ashby` is `active` | `paused`: scope to roles whose Ashby job mapping is
 *   Live (enabled) or Paused in Ashby Live Jobs. Applied client-side from the
 *   roles list (`ashby_mapping_statuses`), never sent to the candidates API.
 * - `q` is a free-text search (name / email / phone digits). Applied
 *   client-side over the already-loaded rows by `matchesCandidateSearch`
 *   (candidateSearch.ts) and NEVER sent to the API, so it can only narrow
 *   what the server already chose to return (owner scoping, phone
 *   redaction). Normalized by `normalizeCandidateQuery`.
 *
 * Everything here is derived from data the candidate list already returns —
 * no fabricated metrics.
 */

import type { Candidate } from '../../types';
import { candidateStatusKey, candidateStatusLabel } from './status';
import { INTAKE_TYPE_ORDER, RESUME_REVIEW_ORDER } from './ResumeReviewBadge';
import { PAGE_SIZES } from '../design/Pagination';
import type { PageSize } from '../design/Pagination';
import type { AshbyJobState } from '../../lib/mapped-roles';
import { RECOMMENDATION_LABELS } from '../../lib/recommendation-labels';

/**
 * Canonical funnel order for the candidate display-status vocabulary. The
 * phone-cycle keys come last: they are terminal outcomes of `queued`, never
 * stored on the candidate (see `candidateDisplayStatus`).
 */
export const CANDIDATE_STATUS_ORDER = [
  'new',
  'queued',
  'screening',
  'screened',
  'advanced',
  'rejected',
  'consent_declined',
  'abandoned_no_answer',
  'phone_failed',
  // 0125 (M013 D1): `failed/screening_abandoned`, its own key.
  'screening_abandoned',
  'wrong_number',
  'opted_out',
  'phone_cancelled',
] as const;

/**
 * The phone-cycle display keys. The status bar always shows
 * `abandoned_no_answer` and shows the rest only when present or selected.
 */
export const PHONE_OUTCOME_STATUS_KEYS: ReadonlySet<string> = new Set([
  'abandoned_no_answer',
  'phone_failed',
  'screening_abandoned',
  'wrong_number',
  'opted_out',
  'phone_cancelled',
]);

export type CandidateStatusKey = (typeof CANDIDATE_STATUS_ORDER)[number];

const STATUS_SET = new Set<string>(CANDIDATE_STATUS_ORDER);

/** Assessment recommendation vocabulary (assessment.recommendation). */
export const RECOMMENDATION_ORDER = ['advance', 'hold', 'reject'] as const;
export type RecommendationKey = (typeof RECOMMENDATION_ORDER)[number];
const RECOMMENDATION_SET = new Set<string>(RECOMMENDATION_ORDER);

const RECOMMENDATION_WORDS: Readonly<Record<string, string>> = RECOMMENDATION_LABELS;

/** Human label for a recommendation (fallback: the raw value). */
export function recommendationLabel(rec: string | null | undefined): string {
  if (!rec) return 'Unassessed';
  return RECOMMENDATION_WORDS[rec] ?? rec;
}

const RESUME_REVIEW_SET = new Set<string>(RESUME_REVIEW_ORDER);
const INTAKE_TYPE_SET = new Set<string>(INTAKE_TYPE_ORDER);

export interface CandidateFilters {
  /** Selected statuses (empty = all). */
  statuses: string[];
  /** Selected assessment recommendations (empty = all). */
  recommendations: string[];
  /**
   * Selected resume-review states (empty = all). Purely additive: it narrows
   * which rows are shown and never touches the status vocabulary, its order,
   * or its counts.
   */
  resumeReview: string[];
  /** Selected intake types (empty = all). Additive, like `resumeReview`. */
  intakeType: string[];
  /** When true, restrict to candidates with a latest assessment score. */
  assessed: boolean;
  /** Selected role id, or null for all roles. */
  roleId: string | null;
  /** Ashby job state scope (`active` | `paused`), or null for all. */
  jobState: AshbyJobState | null;
  /**
   * Normalized free-text search (`''` = none). Client-side only; see
   * `matchesCandidateSearch`. `matchesCandidateFilters` deliberately ignores
   * it so the two predicates stay independently testable.
   */
  query: string;
}

/** Longest search the URL contract keeps, in code points. */
export const CANDIDATE_QUERY_MAX = 100;

/**
 * Canonical form of a search query: trimmed, inner whitespace runs collapsed
 * to one space, capped at `CANDIDATE_QUERY_MAX` code points (never splitting
 * a surrogate pair). `null` / whitespace-only is `''`.
 */
export function normalizeCandidateQuery(raw: string | null | undefined): string {
  if (!raw) return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return Array.from(collapsed).slice(0, CANDIDATE_QUERY_MAX).join('').trim();
}

export const EMPTY_CANDIDATE_FILTERS: CandidateFilters = {
  statuses: [],
  recommendations: [],
  resumeReview: [],
  intakeType: [],
  assessed: false,
  roleId: null,
  jobState: null,
  query: '',
};

/** Normalize a candidate's status to a known key ('new' when missing). */
export function normalizeStatus(status: string | null | undefined): string {
  const s = (status ?? 'new').trim();
  return s || 'new';
}

/** Parse filters from URL search params. Unknown values are dropped (truthful). */
export function parseCandidateFilters(params: URLSearchParams): CandidateFilters {
  const rawStatus = params.get('status');
  const statuses = rawStatus
    ? CANDIDATE_STATUS_ORDER.filter((s) =>
        rawStatus.split(',').map((x) => x.trim()).filter((x) => STATUS_SET.has(x)).includes(s),
      )
    : [];
  const rawRec = params.get('recommendation');
  const recommendations = rawRec
    ? RECOMMENDATION_ORDER.filter((r) =>
        rawRec.split(',').map((x) => x.trim()).filter((x) => RECOMMENDATION_SET.has(x)).includes(r),
      )
    : [];
  const rawResume = params.get('resume');
  const resumeReview = rawResume
    ? RESUME_REVIEW_ORDER.filter((r) =>
        rawResume.split(',').map((x) => x.trim()).filter((x) => RESUME_REVIEW_SET.has(x)).includes(r),
      )
    : [];
  const rawIntake = params.get('intake');
  const intakeType = rawIntake
    ? INTAKE_TYPE_ORDER.filter((t) =>
        rawIntake.split(',').map((x) => x.trim()).filter((x) => INTAKE_TYPE_SET.has(x)).includes(t),
      )
    : [];
  const roleId = params.get('role');
  const rawAshby = params.get('ashby');
  return {
    statuses: [...statuses],
    recommendations: [...recommendations],
    resumeReview: [...resumeReview],
    intakeType: [...intakeType],
    assessed: params.get('assessed') === '1',
    roleId: roleId && roleId.trim() ? roleId.trim() : null,
    jobState: rawAshby === 'active' || rawAshby === 'paused' ? rawAshby : null,
    query: normalizeCandidateQuery(params.get('q')),
  };
}

/** Build URL search params from filters (stable, canonical order). */
export function buildCandidateSearch(filters: CandidateFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.statuses.length > 0) {
    params.set('status', CANDIDATE_STATUS_ORDER.filter((s) => filters.statuses.includes(s)).join(','));
  }
  if (filters.recommendations.length > 0) {
    params.set(
      'recommendation',
      RECOMMENDATION_ORDER.filter((r) => filters.recommendations.includes(r)).join(','),
    );
  }
  if (filters.resumeReview.length > 0) {
    params.set(
      'resume',
      RESUME_REVIEW_ORDER.filter((r) => filters.resumeReview.includes(r)).join(','),
    );
  }
  if (filters.intakeType.length > 0) {
    params.set(
      'intake',
      INTAKE_TYPE_ORDER.filter((t) => filters.intakeType.includes(t)).join(','),
    );
  }
  if (filters.assessed) params.set('assessed', '1');
  if (filters.roleId) params.set('role', filters.roleId);
  if (filters.jobState) params.set('ashby', filters.jobState);
  // LAST, so every pre-existing canonical href is byte-identical.
  const query = normalizeCandidateQuery(filters.query);
  if (query) params.set('q', query);
  return params;
}

/** Build an href to the Candidates page with the given filters applied. */
export function candidatesHref(filters: Partial<CandidateFilters> = {}): string {
  const params = buildCandidateSearch({
    ...EMPTY_CANDIDATE_FILTERS,
    ...filters,
  });
  const qs = params.toString();
  return qs ? `/candidates?${qs}` : '/candidates';
}

/**
 * Client-side status predicate (role is filtered server-side). Keyed by the
 * DISPLAY status, so `queued` no longer includes a candidate whose phone
 * cycle ended with no answer, and `abandoned_no_answer` selects exactly them.
 */
export function matchesCandidateStatus(candidate: Candidate, filters: CandidateFilters): boolean {
  if (filters.statuses.length === 0) return true;
  return filters.statuses.includes(candidateStatusKey(candidate));
}

/**
 * Full client-side predicate: status + recommendation + assessed. Role is
 * filtered server-side; the free-text `query` is applied separately by
 * `matchesCandidateSearch` and ignored here. Recommendation/assessed use the
 * list-enriched latest_recommendation / latest_score fields.
 */
export function matchesCandidateFilters(candidate: Candidate, filters: CandidateFilters): boolean {
  if (!matchesCandidateStatus(candidate, filters)) return false;
  if (
    filters.recommendations.length > 0 &&
    !(candidate.latest_recommendation && filters.recommendations.includes(candidate.latest_recommendation))
  ) {
    return false;
  }
  if (
    filters.resumeReview.length > 0 &&
    !(candidate.resume_review && filters.resumeReview.includes(candidate.resume_review))
  ) {
    return false;
  }
  if (
    filters.intakeType.length > 0 &&
    !(candidate.intake_type && filters.intakeType.includes(candidate.intake_type))
  ) {
    return false;
  }
  if (filters.assessed && candidate.latest_score == null) return false;
  return true;
}

/**
 * Where the reader is in the list: page, rows per page and sort.
 *
 * Kept apart from `CandidateFilters` because it answers a different question,
 * and because a change of filter must drop the page and keep the rest. It goes in
 * the same URL, so a trip to a candidate and back lands on the same rows. The
 * defaults print nothing, so every existing href stays byte-identical.
 */
export type CandidateSortKey = 'score' | 'waiting';

export interface CandidateListView {
  page: number;
  size: PageSize;
  sort: CandidateSortKey | null;
  dir: 'asc' | 'desc';
}

export const DEFAULT_CANDIDATE_VIEW: CandidateListView = { page: 1, size: 10, sort: null, dir: 'desc' };

export function parseCandidateListView(params: URLSearchParams): CandidateListView {
  const page = Number(params.get('page'));
  const size = Number(params.get('size'));
  const rawSort = params.get('sort');
  const sort = rawSort === 'score' || rawSort === 'waiting' ? rawSort : null;
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    size: (PAGE_SIZES as readonly number[]).includes(size) ? (size as PageSize) : 10,
    sort,
    dir: sort !== null && params.get('dir') === 'asc' ? 'asc' : 'desc',
  };
}

/** Add the view to a filter search. LAST, so a filter href is unchanged by it. */
export function applyCandidateListView(params: URLSearchParams, view: CandidateListView): URLSearchParams {
  const next = new URLSearchParams(params);
  if (view.sort) {
    next.set('sort', view.sort);
    if (view.dir === 'asc') next.set('dir', 'asc');
  }
  if (view.size !== 10) next.set('size', String(view.size));
  if (view.page > 1) next.set('page', String(view.page));
  return next;
}

/** Statuses a person or the system still has to act on. Anything else is not waiting. */
const WAITING_STATUSES: ReadonlySet<string> = new Set(['new', 'queued', 'screening', 'screened']);

/**
 * When a candidate started waiting: the moment they were added, while their
 * status still needs someone to act. The list payload carries no screened time,
 * so this is time in the pipeline and not time since the call.
 */
export function candidateWaitingSince(candidate: Candidate): string | null {
  if (!WAITING_STATUSES.has(candidateStatusKey(candidate))) return null;
  return Number.isFinite(Date.parse(candidate.created_at)) ? candidate.created_at : null;
}

/** "22 min", "5 h", "6 d". Under a minute reads "Just now", never a bare 0. */
export function formatWaiting(since: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/**
 * A shell still being read: no name yet, and its resume in progress. These arrive
 * in batches and would otherwise fill page 1 with identical rows for as long as
 * an import takes.
 */
export function isInFlightShell(candidate: Candidate): boolean {
  return !candidate.name?.trim() && candidate.resume_review === 'processing';
}

/**
 * The rows in the order the view asks for.
 *
 * With no sort chosen the API's order stands, except that shells being read go
 * after the named candidates: page 1 starts at someone, and the summary row above
 * the table says how many are arriving. Nothing is left out, so a shell that is
 * stuck is still in the list and still counted.
 *
 * A sort puts rows with nothing to sort by last in either direction, because a
 * candidate with no score is not the lowest or the highest.
 */
export function orderCandidates(
  rows: ReadonlyArray<Candidate>,
  view: Pick<CandidateListView, 'sort' | 'dir'>,
  { keepArrivals = false }: { keepArrivals?: boolean } = {},
): Candidate[] {
  if (view.sort === null) {
    if (keepArrivals) return [...rows];
    return [...rows.filter((c) => !isInFlightShell(c)), ...rows.filter(isInFlightShell)];
  }
  const keyOf = (c: Candidate): number | null => {
    if (view.sort === 'score') return c.latest_score ?? null;
    const since = candidateWaitingSince(c);
    // Longest wait first is the natural "descending".
    return since === null ? null : -Date.parse(since);
  };
  const direction = view.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const [x, y] = [keyOf(a), keyOf(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (x - y) * direction;
  });
}

/** True when any filter is active. */
export function hasActiveFilters(filters: CandidateFilters): boolean {
  return (
    filters.statuses.length > 0 ||
    filters.recommendations.length > 0 ||
    filters.resumeReview.length > 0 ||
    filters.intakeType.length > 0 ||
    filters.assessed ||
    filters.roleId !== null ||
    filters.jobState !== null ||
    filters.query !== ''
  );
}

/**
 * The obvious next recruiter action for a candidate, by status (pass the
 * DISPLAY key, `candidateStatusKey`). Keeps the list actionable without
 * inventing data — purely a restatement of status. The phone-outcome keys are
 * never emphasised: a rescreen is an interviewer action on the profile, not a
 * list button.
 */
export function candidateNextAction(status: string | null | undefined): {
  label: string;
  emphasis: boolean;
} {
  switch (normalizeStatus(status)) {
    case 'new':
      return { label: 'Start screening', emphasis: true };
    case 'queued':
      return { label: 'Queued for screening', emphasis: false };
    case 'screening':
      return { label: 'Screening in progress', emphasis: false };
    case 'screened':
      return { label: 'Review', emphasis: true };
    case 'advanced':
      return { label: 'Advanced', emphasis: false };
    case 'rejected':
      return { label: 'Rejected', emphasis: false };
    case 'consent_declined':
      return { label: 'Consent declined', emphasis: false };
    case 'abandoned_no_answer':
      return { label: 'No answer after every attempt', emphasis: false };
    case 'phone_failed':
      return { label: 'Phone screen failed', emphasis: false };
    case 'screening_abandoned':
      // Never requeued (owner decision): a rescreen is an interviewer action
      // on the profile, which recommends one for this evidence.
      return { label: 'Dropped before screening', emphasis: false };
    case 'wrong_number':
      return { label: 'Wrong number', emphasis: false };
    case 'opted_out':
      return { label: 'Opted out', emphasis: false };
    case 'phone_cancelled':
      return { label: 'Phone screen cancelled', emphasis: false };
    default:
      return { label: 'Open profile', emphasis: false };
  }
}

/**
 * Count candidates per DISPLAY status, in canonical funnel order, keeping only
 * statuses actually present. Each entry carries its status key so callers can
 * build drill-down links. Derived purely from the list — never fabricated.
 */
export function candidateFunnel(
  candidates: ReadonlyArray<Candidate>,
): Array<{ status: string; label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const key = candidateStatusKey(c);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ordered = [
    ...CANDIDATE_STATUS_ORDER.filter((s) => counts.has(s)),
    // Any unknown statuses last, alphabetized, still truthful.
    ...[...counts.keys()].filter((s) => !STATUS_SET.has(s)).sort(),
  ];
  return ordered.map((status) => ({
    status,
    label: candidateStatusLabel(status),
    value: counts.get(status) ?? 0,
  }));
}
