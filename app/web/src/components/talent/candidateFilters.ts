/**
 * URL-addressable candidate filter contract.
 *
 * The recruiter dashboard drills into the Candidates list by linking to
 * `/candidates?status=…&role=…`. This module is the single source of truth
 * for parsing and building those params so the dashboard and the Candidates
 * page always agree, and so deep links / browser back-forward behave.
 *
 * - `status` is a comma-separated subset of the candidate status vocabulary
 *   (DB CHECK 0001/0006/notes): new | queued | screening | screened |
 *   advanced | rejected | consent_declined. Applied client-side (the list
 *   API only filters by role).
 * - `role` is a role id, applied server-side via `listCandidates(roleId)`.
 *
 * Everything here is derived from data the candidate list already returns —
 * no fabricated metrics.
 */

import type { Candidate } from '../../types';
import { candidateStatusLabel } from './status';

/** Canonical funnel order for the candidate status vocabulary. */
export const CANDIDATE_STATUS_ORDER = [
  'new',
  'queued',
  'screening',
  'screened',
  'advanced',
  'rejected',
  'consent_declined',
] as const;

export type CandidateStatusKey = (typeof CANDIDATE_STATUS_ORDER)[number];

const STATUS_SET = new Set<string>(CANDIDATE_STATUS_ORDER);

export interface CandidateFilters {
  /** Selected statuses (empty = all). */
  statuses: string[];
  /** Selected role id, or null for all roles. */
  roleId: string | null;
}

export const EMPTY_CANDIDATE_FILTERS: CandidateFilters = { statuses: [], roleId: null };

/** Normalize a candidate's status to a known key ('new' when missing). */
export function normalizeStatus(status: string | null | undefined): string {
  const s = (status ?? 'new').trim();
  return s || 'new';
}

/** Parse filters from URL search params. Unknown statuses are dropped (truthful). */
export function parseCandidateFilters(params: URLSearchParams): CandidateFilters {
  const rawStatus = params.get('status');
  const statuses = rawStatus
    ? rawStatus
        .split(',')
        .map((s) => s.trim())
        .filter((s) => STATUS_SET.has(s))
    : [];
  // De-dupe while preserving canonical order.
  const ordered = CANDIDATE_STATUS_ORDER.filter((s) => statuses.includes(s));
  const roleId = params.get('role');
  return {
    statuses: ordered,
    roleId: roleId && roleId.trim() ? roleId.trim() : null,
  };
}

/** Build URL search params from filters (stable, canonical order). */
export function buildCandidateSearch(filters: CandidateFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.statuses.length > 0) {
    const ordered = CANDIDATE_STATUS_ORDER.filter((s) => filters.statuses.includes(s));
    params.set('status', ordered.join(','));
  }
  if (filters.roleId) params.set('role', filters.roleId);
  return params;
}

/** Build an href to the Candidates page with the given filters applied. */
export function candidatesHref(filters: Partial<CandidateFilters> = {}): string {
  const params = buildCandidateSearch({
    statuses: filters.statuses ?? [],
    roleId: filters.roleId ?? null,
  });
  const qs = params.toString();
  return qs ? `/candidates?${qs}` : '/candidates';
}

/** Client-side status predicate (role is filtered server-side). */
export function matchesCandidateStatus(candidate: Candidate, filters: CandidateFilters): boolean {
  if (filters.statuses.length === 0) return true;
  return filters.statuses.includes(normalizeStatus(candidate.status));
}

/** True when any filter is active. */
export function hasActiveFilters(filters: CandidateFilters): boolean {
  return filters.statuses.length > 0 || filters.roleId !== null;
}

/**
 * The obvious next recruiter action for a candidate, by status. Keeps the
 * list actionable without inventing data — purely a restatement of status.
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
      return { label: 'Review & decide', emphasis: true };
    case 'advanced':
      return { label: 'Advanced', emphasis: false };
    case 'rejected':
      return { label: 'Rejected', emphasis: false };
    case 'consent_declined':
      return { label: 'Consent declined', emphasis: false };
    default:
      return { label: 'Open profile', emphasis: false };
  }
}

/**
 * Count candidates per status, in canonical funnel order, keeping only
 * statuses actually present. Each entry carries its status key so callers can
 * build drill-down links. Derived purely from the list — never fabricated.
 */
export function candidateFunnel(
  candidates: ReadonlyArray<Candidate>,
): Array<{ status: string; label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const key = normalizeStatus(c.status);
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
