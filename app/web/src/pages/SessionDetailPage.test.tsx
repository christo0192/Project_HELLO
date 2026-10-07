/**
 * SessionDetailPage — read-only post-session view:
 * loading/error/retry, a humane header (named by the candidate and role,
 * never by the session UUID, with graceful fallbacks when those reads
 * fail), transcript speaker labels + empty state, scorecard presence/absence
 * (truthful) for both assessment generations, on-demand signed-URL recording
 * lifecycle, and axe compliance.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionDetailPage } from './SessionDetailPage';
import { mockAssessment, mockTranscript } from '../test/helpers';

const getSession = vi.fn();
const getRecordingDownloadUrl = vi.fn();
const getCandidate = vi.fn();
const getRole = vi.fn();

vi.mock('../api', () => ({
  api: {
    getSession: (...args: any[]) => getSession(...args),
    getRecordingDownloadUrl: (...args: any[]) => getRecordingDownloadUrl(...args),
    getCandidate: (...args: any[]) => getCandidate(...args),
    getRole: (...args: any[]) => getRole(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const completedSessionDetail = {
  session: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    candidate_id: 'candidate-1',
    role_id: 'role-1',
    status: 'completed',
    mode: 'simulation',
    duration_sec: 360,
    candidate_words: 1234,
    created_at: '2026-06-01T00:00:00Z',
  },
  transcript: mockTranscript,
  assessment: mockAssessment,
};

function renderPage(sessionId = '550e8400-e29b-41d4-a716-446655440000') {
  return render(
    <MemoryRouter initialEntries={[`/screening/${sessionId}`]}>
      <Routes>
        <Route path="/screening/:sessionId" element={<SessionDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A v2 (role-scorecard) row as the wire carries it: no v1 dimension fields. */
const v2Assessment = {
  id: 'a-v2',
  schema_version: 2,
  scoring_status: 'complete',
  weighted_score_5: 3.5,
  score_scale_max: 4,
  overall_score: 86,
  recommendation: 'advance',
  summary: 'Specific, well-evidenced answers.',
  raw: {
    schemaVersion: 2,
    status: 'complete',
    scoreScaleMax: 4,
    weightedScore5: 3.5,
    overallScore: 86,
    recommendation: 'advance',
    metricResults: [
      {
        configMetricId: 'm1',
        score: 4,
        evidenceStatus: 'scored',
        rationale: 'Reasoned about failure modes.',
        evidenceRefs: [],
        metric: { id: 'm1', name: 'Technical depth', weightBps: 6000, rubric: {} },
      },
      {
        configMetricId: 'm2',
        score: 3,
        evidenceStatus: 'scored',
        rationale: 'Clear and structured.',
        evidenceRefs: [],
        metric: { id: 'm2', name: 'Communication clarity', weightBps: 4000, rubric: {} },
      },
    ],
  },
};

