/**
 * The R1 review page: every state it can be in, what each role is offered, and how a position moves
 * between the scorecard, the strip, the player and the transcript.
 *
 * Media elements are driven by hand, as in R1RecordingPlayer.test.tsx: jsdom plays nothing, so a test
 * stubs the element's position and fires the events a browser would.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type {
  R1RecordingSummary,
  R1ReviewAssessment,
  R1ReviewAttempt,
  R1ReviewResponse,
  R1ReviewTurn,
  R1TurnPhase,
} from '../lib/r1-types';
import { R1ReviewPage } from './R1ReviewPage';

const mockApi = vi.hoisted(() => ({
  getR1Review: vi.fn(),
  getR1Recording: vi.fn(),
  cancelR1PendingReject: vi.fn(),
  getMe: vi.fn(),
}));

class TestApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

vi.mock('../api', () => ({
  api: mockApi,
  ApiError: class extends Error {
    status = 0;
  },
}));

const ROUND = 'round-1';
const CANDIDATE = 'cand-1';
const START = 1_800_000_000_000;
const ME_ADMIN = { userId: 'admin-1', role: 'admin' };

const recording = (over: Partial<R1RecordingSummary> = {}): R1RecordingSummary => ({
  state: 'ready', reason: null, mode: 'single', has_video: true, started_at_ms: START, duration_ms: 1_500_000,
  camera_off_ms: 0, degraded_at_ms: null, retention_until: '2027-02-01T00:00:00.000Z', deleted_at: null, ...over,
});

const turn = (index: number, sec: number | null, speaker: 'bot' | 'candidate', phase: R1TurnPhase | null, text: string): R1ReviewTurn => ({
  turn_index: index, speaker, text, turn_started_at_ms: sec === null ? null : START + sec * 1000, is_gate: false, phase, interrupted: false,
});

const TURNS: R1ReviewTurn[] = [
  turn(0, 5, 'bot', 'opening', 'Hello, I am Christy.'),
  turn(1, 30, 'candidate', 'icebreaker', 'Happy to be here today.'),
  turn(2, 120, 'bot', 'roleplay', 'Hi, I saw your course.'),
  turn(3, 125, 'candidate', 'roleplay', 'What made you look at it now?'),
  turn(4, 200, 'bot', 'roleplay', 'My plant is closing.'),
  turn(5, 400, 'candidate', 'wrapup', 'Thank you for your time.'),
];

const attempt = (over: Partial<R1ReviewAttempt> = {}): R1ReviewAttempt => ({
  session_id: 's1', attempt_number: 1, counted: true, outcome: 'complete', recording: recording(), persona_id: 'p1_career_switcher',
  persona_label: 'Career switcher', learner_name: 'Priya Nair', session_status: 'completed', started_at: '2026-11-02T10:00:00.000Z',
  ended_at: '2026-11-02T10:30:00.000Z', consent_withdrawn: false, transcript_hidden: false, in_progress: false, turns: TURNS, ...over,
});

const METRICS = ['Probing & discovery', 'Objection handling', 'Urgency & close', 'Negotiation & discount discipline', 'Communication & rapport'];

const assessment = (over: Partial<R1ReviewAssessment> = {}): R1ReviewAssessment => ({
  id: 'a1', session_id: 's1', recommendation: 'hold', raw_recommendation: 'hold', overall_score: 58, scoring_status: 'complete',
  score_scale_max: 4, created_at: '2026-11-02T10:40:00.000Z',
  metric_results: METRICS.map((name, index) => ({
    metric_id: `m${index}`, name, weight_bps: 2000, score: 3, evidence_status: 'scored', rationale: `${name} rationale.`,
    evidence: index === 0 ? [{ turn_index: 3, quote: 'What made you look at it now' }] : [],
  })),
  r1: { outcome: 'scored', valid: true, code: null, gate: { passed: true, failures: [] }, administration_quality: { status: 'ok', failures: [] }, agreement: { runs_agree: true, disagreement: 0 }, thresholds: { advance: 65, hold: 45 } },
  ...over,
});

const review = (over: Partial<R1ReviewResponse> = {}): R1ReviewResponse => ({
  round: {
    id: ROUND, candidate_id: CANDIDATE, status: 'completed', expires_at: '2026-11-06T00:00:00.000Z', attempts_allowed: 2, attempts_counted: 1,
    recommendation: 'hold', overall: 58, status_write: null, pending_reject_until: null, scores_withheld: false, is_staff_dry_run: false,
    created_at: '2026-11-01T00:00:00.000Z', created_by: 'user-1',
  },
  candidate: {
    id: CANDIDATE, name: 'Ava Example', role_title: 'Sales Program Advisor', skills: ['Sales'], experience_years: 4,
    resume: { summary: 'Sold courses for four years.', recent_role: { title: 'Advisor', employer: 'Example Co' }, education: ['BA Economics'] },
  },
  attempts: [attempt()],
  assessment: assessment(),
  events: [{ session_id: 's1', event_type: 'need_revealed', turn_index: 4, family_id: null, need: 'H1', kind: null, created_at: null }],
  phone_screening: null,
  rubric: METRICS.map((name, index) => ({ key: `m${index}`, name, weight_bps: 2000, levels: { 1: `${name} level one.`, 2: 'Two.', 3: 'Three.', 4: 'Four.' } })),
  ...over,
});

let address = '';
function Address() {
  const location = useLocation();
  address = `${location.pathname}${location.search}`;
  return null;
}

function open(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/interviews/${ROUND}${search}`]}>
      <Address />
      <Routes>
        <Route path="/interviews/:roundId" element={<R1ReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const opened = async (body: R1ReviewResponse = review(), search = '') => {
  mockApi.getR1Review.mockResolvedValue(body);
  const view = open(search);
  await screen.findByRole('tablist', { name: 'R1 review sections' });
  return view;
};

const tab = (name: string) => screen.getByRole('tab', { name });
const panel = (name: string) => screen.getByRole('tabpanel', { name });

interface Driven {
  currentTime: number;
  paused: boolean;
  sets: number[];
}

function drive(el: HTMLMediaElement): Driven {
  const state: Driven = { currentTime: 0, paused: true, sets: [] };
  Object.defineProperty(el, 'currentTime', { configurable: true, get: () => state.currentTime, set: (v: number) => { state.currentTime = v; state.sets.push(v); } });
  Object.defineProperty(el, 'paused', { configurable: true, get: () => state.paused });
  el.play = vi.fn(() => { state.paused = false; return Promise.resolve(); }) as unknown as HTMLMediaElement['play'];
  el.pause = vi.fn(() => { state.paused = true; }) as unknown as HTMLMediaElement['pause'];
  return state;
}

/** Press play and get the driven element, with metadata loaded. */
async function chooseSpeed(label: string) {
  await userEvent.click(screen.getByRole('button', { name: /^Speed/, expanded: false }));
  await userEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: label }));
}

async function pressPlay() {
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  const el = await waitFor(() => {
    const found = document.querySelector('video');
    expect(found).not.toBeNull();
    return found as HTMLVideoElement;
  });
  const state = drive(el);
  fireEvent.loadedMetadata(el);
  return { el, state };
}

const moveTo = (el: HTMLMediaElement, state: Driven, sec: number) => {
  state.currentTime = sec;
  fireEvent.timeUpdate(el);
};

const lit = () => [...document.querySelectorAll('[data-turn-row][aria-current="true"]')].map((row) => row.getAttribute('data-turn-row'));

beforeEach(() => {
  vi.clearAllMocks();
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  mockApi.getMe.mockResolvedValue(ME_ADMIN);
  mockApi.getR1Recording.mockResolvedValue({ ...recording(), url: 'https://media.example.com/r1.mp4?sig=abc', content_type: 'video/mp4', expires_in_sec: 300 });
  mockApi.cancelR1PendingReject.mockResolvedValue({ ok: true, auto_status_disabled: false });
});

