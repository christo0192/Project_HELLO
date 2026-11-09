/**
 * The candidate page's tabs, by pipeline: `/candidates/:id?tab=phone|r1|profile`.
 *
 * `review` and `overview` were the names before R1 had a tab of its own. Links with those names are
 * out in the world (bookmarks, an Ashby note, a browser's history), so they stay readable for good.
 *
 * Pure rules, so the page stays layout. No clock and no network.
 */
import type { CandidateDetail } from '../types';
import { latestScreeningAssessment } from './latest-screening-assessment';

export type CandidateTab = 'phone' | 'r1' | 'profile';

const TAB_NAMES: ReadonlyMap<string, CandidateTab> = new Map<string, CandidateTab>([
  ['phone', 'phone'],
  ['r1', 'r1'],
  ['profile', 'profile'],
  ['review', 'phone'],
  ['overview', 'profile'],
]);

/** The tab a `?tab=` value names, or null when it names none and the page must choose. */
export function candidateTabFrom(param: string | null): CandidateTab | null {
  return (param !== null && TAB_NAMES.get(param)) || null;
}

type TabFacts = Pick<CandidateDetail, 'sessions' | 'assessments'>;

const isR1Session = (session: CandidateDetail['sessions'][number]): boolean => session.interview_round_id != null;

/** An R1 session in the candidate's own payload: a result may follow, when the rounds answer. */
export function hasR1Session(detail: Pick<TabFacts, 'sessions'>): boolean {
  return detail.sessions.some(isR1Session);
}

/**
 * Something to read on the Phone screening tab: a completed phone session, or a phone assessment by the
 * header's rule, so that the tab and the score beside it never disagree about what is a phone screening.
 */
export function hasPhoneReview(detail: TabFacts): boolean {
  return (
    detail.sessions.some((session) => !isR1Session(session) && session.status === 'completed')
    || latestScreeningAssessment(detail.assessments, detail.sessions) !== null
  );
}

/** A status that says a person has already ruled on the candidate (`candidates.status`). */
const DECIDED_STATUSES: ReadonlySet<string> = new Set(['advanced', 'rejected']);

/**
 * Where a bare link lands: Phone screening while a phone review is pending, which is to say there is one
 * to read and the candidate is undecided. After that, the R1 interview if there is one. An empty
 * Phone screening tab is not worth landing on, so with neither it is Profile, where the actions are.
 */
export function defaultCandidateTab(detail: TabFacts & Pick<CandidateDetail, 'candidate'>): CandidateTab {
  const phone = hasPhoneReview(detail);
  if (phone && !DECIDED_STATUSES.has(detail.candidate.status)) return 'phone';
  if (detail.sessions.some(isR1Session)) return 'r1';
  return phone ? 'phone' : 'profile';
}
