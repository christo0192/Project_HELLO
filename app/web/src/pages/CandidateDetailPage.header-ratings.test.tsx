/**
 * The header's rating summary on the real page: it sits in the header and not in the Phone screening
 * panel, it goes with that tab, it costs the API nothing, and the last candidate's figures are gone before
 * the next candidate's page has read anything. An R1 result stands beside it and never stands in for it.
 */
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidateDetailPage } from './CandidateDetailPage';
import { ApiError } from '../api';
import { mockCandidateDetail } from '../test/helpers';

const mockApi = {
  getCandidate: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
  listNotes: vi.fn().mockResolvedValue({ notes: [] }),
  listAppeals: vi.fn().mockResolvedValue({ appeals: [] }),
  exportReportAudit: vi.fn().mockResolvedValue(undefined),
  startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
  getSession: vi.fn(),
  getCandidateAshbyWorkflow: vi.fn().mockResolvedValue({ ok: true, workflow: null }),
  listR1Rounds: vi.fn().mockResolvedValue({ rounds: [] }),
  getR1Availability: vi.fn().mockResolvedValue({ state: 'disabled', hold_minutes: 55 }),
  getCandidatePhoneAttempts: vi.fn().mockResolvedValue({ attempts: [], next_cursor: null }),
  getAttemptRecordingDownloadUrl: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    getCandidate: (...args: unknown[]) => mockApi.getCandidate(...args),
    getRecordingDownloadUrl: (...args: unknown[]) => mockApi.getRecordingDownloadUrl(...args),
    listNotes: (...args: unknown[]) => mockApi.listNotes(...args),
    listAppeals: (...args: unknown[]) => mockApi.listAppeals(...args),
    exportReportAudit: (...args: unknown[]) => mockApi.exportReportAudit(...args),
    startLiveKitScreening: (...args: unknown[]) => mockApi.startLiveKitScreening(...args),
    getSession: (...args: unknown[]) => mockApi.getSession(...args),
    getCandidateAshbyWorkflow: (...args: unknown[]) => mockApi.getCandidateAshbyWorkflow(...args),
    listR1Rounds: (...args: unknown[]) => mockApi.listR1Rounds(...args),
    getR1Availability: (...args: unknown[]) => mockApi.getR1Availability(...args),
    getCandidatePhoneAttempts: (...args: unknown[]) => mockApi.getCandidatePhoneAttempts(...args),
    getAttemptRecordingDownloadUrl: (...args: unknown[]) => mockApi.getAttemptRecordingDownloadUrl(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

vi.mock('../lib/supabase', () => {
  const makeChannel = () => {
    const channel: { on: () => unknown; subscribe: () => string } = { on: () => channel, subscribe: () => 'mock-sub' };
    return channel;
  };
  const makeQuery = () => {
    const query: Record<string, unknown> = {};
    query.select = () => query;
    query.eq = () => query;
    query.order = () => query;
    query.limit = () => Promise.resolve({ data: null, error: null });
    return query;
  };
  return { supabase: { from: () => makeQuery(), channel: () => makeChannel(), removeChannel: () => undefined } };
});

function metric(id: string, name: string, score: number | null) {
  return {
    configMetricId: id,
    score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: `${name} rationale.`,
    evidenceRefs: [],
    metric: { id, name, weightBps: 5000 },
  };
}

function detailFor(candidateId: string, name: string, metrics: ReturnType<typeof metric>[], over: Record<string, unknown> = {}) {
  const session = { ...mockCandidateDetail.sessions[0], id: `session-${candidateId}`, candidate_id: candidateId, mode: 'live' };
  const assessment = {
    id: `assessment-${candidateId}`,
    session_id: session.id,
    schema_version: 2,
    scoring_status: 'complete',
    overall_score: 70,
    recommendation: 'advance',
    summary: '',
    role_fit: { score: 0, matched_skills: [], gaps: [], red_flags: [], notes: '' },
    raw: { schemaVersion: 2, status: 'complete', scoreScaleMax: 4, metricResults: metrics, weightedScore5: 3, overallScore: 70, recommendation: 'advance' },
  };
  return {
    candidate: { ...mockCandidateDetail.candidate, id: candidateId, name, decision_use_blocked_at: null, ...over },
    sessions: [session],
    assessments: [assessment],
    assessment,
  };
}

const ASHA = detailFor('asha', 'Asha Rao', [metric('m-a', 'Rapport', 4), metric('m-b', 'Closing', 2)]);
const BALA = detailFor('bala', 'Bala Iyer', [metric('m-c', 'Stability', 1)]);

/** Reads each candidate's own screening from what its detail carries. */
function answerFrom(...details: Array<typeof ASHA>) {
  mockApi.getSession.mockImplementation(async (id: string) => {
    const detail = details.find((d) => d.sessions[0].id === id)!;
    return { session: detail.sessions[0], transcript: [{ speaker: 'bot', text: 'What is your monthly target?', start_offset_sec: 1 }], assessment: detail.assessment };
  });
}

let go: (path: string) => void = () => undefined;
function Navigator() {
  go = useNavigate();
  return null;
}

function renderPage(path = '/candidates/asha') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Navigator />
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const place = () => document.querySelector<HTMLElement>('[data-header-ratings]');
const rating = async (name: RegExp) => {
  await waitFor(() => expect(place()).not.toBeNull());
  return within(place()!).findByRole('button', { name });
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { __allowConsole?: (pattern: RegExp) => void }).__allowConsole?.(/inside a test was not wrapped in act/);
  mockApi.getCandidate.mockImplementation(async (id: string) => (id === 'bala' ? BALA : ASHA));
  // `clearAllMocks` keeps an answer a test set, and a scored round left from one would print a line in the next.
  mockApi.listR1Rounds.mockResolvedValue({ rounds: [] });
  answerFrom(ASHA, BALA);
});