describe('loading and failing', () => {
  it('keeps every block at its final size while it loads', () => {
    mockApi.getR1Review.mockReturnValue(new Promise(() => undefined));
    open();
    expect(screen.getByRole('status', { name: 'Loading the R1 review' })).toBeInTheDocument();
    expect(document.querySelector('[data-review-skeleton="header"]')).not.toBeNull();
    expect(document.querySelector('[data-review-skeleton="tabs"]')).not.toBeNull();
    expect(document.querySelector('[data-review-skeleton="body"]')).not.toBeNull();
  });

  it('says what went wrong in plain words, and Retry reads again', async () => {
    mockApi.getR1Review.mockRejectedValueOnce(new TestApiError('service_unavailable', 503));
    open();
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('service_unavailable');
    expect(alert).toHaveTextContent(/try again/i);
    mockApi.getR1Review.mockResolvedValue(review());
    await userEvent.click(within(alert).getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('tablist', { name: 'R1 review sections' })).toBeInTheDocument();
    expect(mockApi.getR1Review).toHaveBeenCalledTimes(2);
  });

  it.each([[400, 'invalid_id'], [403, 'access_denied'], [404, 'not_found']])('shows one generic state for a %i, with nothing to retry', async (status, code) => {
    mockApi.getR1Review.mockRejectedValue(new TestApiError(code, status));
    open();
    expect(await screen.findByText('This interview is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('asks for the round once, by the id in the address', async () => {
    await opened();
    expect(mockApi.getR1Review).toHaveBeenCalledTimes(1);
    expect(mockApi.getR1Review).toHaveBeenCalledWith(ROUND);
  });
});

describe('the header', () => {
  it('carries the breadcrumb and the title, with the name linking to the candidate', async () => {
    await opened();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs).toHaveTextContent('R1 interviews');
    expect(crumbs).toHaveTextContent('Ava Example');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Sales Program Advisor role-play, Ava Example');
    expect(within(heading).getByRole('link', { name: 'Ava Example' })).toHaveAttribute('href', `/candidates/${CANDIDATE}?tab=overview`);
  });

  it('carries the chips: ended, role, attempt, recording and how long it is kept', async () => {
    await opened(review({ attempts: [attempt({ ended_at: new Date(Date.now() - 3 * 3_600_000).toISOString() })] }));
    const chips = screen.getByRole('list', { name: 'About this interview' });
    expect(chips).toHaveTextContent(/Ended .+ ago/);
    expect(chips).toHaveTextContent('Sales Program Advisor');
    expect(chips).toHaveTextContent('Attempt 1 (counted)');
    expect(chips).toHaveTextContent('Ready');
    expect(chips).toHaveTextContent(/Kept until/);
  });

  it('leaves out a role it does not know, rather than guessing', async () => {
    const body = review();
    body.candidate.role_title = null;
    await opened(body);
    expect(screen.getByRole('list', { name: 'About this interview' })).not.toHaveTextContent('Sales Program Advisor');
  });

  it('offers a switcher when there are two attempts, and it changes the recording', async () => {
    const second = attempt({ session_id: 's2', attempt_number: 2, turns: [turn(0, 2, 'bot', 'opening', 'Welcome back.')] });
    await opened(review({ attempts: [attempt(), second] }));
    const switcher = screen.getByRole('group', { name: 'Attempt' });
    await userEvent.click(within(switcher).getByRole('button', { name: 'Attempt 2 (retake)' }));
    expect(address).toContain('attempt=2');
    await userEvent.click(tab('Recording'));
    expect(await within(panel('Recording')).findByText('Welcome back.')).toBeInTheDocument();
    expect(within(panel('Recording')).queryByText('Hello, I am Christy.')).not.toBeInTheDocument();
  });

  it('has no feedback tab and no placeholder for one', async () => {
    await opened();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Briefing', 'Resume', 'Recording']);
  });
});

describe('the address', () => {
  it('opens the tab it names, and keeps the choice in it', async () => {
    await opened(review(), '?tab=resume');
    expect(tab('Resume')).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(tab('Briefing'));
    expect(address).toContain('tab=briefing');
  });

  it('opens Overview for a tab this build does not have', async () => {
    await opened(review(), '?tab=feedback');
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the named attempt', async () => {
    const second = attempt({ session_id: 's2', attempt_number: 2, turns: [turn(0, 2, 'bot', 'opening', 'Welcome back.')] });
    await opened(review({ attempts: [attempt(), second] }), '?tab=recording&attempt=2');
    expect(within(panel('Recording')).getByText('Welcome back.')).toBeInTheDocument();
  });

  it('cues the position it names, without minting a link', async () => {
    await opened(review(), '?tab=recording&t=125');
    expect(lit()).toEqual(['3']);
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });
});

describe('Overview, scored', () => {
  it('labels the result as AI and says it is not a decision', async () => {
    await opened();
    const result = screen.getByRole('region', { name: 'AI recommendation' });
    expect(result).toHaveTextContent('Borderline');
    expect(result).toHaveTextContent('58');
    expect(result).toHaveTextContent('Not a hiring decision');
  });

  it('draws the verdict in position and word, with no tone', async () => {
    await opened();
    const mark = document.querySelector('[data-verdict-mark]')!;
    expect(mark).toHaveAttribute('data-verdict-mark', 'half');
    expect(mark.getAttribute('class') ?? '').not.toMatch(/voice|danger|error|wash/);
  });

  it('shows all five metric rows open, each with its rationale', async () => {
    await opened();
    const rows = screen.getByRole('list', { name: 'AI rubric ratings' });
    expect(within(rows).getAllByRole('listitem')).toHaveLength(5);
    for (const name of METRICS) expect(within(rows).getByText(`${name} rationale.`)).toBeInTheDocument();
  });

  it('marks a metric with no score as insufficient evidence, never as zero', async () => {
    const body = review();
    body.assessment!.metric_results[1] = { ...body.assessment!.metric_results[1], score: null, evidence_status: 'insufficient_evidence' };
    await opened(body);
    expect(within(screen.getByRole('list', { name: 'AI rubric ratings' })).getByText('Insufficient evidence')).toBeInTheDocument();
  });

  it('says a provisional score is one, in the words the phone scorecard uses', async () => {
    const body = review();
    body.assessment!.scoring_status = 'incomplete_evidence';
    body.assessment!.metric_results[1] = { ...body.assessment!.metric_results[1], score: null };
    await opened(body);
    expect(screen.getByText(/^Provisional: scored from 4 of 5 metrics/)).toBeInTheDocument();
  });

  it('opens Recording at the cited turn from a quote', async () => {
    await opened();
    await userEvent.click(screen.getByRole('button', { name: /What made you look at it now/ }));
    expect(tab('Recording')).toHaveAttribute('aria-selected', 'true');
    expect(address).toContain('tab=recording');
    expect(address).toContain('t=125');
    expect(lit()).toEqual(['3']);
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('opens the attempt that was scored, not the one on screen', async () => {
    const second = attempt({ session_id: 's2', attempt_number: 2, turns: [] });
    await opened(review({ attempts: [attempt(), second] }), '?attempt=2');
    await userEvent.click(screen.getByRole('button', { name: /What made you look at it now/ }));
    expect(address).toContain('attempt=1');
    expect(within(panel('Recording')).getByText('Hello, I am Christy.')).toBeInTheDocument();
  });

  it('leaves a quote it cannot place as plain text', async () => {
    const body = review();
    body.assessment!.metric_results[0].evidence = [{ turn_index: 99, quote: 'A quote with no turn' }];
    await opened(body);
    expect(screen.getByText(/A quote with no turn/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /A quote with no turn/ })).not.toBeInTheDocument();
  });

  it('lists what to check, and nothing when every check passed', async () => {
    await opened();
    expect(screen.getByRole('region', { name: 'Check before trusting it' })).toHaveTextContent('Nothing to flag.');
  });

  it('names failed checks and a disagreement in plain words', async () => {
    const body = review();
    body.assessment!.r1 = { ...body.assessment!.r1, gate: { passed: false, failures: ['roleplay_too_short'] }, agreement: { runs_agree: false } };
    await opened(body);
    const checks = screen.getByRole('region', { name: 'Check before trusting it' });
    expect(checks).toHaveTextContent('The role-play was too short to score reliably.');
    expect(checks).toHaveTextContent('The two scoring runs disagreed.');
  });

  it('labels the ratings as AI, as it does the result', async () => {
    await opened();
    expect(screen.getByRole('region', { name: 'AI rubric ratings' })).toBeInTheDocument();
  });

  it('names the attempt the result is for when there are two: the switcher looks page-wide', async () => {
    const second = attempt({ session_id: 's2', attempt_number: 2 });
    await opened(review({ attempts: [attempt(), second] }), '?attempt=2');
    expect(screen.getByRole('region', { name: 'AI recommendation' })).toHaveTextContent('This result is for Attempt 1 (counted).');
  });

  it('needs no attempt named when there is only one', async () => {
    await opened();
    expect(screen.getByRole('region', { name: 'AI recommendation' })).not.toHaveTextContent('This result is for');
  });

  it('lists the needs, revealed or not, each revealed one seeking to its turn', async () => {
    await opened();
    const needs = screen.getByRole('region', { name: 'Needs revealed' });
    expect(needs).toHaveTextContent('1 of 3 revealed');
    expect(needs).toHaveTextContent('Need 2');
    expect(within(needs).getAllByText('Not revealed')).toHaveLength(2);
    await userEvent.click(within(needs).getByRole('button', { name: /T4/ }));
    expect(tab('Recording')).toHaveAttribute('aria-selected', 'true');
    expect(lit()).toEqual(['4']);
  });

  it('counts a need whose turn is unknown as revealed, and says the turn is what is unknown', async () => {
    await opened(review({ events: [{ session_id: 's1', event_type: 'need_revealed', turn_index: null, family_id: null, need: 'H2', kind: null, created_at: null }] }));
    const needs = screen.getByRole('region', { name: 'Needs revealed' });
    expect(needs).toHaveTextContent('1 of 3 revealed');
    expect(needs).toHaveTextContent('Revealed, turn unknown');
    expect(within(needs).getAllByText('Not revealed')).toHaveLength(2);
  });

  it('checks the recording of the attempt that was scored, not the one on screen', async () => {
    const second = attempt({ session_id: 's2', attempt_number: 2, recording: recording({ has_video: false }) });
    await opened(review({ attempts: [attempt(), second] }), '?attempt=2');
    expect(screen.getByRole('region', { name: 'Check before trusting it' })).toHaveTextContent('Nothing to flag.');
  });

  it('adds one line of phone context with a link', async () => {
    await opened(review({ phone_screening: { recommendation: 'advance', overall_score: 71, created_at: '2026-10-30T00:00:00.000Z', evidence_grade: 'decision', scoring_status: 'complete' } }));
    const line = screen.getByText(/Phone screening/);
    expect(line).toHaveTextContent('Select 71 (AI)');
    expect(within(line).getByRole('link', { name: 'Open the candidate' })).toHaveAttribute('href', `/candidates/${CANDIDATE}?tab=review`);
  });

  it('never sets a held phone score beside the verdict as a result', async () => {
    await opened(review({ phone_screening: { recommendation: 'reject', overall_score: 30, created_at: null, evidence_grade: 'insufficient', scoring_status: 'complete' } }));
    const line = screen.getByText(/Phone screening/);
    expect(line).toHaveTextContent('Held: not enough evidence (AI)');
    expect(line).not.toHaveTextContent('Reject');
    expect(line).not.toHaveTextContent('30');
  });

  it('says a provisional phone score is one', async () => {
    await opened(review({ phone_screening: { recommendation: 'reject', overall_score: 30, created_at: null, evidence_grade: 'decision', scoring_status: 'incomplete_evidence' } }));
    expect(screen.getByText(/Phone screening/)).toHaveTextContent('Reject 30, provisional (AI)');
  });
});

describe('Overview, in every other state', () => {
  const noResult = () => {
    expect(screen.queryByRole('region', { name: 'AI recommendation' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-verdict-mark]')).toBeNull();
  };

  it('invited: when the link runs out, and no review content yet', async () => {
    await opened(review({ assessment: null, attempts: [], round: { ...review().round, status: 'invited', recommendation: null, overall: null } }));
    expect(panel('Overview')).toHaveTextContent(/Link valid until/);
    noResult();
  });

  const live = () => review({
    assessment: null,
    attempts: [attempt({ session_status: 'in_progress', ended_at: null, in_progress: true, turns: [], recording: recording({ state: 'recording', started_at_ms: null, duration_ms: null }) })],
    round: { ...review().round, status: 'in_progress', recommendation: null, overall: null },
  });

  it('in progress: says so, says when the link runs out, and shows no result', async () => {
    await opened(live());
    expect(panel('Overview')).toHaveTextContent('The interview is in progress.');
    expect(panel('Overview')).toHaveTextContent(/Link valid until/);
    noResult();
  });

  it('in progress: the header says so too', async () => {
    await opened(live());
    expect(screen.getByRole('list', { name: 'About this interview' })).toHaveTextContent('In progress');
  });

  const waiting = (over: Partial<R1ReviewAttempt> = {}) => review({
    assessment: null,
    attempts: [attempt({ counted: false, outcome: 'provider_error', session_status: 'failed', ended_at: new Date(Date.now() - 60_000).toISOString(), ...over })],
    round: { ...review().round, status: 'in_progress', attempts_counted: 0, recommendation: null, overall: null },
  });

  it('an attempt that ended uncounted: nobody is in it, and the link is still open', async () => {
    await opened(waiting());
    expect(panel('Overview')).toHaveTextContent('No interview is running.');
    expect(panel('Overview')).toHaveTextContent(/Link valid until/);
    expect(panel('Overview')).not.toHaveTextContent('in progress');
    const chips = screen.getByRole('list', { name: 'About this interview' });
    expect(chips).toHaveTextContent('Link open');
    expect(chips).not.toHaveTextContent('In progress');
    noResult();
  });

  it('an attempt that ended uncounted: Check again sees a new start, because the page does not poll', async () => {
    await opened(waiting());
    mockApi.getR1Review.mockResolvedValue(live());
    await userEvent.click(within(panel('Overview')).getByRole('button', { name: 'Check again' }));
    expect(await within(panel('Overview')).findByText(/The interview is in progress/)).toBeInTheDocument();
  });

  it('a withdrawal in the opening reads no differently: nothing says an interview is running', async () => {
    await opened(waiting({
      outcome: 'candidate_left', consent_withdrawn: true, transcript_hidden: true, turns: [],
      recording: recording({ state: 'deleted', reason: 'consent_withdrawn', started_at_ms: null, duration_ms: null, mode: null, has_video: null, retention_until: null }),
    }));
    expect(screen.getByText('The transcript is hidden.')).toBeInTheDocument();
    expect(panel('Overview')).toHaveTextContent('No interview is running.');
    expect(panel('Overview')).not.toHaveTextContent('in progress');
  });

  it('in progress: no transcript yet, and it says why rather than that none was saved', async () => {
    await opened(live(), '?tab=recording');
    expect(panel('Recording')).toHaveTextContent('The transcript appears here once the interview ends.');
    expect(panel('Recording')).not.toHaveTextContent('No transcript lines were saved');
  });

  const scoring = () => review({
    assessment: null,
    attempts: [attempt({ ended_at: new Date(Date.now() - 60_000).toISOString() })],
    round: { ...review().round, recommendation: null, overall: null },
  });

  it('scoring: says so, and shows no result', async () => {
    await opened(scoring());
    expect(panel('Overview')).toHaveTextContent('Scoring in progress.');
    noResult();
  });

  it('scoring: Check again reads the round, and the result takes over: the page does not poll', async () => {
    await opened(scoring());
    mockApi.getR1Review.mockResolvedValue(review());
    await userEvent.click(within(panel('Overview')).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('region', { name: 'AI recommendation' })).toBeInTheDocument();
    expect(mockApi.getR1Review).toHaveBeenCalledTimes(2);
  });

  const stale = 'This page could not be refreshed, so it may be out of date.';

  it('a Check again that fails says so, keeps the page, and offers another try', async () => {
    await opened(scoring());
    mockApi.getR1Review.mockRejectedValueOnce(new TestApiError('service_unavailable', 503));
    await userEvent.click(within(panel('Overview')).getByRole('button', { name: 'Check again' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(stale);
    expect(alert).not.toHaveTextContent('service_unavailable');
    expect(panel('Overview')).toHaveTextContent('Scoring in progress.');

    mockApi.getR1Review.mockResolvedValue(review());
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'AI recommendation' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a second failure is news again: the notice comes back rather than sit there unchanged', async () => {
    await opened(scoring());
    mockApi.getR1Review.mockRejectedValue(new TestApiError('service_unavailable', 503));
    await userEvent.click(within(panel('Overview')).getByRole('button', { name: 'Check again' }));
    const first = await screen.findByRole('alert');
    await userEvent.click(within(first).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mockApi.getR1Review).toHaveBeenCalledTimes(3));
    const second = await screen.findByRole('alert');
    expect(second).toHaveTextContent(stale);
    expect(second).not.toBe(first);
  });

  it('a Check again that finds the round gone says so, rather than warn about an old page', async () => {
    await opened(scoring());
    mockApi.getR1Review.mockRejectedValue(new TestApiError('not_found', 404));
    await userEvent.click(within(panel('Overview')).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('This interview is not available.')).toBeInTheDocument();
  });

  it('a round whose consent was withdrawn never says a score is coming', async () => {
    const left = attempt({
      session_status: 'failed', outcome: 'candidate_left', ended_at: new Date(Date.now() - 60_000).toISOString(), consent_withdrawn: true, transcript_hidden: true, turns: [],
      recording: recording({ state: 'deleted', reason: 'consent_withdrawn', started_at_ms: null, duration_ms: null, mode: null, has_video: null, retention_until: null }),
    });
    await opened(review({ assessment: null, attempts: [left], round: { ...review().round, recommendation: null, overall: null } }));
    expect(panel('Overview')).toHaveTextContent('This round ended without a scored interview.');
    expect(panel('Overview')).not.toHaveTextContent('Scoring in progress');
    expect(within(panel('Overview')).queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('a round that scoring never reached ends the same way, a day on', async () => {
    const old = attempt({ ended_at: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString() });
    await opened(review({ assessment: null, attempts: [old], round: { ...review().round, recommendation: null, overall: null } }));
    expect(panel('Overview')).toHaveTextContent('This round ended without a scored interview.');
  });

  it('closed: says the round ended with nothing to review', async () => {
    await opened(review({ assessment: null, attempts: [], round: { ...review().round, status: 'expired', recommendation: null, overall: null } }));
    expect(panel('Overview')).toHaveTextContent('This round ended without a scored interview.');
  });

  it('human review: "Not scored" with the reason, and no verdict or figure', async () => {
    const a = assessment({ recommendation: null, raw_recommendation: 'human_review', overall_score: null, r1: { ...assessment().r1, outcome: 'no_candidate_speech', valid: false } });
    await opened(review({ assessment: a, round: { ...review().round, recommendation: null, overall: null } }));
    expect(panel('Overview')).toHaveTextContent('Not scored: the candidate said too little in the scored phases.');
    expect(document.querySelector('[data-verdict-mark]')).toBeNull();
  });

  it('human review with ratings: says plainly they gave no usable result, under the AI label', async () => {
    const a = assessment({ recommendation: null, raw_recommendation: 'human_review', overall_score: null, r1: { ...assessment().r1, outcome: 'scored', valid: false, gate: { passed: false, failures: ['runs_disagree'] } } });
    await opened(review({ assessment: a, round: { ...review().round, recommendation: null, overall: null } }));
    expect(panel('Overview')).toHaveTextContent('Not scored: the interview did not pass its checks.');
    const ratings = screen.getByRole('region', { name: 'AI rubric ratings' });
    expect(ratings).toHaveTextContent('These AI ratings gave no usable result. They are here for human review only.');
    expect(within(ratings).getAllByRole('listitem')).toHaveLength(5);
  });

  it('a usable result carries no such warning', async () => {
    await opened();
    expect(panel('Overview')).not.toHaveTextContent('no usable result');
  });

  it('an appeal: the existing notices, and no score anywhere', async () => {
    await opened(review({ assessment: null, round: { ...review().round, recommendation: null, overall: null, scores_withheld: true } }));
    expect(screen.getByText('Decision use is paused — open appeal')).toBeInTheDocument();
    expect(panel('Overview')).toHaveTextContent('Scorecards are suppressed while an appeal is under review.');
    noResult();
    expect(screen.queryByRole('region', { name: 'Check before trusting it' })).not.toBeInTheDocument();
  });

  it('an appeal keeps the interview itself: the transcript still reads', async () => {
    await opened(review({ assessment: null, round: { ...review().round, recommendation: null, overall: null, scores_withheld: true } }), '?tab=recording');
    expect(within(panel('Recording')).getByText('Hello, I am Christy.')).toBeInTheDocument();
  });
});

describe('a staff dry run', () => {
  it('is marked in the header and in a banner', async () => {
    await opened(review({ round: { ...review().round, is_staff_dry_run: true } }));
    expect(screen.getByRole('list', { name: 'About this interview' })).toHaveTextContent('Staff dry run');
    expect(screen.getByRole('note')).toHaveTextContent('Not used for any decision');
  });

  it('is not marked otherwise', async () => {
    await opened();
    expect(screen.queryByText('Not used for any decision')).not.toBeInTheDocument();
  });
});

describe('a pending rejection', () => {
  const pending = () => review({ round: { ...review().round, recommendation: 'reject', status_write: 'pending_reject', pending_reject_until: '2026-11-06T10:00:00.000Z', created_by: 'interviewer-1' } });

  it('shows in the header, and Cancel asks first', async () => {
    await opened(pending());
    expect(screen.getByRole('list', { name: 'About this interview' })).toHaveTextContent(/Rejection pending until/);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel rejection' }));
    expect(mockApi.cancelR1PendingReject).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Cancel this pending rejection?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it pending' }));
    expect(mockApi.cancelR1PendingReject).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancels on confirm, and reads the round again', async () => {
    await opened(pending());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel rejection' }));
    mockApi.getR1Review.mockResolvedValue(review());
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel the rejection' }));
    await waitFor(() => expect(mockApi.cancelR1PendingReject).toHaveBeenCalledWith(ROUND));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockApi.getR1Review).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('list', { name: 'About this interview' })).not.toHaveTextContent(/Rejection pending/);
  });

  it('shows a cancel that worked even when the re-read after it fails', async () => {
    await opened(pending());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel rejection' }));
    mockApi.getR1Review.mockRejectedValue(new TestApiError('service_unavailable', 503));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel the rejection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This page could not be refreshed, so it may be out of date.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'About this interview' })).not.toHaveTextContent(/Rejection pending/);
    expect(screen.queryByRole('button', { name: 'Cancel rejection' })).not.toBeInTheDocument();
  });

  it('says so in plain words when it was no longer pending, and refreshes', async () => {
    mockApi.cancelR1PendingReject.mockRejectedValue(new TestApiError('not_pending', 409));
    await opened(pending());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel rejection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel the rejection' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('This rejection is no longer pending.');
    expect(mockApi.getR1Review).toHaveBeenCalledTimes(2);
  });

  it('offers Cancel to the interviewer who sent the round, and to nobody else', async () => {
    mockApi.getMe.mockResolvedValue({ userId: 'interviewer-1', role: 'interviewer' });
    const { unmount } = await opened(pending());
    expect(await screen.findByRole('button', { name: 'Cancel rejection' })).toBeInTheDocument();
    unmount();

    mockApi.getMe.mockResolvedValue({ userId: 'someone-else', role: 'interviewer' });
    const other = await opened(pending());
    await waitFor(() => expect(mockApi.getMe).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Cancel rejection' })).not.toBeInTheDocument();
    other.unmount();

    mockApi.getMe.mockResolvedValue({ userId: 'viewer-1', role: 'viewer' });
    await opened(pending());
    await waitFor(() => expect(mockApi.getMe).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('button', { name: 'Cancel rejection' })).not.toBeInTheDocument();
  });

  it('offers nothing when who is asking cannot be read', async () => {
    mockApi.getMe.mockRejectedValue(new TestApiError('unavailable', 503));
    await opened(pending());
    await waitFor(() => expect(mockApi.getMe).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Cancel rejection' })).not.toBeInTheDocument();
  });
});

describe('Briefing', () => {
  it('shows what the candidate saw, from the scenario card', async () => {
    await opened(review(), '?tab=briefing');
    const briefing = panel('Briefing');
    expect(briefing).toHaveTextContent('$9,000');
    expect(briefing).toHaveTextContent('6 months');
    expect(briefing).toHaveTextContent('Your goal: understand their needs');
  });

  it('shows every rubric level', async () => {
    await opened(review(), '?tab=briefing');
    const briefing = panel('Briefing');
    for (const name of METRICS) expect(within(briefing).getByText(`${name} level one.`)).toBeInTheDocument();
  });

  it('shows the phases, with the two role-play clock readings', async () => {
    await opened(review(), '?tab=briefing');
    expect(panel('Briefing')).toHaveTextContent('14:00');
    expect(panel('Briefing')).toHaveTextContent('20:00');
  });

  it('says who the learner was, and nothing of what she held back', async () => {
    await opened(review(), '?tab=briefing');
    const persona = within(panel('Briefing')).getByRole('region', { name: 'The AI learner' });
    expect(persona).toHaveTextContent('Priya Nair');
    expect(persona).toHaveTextContent('Career switcher');
  });
});

describe('Resume', () => {
  it('shows the parsed facts', async () => {
    await opened(review(), '?tab=resume');
    const resume = panel('Resume');
    expect(resume).toHaveTextContent('Sold courses for four years.');
    expect(resume).toHaveTextContent('Advisor · Example Co');
    expect(resume).toHaveTextContent('BA Economics');
    expect(resume).toHaveTextContent('Sales');
  });

  it('says so when there is none', async () => {
    const body = review();
    body.candidate = { ...body.candidate, resume: null, skills: [], experience_years: null };
    await opened(body, '?tab=resume');
    expect(panel('Resume')).toHaveTextContent('No resume on file');
  });
});

describe('Recording: the controls', () => {
  const recordingTab = () => opened(review(), '?tab=recording');

  it('mints nothing until the first play, then plays', async () => {
    await recordingTab();
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
    const { state } = await pressPlay();
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    expect(mockApi.getR1Recording).toHaveBeenCalledWith(ROUND, 's1');
    expect(state.paused).toBe(false);
  });

  it('turns Play into Pause while it plays', async () => {
    await recordingTab();
    const { el, state } = await pressPlay();
    fireEvent.play(el);
    const pause = await screen.findByRole('button', { name: 'Pause' });
    fireEvent.click(pause);
    expect(state.paused).toBe(true);
    fireEvent.pause(el);
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('skips back and forward 15 seconds', async () => {
    await recordingTab();
    const { el, state } = await pressPlay();
    moveTo(el, state, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }));
    expect(state.currentTime).toBe(115);
    fireEvent.click(screen.getByRole('button', { name: 'Back 15 seconds' }));
    expect(state.currentTime).toBe(100);
  });

  it('moves the cued position without a link, and never mints for it', async () => {
    await recordingTab();
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }));
    expect(screen.getByTestId('position')).toHaveTextContent('0:30');
    expect(lit()).toEqual(['1']);
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('plays from the cued position', async () => {
    await opened(review(), '?tab=recording&t=200');
    const { state } = await pressPlay();
    expect(state.sets.at(-1)).toBeCloseTo(199.75);
  });

  it('skips within a recording whose length is not known yet', async () => {
    const body = review();
    body.attempts[0] = attempt({ recording: recording({ duration_ms: null }), turns: [] });
    await opened(body, '?tab=recording');
    const { el, state } = await pressPlay();
    moveTo(el, state, 40);
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }));
    expect(state.currentTime).toBe(55);
  });

  it('never skips past either end', async () => {
    await recordingTab();
    const { el, state } = await pressPlay();
    moveTo(el, state, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Back 15 seconds' }));
    expect(state.currentTime).toBe(0);
    moveTo(el, state, 1495);
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }));
    expect(state.currentTime).toBe(1500);
  });

  it('shows the time and the length', async () => {
    await recordingTab();
    const { el, state } = await pressPlay();
    moveTo(el, state, 75);
    expect(screen.getByTestId('position')).toHaveTextContent('1:15');
    expect(screen.getByTestId('length')).toHaveTextContent('25:00');
  });

  it('offers the speeds from 0.75x to 2x, and applies one', async () => {
    await recordingTab();
    const { el } = await pressPlay();
    await userEvent.click(screen.getByRole('button', { name: /^Speed/, expanded: false }));
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['0.75x', '1x', '1.25x', '1.5x', '1.75x', '2x']);
    await userEvent.keyboard('{Escape}');
    await chooseSpeed('1.5x');
    expect(el.playbackRate).toBe(1.5);
  });

  it('mutes and sets the volume', async () => {
    await recordingTab();
    const { el } = await pressPlay();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(el.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '40' } });
    expect(el.volume).toBeCloseTo(0.4);
  });

  it('puts a speed, a volume and a mute chosen before the first play on the media', async () => {
    await recordingTab();
    await chooseSpeed('1.5x');
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    const { el } = await pressPlay();
    expect(el.playbackRate).toBe(1.5);
    expect(el.volume).toBeCloseTo(0.4);
    expect(el.muted).toBe(true);
  });

  it('keeps them on the fresh link a re-mint brings: a new source resets the media', async () => {
    await recordingTab();
    const { el } = await pressPlay();
    await chooseSpeed('1.25x');
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));

    mockApi.getR1Recording.mockResolvedValue({ ...recording(), url: 'https://media.example.com/r1.mp4?sig=fresh', content_type: 'video/mp4', expires_in_sec: 300 });
    fireEvent.error(el);
    await waitFor(() => expect(el.getAttribute('src')).toContain('sig=fresh'));
    el.playbackRate = 1;
    el.volume = 1;
    el.muted = false;
    fireEvent.loadedMetadata(el);
    expect(el.playbackRate).toBe(1.25);
    expect(el.volume).toBeCloseTo(0.6);
    expect(el.muted).toBe(true);
  });

  it('keeps nodownload on the video', async () => {
    await recordingTab();
    const { el } = await pressPlay();
    expect(el).toHaveAttribute('controlslist', 'nodownload');
    expect(el).not.toHaveAttribute('controls');
  });
});

