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

export const ROUTES: RouteCase[] = [
  { name: 'root-redirect', path: '/', heading: 'Dashboard', landmark: 'Recent candidates', finalPath: /\/dashboard$/ },
  { name: 'dashboard', path: '/dashboard', heading: 'Dashboard', landmark: 'Recent candidates' },
  { name: 'candidates', path: '/candidates', heading: 'Candidates', landmark: 'Meera Iyer' },
  { name: 'candidates-filtered', path: '/candidates?status=screened', heading: 'Candidates', landmark: 'Diego Ferreira' },
  { name: 'candidate-detail', path: `/candidates/${STAR_CANDIDATE_ID}`, heading: 'Meera Iyer', landmark: 'Screening cycle 1' },
  { name: 'candidate-detail-legacy', path: `/candidates/${LEGACY_CANDIDATE_ID}`, heading: 'Rohan Deshpande', landmark: 'Moved to technical round.' },
  // Named by whose screening it is (the candidate's name), never by the
  // session id. Legacy (v1) and role-scorecard (v2) assessments both render:
  // the landmark proves the scorecard itself arrived, not just the shell.
  { name: 'session-legacy', path: `/sessions/${LEGACY_SESSION_ID}`, heading: 'Rohan Deshpande’s screening', landmark: 'Overall score' },
  { name: 'session-v2', path: `/sessions/${V2_SESSION_ID}`, heading: 'Meera Iyer’s screening', landmark: 'Technical depth' },
  { name: 'screening-console', path: `/screening/${V2_SESSION_ID}`, heading: 'Screening with Gopu', landmark: /walk me through your current role/i },
  { name: 'screening-console-legacy', path: `/screening/${LEGACY_SESSION_ID}`, heading: 'Screening with Gopu', landmark: /walk me through your current role/i },
  { name: 'roles', path: '/roles', heading: 'Agents', landmark: 'Senior Backend Engineer' },
  { name: 'phone-calendar', path: '/phone-calendar', heading: 'Phone calendar', landmark: /Meera Iyer|Ananya Chaudhary/ },
  { name: 'mission-control', path: '/mission-control', heading: 'Mission Control', landmark: 'Session status mix' },
  { name: 'mission-control-access', path: '/mission-control#access', heading: 'Mission Control', landmark: 'hiring.lead@example.com' },
  { name: 'mission-control-sessions', path: '/mission-control#sessions', heading: 'Mission Control', landmark: 'Override session status' },
  { name: 'mission-control-quotas', path: '/mission-control#quotas', heading: 'Mission Control', landmark: 'Quota policies' },
  { name: 'mission-control-funnel', path: '/mission-control#funnel', heading: 'Mission Control', landmark: 'Failures by stage' },
  { name: 'mission-control-audit', path: '/mission-control#audit', heading: 'Mission Control', landmark: 'Audit log' },
  { name: 'mission-control-maintenance', path: '/mission-control#maintenance', heading: 'Mission Control', landmark: 'Change maintenance mode' },
  { name: 'admin-redirect', path: '/admin', heading: 'Mission Control', landmark: 'Session status mix', finalPath: /\/mission-control$/ },
  { name: 'ashby-mission-control', path: '/ashby-mission-control', heading: 'Ashby Live Jobs', landmark: 'Application workflows' },
  { name: 'ashby-scoped-review', path: `/ashby/review/${SCOPED_REVIEW_LINK_ID}`, heading: 'Meera Iyer', landmark: 'Ashby screening pipeline' },
];