describe('SessionDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCandidate.mockResolvedValue({
      candidate: { id: 'candidate-1', name: 'Jane Doe' },
      sessions: [],
      assessments: [],
    });
    getRole.mockResolvedValue({ id: 'role-1', title: 'Frontend Engineer' });
  });

  it('shows loading state initially', () => {
    getSession.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading session…')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    getSession.mockRejectedValueOnce({ message: 'Session not found' });
    renderPage();
    expect(await screen.findByText('Session not found')).toBeInTheDocument();
    getSession.mockResolvedValue(completedSessionDetail);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Transcript')).toBeInTheDocument();
  });

  it('renders read-only session meta and back link to the candidate', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    renderPage();
    const back = await screen.findByRole('link', { name: 'Back to candidate' });
    expect(back).toHaveAttribute('href', '/candidates/candidate-1');
    expect(screen.getByText('6m 0s')).toBeInTheDocument(); // duration_sec 360
    expect(screen.getByText('1,234')).toBeInTheDocument(); // candidate_words
    // Read-only: no composer exists.
    expect(screen.queryByPlaceholderText(/candidate's answer/i)).not.toBeInTheDocument();
  });

  describe('M013 S02: a phone session reads its connected time from the per-call roll-up, never duration_sec', () => {
    const SID = '550e8400-e29b-41d4-a716-446655440000';
    const phone = {
      ...completedSessionDetail,
      session: {
        ...completedSessionDetail.session,
        mode: 'live',
        // The 9f60523d shape after 0125: SQL counted leg A to our
        // reconciler's DETECTION time (75 s) and left leg B (reclaimed) out.
        duration_sec: 75,
        duration_unobserved_legs: 1,
      },
    };
    const candidateWith = (session: Record<string, unknown>) => ({
      candidate: { id: 'candidate-1', name: 'Jane Doe' },
      sessions: [{ id: SID, ...session }],
      assessments: [],
    });

    it('9f60523d: leg A only detected, leg B unobserved -> "Not known", never the 75 s detection lag', async () => {
      getSession.mockResolvedValue(phone);
      // The roll-up the candidate header reads: leg A `detected`, leg B
      // `unobserved`, so connected is not complete and has no total.
      getCandidate.mockResolvedValue(candidateWith({
        recorded_total_sec: 70.8, recorded_legs: 2, connected_complete: false, connected_total_sec: null,
        connected_unobserved_legs: 1, connected_detected_legs: 1, connected_open_legs: 0,
      }));
      renderPage();
      await screen.findByText('Connected time');
      expect(screen.queryByText('Duration')).toBeNull();
      // Both reasons, from the roll-up (review round 3): leg B unobserved,
      // leg A's end only approximate.
      expect(document.querySelector('[data-session-connected]')?.textContent).toBe(
        "Not known (1 call's end not observed; 1 call's end time approximate)",
      );
      expect(document.body.textContent).not.toContain('1m 15s');
      expect(document.querySelector('[data-session-recorded]')?.textContent).toBe('1m 11s across 2 calls');
    });

    it('a call end only our reconciler detected reads approximate; the reason never comes from SQL duration_unobserved_legs', async () => {
      // SQL says 3 unobserved legs; the roll-up (the truth the page shows)
      // says one detected end. The page follows the roll-up.
      getSession.mockResolvedValue({ ...phone, session: { ...phone.session, duration_unobserved_legs: 3 } });
      getCandidate.mockResolvedValue(candidateWith({
        connected_complete: false, connected_total_sec: null,
        connected_unobserved_legs: 0, connected_detected_legs: 1, connected_open_legs: 0,
      }));
      renderPage();
      await screen.findByText('Connected time');
      expect(document.querySelector('[data-session-connected]')?.textContent).toBe(
        "Not known (1 call's end time approximate)",
      );
    });

    it('pluralises the unobserved note', async () => {
      getSession.mockResolvedValue({
        ...phone,
        session: { ...phone.session, duration_sec: null, duration_unobserved_legs: 2 },
      });
      getCandidate.mockResolvedValue(candidateWith({
        connected_complete: false, connected_total_sec: null,
        connected_unobserved_legs: 2, connected_detected_legs: 0, connected_open_legs: 0,
      }));
      renderPage();
      await screen.findByText('Connected time');
      expect(document.querySelector('[data-session-connected]')?.textContent).toBe(
        "Not known (2 calls' ends not observed)",
      );
      // The roll-up has no recorded total for this session: no recorded row.
      expect(document.querySelector('[data-session-recorded]')).toBeNull();
    });

    it('a LIVE call reads "Call in progress", never "Not known" or "approximate" (review round 3)', async () => {
      getSession.mockResolvedValue({
        ...phone,
        session: { ...phone.session, status: 'in_progress', duration_sec: null, duration_unobserved_legs: null },
      });
      getCandidate.mockResolvedValue(candidateWith({
        connected_complete: false, connected_total_sec: null,
        connected_unobserved_legs: 0, connected_detected_legs: 0, connected_open_legs: 1,
      }));
      renderPage();
      await screen.findByText('Connected time');
      const text = document.querySelector('[data-session-connected]')?.textContent;
      expect(text).toBe('Call in progress');
      expect(text).not.toMatch(/not known|approximate/i);
    });

    it('an open call on an ENDED session is not "in progress": its end was not observed', async () => {
      getSession.mockResolvedValue({
        ...phone,
        session: { ...phone.session, status: 'completed', duration_sec: null, duration_unobserved_legs: null },
      });
      getCandidate.mockResolvedValue(candidateWith({
        connected_complete: false, connected_total_sec: null,
        connected_unobserved_legs: 0, connected_detected_legs: 0, connected_open_legs: 1,
      }));
      renderPage();
      await screen.findByText('Connected time');
      const text = document.querySelector('[data-session-connected]')?.textContent;
      expect(text).toBe("Not known (1 call's end not observed)");
      expect(text).not.toMatch(/in progress/i);
    });

    it('a failed session with a reclaimed call says its end was not observed (SQL count is null there)', async () => {
      getSession.mockResolvedValue({
        ...phone,
        session: { ...phone.session, status: 'failed', duration_sec: null, duration_unobserved_legs: null },
      });
      getCandidate.mockResolvedValue(candidateWith({
        connected_complete: false, connected_total_sec: null,
        connected_unobserved_legs: 1, connected_detected_legs: 0, connected_open_legs: 0,
      }));
      renderPage();
      await screen.findByText('Connected time');
      expect(document.querySelector('[data-session-connected]')?.textContent).toBe(
        "Not known (1 call's end not observed)",
      );
    });

    it('never a bare "Not known": a roll-up without reason counts still names a reason', async () => {
      getSession.mockResolvedValue(phone);
      getCandidate.mockResolvedValue(candidateWith({ connected_complete: false, connected_total_sec: null }));
      renderPage();
      await screen.findByText('Connected time');
      expect(document.querySelector('[data-session-connected]')?.textContent).toBe(
        "Not known (a call's end time is uncertain)",
      );
    });

    it('a complete roll-up with a 0 s total reads "Under 1s"; with no total the row is omitted', async () => {
      getSession.mockResolvedValue(phone);
      getCandidate.mockResolvedValue(candidateWith({ connected_complete: true, connected_total_sec: 0 }));
      const { unmount } = renderPage();
      await screen.findByText('Connected time');
      expect(document.querySelector('[data-session-connected]')?.textContent).toBe('Under 1s');
      unmount();

      getCandidate.mockResolvedValue(candidateWith({ connected_complete: true, connected_total_sec: null }));
      renderPage();
      await screen.findByText('Details');
      expect(screen.queryByText('Connected time')).toBeNull();
      expect(document.body.textContent).not.toMatch(/Not known/);
    });

    it('no roll-up for the session (read failed / nothing answered): no connected row, never duration_sec', async () => {
      getSession.mockResolvedValue(phone);
      renderPage();
      await screen.findByText('Details');
      expect(screen.queryByText('Connected time')).toBeNull();
      expect(document.body.textContent).not.toContain('1m 15s');
    });

    it('every end known exactly: the roll-up total with no note; a browser session keeps "Duration"', async () => {
      getSession.mockResolvedValue({ ...phone, session: { ...phone.session, duration_unobserved_legs: 0 } });
      getCandidate.mockResolvedValue(candidateWith({ connected_complete: true, connected_total_sec: 61.474 }));
      const { unmount } = renderPage();
      await screen.findByText('Connected time');
      expect(document.querySelector('[data-session-connected]')?.textContent).toBe('1m 1s');
      unmount();

      getSession.mockResolvedValue({
        ...completedSessionDetail,
        session: { ...completedSessionDetail.session, mode: 'browser', duration_unobserved_legs: 1 },
      });
      renderPage();
      await screen.findByText('Duration');
      expect(screen.queryByText('Connected time')).toBeNull();
      expect(screen.getByText('6m 0s')).toBeInTheDocument();
    });
  });

  it('names the page by the candidate and role, never by the session UUID', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Jane Doe’s screening' }),
    ).toBeInTheDocument();
    expect(getCandidate).toHaveBeenCalledWith('candidate-1');
    expect(getRole).toHaveBeenCalledWith('role-1');
    // Role, humanized mode and a d MMM date as the meta line.
    expect(
      screen.getByText(/^Frontend Engineer · Simulation · (31 May|1 Jun)( 2026)?, \d{2}:\d{2}$/),
    ).toBeInTheDocument();
    // The id is a quiet reference with the full value one hover away.
    const ref = screen.getByText('550e8400');
    expect(ref).toHaveAttribute('title', '550e8400-e29b-41d4-a716-446655440000');
    expect(screen.queryByText('550e8400-e29b-41d4-a716-446655440000')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /550e8400/ })).not.toBeInTheDocument();
  });

  it('falls back to the role, then the mode, when the enrichment reads fail', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    getCandidate.mockRejectedValue(new Error('forbidden'));
    const { unmount } = renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Frontend Engineer screening' }),
    ).toBeInTheDocument();
    unmount();

    getRole.mockRejectedValue(new Error('gone'));
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Simulation screening' }),
    ).toBeInTheDocument();
    // The page itself still renders in full.
    expect(screen.getByText('Scorecard')).toBeInTheDocument();
  });

  it('treats a blank candidate name as unknown', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    getCandidate.mockResolvedValue({ candidate: { id: 'candidate-1', name: '   ' } });
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Frontend Engineer screening' }),
    ).toBeInTheDocument();
  });

  it('renders the transcript with speaker labels (no timestamps fabricated)', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    renderPage();
    expect(await screen.findByText('Welcome to the screening.')).toBeInTheDocument();
    expect(screen.getByText('Thank you!')).toBeInTheDocument();
    expect(screen.getAllByText('Bot').length).toBeGreaterThan(0);
    // Truthful turn count.
    expect(screen.getByText('3 speaker turns')).toBeInTheDocument();
  });

  it('shows an empty transcript state when none exists', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      transcript: [],
    });
    renderPage();
    expect(
      await screen.findByText(/No transcript lines recorded for this session yet/i),
    ).toBeInTheDocument();
  });

  it('labels an all-gate session as pre-interview evidence, not a broken screening transcript', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      transcript: [
        { speaker: 'bot', text: 'This call may be recorded.', is_gate: true },
        { speaker: 'candidate', text: 'I understand.', is_gate: true },
      ],
    });
    renderPage();
    expect(await screen.findByText('Pre-interview gate transcript')).toBeInTheDocument();
    expect(screen.getByText(/before the interview/i)).toBeInTheDocument();
    expect(screen.getByText(/No screening interview was recorded/i)).toBeInTheDocument();
  });

  it('renders the scorecard when an assessment exists', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    renderPage();
    expect(await screen.findByText('Scorecard')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
    expect(screen.getByText('Advance')).toBeInTheDocument();
  });

  it('renders a role-scorecard (v2) assessment instead of crashing', async () => {
    getSession.mockResolvedValue({ ...completedSessionDetail, assessment: v2Assessment });
    renderPage();
    expect(await screen.findByText('Scorecard')).toBeInTheDocument();
    expect(screen.getByText('86')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: 'Technical depth' })).toBeInTheDocument();
    expect(screen.getByText('Excellent')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('Weight 60%')).toBeInTheDocument();
  });

  it('shows a truthful no-scorecard state when completed without an assessment', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      assessment: null,
    });
    renderPage();
    expect(await screen.findByText('No scorecard yet')).toBeInTheDocument();
    expect(screen.getByText(/Scoring may still be running/i)).toBeInTheDocument();
  });

  it('shows a no-scorecard state when the session has not completed', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      session: { ...completedSessionDetail.session, status: 'in_progress' },
      assessment: null,
    });
    renderPage();
    expect(await screen.findByText('No scorecard yet')).toBeInTheDocument();
    expect(screen.getByText(/has not completed, so it has not been scored/i)).toBeInTheDocument();
  });

  it('gates recording access behind an explicit click', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    // Control the mocked request so the test drives (and awaits) the exact
    // request→render transition deterministically. The prior version raced two
    // wall-clock waitFor(<audio>) polls; combined with the mount-effect flush
    // below, this removes the flake seen on the post-merge coverage run.
    let resolveRec!: (v: { url: string }) => void;
    getRecordingDownloadUrl.mockImplementationOnce(
      () => new Promise<{ url: string }>((res) => { resolveRec = res; }),
    );
    renderPage();
    await screen.findByText('Recording');
    // Flush RecordingCard's mount effects (its on-mount in-flight-invalidation
    // effect) BEFORE interacting, so a synthetic click cannot race that effect
    // and get its request generation clobbered. A real user only ever clicks
    // after mount has settled; the test must mirror that.
    await act(async () => {});

    // Fetch is issued ONLY on the explicit click — never before.
    expect(getRecordingDownloadUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    expect(getRecordingDownloadUrl).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
    );

    // Settle the request; the player controls (incl. "Refresh link") render in
    // the same commit as <audio>. Await that control via a mutation-observing
    // query so the assertion never races React's flush scheduling.
    resolveRec({ url: 'https://x.invalid/rec' });
    await screen.findByRole('button', { name: /refresh link/i });

    const audio = document.querySelector('audio') as HTMLAudioElement;
    expect(audio).not.toBeNull();
    expect(audio.src).toContain('x.invalid/rec');
  });

  it('refreshes an expired link on demand and reports errors inline', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    // Controlled deferreds: the first load resolves a fresh URL; the on-demand
    // refresh rejects (expired link). Each transition is settled explicitly and
    // awaited via a semantic query, so the test never races async latency.
    let resolveFirst!: (v: { url: string }) => void;
    let rejectSecond!: (e: { message: string }) => void;
    getRecordingDownloadUrl
      .mockImplementationOnce(() => new Promise<{ url: string }>((res) => { resolveFirst = res; }))
      .mockImplementationOnce(() => new Promise<{ url: string }>((_res, rej) => { rejectSecond = rej; }));
    renderPage();
    await screen.findByText('Recording');
    // Flush mount effects before interacting (see the gating test above).
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    resolveFirst({ url: 'https://x.invalid/rec1' });
    // The "Refresh link" control renders alongside <audio> once the URL loads.
    await screen.findByRole('button', { name: /refresh link/i });
    expect(document.querySelector('audio')).not.toBeNull();

    // Explicit user-gated refresh mints a new URL; the expired response surfaces
    // inline without fabricating a URL.
    fireEvent.click(screen.getByRole('button', { name: /refresh link/i }));
    rejectSecond({ message: 'link expired' });
    expect(await screen.findByText('link expired')).toBeInTheDocument();
  });

  it('does not offer recording access before completion', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      session: { ...completedSessionDetail.session, status: 'waiting' },
    });
    renderPage();
    expect(
      await screen.findByText(/Recording access is available once the session completes/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    const { container } = renderPage();
    await screen.findByText('Scorecard');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with a v2 assessment', async () => {
    getSession.mockResolvedValue({ ...completedSessionDetail, assessment: v2Assessment });
    const { container } = renderPage();
    await screen.findByText('Technical depth');
    await expect(container).toHaveNoViolations();
  });
});