describe('Recording: bringing focus in', () => {
  const picture = () => document.querySelector('[data-r1-recording-state]') as HTMLElement;

  it('lands on Play when the tab is pressed, so K and Space answer at once', async () => {
    await opened();
    await userEvent.click(tab('Recording'));
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play).toHaveFocus();
    fireEvent.keyDown(play, { key: 'k' });
    await waitFor(() => expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1));
  });

  it('leaves the arrow keys with the tabs', async () => {
    await opened(review(), '?tab=resume');
    tab('Resume').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tab('Recording')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Recording')).toHaveFocus();
  });

  it('does not take focus from the attempt switcher', async () => {
    const second = attempt({ session_id: 's2', attempt_number: 2, turns: [turn(0, 2, 'bot', 'opening', 'Welcome back.')] });
    await opened(review({ attempts: [attempt(), second] }));
    await userEvent.click(tab('Recording'));
    const next = within(screen.getByRole('group', { name: 'Attempt' })).getByRole('button', { name: 'Attempt 2 (retake)' });
    await userEvent.click(next);
    expect(screen.getByRole('button', { name: 'Play' })).not.toHaveFocus();
  });

  it('plays and pauses from a click on the picture', async () => {
    await opened(review(), '?tab=recording');
    fireEvent.click(picture());
    const el = await waitFor(() => {
      const found = document.querySelector('video');
      expect(found).not.toBeNull();
      return found as HTMLVideoElement;
    });
    const state = drive(el);
    fireEvent.loadedMetadata(el);
    expect(state.paused).toBe(false);
    fireEvent.click(el);
    expect(state.paused).toBe(true);
    fireEvent.click(el);
    expect(state.paused).toBe(false);
  });

  it('takes focus into the panel from that click, so the keys answer after it', async () => {
    await opened(review(), '?tab=recording');
    await userEvent.click(picture());
    expect(screen.getByRole('group', { name: 'Recording player' })).toHaveFocus();
  });

  it('takes neither Try again nor the error block for the picture', async () => {
    mockApi.getR1Recording.mockRejectedValueOnce(new TestApiError('service_unavailable', 503));
    await opened(review(), '?tab=recording');
    fireEvent.click(picture());
    const alert = await within(panel('Recording')).findByRole('alert');
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByText(/Could not load/));
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole('button', { name: /^Try again/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
  });
});