describe('the rating summary on the candidate page', () => {
  it('sits in the header, after the name and after the actions, outside the Phone screening panel', async () => {
    renderPage();
    const item = await rating(/^Rapport/);
    expect(item).toHaveAttribute('aria-label', 'Rapport, Excellent, 4 of 4');
    expect(item.closest('[role="tabpanel"]')).toBeNull();
    expect(item.closest('[data-header-ratings]')).toBe(place());
    const name = screen.getByRole('heading', { level: 1, name: 'Asha Rao' });
    expect(name.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Under Export report on screen, mostly, so after the actions in the Tab order: focus never climbs back up to them.
    expect(document.querySelector('[data-header-actions]')!.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['Profile', 'R1 interview'])('goes with the Phone screening tab for %s, and comes back with no second read', async (other) => {
    renderPage();
    await rating(/^Rapport/);
    expect(mockApi.getSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: other }));
    await waitFor(() => expect(place()).toBeNull());
    expect(document.querySelector('[data-header-rating]')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Phone screening' }));
    expect(await rating(/^Rapport/)).toBeInTheDocument();
    expect(mockApi.getSession).toHaveBeenCalledTimes(1);
  });

  it.each(['profile', 'r1', 'overview'])('is not on a page opened with ?tab=%s', async (tab) => {
    renderPage(`/candidates/asha?tab=${tab}`);
    await screen.findByRole('heading', { level: 1, name: 'Asha Rao' });
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalled());
    expect(place()).toBeNull();
    expect(document.querySelector('[data-header-rating]')).toBeNull();
  });

  it.each(['phone', 'review'])('is on a page opened with ?tab=%s', async (tab) => {
    renderPage(`/candidates/asha?tab=${tab}`);
    expect(await rating(/^Rapport/)).toBeInTheDocument();
  });

  it('prints nothing while decision use is blocked', async () => {
    const blocked = detailFor('asha', 'Asha Rao', [metric('m-a', 'Rapport', 4)], { decision_use_blocked_at: '2026-10-01T00:00:00.000Z' });
    mockApi.getCandidate.mockResolvedValue(blocked);
    answerFrom(blocked);
    renderPage();
    expect(await screen.findByText('Scorecards are suppressed while an appeal is under review.')).toBeInTheDocument();
    expect(place()).toBeEmptyDOMElement();
  });

  it('clears on a change of candidate, before the next page has read anything', async () => {
    renderPage();
    await rating(/^Rapport/);

    let answer: (detail: typeof BALA) => void = () => undefined;
    mockApi.getCandidate.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    act(() => go('/candidates/bala'));
    expect(document.body).not.toHaveTextContent('Rapport');
    expect(document.querySelector('[data-header-rating]')).toBeNull();

    await act(async () => answer(BALA));
    expect(await rating(/^Stability/)).toHaveAttribute('aria-label', 'Stability, Poor, 1 of 4');
    expect(place()).not.toHaveTextContent('Rapport');
  });
});

describe('beside an R1 result', () => {
  const R1_LINE = 'R1 role-play: Borderline 58 (AI)';
  const r1Line = () => document.querySelector<HTMLElement>('[data-header-r1-line]');
  const round = (over: Record<string, unknown> = {}) => ({ id: 'round-1', status: 'completed', recommendation: 'hold', overall: 58, attempts: [], ...over });

  /** A phone scorecard, and an R1 session beside it unless the candidate has only one of the two. */
  function withR1(detail: typeof ASHA) {
    const r1Session = { ...detail.sessions[0], id: 'session-r1', interview_round_id: 'round-1' };
    return { ...detail, sessions: [...detail.sessions, r1Session] };
  }

  function r1Only() {
    const detail = withR1(ASHA);
    return {
      ...detail,
      sessions: detail.sessions.filter((session) => session.id === 'session-r1'),
      assessments: [{ ...detail.assessment, id: 'assessment-r1', session_id: 'session-r1' }],
    };
  }

  it('prints both, in the same header', async () => {
    mockApi.getCandidate.mockResolvedValue(withR1(ASHA));
    mockApi.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    renderPage();
    expect(await rating(/^Rapport/)).toBeInTheDocument();
    await waitFor(() => expect(r1Line()).toHaveTextContent(R1_LINE));
    expect(r1Line()!.closest('[data-header-who]')).not.toBeNull();
    expect(place()).not.toHaveTextContent('R1');
  });

  it('keeps the line\'s room from the first paint, before the rounds answer, so nothing moves when they do', async () => {
    mockApi.getCandidate.mockResolvedValue(withR1(ASHA));
    let answer: (result: { rounds: unknown[] }) => void = () => undefined;
    mockApi.listR1Rounds.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    renderPage();
    await rating(/^Rapport/);
    const held = r1Line()!;
    expect(held).toBeEmptyDOMElement();
    // jsdom lays nothing out, so the room is its classes: the widest line's width and one line's height.
    // review.e2e.ts measures both in a browser.
    expect(held).toHaveClass('min-w-[11.25rem]', 'min-h-4');

    await act(async () => answer({ rounds: [round()] }));
    await waitFor(() => expect(r1Line()).toHaveTextContent(R1_LINE));
    expect(r1Line()).toBe(held);
  });

  /** Any element in the who block still holding the line's width, with or without its data attribute. */
  const heldWidth = () => document.querySelector('[data-header-who] .min-w-\\[11\\.25rem\\]');

  // Every rule that hides the line hides its room too, once the rounds have answered: a blank 180px wide
  // would keep the rating summary out of the name row for good, and every R1 round today is unscored.
  it.each([
    ['rounds with no result', () => [round({ recommendation: null, overall: null })]],
    ['no round at all', () => []],
    ['a result that is withheld', () => [round({ scores_withheld: true })]],
    ['a staff dry run\'s result alone', () => [round({ is_staff_dry_run: true })]],
  ])('gives the room back when the rounds answer with %s', async (_what, rounds) => {
    mockApi.getCandidate.mockResolvedValue(withR1(ASHA));
    mockApi.listR1Rounds.mockResolvedValue({ rounds: rounds() });
    renderPage();
    await rating(/^Rapport/);
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalled());
    await waitFor(() => expect(r1Line()).toBeNull());
    expect(heldWidth()).toBeNull();
    expect(screen.queryByText(/^R1 role-play:/)).toBeNull();
  });

  it.each([
    ['fails', () => new Error('service_unavailable')],
    ['is refused', () => new ApiError('R1 is not available for this candidate.', 403)],
  ])('gives the room back when the rounds read %s', async (_what, failure) => {
    mockApi.getCandidate.mockResolvedValue(withR1(ASHA));
    mockApi.listR1Rounds.mockRejectedValue(failure());
    renderPage();
    await rating(/^Rapport/);
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalled());
    await waitFor(() => expect(r1Line()).toBeNull());
    expect(heldWidth()).toBeNull();
  });

  it('holds the room while the read is out, and for the next candidate\'s read after one gave it back', async () => {
    const BALA_R1 = withR1(BALA);
    mockApi.getCandidate.mockImplementation(async (id: string) => (id === 'bala' ? BALA_R1 : withR1(ASHA)));
    mockApi.listR1Rounds.mockResolvedValueOnce({ rounds: [round({ recommendation: null, overall: null })] });
    renderPage();
    await rating(/^Rapport/);
    await waitFor(() => expect(r1Line()).toBeNull());

    let answer: (result: { rounds: unknown[] }) => void = () => undefined;
    mockApi.listR1Rounds.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    act(() => go('/candidates/bala'));
    expect(await rating(/^Stability/)).toBeInTheDocument();
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenLastCalledWith('bala'));
    expect(r1Line()).toBeEmptyDOMElement();
    expect(r1Line()).toHaveClass('min-w-[11.25rem]', 'min-h-4');

    await act(async () => answer({ rounds: [round()] }));
    await waitFor(() => expect(r1Line()).toHaveTextContent(R1_LINE));
  });

  describe('the summary\'s fit, measured again when the room goes', () => {
    /**
     * Lays the header out as a browser would, as header-ratings.test.tsx does: jsdom has no layout. The who
     * block is 180px wider while the R1 line's room is in it, and that takes the room the summary needs.
     */
    function laidOut() {
      const room = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-ratings-fit') ? 1137 : 0;
      });
      const boxes = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const who = 400 + (this.querySelector('[data-header-r1-line]') ? 180 : 0);
        const width = this.hasAttribute('data-header-who') ? who : this.hasAttribute('data-header-actions') ? 120 : 0;
        return { top: 0, bottom: 0, left: 0, right: width, width, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
      return () => {
        room.mockRestore();
        boxes.mockRestore();
      };
    }
    const fit = () => document.querySelector('[data-ratings-fit]')?.getAttribute('data-ratings-fit');

    it('moves the summary back into the name row when the rounds answer with no line', async () => {
      const restore = laidOut();
      try {
        mockApi.getCandidate.mockResolvedValue(withR1(ASHA));
        let answer: (result: { rounds: unknown[] }) => void = () => undefined;
        mockApi.listR1Rounds.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
        renderPage();
        await rating(/^Rapport/);
        expect(r1Line()).toBeEmptyDOMElement();
        expect(fit()).toBe('line');

        await act(async () => answer({ rounds: [round({ recommendation: null, overall: null })] }));
        await waitFor(() => expect(r1Line()).toBeNull());
        expect(fit()).toBe('row');
      } finally {
        restore();
      }
    });

    it('leaves it where it was when the rounds answer with a line, which fills the room kept for it', async () => {
      const restore = laidOut();
      try {
        mockApi.getCandidate.mockResolvedValue(withR1(ASHA));
        let answer: (result: { rounds: unknown[] }) => void = () => undefined;
        mockApi.listR1Rounds.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
        renderPage();
        await rating(/^Rapport/);
        expect(fit()).toBe('line');

        await act(async () => answer({ rounds: [round()] }));
        await waitFor(() => expect(r1Line()).toHaveTextContent(R1_LINE));
        expect(fit()).toBe('line');
      } finally {
        restore();
      }
    });
  });

  it('keeps no room for a candidate with no R1 session', async () => {
    renderPage();
    await rating(/^Rapport/);
    expect(r1Line()).toBeNull();
  });

  it('keeps no room and prints no line while decision use is blocked', async () => {
    const blocked = withR1(detailFor('asha', 'Asha Rao', [metric('m-a', 'Rapport', 4)], { decision_use_blocked_at: '2026-10-01T00:00:00.000Z' }));
    mockApi.getCandidate.mockResolvedValue(blocked);
    mockApi.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    answerFrom(blocked);
    renderPage();
    expect(await screen.findByText('Scorecards are suppressed while an appeal is under review.')).toBeInTheDocument();
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalled());
    expect(r1Line()).toBeNull();
    expect(place()).toBeEmptyDOMElement();
  });

  it.each(['phone', 'review'])('shows no summary for an R1-only candidate on ?tab=%s, however good the R1 result', async (tab) => {
    mockApi.getCandidate.mockResolvedValue(r1Only());
    mockApi.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    renderPage(`/candidates/asha?tab=${tab}`);
    await screen.findByRole('heading', { level: 1, name: 'Asha Rao' });
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalled());
    expect(mockApi.getSession).not.toHaveBeenCalled();
    expect(place()).toBeNull();
    expect(document.querySelector('[data-ratings-fit]')).toBeNull();
    expect(document.querySelector('[data-header-rating]')).toBeNull();
  });

  it('shows no summary for a phone assessment with no completed call, which has no workspace to fill it', async () => {
    const detail = { ...ASHA, sessions: ASHA.sessions.map((session) => ({ ...session, status: 'failed' })) };
    mockApi.getCandidate.mockResolvedValue(detail);
    renderPage('/candidates/asha?tab=phone');
    await screen.findByRole('heading', { level: 1, name: 'Asha Rao' });
    expect(place()).toBeNull();
    expect(document.querySelector('[data-ratings-fit]')).toBeNull();
  });
});
