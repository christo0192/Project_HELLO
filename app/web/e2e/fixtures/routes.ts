/**
 * The route catalogue: every recruiter/admin screen the harness visits.
 *
 * One list drives both the check suite (app.e2e.ts) and the screenshot run
 * (shots.e2e.ts), so a route added here is automatically checked AND
 * captured. `heading` is the page's `<h1>`; `landmark` is a second piece of
 * content that only renders once the route's DATA has arrived, so "the
 * heading showed" cannot pass on a page whose requests all failed.
 */

import {
  LEGACY_CANDIDATE_ID,
  LEGACY_SESSION_ID,
  SCOPED_REVIEW_LINK_ID,
  STAR_CANDIDATE_ID,
  V2_SESSION_ID,
} from './data';

export interface RouteCase {
  /** File-safe slug; also the screenshot name. */
  name: string;
  path: string;
  /** Accessible name of the page's `<h1>`. */
  heading: string | RegExp;
  /** Text that proves the route's data rendered. */
  landmark: string | RegExp;
  /** Where the app must end up, when the route redirects. */
  finalPath?: RegExp;
  /**
   * A known app defect, PINNED: instead of the route's normal checks the
   * test asserts this exact failure (see `KnownDefect`). Remove the flag in
   * the PR that fixes the defect — the pinned test goes red until you do.
   */
  knownIssue?: KnownDefect;
}

/**
 * A pinned app defect. The route's test asserts that the page crashes into
 * the error boundary WITH THIS console error — and nothing else: the error is
 * cleared only after it has been seen, and the usual "no other console
 * errors, no unmocked call, no external request" checks still run.
 *
 * So the test goes red both when the defect is FIXED (no error boundary, no
 * matching error → delete the flag) and when the route breaks some OTHER way
 * (a different crash, an auth redirect, a new unmocked call). This replaces
 * `test.fail`, which accepted ANY failure and so could not tell those apart.
 */
export interface KnownDefect {
  /** What is broken, and where — shown as the test's annotation. */
  reason: string;
  /** Matches the console error the crash logs, and only that one. */
  consoleError: RegExp;
}

/** What `ErrorBoundary` (src/components/ErrorBoundary.tsx) renders in its `role="alert"`. */
export const ERROR_BOUNDARY_TEXT = 'Something went wrong loading this page';

/**
 * APP DEFECT found by this harness (not a harness gap): `SessionDetailPage`
 * and `ScreeningPage` hand every assessment to the legacy `<Scorecard>`,
 * which reads v1 fields (`tone.notes`, `role_fit.notes`). A role-scorecard v2
 * assessment carries none of them on the wire (see `Assessment` in
 * src/types.ts), so opening a v2-scored session crashes the route into the
 * error boundary ("Something went wrong loading this page"). Ashby Mission
 * Control's "Review screening" link and the phone-attempt transcript link
 * both land here.
 *
 * REMOVE `knownIssue: APP_DEFECT_V2_SCORECARD` from both routes below (and
 * this constant) when the v2 session crash is fixed — a follow-up PR fixes
 * it. Until then the pinned test is green only while the page fails in
 * exactly this way; once it is fixed, the pinned test turns red on purpose.
 */
const APP_DEFECT_V2_SCORECARD: KnownDefect = {
  reason: 'App defect: legacy <Scorecard> crashes on a v2 assessment (TypeError reading "notes") — /sessions/:id and /screening/:id',
  // React logs a caught render error as ONE console.error carrying the error,
  // its stack and "The above error occurred in the <Scorecard> component".
  // Both halves are required, so a `notes` crash elsewhere does not match.
  consoleError: /TypeError: Cannot read properties of undefined \(reading 'notes'\)[\s\S]*The above error occurred in the <Scorecard> component/,
};

export const ROUTES: RouteCase[] = [
  { name: 'root-redirect', path: '/', heading: 'Dashboard', landmark: 'Recent candidates', finalPath: /\/dashboard$/ },
  { name: 'dashboard', path: '/dashboard', heading: 'Dashboard', landmark: 'Recent candidates' },
  { name: 'candidates', path: '/candidates', heading: 'Candidates', landmark: 'Meera Iyer' },
  { name: 'candidates-filtered', path: '/candidates?status=screened', heading: 'Candidates', landmark: 'Diego Ferreira' },
  { name: 'candidate-detail', path: `/candidates/${STAR_CANDIDATE_ID}`, heading: 'Meera Iyer', landmark: 'Screening cycle 1' },
  { name: 'candidate-detail-legacy', path: `/candidates/${LEGACY_CANDIDATE_ID}`, heading: 'Rohan Deshpande', landmark: 'Moved to technical round.' },
  { name: 'session-legacy', path: `/sessions/${LEGACY_SESSION_ID}`, heading: `Session ${LEGACY_SESSION_ID.slice(0, 8)}`, landmark: 'Overall score' },
  {
    name: 'session-v2',
    path: `/sessions/${V2_SESSION_ID}`,
    heading: `Session ${V2_SESSION_ID.slice(0, 8)}`,
    landmark: 'Session details',
    knownIssue: APP_DEFECT_V2_SCORECARD,
  },
  {
    name: 'screening-console',
    path: `/screening/${V2_SESSION_ID}`,
    heading: 'Screening with Gopu',
    landmark: /walk me through your current role/i,
    knownIssue: APP_DEFECT_V2_SCORECARD,
  },
  // The same two screens over a legacy (v1) session render fine, which pins
  // the defect above to the assessment generation, not to the routes.
  { name: 'screening-console-legacy', path: `/screening/${LEGACY_SESSION_ID}`, heading: 'Screening with Gopu', landmark: /walk me through your current role/i },
  { name: 'roles', path: '/roles', heading: 'Roles', landmark: 'Senior Backend Engineer' },
  { name: 'phone-calendar', path: '/phone-calendar', heading: 'Phone calendar', landmark: /Meera Iyer|Ananya Chaudhary/ },
  { name: 'mission-control', path: '/mission-control', heading: 'Mission Control', landmark: 'Session status mix' },
  { name: 'mission-control-access', path: '/mission-control#access', heading: 'Mission Control', landmark: 'hiring.lead@example.com' },
  { name: 'mission-control-sessions', path: '/mission-control#sessions', heading: 'Mission Control', landmark: 'Override session status' },
  { name: 'mission-control-quotas', path: '/mission-control#quotas', heading: 'Mission Control', landmark: 'Quota policies' },
  { name: 'mission-control-funnel', path: '/mission-control#funnel', heading: 'Mission Control', landmark: 'Failures by stage' },
  { name: 'mission-control-audit', path: '/mission-control#audit', heading: 'Mission Control', landmark: 'Audit log' },
  { name: 'mission-control-maintenance', path: '/mission-control#maintenance', heading: 'Mission Control', landmark: 'Change maintenance mode' },
  { name: 'admin-redirect', path: '/admin', heading: 'Mission Control', landmark: 'Session status mix', finalPath: /\/mission-control$/ },
  { name: 'ashby-mission-control', path: '/ashby-mission-control', heading: 'Ashby Mission Control', landmark: 'Application workflows' },
  { name: 'ashby-scoped-review', path: `/ashby/review/${SCOPED_REVIEW_LINK_ID}`, heading: 'Meera Iyer', landmark: 'Ashby screening pipeline' },
];