describe('Recording: when the media fails', () => {
  const minted = (sig: string) => ({ ...recording(), url: `https://media.example.com/r1.mp4?sig=${sig}`, content_type: 'video/mp4', expires_in_sec: 300 });

  /** Play, then two errors inside 30 s: the player drops the element. */
  async function dropped() {
    mockApi.getR1Recording.mockResolvedValueOnce(minted('one')).mockResolvedValueOnce(minted('two'));
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    fireEvent.play(el);
    await screen.findByRole('button', { name: 'Pause' });
    moveTo(el, state, 100);
    fireEvent.error(el);
    await waitFor(() => expect(el.getAttribute('src')).toContain('sig=two'));
    fireEvent.loadedMetadata(el);
    fireEvent.error(el);
    return within(panel('Recording')).findByRole('alert');
  }

  it('goes back to Play when the element is dropped: it never sends its pause', async () => {
    await dropped();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });

  it('plays again from the button after Try again, at the same place', async () => {
    const alert = await dropped();
    fireEvent.click(within(alert).getByRole('button', { name: /^Try again/ }));
    const el = await waitFor(() => {
      const found = document.querySelector('video');
      expect(found).not.toBeNull();
      return found as HTMLVideoElement;
    });
    const state = drive(el);
    fireEvent.loadedMetadata(el);
    expect(state.currentTime).toBe(100);
    expect(state.paused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(state.paused).toBe(false);
  });

  it('decides from the media, not from the button: a media that stopped silently plays on a press of Pause', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    fireEvent.play(el);
    state.paused = true;
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(state.paused).toBe(false);
  });

  it('keeps the clicked moment through a failed first load: Try again, then Play, starts at that turn', async () => {
    mockApi.getR1Recording.mockRejectedValueOnce(new TestApiError('service_unavailable', 503));
    await opened(review(), '?tab=recording');
    fireEvent.click(screen.getByRole('button', { name: /^Play from 2:05/ }));
    const alert = await within(panel('Recording')).findByRole('alert');
    expect(screen.getByTestId('position')).toHaveTextContent('2:05');
    fireEvent.click(within(alert).getByRole('button', { name: /^Try again/ }));
    const el = await waitFor(() => {
      const found = document.querySelector('video');
      expect(found).not.toBeNull();
      return found as HTMLVideoElement;
    });
    const state = drive(el);
    fireEvent.loadedMetadata(el);
    expect(state.sets).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(state.sets).toEqual([124.75]);
    expect(state.paused).toBe(false);
    expect(screen.getByTestId('position')).toHaveTextContent('2:05');
    expect(lit()).toEqual(['3']);
  });

  it('skips from the reader\'s place after that, not from the start of the media', async () => {
    mockApi.getR1Recording.mockRejectedValueOnce(new TestApiError('service_unavailable', 503));
    await opened(review(), '?tab=recording');
    fireEvent.click(screen.getByRole('button', { name: /^Play from 2:05/ }));
    const alert = await within(panel('Recording')).findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: /^Try again/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }));
    expect(screen.getByTestId('position')).toHaveTextContent('2:20');
  });
});

describe('Recording: the keyboard', () => {
  const inside = () => screen.getByRole('button', { name: 'Forward 15 seconds' });

  it('plays and pauses on K and Space, from anywhere in the player', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    fireEvent.play(el);
    fireEvent.keyDown(inside(), { key: 'k' });
    expect(state.paused).toBe(true);
    fireEvent.pause(el);
    fireEvent.keyDown(screen.getByRole('group', { name: 'Recording player' }), { key: ' ' });
    expect(state.paused).toBe(false);
  });

  it('leaves Space on a button to the button: one press is one action', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    fireEvent.play(el);
    fireEvent.keyDown(inside(), { key: ' ' });
    expect(state.paused).toBe(false);
  });

  it('skips 15 seconds on J and L, and 5 on the arrows', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    moveTo(el, state, 100);
    fireEvent.keyDown(inside(), { key: 'l' });
    expect(state.currentTime).toBe(115);
    fireEvent.keyDown(inside(), { key: 'j' });
    expect(state.currentTime).toBe(100);
    fireEvent.keyDown(inside(), { key: 'ArrowRight' });
    expect(state.currentTime).toBe(105);
    fireEvent.keyDown(inside(), { key: 'ArrowLeft' });
    expect(state.currentTime).toBe(100);
  });

  it('changes the speed on [ and ]', async () => {
    await opened(review(), '?tab=recording');
    const { el } = await pressPlay();
    fireEvent.keyDown(inside(), { key: ']' });
    expect(el.playbackRate).toBe(1.25);
    fireEvent.keyDown(inside(), { key: '[' });
    fireEvent.keyDown(inside(), { key: '[' });
    expect(el.playbackRate).toBe(0.75);
    fireEvent.keyDown(inside(), { key: '[' });
    expect(el.playbackRate).toBe(0.75);
  });

  it('leaves its keys to the speed list: arrows there move the list, not the recording', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    moveTo(el, state, 100);
    fireEvent.keyDown(screen.getByRole('button', { name: /^Speed/ }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('button', { name: /^Speed/ }), { key: 'k' });
    expect(state.currentTime).toBe(100);
    expect(state.paused).toBe(false);
  });

  it('takes no key from the transcript search, or with a modifier held', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    moveTo(el, state, 100);
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search the transcript' }), { key: 'l' });
    expect(state.currentTime).toBe(100);
    fireEvent.keyDown(inside(), { key: 'l', ctrlKey: true });
    expect(state.currentTime).toBe(100);
  });
});

describe('Recording: seeking from the transcript', () => {
  const timecode = (label: string) => screen.getByRole('button', { name: new RegExp(`^Play from ${label}`) });

  it('makes the timecode the button, and leaves the words selectable', async () => {
    await opened(review(), '?tab=recording');
    const words = screen.getByText('Hi, I saw your course.');
    expect(words.closest('button')).toBeNull();
    expect(timecode('2:00')).toBeInTheDocument();
  });

  it('mints on the first click and lands just before the turn', async () => {
    await opened(review(), '?tab=recording');
    fireEvent.click(timecode('2:05'));
    const el = await waitFor(() => {
      const found = document.querySelector('video');
      expect(found).not.toBeNull();
      return found as HTMLVideoElement;
    });
    const state = drive(el);
    fireEvent.loadedMetadata(el);
    expect(state.sets).toEqual([124.75]);
    expect(state.paused).toBe(false);
  });

  it('lights the clicked row at once, and holds it through the lead-in', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    fireEvent.click(timecode('2:05'));
    expect(lit()).toEqual(['3']);
    // The lead-in: by the highlight rule this position belongs to the row before.
    moveTo(el, state, 124.75);
    expect(lit()).toEqual(['3']);
    moveTo(el, state, 125);
    expect(lit()).toEqual(['3']);
    // Past the start the rule is back, and the row after can take over.
    moveTo(el, state, 200);
    expect(lit()).toEqual(['4']);
  });

  it('keeps a click that lands the moment new rows commit, before that render has settled', async () => {
    const pending = { ...review().round, recommendation: 'reject' as const, status_write: 'pending_reject' as const, pending_reject_until: '2026-11-06T10:00:00.000Z' };
    await opened(review({ round: pending }), '?tab=recording');
    const { el, state } = await pressPlay();

    // A re-read brings a row the page did not have.
    mockApi.getR1Review.mockResolvedValue(review({ attempts: [attempt({ turns: [...TURNS, turn(6, 500, 'bot', 'closing', 'Goodbye for now.')] })] }));

    // React runs a render's passive effects in a later task, so a click queued behind that render lands
    // between the two. A mutation observer is a microtask: this click lands there every time.
    const watcher = new MutationObserver(() => {
      const row = document.querySelector<HTMLButtonElement>('button[aria-label^="Play from 8:20"]');
      if (!row) return;
      watcher.disconnect();
      row.click();
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => watcher.disconnect());

    await userEvent.click(screen.getByRole('button', { name: 'Cancel rejection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel the rejection' }));
    await screen.findByText('Goodbye for now.');
    await waitFor(() => expect(state.sets.at(-1)).toBe(499.75));

    // The lead-in: by the highlight rule this position belongs to the row before, so only a hold that
    // survived the commit keeps the clicked row lit.
    moveTo(el, state, 499.75);
    expect(lit()).toEqual(['6']);
  });

  it('ends the hold on a scrub out of the lead-in', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    fireEvent.click(timecode('2:05'));
    moveTo(el, state, 40);
    expect(lit()).toEqual(['1']);
  });

  it('lets no row stay lit when the click failed', async () => {
    mockApi.getR1Recording.mockRejectedValue(new TestApiError('service_unavailable', 503));
    await opened(review(), '?tab=recording');
    fireEvent.click(timecode('2:05'));
    expect(lit()).toEqual(['3']);
    await within(panel('Recording')).findByRole('alert');
    expect(lit()).toEqual([]);
  });

  it('ignores the position while a seek is on its way', async () => {
    await opened(review(), '?tab=recording');
    fireEvent.click(timecode('2:05'));
    const el = await waitFor(() => {
      const found = document.querySelector('video');
      expect(found).not.toBeNull();
      return found as HTMLVideoElement;
    });
    const state = drive(el);
    moveTo(el, state, 0);
    expect(lit()).toEqual(['3']);
  });

  it('takes a quote to the media when it is already loaded, and holds the row through the lead-in', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    await userEvent.click(tab('Overview'));
    await userEvent.click(screen.getByRole('button', { name: /What made you look at it now/ }));
    expect(state.currentTime).toBe(124.75);
    moveTo(el, state, 124.75);
    expect(lit()).toEqual(['3']);
  });

  it('seeks from an evidence tick on the strip', async () => {
    await opened(review(), '?tab=recording');
    const { state } = await pressPlay();
    fireEvent.click(screen.getByRole('button', { name: /^Evidence 1/ }));
    expect(state.currentTime).toBe(124.75);
    expect(lit()).toEqual(['3']);
  });

  it('seeks from a logged moment on the strip', async () => {
    await opened(review(), '?tab=recording');
    const { state } = await pressPlay();
    fireEvent.click(screen.getByRole('button', { name: /^Need 1 revealed/ }));
    expect(state.currentTime).toBe(199.75);
  });

  it('marks a turn with no time plainly, and offers no button for it', async () => {
    const body = review();
    body.attempts[0].turns = [turn(0, null, 'bot', 'opening', 'A line with no time.')];
    await opened(body, '?tab=recording');
    expect(screen.queryByRole('button', { name: /^Play from/ })).not.toBeInTheDocument();
    expect(screen.getByText('No time')).toBeInTheDocument();
  });
});

describe('Recording: the transcript panel', () => {
  it('names each speaker, AI as AI', async () => {
    await opened(review(), '?tab=recording');
    const transcript = screen.getByRole('region', { name: 'Transcript' });
    expect(within(transcript).getAllByText('Christy (AI interviewer)').length).toBeGreaterThan(0);
    expect(within(transcript).getAllByText('Priya Nair (AI learner)').length).toBeGreaterThan(0);
    expect(within(transcript).getAllByText('Ava Example').length).toBeGreaterThan(0);
  });

  it('labels a turn by the stored voice where there is one', async () => {
    const body = review();
    body.attempts[0].turns = [{ ...turn(0, 5, 'bot', 'aside', 'I really have to go soon.'), ai_voice: 'learner' }];
    await opened(body, '?tab=recording');
    expect(document.querySelector('[data-turn-row="0"]')).toHaveTextContent('Priya Nair (AI learner)');
  });

  it('draws a talk bar where an end is stored, and a tick everywhere else', async () => {
    const body = review();
    body.attempts[0].turns = [
      { ...turn(0, 5, 'candidate', 'roleplay', 'Timed end.'), turn_ended_at_ms: START + 20_000 },
      turn(1, 30, 'candidate', 'roleplay', 'No end.'),
      { ...turn(2, 40, 'bot', 'roleplay', 'A cut line.'), turn_ended_at_ms: START + 60_000, interrupted: true },
    ];
    await opened(body, '?tab=recording');
    expect(document.querySelectorAll('[data-talk-bar]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-turn-tick]')).toHaveLength(2);
  });

  it('falls back to "AI learner"', async () => {
    const body = review();
    body.attempts[0].learner_name = null;
    await opened(body, '?tab=recording');
    expect(within(screen.getByRole('region', { name: 'Transcript' })).getAllByText('AI learner').length).toBeGreaterThan(0);
  });

  it('divides the transcript by phase', async () => {
    await opened(review(), '?tab=recording');
    const dividers = [...document.querySelectorAll('[data-phase-divider]')].map((d) => d.textContent);
    expect(dividers).toEqual(['Opening', 'Icebreaker', 'Role-play', 'Wrap-up']);
  });

  it('labels a cited turn with its metric and highlights the words', async () => {
    await opened(review(), '?tab=recording');
    const row = document.querySelector('[data-turn-row="3"]') as HTMLElement;
    expect(row).toHaveTextContent('Cited · Probing & discovery');
    expect(row.querySelector('mark')).toHaveTextContent('What made you look at it now');
  });

  it('says when a turn was cut off', async () => {
    const body = review();
    body.attempts[0].turns = [{ ...turn(0, 5, 'bot', 'roleplay', 'I was saying'), interrupted: true }];
    await opened(body, '?tab=recording');
    expect(document.querySelector('[data-turn-row="0"]')).toHaveTextContent('Cut off');
  });

  it('searches the words, and says how many it found', async () => {
    await opened(review(), '?tab=recording');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the transcript' }), 'plant');
    expect(screen.getByText('My plant is closing.')).toBeInTheDocument();
    expect(screen.queryByText('Hello, I am Christy.')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 6 turns')).toBeInTheDocument();
  });

  it('says when nothing matched', async () => {
    await opened(review(), '?tab=recording');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the transcript' }), 'zebra');
    expect(screen.getByText('No turn matches.')).toBeInTheDocument();
  });

  it('filters to the candidate', async () => {
    await opened(review(), '?tab=recording');
    await userEvent.click(screen.getByRole('button', { name: 'Candidate only' }));
    expect(screen.getByText('Happy to be here today.')).toBeInTheDocument();
    expect(screen.queryByText('Hello, I am Christy.')).not.toBeInTheDocument();
  });

  it('stops following when the reader scrolls, and Back to current brings them back', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    moveTo(el, state, 40);
    expect(screen.queryByRole('button', { name: 'Back to current' })).not.toBeInTheDocument();
    const scroller = screen.getByRole('region', { name: 'Transcript turns' });
    fireEvent.wheel(scroller);
    const back = await screen.findByRole('button', { name: 'Back to current' });
    scroller.scrollTop = 0;
    fireEvent.click(back);
    expect(screen.queryByRole('button', { name: 'Back to current' })).not.toBeInTheDocument();
  });

  it('follows again from a row the reader plays', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    moveTo(el, state, 40);
    fireEvent.wheel(screen.getByRole('region', { name: 'Transcript turns' }));
    await screen.findByRole('button', { name: 'Back to current' });
    fireEvent.click(screen.getByRole('button', { name: /^Play from 2:05/ }));
    expect(screen.queryByRole('button', { name: 'Back to current' })).not.toBeInTheDocument();
  });
});

describe('Recording: following', () => {
  const scroller = () => screen.getByRole('region', { name: 'Transcript turns' });
  const back = () => screen.queryByRole('button', { name: 'Back to current' });

  async function following() {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    moveTo(el, state, 40);
  }

  it('stops on a scrollbar drag, which sends nothing but `scroll`', async () => {
    await following();
    scroller().scrollTop = 500;
    fireEvent.scroll(scroller());
    expect(await screen.findByRole('button', { name: 'Back to current' })).toBeInTheDocument();
  });

  it('keeps following through a `scroll` of its own', async () => {
    await following();
    fireEvent.scroll(scroller());
    expect(back()).not.toBeInTheDocument();
  });

  it('stops on a press in the words: selecting text must not be pulled away', async () => {
    await following();
    fireEvent.pointerDown(screen.getByText('Hi, I saw your course.'));
    expect(await screen.findByRole('button', { name: 'Back to current' })).toBeInTheDocument();
  });

  it('does not flash Back to current on a press of a timecode', async () => {
    await following();
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Play from 2:05/ }));
    expect(back()).not.toBeInTheDocument();
  });
});

describe('Recording: the strip in words', () => {
  const words = () => document.querySelector('[data-call-strip] figcaption')?.textContent ?? '';

  it('names every phase, however narrow its box', async () => {
    await opened(review(), '?tab=recording');
    expect(words()).toContain('Phases: Opening from 0:05, Icebreaker from 0:30, Role-play from 2:00, Wrap-up from 6:40.');
  });

  it('says where the two role-play lines fall', async () => {
    const body = review();
    body.attempts[0].turns = [turn(0, 100, 'bot', 'roleplay', 'Hi.'), turn(1, 1400, 'candidate', 'wrapup', 'Bye.')];
    await opened(body, '?tab=recording');
    expect(words()).toContain('Earliest offer to wrap up at 15:40, End of the role-play at 21:40.');
  });
});

describe('Recording: when there is nothing to play', () => {
  it.each([
    ['none', { state: 'none' as const, started_at_ms: null, duration_ms: null, retention_until: null }, 'No recording was made for this attempt.'],
    ['failed', { state: 'failed' as const, reason: 'capture_failed', started_at_ms: null, duration_ms: null }, 'Recording failed during the interview.'],
    ['deleted', { state: 'deleted' as const, reason: 'retention', deleted_at: '2026-11-04T00:00:00.000Z', started_at_ms: null, duration_ms: null }, 'after the retention period'],
  ])('%s: the state sentence, no player, and the transcript still reads', async (_name, over, sentence) => {
    const body = review();
    body.attempts[0].recording = recording(over);
    await opened(body, '?tab=recording');
    const recordingPanel = panel('Recording');
    expect(recordingPanel).toHaveTextContent(sentence);
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    expect(within(recordingPanel).getByText('Hello, I am Christy.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Play from/ })).not.toBeInTheDocument();
  });

  it('keeps a time into the call on a row with no recording, as plain text', async () => {
    const body = review();
    body.attempts[0].recording = recording({ state: 'none', started_at_ms: null, duration_ms: null });
    await opened(body, '?tab=recording');
    expect(document.querySelector('[data-turn-row="1"]')).toHaveTextContent('0:25');
  });

  it('asks again for a recording still being prepared', async () => {
    const body = review();
    body.attempts[0].recording = recording({ state: 'processing', started_at_ms: null, duration_ms: null });
    await opened(body, '?tab=recording');
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(mockApi.getR1Review).toHaveBeenCalledTimes(2));
  });

  it('says so when no attempt exists yet', async () => {
    await opened(review({ assessment: null, attempts: [], round: { ...review().round, status: 'invited' } }), '?tab=recording');
    expect(panel('Recording')).toHaveTextContent('There is no recording yet.');
  });
});

describe('Recording: partial and audio-only', () => {
  it('notices a partial recording, and bands it on the strip', async () => {
    const body = review();
    body.attempts[0].recording = recording({ state: 'partial', reason: 'crash_recovered' });
    await opened(body, '?tab=recording');
    expect(panel('Recording')).toHaveTextContent('Recovered after an interruption; it may end early.');
    expect(document.querySelector('[data-band]')).toHaveTextContent('Partial recording');
  });

  it('notices an audio-only recording, and bands it on the strip', async () => {
    const body = review();
    body.attempts[0].recording = recording({ has_video: false, reason: 'video_unavailable' });
    await opened(body, '?tab=recording');
    expect(panel('Recording')).toHaveTextContent('The camera was not available, so this is an audio-only recording.');
    expect(document.querySelector('[data-band]')).toHaveTextContent('Audio only');
  });

  it('carries both to Overview, under Check before trusting it', async () => {
    const body = review();
    body.attempts[0].recording = recording({ has_video: false, reason: 'video_unavailable' });
    await opened(body);
    expect(screen.getByRole('region', { name: 'Check before trusting it' })).toHaveTextContent('audio-only recording');
  });
});

describe('after consent is withdrawn', () => {
  const withdrawn = () => {
    const body = review();
    body.attempts[0] = attempt({
      consent_withdrawn: true, transcript_hidden: true, turns: [],
      recording: recording({ state: 'deleted', reason: 'consent_withdrawn', started_at_ms: null, duration_ms: null, mode: null, has_video: null, retention_until: null }),
    });
    // The API drops the rationales and the quotes with the transcript.
    body.assessment!.metric_results = body.assessment!.metric_results.map((metric) => ({ ...metric, evidence: [], rationale: null }));
    return body;
  };

  it('disables the Recording tab and gives the reason in the existing words', async () => {
    await opened(withdrawn());
    expect(tab('Recording')).toBeDisabled();
    expect(screen.getByText('This recording was deleted because consent was withdrawn.')).toBeInTheDocument();
  });

  it('says the transcript is hidden', async () => {
    await opened(withdrawn());
    expect(screen.getByText('The transcript is hidden.')).toBeInTheDocument();
  });

  it('gives the reason when there was no recording to delete', async () => {
    const body = withdrawn();
    body.attempts[0].recording = recording({ state: 'none', started_at_ms: null, duration_ms: null, mode: null, has_video: null, retention_until: null });
    await opened(body);
    expect(screen.getByText('No recording was made for this attempt.')).toBeInTheDocument();
    expect(screen.getByText('The transcript is hidden because consent was withdrawn.')).toBeInTheDocument();
    expect(tab('Recording')).toBeDisabled();
  });

  it('says each rating\'s detail is hidden, and keeps the rating', async () => {
    await opened(withdrawn());
    const ratings = screen.getByRole('region', { name: 'AI rubric ratings' });
    expect(within(ratings).getAllByText('Detail hidden with the transcript.')).toHaveLength(5);
    expect(within(ratings).getAllByText('3/4')).toHaveLength(5);
  });

  it('hides no detail of a scored attempt that kept its transcript', async () => {
    await opened();
    expect(screen.queryByText('Detail hidden with the transcript.')).not.toBeInTheDocument();
  });

  it('falls back to Overview from an address that names Recording', async () => {
    await opened(withdrawn(), '?tab=recording');
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps Recording for an attempt made after the withdrawal', async () => {
    const body = withdrawn();
    body.attempts.push(attempt({ session_id: 's2', attempt_number: 2 }));
    await opened(body, '?attempt=2');
    expect(tab('Recording')).not.toBeDisabled();
  });
});

describe('never a link in the page', () => {
  it('keeps the signed link out of the text and every attribute but src', async () => {
    await opened(review(), '?tab=recording');
    await pressPlay();
    expect(document.body.textContent).not.toContain('sig=abc');
    for (const node of document.body.querySelectorAll('*')) {
      for (const attribute of node.attributes) {
        if (attribute.name !== 'src') expect(attribute.value).not.toContain('sig=abc');
      }
    }
  });
});

describe('a hidden tab', () => {
  it('pauses the recording, and keeps the place', async () => {
    await opened(review(), '?tab=recording');
    const { el, state } = await pressPlay();
    // The position first: once `play` starts the frame loop only a frame reports it, and the click below
    // can pause the media before one runs.
    moveTo(el, state, 100);
    fireEvent.play(el);
    await userEvent.click(tab('Overview'));
    expect(state.paused).toBe(true);
    await userEvent.click(tab('Recording'));
    expect(screen.getByTestId('position')).toHaveTextContent('1:40');
  });
});

describe('a restart: two attempts with one number', () => {
  const failedStart = () => attempt({
    session_id: 's0', counted: false, outcome: 'provider_error', session_status: 'failed',
    turns: [turn(0, 2, 'bot', 'opening', 'A line from the failed start.')],
  });
  const orders: Array<[string, () => R1ReviewAttempt[]]> = [
    ['the failed start first', () => [failedStart(), attempt()]],
    ['the scored run first', () => [attempt(), failedStart()]],
  ];
  const switcher = () => screen.getByRole('group', { name: 'Attempt' });
  const transcript = () => within(panel('Recording'));

  it.each(orders)('takes a quote to the run it came from, with %s', async (_order, attempts) => {
    await opened(review({ attempts: attempts() }));
    await userEvent.click(screen.getByRole('button', { name: /What made you look at it now/ }));
    expect(await transcript().findByText('Hi, I saw your course.')).toBeInTheDocument();
    expect(transcript().queryByText('A line from the failed start.')).not.toBeInTheDocument();
    expect(lit()).toEqual(['3']);
    expect(address).toContain('t=125');
  });

  it('puts the place in the list in the address, not the number they share', async () => {
    await opened(review({ attempts: [failedStart(), attempt()] }));
    await userEvent.click(screen.getByRole('button', { name: /What made you look at it now/ }));
    expect(address).toContain('attempt=2');
  });

  it.each(orders)('reaches each from the switcher, with %s', async (_order, attempts) => {
    await opened(review({ attempts: attempts() }), '?tab=recording');
    await userEvent.click(within(switcher()).getByRole('button', { name: 'Attempt 1 (not counted)' }));
    expect(await transcript().findByText('A line from the failed start.')).toBeInTheDocument();
    await userEvent.click(within(switcher()).getByRole('button', { name: 'Attempt 1 (counted)' }));
    expect(await transcript().findByText('Hi, I saw your course.')).toBeInTheDocument();
    expect(transcript().queryByText('A line from the failed start.')).not.toBeInTheDocument();
  });

  it('marks one of them as chosen, and gives React no duplicate key', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());
    await opened(review({ attempts: [failedStart(), attempt()] }));
    const pressed = within(switcher()).getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((button) => button.textContent)).toEqual(['Attempt 1 (counted)']);
    expect(logged.mock.calls.flat().join(' ')).not.toContain('same key');
  });

  it('opens the address it wrote: the place survives a reload', async () => {
    await opened(review({ attempts: [failedStart(), attempt()] }), '?tab=recording&attempt=1');
    expect(transcript().getByText('A line from the failed start.')).toBeInTheDocument();
  });
});

describe('between attempts', () => {
  it('starts the player over, on the new attempt', async () => {
    const second = attempt({ session_id: 's2', attempt_number: 2, turns: [turn(0, 2, 'bot', 'opening', 'Welcome back.')] });
    await opened(review({ attempts: [attempt(), second] }), '?tab=recording&attempt=1');
    await pressPlay();
    await act(async () => {
      await userEvent.click(within(screen.getByRole('group', { name: 'Attempt' })).getByRole('button', { name: 'Attempt 2 (retake)' }));
    });
    expect(document.querySelector('video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(mockApi.getR1Recording).toHaveBeenLastCalledWith(ROUND, 's2'));
  });
});
